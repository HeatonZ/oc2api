package zen

import (
	"strings"
	"testing"

	"oc2api/internal/config"
)

// 现存 Sub2API 账号里存的是 v3 的反向代理地址。v4 必须能从这种地址里
// 认出「真实目标站」和「出口账号」，否则上线就得逐条改账号。
func TestParseLegacyRelay(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want legacyRelay
		ok   bool
	}{
		{
			name: "标准 v3 反向代理地址",
			in:   "http://resin:2260/11123zzzsf/opencode.freeproxy1/https/opencode.ai",
			want: legacyRelay{target: "https://opencode.ai", host: "opencode.ai", account: "freeproxy1"},
			ok:   true,
		},
		{
			name: "带路径尾巴",
			in:   "http://resin:2260/tok/opencode.freeproxy25/https/opencode.ai/inference",
			want: legacyRelay{target: "https://opencode.ai/inference", host: "opencode.ai", account: "freeproxy25"},
			ok:   true,
		},
		{
			name: "冒号分隔身份",
			in:   "http://resin:2260/tok/opencode:freeproxy9/https/opencode.ai",
			want: legacyRelay{target: "https://opencode.ai", host: "opencode.ai", account: "freeproxy9"},
			ok:   true,
		},
		{
			name: "普通上游地址不当作反代",
			in:   "https://opencode.ai/inference",
			ok:   false,
		},
		{
			name: "段数不足",
			in:   "http://resin:2260/tok/opencode.ai",
			ok:   false,
		},
		{
			name: "协议段不是 http/https",
			in:   "http://resin:2260/tok/opencode.freeproxy1/ftp/opencode.ai",
			ok:   false,
		},
	}
	for _, c := range cases {
		got, ok := parseLegacyRelay(c.in)
		if ok != c.ok {
			t.Fatalf("%s: 识别结果应为 %v，实际 %v", c.name, c.ok, ok)
		}
		if !c.ok {
			continue
		}
		if got != c.want {
			t.Fatalf("%s: 期望 %+v，实际 %+v", c.name, c.want, got)
		}
	}
}

// 旧地址必须被解析成「真实目标 + 按账号的 egress」，而不是继续走反代。
func TestResolveTargetFromLegacyRelay(t *testing.T) {
	factory := NewFactory(config.Config{
		EgressURL:  "socks5://egress-filter:1080",
		EgressUser: "opencode.{account}",
		EgressPass: "pw",
	})

	target, err := factory.Resolve(
		"http://resin:2260/11123zzzsf/opencode.freeproxy7/https/opencode.ai",
		"",
	)
	if err != nil {
		t.Fatalf("意外错误: %v", err)
	}
	if target.Base != "https://opencode.ai" {
		t.Fatalf("基址应还原成真实上游，实际 %q", target.Base)
	}
	if !strings.HasPrefix(target.Proxy.URL, "socks5://") {
		t.Fatalf("出口应为 socks5 隧道，实际 %q", target.Proxy.URL)
	}
	if !strings.Contains(target.Proxy.URL, "opencode.freeproxy7") {
		t.Fatalf("出口用户名应带账号，实际 %q", target.Proxy.URL)
	}
	if strings.Contains(target.Proxy.URL, "resin:2260") {
		t.Fatalf("不应再走反代地址: %q", target.Proxy.URL)
	}
}

// 显式请求头 x-opencode-egress 必须压过旧地址推导出来的出口。
func TestEgressHeaderWinsOverLegacy(t *testing.T) {
	factory := NewFactory(config.Config{
		EgressURL:  "socks5://egress-filter:1080",
		EgressUser: "opencode.{account}",
		EgressPass: "pw",
	})

	target, err := factory.Resolve(
		"http://resin:2260/tok/opencode.freeproxy7/https/opencode.ai",
		"socks5://opencode.freeproxy99:pw2@other-egress:1080",
	)
	if err != nil {
		t.Fatalf("意外错误: %v", err)
	}
	if !strings.Contains(target.Proxy.URL, "freeproxy99") {
		t.Fatalf("显式出口未生效: %q", target.Proxy.URL)
	}
}

// 没有配 egress 时不能悄悄退回反代，必须落到直连（并暴露问题），
// 否则会以「看似成功」的方式丢掉按账号轮转。
func TestNoEgressFallsBackToDirect(t *testing.T) {
	factory := NewFactory(config.Config{})

	target, err := factory.Resolve(
		"http://resin:2260/tok/opencode.freeproxy7/https/opencode.ai",
		"",
	)
	if err != nil {
		t.Fatalf("意外错误: %v", err)
	}
	if target.Proxy.URL != "" {
		t.Fatalf("未配 egress 时应直连，实际 %q", target.Proxy.URL)
	}
	if target.Base != "https://opencode.ai" {
		t.Fatalf("基址仍应还原，实际 %q", target.Base)
	}
}
