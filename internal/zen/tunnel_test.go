package zen

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"oc2api/internal/dial"
)

// 这段测试证明移植的核心不变量：经 CONNECT 隧道发请求时，上游收到的仍是
// uTLS/Bun 的握手，而不是 Go 默认握手。指纹一旦在链路中间被换掉，免费层的
// 客户端校验就会失效（实测表现为 403 FreeTierError），所以这条不能用
// 「请求能通」代替验收。

type capturedHello struct {
	version      uint16
	cipherSuites []uint16
	sni          string
	hasSNI       bool
	alpn         []string
	curves       []uint16
}

// tlsUpstream 起一个记录 ClientHello 的 TLS 服务器。
func tlsUpstream(t *testing.T) (addr string, captured *[]capturedHello) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("上游监听失败: %v", err)
	}
	seen := &[]capturedHello{}
	cert := selfSigned(t)
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				hello, raw, err := readClientHelloRecord(c)
				if err != nil {
					return
				}
				*seen = append(*seen, hello)
				// 这段字节已经被读走，必须先回放，否则服务端看不到 ClientHello。
				replay := &replayConn{Conn: c, prefix: raw}
				server := tls.Server(replay, &tls.Config{Certificates: []tls.Certificate{cert}})
				if err := server.Handshake(); err != nil {
					return
				}
				reader := bufio.NewReader(server)
				for {
					line, err := reader.ReadString('\n')
					if err != nil || strings.TrimSpace(line) == "" {
						break
					}
				}
				_, _ = server.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"))
				_ = server.Close()
			}(conn)
		}
	}()
	// TLS 规范禁止对 IP 字面量发送 SNI，用 127.0.0.1 会得到「没有 SNI」的假失败，
	// 所以对外用 localhost。
	_, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("解析监听地址失败: %v", err)
	}
	return "localhost:" + port, seen
}

// recordingProxy 是最小 CONNECT 代理：记录目标后纯字节中继，绝不终结 TLS。
func recordingProxy(t *testing.T) (addr string, targets *[]string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("代理监听失败: %v", err)
	}
	seen := &[]string{}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				reader := bufio.NewReader(c)
				line, err := reader.ReadString('\n')
				if err != nil {
					return
				}
				fields := strings.Fields(line)
				if len(fields) < 2 || !strings.EqualFold(fields[0], http.MethodConnect) {
					return
				}
				target := fields[1]
				*seen = append(*seen, target)
				for {
					header, err := reader.ReadString('\n')
					if err != nil {
						return
					}
					if strings.TrimSpace(header) == "" {
						break
					}
				}
				upstream, err := net.Dial("tcp", target)
				if err != nil {
					_, _ = c.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
					return
				}
				defer func() { _ = upstream.Close() }()
				if _, err := c.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
					return
				}
				go func() { _, _ = io.Copy(upstream, reader) }()
				_, _ = io.Copy(c, upstream)
			}(conn)
		}
	}()
	return listener.Addr().String(), seen
}

// fetchThrough 用生产客户端发一次真实请求。上游是自签证书，请求最终会因
// 校验失败而报错，但握手已经发生、指纹已经到达上游，这正是要断言的部分。
func fetchThrough(t *testing.T, proxy dial.Proxy, addr string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "https://"+addr+"/v1/chat/completions", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	resp, err := Client(proxy).Do(req)
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等待超时: %s", what)
}

// 直连时指纹成立。
func TestUTLSFingerprintDirect(t *testing.T) {
	addr, captured := tlsUpstream(t)
	fetchThrough(t, dial.Proxy{}, addr)
	waitFor(t, func() bool { return len(*captured) >= 1 }, "上游握手")
	assertBunFingerprint(t, (*captured)[0])
}

// 经 CONNECT 隧道时指纹仍成立——这是整套移植成立的前提。
func TestUTLSFingerprintThroughTunnel(t *testing.T) {
	addr, captured := tlsUpstream(t)
	proxyAddr, targets := recordingProxy(t)

	fetchThrough(t, dial.Proxy{URL: "http://" + proxyAddr}, addr)
	waitFor(t, func() bool { return len(*captured) >= 1 }, "上游握手")

	if len(*targets) != 1 || (*targets)[0] != addr {
		t.Fatalf("代理未收到指向上游的 CONNECT: %v", *targets)
	}
	assertBunFingerprint(t, (*captured)[0])
}

// 对照组：Go 默认 TLS 经同一隧道时特征必须与 Bun 不同，
// 否则前面的断言没有区分力，测了等于没测。
func TestGoTLSFingerprintDiffers(t *testing.T) {
	addr, captured := tlsUpstream(t)
	proxyAddr, _ := recordingProxy(t)

	conn, err := dial.Dial(t.Context(), dial.Proxy{URL: "http://" + proxyAddr}, addr)
	if err != nil {
		t.Fatalf("经隧道连接失败: %v", err)
	}
	goTLS := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, ServerName: "127.0.0.1"})
	if err := goTLS.Handshake(); err != nil {
		t.Fatalf("Go TLS 握手失败: %v", err)
	}
	_ = goTLS.Close()

	waitFor(t, func() bool { return len(*captured) >= 1 }, "上游握手")
	if sameCipherSuites((*captured)[0].cipherSuites, bunClientHello().CipherSuites) {
		t.Fatal("Go 默认 TLS 与 Bun 指纹的 cipher suites 相同，指纹断言失去区分力")
	}
}

