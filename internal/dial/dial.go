// Package dial 负责「怎么把 TCP 连到上游」：直连，或经代理的隧道。
//
// 为什么必须走隧道：opencode 免费层按 TLS 指纹识别客户端。任何会终结 TLS
// 再重新发起的中间层（反向代理、TLS 终结网关）都会把上游看到的指纹换掉，
// 我们复刻的 Bun 指纹就白做了。HTTP CONNECT 与 SOCKS5 CONNECT 都只中继字节，
// 指纹端到端保住。
//
// 支持的两种代理：
//
//	http://user:pass@host:port   → HTTP CONNECT 隧道（直连 Resin 用）
//	socks5://user:pass@host:port → SOCKS5 CONNECT 隧道（经 egress-filter 用）
//
// 生产链路是 socks5：egress-filter 把用户名当作「优先租约」，在 Resin 里按账号
// 绑定出口并在失败时换租约。用 http 直连 Resin 会绕过这层轮转。
package dial

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Proxy 是一次隧道所需的代理信息。空值表示直连。
type Proxy struct {
	URL string
}

// Enabled 表示是否配了代理。
func (p Proxy) Enabled() bool { return strings.TrimSpace(p.URL) != "" }

// Label 给日志用的脱敏标识：只保留 host:port，不打印凭据。
func (p Proxy) Label() string {
	if !p.Enabled() {
		return "direct"
	}
	parsed, err := url.Parse(p.URL)
	if err != nil {
		return "proxy"
	}
	scheme := parsed.Scheme
	if scheme == "" {
		scheme = "http"
	}
	user := ""
	if parsed.User != nil {
		user = parsed.User.Username() + "@"
	}
	return scheme + ":" + user + parsed.Host
}

var (
	directOnce sync.Once
	direct     *net.Dialer
)

func directDialer() *net.Dialer {
	directOnce.Do(func() {
		direct = &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	})
	return direct
}

// Dial 建立到 addr 的 TCP 连接：配了代理就走隧道，否则直连。
func Dial(ctx context.Context, p Proxy, addr string) (net.Conn, error) {
	if !p.Enabled() {
		return directDialer().DialContext(ctx, "tcp", addr)
	}

	parsed, err := url.Parse(p.URL)
	if err != nil {
		return nil, fmt.Errorf("代理地址无法解析: %w", err)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("代理地址缺少 host")
	}

	switch strings.ToLower(parsed.Scheme) {
	case "", "http", "https":
		return dialHTTPConnect(ctx, parsed, addr)
	case "socks5", "socks5h":
		return dialSOCKS5(ctx, parsed, addr)
	default:
		return nil, fmt.Errorf("不支持的代理协议: %s", parsed.Scheme)
	}
}

// dialHTTPConnect 走 HTTP CONNECT 隧道。
func dialHTTPConnect(ctx context.Context, parsed *url.URL, addr string) (net.Conn, error) {
	proxyAddr := parsed.Host
	if parsed.Port() == "" {
		proxyAddr = net.JoinHostPort(parsed.Hostname(), "80")
	}

	conn, err := directDialer().DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, err
	}

	// 握手本身也要受 ctx 约束，否则代理不响应时会一直挂着。
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	}

	header := map[string]string{"Host": addr}
	if parsed.User != nil {
		password, _ := parsed.User.Password()
		credential := parsed.User.Username() + ":" + password
		header["Proxy-Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(credential))
	}
	if err := writeConnect(conn, addr, header); err != nil {
		_ = conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	status, err := readConnectResponse(reader)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if status != http.StatusOK {
		_ = conn.Close()
		return nil, fmt.Errorf("代理 CONNECT 返回 %d", status)
	}

	_ = conn.SetDeadline(time.Time{})
	// bufio 可能已经预读了隧道里的字节，必须把剩余部分接回来，不能丢掉。
	if reader.Buffered() > 0 {
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}
	return conn, nil
}

func writeConnect(conn net.Conn, addr string, header map[string]string) error {
	var b strings.Builder
	b.WriteString("CONNECT " + addr + " HTTP/1.1\r\n")
	for key, value := range header {
		b.WriteString(key + ": " + value + "\r\n")
	}
	b.WriteString("\r\n")
	_, err := io.WriteString(conn, b.String())
	return err
}

// readConnectResponse 只读状态行和头部，读到空行即止，之后全是隧道字节。
func readConnectResponse(reader *bufio.Reader) (int, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return 0, err
	}
	fields := strings.SplitN(strings.TrimSpace(line), " ", 3)
	if len(fields) < 2 {
		return 0, fmt.Errorf("代理返回了非法响应行: %q", strings.TrimSpace(line))
	}
	status := 0
	if _, err := fmt.Sscanf(fields[1], "%d", &status); err != nil {
		return 0, fmt.Errorf("代理返回了非法状态码: %q", fields[1])
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return 0, err
		}
		if strings.TrimSpace(line) == "" {
			return status, nil
		}
	}
}

