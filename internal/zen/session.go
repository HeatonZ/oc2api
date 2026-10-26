package zen

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 上游只接受 ses_ + 12 位小写 hex + 14 位 base62 的形状。
var sessionIDPattern = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)

// 同一毫秒内的序号上限。上游要求 1..15，超出会被判成非法。
const maxPerMillisecond = 16

// IsRealSessionID 判断一个 id 是否已经是合规的上游 session id。
// 除了形状，还要看低 12 位编码出的毫秒内序号：合法区间是 1..15。
// 边界 0（低 12 位全 0xFFF）形状完全合法，但实测会被上游回 429，
// 所以不能只靠正则放行——这条是 v4 用真实请求换来的结论。
func IsRealSessionID(id string) bool {
	if !sessionIDPattern.MatchString(id) {
		return false
	}
	low, err := strconv.ParseInt(id[13:16], 16, 64)
	if err != nil {
		return false
	}
	counter := 0xfff - low
	return counter >= 1 && counter < maxPerMillisecond
}

func readHeader(r *http.Request, name string) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(r.Header.Get(name))
}

// sessionSeed 按「调用方明确指定 → 会话标识头 → body 缓存键 → 内容派生」取种子。
// 不同来源加不同前缀，避免「客户端 id 恰好等于某个会话头」时被错误合并。
func sessionSeed(r *http.Request, payload map[string]any) string {
	for _, name := range []string{"x-opencode-session", "x-opencode-session-id"} {
		if value := readHeader(r, name); IsRealSessionID(value) {
			return value
		}
	}
	for _, name := range []string{"x-hermes-session-id", "x-session-affinity", "x-session-id", "conversation-id"} {
		if value := readHeader(r, name); value != "" {
			return "header:" + truncate(value, 200)
		}
	}
	if fromBody := payloadSessionSeed(payload); fromBody != "" {
		return "cache:" + truncate(fromBody, 200)
	}
	if fromContent := contentSessionSeed(payload["messages"]); fromContent != "" {
		sum := sha256.Sum256([]byte(fromContent))
		return "first:" + hex.EncodeToString(sum[:])
	}
	return ""
}

// payloadSessionSeed 取 OpenAI 的 prompt_cache_key 与 Anthropic 的 metadata.user_id。
func payloadSessionSeed(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if value, ok := payload["prompt_cache_key"].(string); ok && strings.TrimSpace(value) != "" {
		return value
	}
	metadata, _ := payload["metadata"].(map[string]any)
	if metadata == nil {
		return ""
	}
	if value, ok := metadata["user_id"].(string); ok {
		return value
	}
	return ""
}

// contentSessionSeed 用 system + 首条 user 内容派生：多轮对话里它比末条稳定，
// 而末条每轮都变，拿它当种子等于每轮换 session、缓存必然不命中。
func contentSessionSeed(messages any) string {
	list, _ := messages.([]any)
	var system, firstUser string
	for _, raw := range list {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		switch role {
		case "system":
			if system == "" {
				system = stringifyContent(message["content"])
			}
		case "user":
			if firstUser == "" {
				firstUser = stringifyContent(message["content"])
			}
		}
		if system != "" && firstUser != "" {
			break
		}
	}
	if system == "" && firstUser == "" {
		return ""
	}
	return system + "\x00" + firstUser
}

func stringifyContent(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case nil:
		return ""
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// 种子 → 规范 session 的映射。同一会话复用同一个 session，上游提示词缓存亲和才稳。
const (
	cacheTTL   = 30 * time.Minute
	cacheLimit = 1000
)

type cacheEntry struct {
	id string
	at time.Time
}

var (
	cacheMu  sync.Mutex
	cacheMap = map[string]*cacheEntry{}
)

// SessionFor 按「使用者 + 这段对话」取 session。
// 使用者参与 seed，否则两个调用方首句相同就会共用同一份上游缓存。
// 调用方自己给了合规 id 时原样沿用，不能被我们改掉。
func SessionFor(r *http.Request, payload map[string]any, user string) string {
	seed := sessionSeed(r, payload)
	if IsRealSessionID(seed) {
		return seed
	}
	return sessionForSeed(user + "\x00" + seed)
}

// SessionForID 供没有 *http.Request 的载体（JSON-RPC）用：
// 调用方直接给出了会话种子时按种子走，否则回退到内容派生。
func SessionForID(seed string, payload map[string]any) string {
	if IsRealSessionID(seed) {
		return seed
	}
	if strings.TrimSpace(seed) != "" {
		return sessionForSeed("header:" + truncate(seed, 200))
	}
	return sessionForSeed(sessionSeed(nil, payload))
}

func sessionForSeed(seed string) string {
	key := strings.TrimSpace(seed)
	if key == "" {
		return ""
	}
	if IsRealSessionID(key) {
		return key
	}

	now := time.Now()
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if existing, ok := cacheMap[key]; ok {
		// 先判过期再刷新时间，否则刚赋值就成了「零间隔」，永远不会过期。
		stale := now.Sub(existing.at) >= cacheTTL
		existing.at = now
		if stale {
			existing.id = SessionID()
		}
		return existing.id
	}
	entry := &cacheEntry{id: SessionID(), at: now}
	cacheMap[key] = entry
	for len(cacheMap) > cacheLimit {
		oldestKey := ""
		var oldest time.Time
		for candidate, value := range cacheMap {
			if oldestKey == "" || value.at.Before(oldest) {
				oldestKey, oldest = candidate, value.at
			}
		}
		delete(cacheMap, oldestKey)
	}
	return entry.id
}
