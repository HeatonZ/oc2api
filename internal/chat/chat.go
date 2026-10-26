// Package chat 串起一次对话请求：整形 → 上游 → 原始响应交给调用方。
package chat

import (
	"context"
	"io"
	"log"
	"net/http"
	"strings"

	"oc2api/internal/config"
	"oc2api/internal/protocol"
	"oc2api/internal/shape"
	"oc2api/internal/zen"
)

// Service 持有一次对话需要的依赖，由 main 注入。
type Service struct {
	client  *zen.Client
	targets *zen.Factory
	debug   bool
}

// New 注入上游客户端、请求级目标解析器与调试开关。
func New(cfg config.Config, client *zen.Client, targets *zen.Factory) *Service {
	return &Service{client: client, targets: targets, debug: cfg.Debug}
}

// Upstream 发起一次上游对话请求（上游只接受流式，非流式由调用方聚合）。
// baseOverride / egressOverride 是请求头带来的按请求覆盖，空串表示用默认。
func (s *Service) Upstream(ctx context.Context, payload map[string]any, model, baseOverride, egressOverride string) (*http.Response, *shape.Renames, error) {
	return s.UpstreamWithSession(ctx, payload, model, baseOverride, egressOverride, zen.SessionID())
}

// UpstreamWithSession 允许复用会话 id，多轮对话可以命中上游 prompt 缓存。
// target 按本次请求的覆盖值解析，不固定在进程级——每个账号各走自己的出口。
func (s *Service) UpstreamWithSession(ctx context.Context, payload map[string]any, model, baseOverride, egressOverride, session string) (*http.Response, *shape.Renames, error) {
	target, err := s.targets.Resolve(baseOverride, egressOverride)
	if err != nil {
		return nil, nil, err
	}
	body, renames, err := shape.Build(payload, model)
	if err != nil {
		return nil, nil, err
	}
	if s.debug {
		log.Printf("[chat] model=%s session=%s%s tools=%d body=%dB egress=%s base=%s", model, session, describeMessages(payload), countClientTools(payload), len(body), target.Proxy.Label(), target.Base)
	}
	resp, err := s.client.Chat(ctx, target, body, session)
	if err != nil {
		return nil, nil, err
	}
	if s.debug {
		log.Printf("[chat] upstream status=%d retry-after=%s", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
	return resp, renames, nil
}

// describeMessages 汇总消息角色，便于在日志里还原客户端请求形态。
func describeMessages(payload map[string]any) string {
	messages, _ := payload["messages"].([]any)
	roles := make([]string, 0, len(messages))
	for _, raw := range messages {
		if message, ok := raw.(map[string]any); ok {
			role, _ := message["role"].(string)
			roles = append(roles, role)
		}
	}
	return " messages=" + strings.Join(roles, ",")
}

func countClientTools(payload map[string]any) int {
	tools, _ := payload["tools"].([]any)
	return len(tools)
}

// Validate 与 Node 版保持同一套门面校验：只拦明显不合法的请求，
// 其余字段原样交给上游。返回空字符串表示通过。
func Validate(payload map[string]any) (model string, reason string) {
	model, _ = payload["model"].(string)
	if strings.TrimSpace(model) == "" {
		return "", "model must be a non-empty string"
	}
	if model != "big-pickle" && !strings.HasSuffix(model, "-free") {
		return "", "Only big-pickle and models ending in -free are allowed"
	}
	messages, _ := payload["messages"].([]any)
	if len(messages) == 0 {
		return "", "messages must be a non-empty array"
	}
	return model, ""
}

// 客户端没有工具时，模型偶尔仍会选中内置工具；被丢弃后正文为空，这时补一句
// 明确指令重试一次，避免给客户端一个空回答。
const noToolRetry = "（本客户端没有可用的工具，请直接用文字回答，不要调用任何工具。）"

// Complete 返回聚合后的非流式响应。
func (s *Service) Complete(ctx context.Context, payload map[string]any, model, baseOverride, egressOverride string) (map[string]any, error) {
	return s.CompleteWithSession(ctx, payload, model, baseOverride, egressOverride, zen.SessionID())
}

// CompleteWithSession 是 Complete 的会话显式版：同一段对话复用同一个 session，
// 上游才会命中提示词缓存。
func (s *Service) CompleteWithSession(ctx context.Context, payload map[string]any, model, baseOverride, egressOverride, session string) (map[string]any, error) {
	resp, renames, err := s.UpstreamWithSession(ctx, payload, model, baseOverride, egressOverride, session)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, &UpstreamError{Status: resp.StatusCode, RetryAfter: resp.Header.Get("Retry-After"), Body: text}
	}
	result, dropped, err := protocol.Aggregate(resp, renames)
	if err != nil {
		return nil, err
	}
	if dropped == 0 || hasContent(result) {
		return result, nil
	}

	retryPayload := withNudge(payload)
	resp2, renames2, err := s.UpstreamWithSession(ctx, retryPayload, model, baseOverride, egressOverride, session)
	if err != nil {
		return result, nil
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusOK {
		return result, nil
	}
	retried, _, err := protocol.Aggregate(resp2, renames2)
	if err != nil || !hasContent(retried) {
		return result, nil
	}
	return retried, nil
}

// UpstreamError 保留上游状态码，供 HTTP/RPC 层原样透出。
type UpstreamError struct {
	Status     int
	RetryAfter string
	Body       []byte
}

func (e *UpstreamError) Error() string { return string(e.Body) }

func hasContent(result map[string]any) bool {
	choices, _ := result["choices"].([]any)
	for _, raw := range choices {
		choice, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		message, _ := choice["message"].(map[string]any)
		if text, ok := message["content"].(string); ok && strings.TrimSpace(text) != "" {
			return true
		}
		if _, ok := message["tool_calls"]; ok {
			return true
		}
	}
	return false
}

func withNudge(payload map[string]any) map[string]any {
	cloned := map[string]any{}
	for k, v := range payload {
		cloned[k] = v
	}
	messages, _ := payload["messages"].([]any)
	extended := make([]any, 0, len(messages)+1)
	extended = append(extended, messages...)
	extended = append(extended, map[string]any{"role": "user", "content": noToolRetry})
	cloned["messages"] = extended
	return cloned
}
