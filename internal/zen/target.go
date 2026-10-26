package zen

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"oc2api/internal/dial"
)

// Target 是一次请求实际要打到哪：上游基址 + 走哪个出口。
// 两者都可以按请求覆盖，所以不能塞进进程级配置。
type Target struct {
	Base  string
	Proxy dial.Proxy
}

// 上游路径的两种拼法，和 v3 保持一致：
// 基址已经指到版本路径（.../inference/v1、.../zen/v1、.../v1）时直接拼相对路径，
// 否则补上 /inference/v1。
const zenAPIPath = "/inference/v1"

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

// ResolveBase 按「请求覆盖 → BASE_URL → ZEN_API_BASE_URL → 默认」的优先级解析上游基址。
// 顺序和 v3 的 resolveBaseURL 一致，校验的报错文案也保持一致。
func ResolveBase(requestOverride string) (string, error) {
	value := strings.TrimSpace(requestOverride)
	if value == "" {
		value = strings.TrimSpace(os.Getenv("BASE_URL"))
	}
	if value == "" {
		value = strings.TrimSpace(os.Getenv("ZEN_API_BASE_URL"))
	}
	if value == "" {
		value = UpstreamBase
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

// ResolveTarget 解析一次请求的上游基址与出口。
// 出口优先级：请求头 x-opencode-egress 指定 → 从旧格式 base URL 提取 → 环境变量 → 直连。
//
// 兼容背景：v3 时代账号里存的是 Resin 反向代理地址
// （http://resin:2260/<token>/opencode.<account>/https/opencode.ai），
// 那条路径会让 Resin 终结 TLS、指纹丢失。v4 必须走隧道，所以这里把旧地址
// 解析成「真实目标站 + 出口账号」两个独立信息，上游直连目标站、出口走 egress。
// 这样 Sub2API 里现有账号不必逐条改 header 就能切换到正确链路。
func ResolveTarget(baseOverride, proxyOverride string) (Target, error) {
	egress := strings.TrimSpace(proxyOverride)
	baseValue := strings.TrimSpace(baseOverride)

	var host, account string
	if legacy, ok := parseLegacyRelay(baseValue); ok {
		host, account = legacy.host, legacy.account
		baseValue = legacy.target
	}

	base, err := ResolveBase(baseValue)
	if err != nil {
		return Target{}, err
	}

	proxy := egress
	if proxy == "" && account != "" {
		proxy = buildEgressProxy(host, account)
	}
	if proxy == "" {
		proxy = dial.DefaultProxy().URL
	}
	return Target{Base: base, Proxy: dial.Proxy{URL: proxy}}, nil
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

// buildEgressProxy 按账号拼出 egress 入口地址。
//
// 用环境变量而不是另建配置项：出口入口只有一个，账号才是每请求变化的维度。
//
//	OC2API_EGRESS_URL  代理入口，默认 socks5://egress-filter:1080
//	OC2API_EGRESS_USER 代理用户名模板，默认 opencode.{account}
//	OC2API_EGRESS_PASS 代理密码
func buildEgressProxy(host, account string) string {
	entry := strings.TrimSpace(os.Getenv("OC2API_EGRESS_URL"))
	if entry == "" {
		return ""
	}
	parsed, err := url.Parse(entry)
	if err != nil || parsed.Host == "" {
		return ""
	}

	userTemplate := strings.TrimSpace(os.Getenv("OC2API_EGRESS_USER"))
	if userTemplate == "" {
		userTemplate = "opencode.{account}"
	}
	username := strings.ReplaceAll(userTemplate, "{account}", account)
	// 平台前缀已经是约定的一部分，账号里若已带平台就不再重复加。
	if strings.Contains(userTemplate, "{account}") && !strings.Contains(username, ".") {
		username = "opencode." + username
	}

	password := os.Getenv("OC2API_EGRESS_PASS")
	if password == "" {
		parsed.User = url.User(username)
	} else {
		parsed.User = url.UserPassword(username, password)
	}
	return parsed.String()
}
