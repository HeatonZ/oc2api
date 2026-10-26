package zen

import (
	"net/http"
	"strings"
	"testing"
)

func TestIsRealSessionID(t *testing.T) {
	valid := SessionID()
	if !IsRealSessionID(valid) {
		t.Fatalf("自己生成的 id 应当合规: %q", valid)
	}
	invalid := []string{
		"",
		"ses_",
		"ses_0123456789ab01234567890123", // 只有 12+14 之外的长度差
		"ses_0123456789abcdefghijklmn",   // hex 段长度不对
		"xyz_0123456789abABCDEFGHIJKLMN", // 前缀不对
		"ses_0123456789ABABCDEFGHIJKLMN", // hex 段含大写
		"ses_ffffffffffffABCDEFGHIJKLMN", // 毫秒内序号越界
	}
	for _, value := range invalid {
		if IsRealSessionID(value) {
			t.Fatalf("%q 应被判为非法", value)
		}
	}
}

// 同一个会话的多次请求必须拿到同一个 session，否则上游提示词缓存亲和会断。
func TestSessionStablePerConversation(t *testing.T) {
	payload := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "你是助手"},
			map[string]any{"role": "user", "content": "第一问"},
		},
	}
	first := SessionForID("", payload)
	second := SessionForID("", payload)
	if first == "" || first != second {
		t.Fatalf("同会话应复用 session: %q vs %q", first, second)
	}

	other := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "你是助手"},
			map[string]any{"role": "user", "content": "另一个问题"},
		},
	}
	if SessionForID("", other) == first {
		t.Fatal("不同首问不应当共用 session")
	}
}

// 客户端给的合规 id 必须原样透传，不能被网关改掉。
func TestSessionPassthroughFromHeader(t *testing.T) {
	client := SessionID()
	req, _ := http.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("x-opencode-session", client)
	if got := SessionFor(req, map[string]any{}, "user-a"); got != client {
		t.Fatalf("应原样透传 %q，实际 %q", client, got)
	}
}

// 各类会话标识头都要能被识别，并且不同来源不能互相串。
func TestSessionHeaderPriority(t *testing.T) {
	payload := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "同一条"}},
	}
	req, _ := http.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("x-hermes-session-id", "hermes-1")
	req.Header.Set("x-session-affinity", "affinity-1")
	withHermes := SessionFor(req, payload, "u")

	req2, _ := http.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req2.Header.Set("x-session-affinity", "affinity-1")
	withAffinity := SessionFor(req2, payload, "u")

	if withHermes == "" || withAffinity == "" {
		t.Fatal("会话头未生效")
	}
	if withHermes == withAffinity {
		t.Fatal("不同来源的标识不应合并成同一个 session")
	}
}

// prompt_cache_key 是 OpenAI 标准字段，应当被采信。
func TestSessionFromPromptCacheKey(t *testing.T) {
	payload := map[string]any{
		"prompt_cache_key": "cache-abc",
		"messages":         []any{map[string]any{"role": "user", "content": "hi"}},
	}
	a := SessionForID("", payload)
	b := SessionForID("", payload)
	if a == "" || a != b {
		t.Fatalf("prompt_cache_key 应稳定派生: %q vs %q", a, b)
	}
}

// 不同使用者首句相同也不能共用缓存。
func TestSessionSeparatesUsers(t *testing.T) {
	payload := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "同一句话"}},
	}
	reqA, _ := http.NewRequest(http.MethodPost, "/", nil)
	reqB, _ := http.NewRequest(http.MethodPost, "/", nil)
	if SessionFor(reqA, payload, "user-a") == SessionFor(reqB, payload, "user-b") {
		t.Fatal("不同使用者不应共用 session")
	}
}

func TestSessionCacheBounded(t *testing.T) {
	// 灌超上限的种子，缓存不能无限增长。
	for i := 0; i < cacheLimit+50; i++ {
		sessionForSeed("seed-" + strings.Repeat("x", 1) + string(rune('a'+i%26)) + string(rune('a'+i/26)))
	}
	cacheMu.Lock()
	size := len(cacheMap)
	cacheMu.Unlock()
	if size > cacheLimit {
		t.Fatalf("会话缓存超过上限: %d > %d", size, cacheLimit)
	}
}
