package zen

import (
	"fmt"
	"net/url"
	"strings"

	"oc2api/internal/config"
	"oc2api/internal/dial"
)

// Target 是一次请求实际要打到哪：上游基址 + 走哪个出口。
// 两者都可以按请求覆盖，所以不能塞进进程级配置。
type Target struct {
	Base  string
	Proxy dial.Proxy
}

// Factory 按注入的配置解析每次请求的 Target。
//
// 上游 v4.2 把配置收进 config 并改成依赖注入，其余包不再读环境变量；
// 这里跟着走，出口相关的三项也由 main 注入，不各自去碰 os.Getenv。
type Factory struct {
	cfg config.Config
}

// NewFactory 用启动时定下来的配置构造解析器。
func NewFactory(cfg config.Config) *Factory {
	return &Factory{cfg: cfg}
}

// Resolve 解析一次请求的上游基址与出口。
// 出口优先级：请求头 x-opencode-egress → 从旧格式 base URL 推导 → 配置里的默认出口 → 直连。
//
// 兼容背景：v3 时代账号里存的是 Resin 反向代理地址
// （http://resin:2260/<token>/opencode.<account>/https/opencode.ai），
// 那条路径会让 Resin 终结 TLS、指纹丢失。v4 必须走隧道，所以这里把旧地址
// 解析成「真实目标站 + 出口账号」两个独立信息，上游直连目标站、出口走 egress。
// 这样 Sub2API 里现有账号不必逐条改 header 就能切换到正确链路。
func (f *Factory) Resolve(baseOverride, proxyOverride string) (Target, error) {
	egress := strings.TrimSpace(proxyOverride)
	baseValue := strings.TrimSpace(baseOverride)

	var account string
	if legacy, ok := parseLegacyRelay(baseValue); ok {
		account = legacy.account
		baseValue = legacy.target
	}

	base, err := ResolveBase(baseValue, f.cfg.ZenAPIBaseURL)
	if err != nil {
		return Target{}, err
	}

	proxy := egress
	if proxy == "" && account != "" {
		proxy = f.buildEgressProxy(account)
	}
	if proxy == "" {
		proxy = f.cfg.EgressURL
	}
	return Target{Base: base, Proxy: dial.Proxy{URL: proxy}}, nil
}

// buildEgressProxy 按账号拼出 egress 入口地址。
// 出口入口是进程级配置，账号才是每请求变化的维度。
func (f *Factory) buildEgressProxy(account string) string {
	entry := strings.TrimSpace(f.cfg.EgressURL)
	if entry == "" {
		return ""
	}
	parsed, err := url.Parse(entry)
	if err != nil || parsed.Host == "" {
		return ""
	}

	username := strings.ReplaceAll(f.cfg.EgressUser, "{account}", account)
	// 平台前缀已经是约定的一部分，账号里若已带平台就不再重复加。
	if !strings.Contains(username, ".") {
		username = "opencode." + username
	}

	if f.cfg.EgressPass == "" {
		parsed.User = url.User(username)
	} else {
		parsed.User = url.UserPassword(username, f.cfg.EgressPass)
	}
	return parsed.String()
}

// 上游路径的两种拼法，和 v3 保持一致：
// 基址已经指到版本路径（.../inference/v1、.../zen/v1、.../v1）时直接拼相对路径，
// 否则补上 /inference/v1。
var versionPathSuffixes = []string{"/inference/v1", "/zen/v1", "/v1"}

// normalizeZenBase 把 opencode.ai 上的 /zen* 改写成 /inference*。
// /zen/go 是付费网关，与免费层无关，原样保留。
func normalizeZenBase(base string) string {
	parsed, err := url.Parse(base)
	if err != nil {
		return base
	}
	if parsed.Hostname() != "opencode.ai" && !strings.HasSuffix(parsed.Hostname(), ".opencode.ai") {
		return base
	}
	rest := strings.TrimPrefix(parsed.Path, "/zen")
	if rest == parsed.Path || rest == "/go" || strings.HasPrefix(rest, "/go/") {
		return base
	}
	if rest != "" && !strings.HasPrefix(rest, "/") {
		return base
	}
	parsed.Path = "/inference" + rest
	return strings.TrimRight(parsed.String(), "/")
}