// bufferedConn 让 bufio 预读走的字节仍然能被读到。
type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

// DefaultProxy 从环境变量读出口代理。OC2API_PROXY 优先，其次标准 HTTPS_PROXY。
func DefaultProxy() Proxy {
	for _, name := range []string{"OC2API_PROXY", "HTTPS_PROXY", "https_proxy"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return Proxy{URL: value}
		}
	}
	return Proxy{}
}

// dialSOCKS5 走 SOCKS5 CONNECT 隧道（RFC 1928 + 用户名密码认证 RFC 1929）。
// egress-filter 把用户名当「优先租约」，所以凭据必须原样带上，不能退化成匿名。
func dialSOCKS5(ctx context.Context, parsed *url.URL, addr string) (net.Conn, error) {
	proxyAddr := parsed.Host
	if parsed.Port() == "" {
		proxyAddr = net.JoinHostPort(parsed.Hostname(), "1080")
	}

	conn, err := directDialer().DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	}

	if err := socks5Handshake(conn, parsed, addr); err != nil {
		_ = conn.Close()
		return nil, err
	}

	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func socks5Handshake(conn net.Conn, parsed *url.URL, addr string) error {
	user := ""
	password := ""
	if parsed.User != nil {
		user = parsed.User.Username()
		password, _ = parsed.User.Password()
	}

	// 有凭据就只报「用户名密码」一种方法：退化到匿名会让 egress-filter
	// 随机挑租约，按账号绑定出口的语义就失效了。
	methods := []byte{0x00}
	if user != "" {
		methods = []byte{0x02}
	}
	greeting := append([]byte{0x05, byte(len(methods))}, methods...)
	if _, err := conn.Write(greeting); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[0] != 0x05 {
		return fmt.Errorf("SOCKS5 版本不符: %d", reply[0])
	}
	switch reply[1] {
	case 0x00: // 无需认证
	case 0x02:
		if user == "" {
			return fmt.Errorf("SOCKS5 要求认证但未配置凭据")
		}
		auth := []byte{0x01, byte(len(user))}
		auth = append(auth, user...)
		auth = append(auth, byte(len(password)))
		auth = append(auth, password...)
		if _, err := conn.Write(auth); err != nil {
			return err
		}
		status := make([]byte, 2)
		if _, err := io.ReadFull(conn, status); err != nil {
			return err
		}
		if status[1] != 0x00 {
			return fmt.Errorf("SOCKS5 认证失败（状态 %d）", status[1])
		}
	case 0xff:
		return fmt.Errorf("SOCKS5 代理拒绝了所有认证方式")
	default:
		return fmt.Errorf("SOCKS5 返回了不支持的认证方式: %d", reply[1])
	}

	// CONNECT 请求：域名交给代理解析（远端解析），避免本地 DNS 泄漏。
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("目标地址非法: %w", err)
	}
	portNum := 0
	if _, err := fmt.Sscanf(port, "%d", &portNum); err != nil {
		return fmt.Errorf("目标端口非法: %w", err)
	}
	request := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		request = append(request, 0x01)
		request = append(request, ip.To4()...)
	} else if ip := net.ParseIP(host); ip != nil {
		request = append(request, 0x04)
		request = append(request, ip.To16()...)
	} else {
		if len(host) > 255 {
			return fmt.Errorf("目标域名过长")
		}
		request = append(request, 0x03, byte(len(host)))
		request = append(request, host...)
	}
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(portNum))
	request = append(request, portBytes...)
	if _, err := conn.Write(request); err != nil {
		return err
	}

	// 响应：VER REP RSV ATYP BND.ADDR BND.PORT
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return err
	}
	if head[0] != 0x05 {
		return fmt.Errorf("SOCKS5 响应版本不符: %d", head[0])
	}
	if head[1] != 0x00 {
		return fmt.Errorf("SOCKS5 CONNECT 失败（状态 %d）", head[1])
	}
	switch head[3] {
	case 0x01:
		if _, err := io.ReadFull(conn, make([]byte, 4+2)); err != nil {
			return err
		}
	case 0x04:
		if _, err := io.ReadFull(conn, make([]byte, 16+2)); err != nil {
			return err
		}
	case 0x03:
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			return err
		}
		if _, err := io.ReadFull(conn, make([]byte, int(length[0])+2)); err != nil {
			return err
		}
	default:
		return fmt.Errorf("SOCKS5 响应地址类型未知: %d", head[3])
	}
	return nil
}
