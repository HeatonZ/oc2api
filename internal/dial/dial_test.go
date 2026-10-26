package dial

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// 这段测试守住 SOCKS5 客户端的关键语义：用户名必须作为认证信息送到代理。
// egress-filter 用用户名选租约，用户名丢了就退化成随机挑出口，
// 「按账号绑定出口」的整个轮转设计就失效了。

// socks5Recorder 起一个最小 SOCKS5 服务端，记录收到的用户名与目标主机。
func socks5Recorder(t *testing.T) (addr string, users *[]string, targets *[]string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	seenUsers := &[]string{}
	seenTargets := &[]string{}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveSOCKS5(conn, seenUsers, seenTargets)
		}
	}()
	return listener.Addr().String(), seenUsers, seenTargets
}

func serveSOCKS5(c net.Conn, users *[]string, targets *[]string) {
	defer func() { _ = c.Close() }()
	br := bufio.NewReader(c)

	head := make([]byte, 2)
	if _, err := io.ReadFull(br, head); err != nil {
		return
	}
	if _, err := io.ReadFull(br, make([]byte, int(head[1]))); err != nil {
		return
	}
	if _, err := c.Write([]byte{0x05, 0x02}); err != nil {
		return
	}

	authHead := make([]byte, 2)
	if _, err := io.ReadFull(br, authHead); err != nil {
		return
	}
	user := make([]byte, int(authHead[1]))
	if _, err := io.ReadFull(br, user); err != nil {
		return
	}
	passLen := make([]byte, 1)
	if _, err := io.ReadFull(br, passLen); err != nil {
		return
	}
	if _, err := io.ReadFull(br, make([]byte, int(passLen[0]))); err != nil {
		return
	}
	*users = append(*users, string(user))
	if _, err := c.Write([]byte{0x01, 0x00}); err != nil {
		return
	}

	reqHead := make([]byte, 4)
	if _, err := io.ReadFull(br, reqHead); err != nil {
		return
	}
	host := ""
	switch reqHead[3] {
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(br, l); err != nil {
			return
		}
		name := make([]byte, int(l[0]))
		if _, err := io.ReadFull(br, name); err != nil {
			return
		}
		host = string(name)
	case 0x01:
		ip := make([]byte, 4)
		if _, err := io.ReadFull(br, ip); err != nil {
			return
		}
		host = net.IP(ip).String()
	case 0x04:
		ip := make([]byte, 16)
		if _, err := io.ReadFull(br, ip); err != nil {
			return
		}
		host = net.IP(ip).String()
	}
	if _, err := io.ReadFull(br, make([]byte, 2)); err != nil {
		return
	}
	*targets = append(*targets, host)
	_, _ = c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	time.Sleep(50 * time.Millisecond)
}

func TestSOCKS5CarriesUsername(t *testing.T) {
	addr, users, targets := socks5Recorder(t)
	proxy := Proxy{URL: "socks5://opencode.freeproxy7:s3cr3t@" + addr}

	conn, err := Dial(context.Background(), proxy, "opencode.ai:443")
	if err != nil {
		t.Fatalf("SOCKS5 连接失败: %v", err)
	}
	_ = conn.Close()

	if len(*users) != 1 {
		t.Fatalf("代理应收到 1 次认证，实际 %d", len(*users))
	}
	// 用户名必须原样带着，egress-filter 靠它选租约。
	if (*users)[0] != "opencode.freeproxy7" {
		t.Fatalf("用户名未正确透传: %q", (*users)[0])
	}
	if len(*targets) != 1 || (*targets)[0] != "opencode.ai" {
		t.Fatalf("目标未正确透传: %v", *targets)
	}
}

func TestSOCKS5RejectsBadAuth(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer func() { _ = listener.Close() }()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		buf := make([]byte, 64)
		_, _ = conn.Read(buf)
		_, _ = conn.Write([]byte{0x05, 0x02})
		_, _ = conn.Read(buf)
		_, _ = conn.Write([]byte{0x01, 0x01}) // 认证失败
		time.Sleep(200 * time.Millisecond)
	}()

	proxy := Proxy{URL: "socks5://user:wrong@" + listener.Addr().String()}
	if _, err := Dial(context.Background(), proxy, "opencode.ai:443"); err == nil {
		t.Fatal("认证失败应当返回错误")
	}
}

func TestHTTPConnectCarriesBasicAuth(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer func() { _ = listener.Close() }()
	gotAuth := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		br := bufio.NewReader(conn)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if strings.HasPrefix(line, "Proxy-Authorization:") {
				gotAuth <- strings.TrimSpace(strings.TrimPrefix(line, "Proxy-Authorization:"))
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		time.Sleep(50 * time.Millisecond)
	}()

	proxy := Proxy{URL: "http://opencode.freeproxy1:tok@" + listener.Addr().String()}
	conn, err := Dial(context.Background(), proxy, "opencode.ai:443")
	if err != nil {
		t.Fatalf("CONNECT 失败: %v", err)
	}
	_ = conn.Close()

	auth := <-gotAuth
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("opencode.freeproxy1:tok"))
	if auth != want {
		t.Fatalf("Proxy-Authorization 不符: %q", auth)
	}
}

func TestUnsupportedScheme(t *testing.T) {
	if _, err := Dial(context.Background(), Proxy{URL: "ftp://x:1"}, "a:1"); err == nil {
		t.Fatal("不支持的协议应当报错")
	}
}

func TestLabelRedactsPassword(t *testing.T) {
	proxy := Proxy{URL: "socks5://opencode.freeproxy1:s3cr3t@egress:1080"}
	label := proxy.Label()
	if strings.Contains(label, "s3cr3t") {
		t.Fatalf("日志标签泄漏了密码: %q", label)
	}
	if !strings.Contains(label, "egress:1080") {
		t.Fatalf("日志标签缺少 host: %q", label)
	}
}