// ResolveBase 按「请求覆盖 → 注入的默认基址」解析上游基址。
// 顺序和 v3 的 resolveBaseURL 一致，校验的报错文案也保持一致。
//
// 与 v3 的差别：不再自己读 BASE_URL / ZEN_API_BASE_URL 环境变量，改由调用方
// 传入启动时定下来的默认值（config 注入）。
func ResolveBase(requestOverride, fallback string) (string, error) {
	value := strings.TrimSpace(requestOverride)
	if value == "" {
		value = strings.TrimSpace(fallback)
	}
	if value == "" {
		value = config.DefaultZenAPIBaseURL
	}
	value = strings.TrimRight(value, "/")

	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("base URL must be a valid http:// or https:// URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("base URL must use http:// or https://")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("base URL must include a host")
	}
	return normalizeZenBase(value), nil
}

// Endpoint 拼出最终请求地址。
// 语义对齐 v3 的 zenEndpoint(base, relativePath)：relativePath 已含版本段
// （如 "v1/chat/completions"），这里只决定要不要补 /inference。
// "/inference" 自身也算已定位到免费层入口——默认基址就是它。
func Endpoint(base, relativePath string) string {
	relativePath = strings.TrimLeft(relativePath, "/")
	if strings.HasSuffix(base, "/inference") {
		return base + "/" + relativePath
	}
	for _, suffix := range versionPathSuffixes {
		if strings.HasSuffix(base, suffix) {
			return base + "/" + relativePath
		}
	}
	return base + "/inference/" + relativePath
}

// legacyRelay 是从旧版反向代理地址里拆出来的信息。
type legacyRelay struct {
	// target 是真实上游基址，例如 https://opencode.ai
	target string
	// host 是目标主机名，用来取 egress 入口（默认与 target 同主机）
	host string
	// account 是 Resin 租约名，例如 freeproxy1
	account string
}

// parseLegacyRelay 识别 v3 的反向代理地址：
//
//	http://<proxyHost>:<port>/<token>/<platform>.<account>/<scheme>/<upstreamHost>[/<rest>]
//
// 识别不出来就返回 false，让调用方按普通 base URL 处理。
func parseLegacyRelay(value string) (legacyRelay, bool) {
	if value == "" {
		return legacyRelay{}, false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return legacyRelay{}, false
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	// token / platform.account / scheme / upstreamHost 至少四段
	if len(segments) < 4 {
		return legacyRelay{}, false
	}
	identity := segments[1]
	scheme := strings.ToLower(segments[2])
	if scheme != "http" && scheme != "https" {
		return legacyRelay{}, false
	}
	upstreamHost := segments[3]
	if upstreamHost == "" {
		return legacyRelay{}, false
	}

	platform, account := splitPlatformAccount(identity)
	if account == "" {
		return legacyRelay{}, false
	}
	// 只有带账号的形态才是出口选择；不带账号的普通反代按原样交给 ResolveBase。
	if platform == "" {
		return legacyRelay{}, false
	}

	target := scheme + "://" + upstreamHost
	if len(segments) > 4 {
		target += "/" + strings.Join(segments[4:], "/")
	}
	return legacyRelay{target: target, host: upstreamHost, account: account}, true
}

// splitPlatformAccount 拆 "platform.account"（点或冒号分隔）。
func splitPlatformAccount(identity string) (platform, account string) {
	for _, sep := range []string{".", ":"} {
		if index := strings.Index(identity, sep); index > 0 && index < len(identity)-1 {
			return identity[:index], identity[index+1:]
		}
	}
	return "", identity
}
