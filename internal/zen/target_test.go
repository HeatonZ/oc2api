package zen

import (
	"strings"
	"testing"

	"oc2api/internal/dial"
)

func TestResolveBasePriority(t *testing.T) {
	t.Setenv("BASE_URL", "https://configured.example/base/")
	t.Setenv("ZEN_API_BASE_URL", "https://relay.example")
	cases := []struct {
		name     string
		override string
		want     string
	}{
		{"请求覆盖优先", "https://request.example/x", "https://request.example/x"},
		{"其次 BASE_URL", "", "https://configured.example/base"},
	}
	for _, c := range cases {
		got, err := ResolveBase(c.override)
		if err != nil {
			t.Fatalf("%s: 意外错误 %v", c.name, err)
		}
		if got != c.want {
			t.Fatalf("%s: 期望 %q，实际 %q", c.name, c.want, got)
		}
	}

	t.Setenv("BASE_URL", "")
	if got, err := ResolveBase(""); err != nil || got != "https://relay.example" {
		t.Fatalf("回退 ZEN_API_BASE_URL 失败: %q %v", got, err)
	}

	t.Setenv("ZEN_API_BASE_URL", "")
	if got, err := ResolveBase(""); err != nil || got != UpstreamBase {
		t.Fatalf("回退默认值失败: %q %v", got, err)
	}
}

func TestResolveBaseValidation(t *testing.T) {
	cases := []string{
		"ftp://example.com",
		"not-a-url",
		"https://",
	}
	for _, value := range cases {
		if _, err := ResolveBase(value); err == nil {
			t.Fatalf("%q 应被判为非法", value)
		}
	}
}

// opencode.ai 上的 /zen* 要改写成 /inference*，但 /zen/go 是付费网关，不能动。
func TestNormalizeZenBase(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://opencode.ai/zen/v1", "https://opencode.ai/inference/v1"},
		{"https://opencode.ai/zen", "https://opencode.ai/inference"},
		{"https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1"},
		{"https://opencode.ai/inference/v1", "https://opencode.ai/inference/v1"},
		{"http://resin:2260/token/opencode.freeproxy1/https/opencode.ai", "http://resin:2260/token/opencode.freeproxy1/https/opencode.ai"},
	}
	for _, c := range cases {
		if got := normalizeZenBase(c.in); got != c.want {
			t.Fatalf("%q: 期望 %q，实际 %q", c.in, c.want, got)
		}
	}
}

func TestEndpoint(t *testing.T) {
	// 基址是主机形态（UpstreamBase 就是这种），版本段由 relativePath 提供。
	cases := []struct{ base, want string }{
		{"https://opencode.ai/inference", "https://opencode.ai/inference/v1/chat/completions"},
		{"https://proxy.example", "https://proxy.example/inference/v1/chat/completions"},
		{"http://resin:2260/tok/opencode.freeproxy1/https/opencode.ai", "http://resin:2260/tok/opencode.freeproxy1/https/opencode.ai/inference/v1/chat/completions"},
	}
	for _, c := range cases {
		got := Endpoint(c.base, "v1/chat/completions")
		if got != c.want {
			t.Fatalf("base %q: 期望 %q，实际 %q", c.base, c.want, got)
		}
	}
	// 关键回归点：v4 上游原本拼的是 /openai/v1，免费层不认这个路径。
	if strings.Contains(Endpoint(UpstreamBase, "v1/chat/completions"), "/openai/") {
		t.Fatal("上游路径不应包含 /openai")
	}
}

func TestResolveTargetEgress(t *testing.T) {
	t.Setenv("BASE_URL", "")
	t.Setenv("ZEN_API_BASE_URL", "")
	t.Setenv("OC2API_PROXY", "")
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("https_proxy", "")

	target, err := ResolveTarget("https://up.example", "http://opencode.freeproxy1:tok@resin:2260")
	if err != nil {
		t.Fatalf("意外错误 %v", err)
	}
	if target.Proxy.URL != "http://opencode.freeproxy1:tok@resin:2260" {
		t.Fatalf("请求级出口未生效: %q", target.Proxy.URL)
	}
	if target.Base != "https://up.example" {
		t.Fatalf("请求级上游未生效: %q", target.Base)
	}

	t.Setenv("OC2API_PROXY", "http://env@egress:8080")
	target, err = ResolveTarget("", "")
	if err != nil {
		t.Fatalf("意外错误 %v", err)
	}
	if target.Proxy.URL != "http://env@egress:8080" {
		t.Fatalf("环境变量出口未生效: %q", target.Proxy.URL)
	}

	// 请求头必须压过环境变量，否则多账号轮转无法按请求选出口。
	target, _ = ResolveTarget("", "http://req@egress:9090")
	if target.Proxy.URL != "http://req@egress:9090" {
		t.Fatalf("请求头未压过环境变量: %q", target.Proxy.URL)
	}
}

// 出口标识不能把凭据打进日志。
func TestProxyLabelRedacts(t *testing.T) {
	proxy := dial.Proxy{URL: "http://opencode.freeproxy1:s3cr3t@resin:2260"}
	label := proxy.Label()
	if strings.Contains(label, "s3cr3t") {
		t.Fatalf("日志标签泄漏了密码: %q", label)
	}
	if !strings.Contains(label, "resin:2260") {
		t.Fatalf("日志标签缺少 host: %q", label)
	}
}