func assertBunFingerprint(t *testing.T, hello capturedHello) {
	t.Helper()
	want := bunClientHello()

	if hello.version != tls.VersionTLS12 {
		t.Fatalf("legacy_version 期望 TLS1.2(0x0303)，实际 0x%04x", hello.version)
	}
	if !hello.hasSNI || hello.sni == "" {
		t.Fatal("缺少 SNI 扩展")
	}
	if !sameCipherSuites(hello.cipherSuites, want.CipherSuites) {
		t.Fatalf("cipher suites 与 Bun 指纹不一致:\n  实际 %v\n  期望 %v", hello.cipherSuites, want.CipherSuites)
	}
	// Bun 只宣告 http/1.1；宣告 h2 会被判成别的客户端。
	if len(hello.alpn) != 1 || hello.alpn[0] != "http/1.1" {
		t.Fatalf("ALPN 期望仅 http/1.1，实际 %v", hello.alpn)
	}
	// X25519MLKEM768(0x11ec) 是 Bun 握手的强特征。
	if !containsCurve(hello.curves, 0x11ec) {
		t.Fatalf("supported_groups 缺少 X25519MLKEM768(0x11ec)，实际 %v", hello.curves)
	}
}

func sameCipherSuites(a, b []uint16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsCurve(list []uint16, want uint16) bool {
	for _, value := range list {
		if value == want {
			return true
		}
	}
	return false
}

// readClientHelloRecord 解析 TLS 记录层里的 ClientHello，取关键特征。
// 手写 bit 偏移太容易错，session_id 与扩展段长度都是变长的；
// 这里用标准库解出字段后，再单独遍历扩展拿 SNI / ALPN / supported_groups。
func readClientHelloRecord(conn net.Conn) (capturedHello, []byte, error) {
	result := capturedHello{}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	header := make([]byte, 5)
	if _, err := io.ReadFull(conn, header); err != nil {
		return result, nil, err
	}
	if header[0] != 0x16 {
		return result, nil, io.ErrUnexpectedEOF
	}
	length := int(header[3])<<8 | int(header[4])
	body := make([]byte, length)
	if _, err := io.ReadFull(conn, body); err != nil {
		return result, nil, err
	}
	raw := append(append([]byte{}, header...), body...)

	if len(body) < 38 || body[0] != 0x01 {
		return result, raw, nil
	}
	result.version = uint16(body[4])<<8 | uint16(body[5])
	if err := parseClientHelloFields(raw, &result); err != nil {
		return result, raw, err
	}
	return result, raw, nil
}

// parseClientHelloFields 从原始 TLS 记录里解出 cipher_suites 与关心的扩展。
// 标准库不暴露客户端握手的原始扩展，所以这里按 RFC 8446 的布局自己走一遍。
func parseClientHelloFields(record []byte, result *capturedHello) error {
	// record(5) + handshake_type(1) + handshake_len(3) + version(2) + random(32)
	pos := 5 + 1 + 3 + 2 + 32
	if pos >= len(record) {
		return io.ErrUnexpectedEOF
	}
	pos += 1 + int(record[pos]) // session_id
	if pos+2 > len(record) {
		return io.ErrUnexpectedEOF
	}
	suiteLen := int(record[pos])<<8 | int(record[pos+1])
	pos += 2
	suiteEnd := pos + suiteLen
	for pos+1 < suiteEnd && pos+1 < len(record) {
		result.cipherSuites = append(result.cipherSuites, uint16(record[pos])<<8|uint16(record[pos+1]))
		pos += 2
	}
	pos = suiteEnd
	if pos >= len(record) {
		return io.ErrUnexpectedEOF
	}
	pos += 1 + int(record[pos]) // compression_methods
	if pos+2 > len(record) {
		return io.ErrUnexpectedEOF
	}
	extEnd := pos + 2 + (int(record[pos])<<8 | int(record[pos+1]))
	pos += 2
	for pos+4 <= extEnd && pos+4 <= len(record) {
		extType := uint16(record[pos])<<8 | uint16(record[pos+1])
		extSize := int(record[pos+2])<<8 | int(record[pos+3])
		pos += 4
		if pos+extSize > len(record) {
			return io.ErrUnexpectedEOF
		}
		data := record[pos : pos+extSize]
		switch extType {
		case 0x0000: // server_name
			if len(data) > 5 {
				nameLen := int(data[3])<<8 | int(data[4])
				if 5+nameLen <= len(data) {
					result.sni = string(data[5 : 5+nameLen])
					result.hasSNI = true
				}
			}
		case 0x0010: // ALPN
			for i := 2; i < len(data); {
				l := int(data[i])
				if l == 0 || i+1+l > len(data) {
					break
				}
				result.alpn = append(result.alpn, string(data[i+1:i+1+l]))
				i += 1 + l
			}
		case 0x000a: // supported_groups
			for i := 2; i+1 < len(data); i += 2 {
				result.curves = append(result.curves, uint16(data[i])<<8|uint16(data[i+1]))
			}
		}
		pos += extSize
	}
	return nil
}

// replayConn 先把已读走的字节吐回去，再继续读底层连接。
type replayConn struct {
	net.Conn
	prefix []byte
}

func (c *replayConn) Read(p []byte) (int, error) {
	if len(c.prefix) > 0 {
		n := copy(p, c.prefix)
		c.prefix = c.prefix[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}

func selfSigned(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:         true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("签发证书失败: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}
