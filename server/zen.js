// OpenCode Zen 上游客户端。免费层的硬门槛（均对真实上游逐项验证过）：
//   1. User-Agent 必须形如 opencode/<version>，其他一律 403；
//   2. 必须带 x-opencode-session，且其前 12 位 hex 必须是「倒置毫秒时间戳」
//      ~(BigInt(Date.now()) * 4096n + counter)；格式不符或前缀是随机值一律 403；
//   3. 请求体必须含 bash / read 两个"门禁工具"，缺失即 403；
//   4. stream 必须为 true，stream:false 一律 403。
// 除此之外上游就是标准 OpenAI 协议，本模块只补齐上述条件，业务字段原样透传。
//
// 第 2 条按调用方会话动态取值：入站 x-opencode-session / x-hermes-session-id
// 优先，其次 body 的 prompt_cache_key / metadata.user_id，再次由 system 提示与
// 首条 user 消息内容派生。任何种子都先归一化成上游认可的
// ses_<12 位倒置时间戳><14 位 base62> 再发出——不做归一化直接透传 UUID 会被 403，
// 而用随机 hex / sha256 摘要充当前缀同样会被判为伪造客户端（见 canonicalSessionId）。
import { ocId } from "./shared.js"
import { debugLog } from "./log.js"

const DEFAULT_BASE_URL = "https://opencode.ai"
// Optional shared Zen relay; request Header and BASE_URL remain higher priority.
const ZEN_API_BASE_URL = (process.env.ZEN_API_BASE_URL || "").trim()

export function resolveBaseURL(requestOverride = "") {
  const override = String(requestOverride || "").trim()
  const configured = String(process.env.BASE_URL || "").trim()
  const relay = ZEN_API_BASE_URL
  const value = (override || configured || relay || DEFAULT_BASE_URL).replace(/\/+$/, "")
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("base URL must be a valid http:// or https:// URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base URL must use http:// or https://")
  }
  if (!parsed.host) throw new Error("base URL must include a host")
  return value
}

export function requestBaseURL(request) {
  const headers = request?.headers
  if (typeof headers?.get === "function") return headers.get("x-opencode-base-url")?.trim() || ""
  return headers?.["x-opencode-base-url"]?.trim() || ""
}

export function zenEndpoint(relativePath, requestOverride = "") {
  const base = resolveBaseURL(requestOverride)
  if (base.endsWith("/zen/v1") || base.endsWith("/v1")) return `${base}/${relativePath}`
  return `${base}/zen/v1/${relativePath}`
}

// 上游通过 UA 判断请求是否来自 OpenCode 客户端；版本号对判定无影响（已验证）。
const ZEN_USER_AGENT = "opencode/1.18.31"

// 建立连接与模型列表的超时。注意：响应头之后的读取由 openai.js 的看门狗负责。
const CONNECT_TIMEOUT_MS = Number(process.env.ZEN_CONNECT_TIMEOUT_MS || 60 * 1000)
if (!Number.isFinite(CONNECT_TIMEOUT_MS) || CONNECT_TIMEOUT_MS < 1 || CONNECT_TIMEOUT_MS > 600000) {
  throw new Error("ZEN_CONNECT_TIMEOUT_MS must be between 1 and 600000 milliseconds")
}

// 免费层门禁要求的工具名。只放必需的 bash / read（已验证最小集）。
const GATE_TOOL_NAMES = ["bash", "read"]

// 这些键名在 JS 里有特殊含义，用户塞进请求体没有任何意义，一律不转发给上游。
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"]

const GATE_TOOL_DESCRIPTION =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead."

export function gateTool(name) {
  return {
    type: "function",
    function: {
      name,
      description: GATE_TOOL_DESCRIPTION,
      parameters: { type: "object", properties: {} },
    },
  }
}

// 用户已经自带同名工具时保留用户定义，只补缺失的门禁工具。
function withGateTools(tools) {
  const result = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool === "object") : []
  const present = new Set(result.map((tool) => tool?.function?.name).filter((name) => typeof name === "string"))
  for (const name of GATE_TOOL_NAMES) {
    if (present.has(name)) continue
    result.push(gateTool(name))
    present.add(name)
  }
  return result
}

export function isAllowedModelId(id) {
  return typeof id === "string" && (id === "big-pickle" || id.endsWith("-free"))
}

// 上游只接受流式；下游是否流式由响应层决定，与这里无关。
export function buildUpstreamRequest(payload, sessionId) {
  const body = {
    ...payload,
    tools: withGateTools(payload.tools),
    stream: true,
    stream_options: { include_usage: true },
  }

  // 危险键名不转发：JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，
  // 展开后原样带到上游 body 里（实测不污染本地原型，但没有任何透传价值）。
  for (const key of DANGEROUS_KEYS) delete body[key]

  // 没有任何用户工具时禁止模型选中门禁工具；有用户工具时沿用下游的选择。
  const hasUserTools = Array.isArray(payload.tools) && payload.tools.length > 0
  if (!hasUserTools) body.tool_choice = "none"
  else if (payload.tool_choice != null) body.tool_choice = payload.tool_choice
  else delete body.tool_choice

  // 兼容既有 camelCase 别名；上游和官方 SDK 使用 snake_case，不能只影响本地过滤。
  const reasoningEffort = payload.reasoning_effort ?? payload.reasoningEffort
  delete body.reasoningEffort
  if (reasoningEffort != null && reasoningEffort !== "") body.reasoning_effort = reasoningEffort
  else delete body.reasoning_effort

  if (body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = 32000

  return {
    body: JSON.stringify(body),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": ZEN_USER_AGENT,
      "x-opencode-client": "desktop",
      "x-opencode-request": ocId("msg"),
      "x-opencode-session": sessionId,
    },
  }
}

// 只在建立连接阶段计时；响应头一到就交给调用方，避免把长回答误杀。
export async function fetchUpstream(request, ctx) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), CONNECT_TIMEOUT_MS)
  const started = Date.now()

  try {
    const response = await fetch(request.url || zenEndpoint("chat/completions"), {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    debugLog("[ZEN RES]", {
      requestId: ctx.requestId,
      model: ctx.model,
      status: response.status,
      ms: Date.now() - started,
    })
    return response
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout", { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

let cachedModels = null

export async function listModels(baseURL = "") {
  // 请求级地址不能复用全局 relay 的缓存。
  if (baseURL) return fetchZenModels(baseURL)
  if (cachedModels) return cachedModels
  cachedModels = await fetchZenModels()
  return cachedModels
}

async function fetchZenModels(baseURL = "") {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), CONNECT_TIMEOUT_MS)

  try {
    const response = await fetch(zenEndpoint("models", baseURL), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer public",
        "User-Agent": ZEN_USER_AGENT,
      },
      signal: controller.signal,
    })
    const parsed = await response.json().catch((error) => {
      if (error instanceof SyntaxError) return null
      throw error
    })
    if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}`)
    if (!Array.isArray(parsed?.data)) throw new Error("Invalid model list response")

    const models = parsed.data.filter((item) => isAllowedModelId(item?.id))
    if (!models.length) throw new Error("No allowed models returned from upstream")

    if (!baseURL) cachedModels = models
    return models
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout", { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// 上游对 x-opencode-session 的校验（逐项对照实测得出）：
//   格式：ses_ + 12 位小写 hex + 14 位 base62 字符；UUID、25 位、大写 hex 一律 403。
//   语义：前 12 位 hex 按 ~(BigInt(Date.now()) * 4096n + counter) 截断到 48 位解读，
//         其中低 12 位的 counter 必须落在接受区间内（实测 0~32 通过、64 起 403）。
//         高 36 位（时间戳）实测不被校验，但按官方格式写才安全。
// 随机 hex / sha256 摘要的 counter 是任意值，绝大多数落在区间外，于是被判为非
// OpenCode 客户端并回 403 FreeTierError
// （原文 "OpenCode's free tier can only be used from within OpenCode"）。
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

// 前缀低 12 位编码的 counter。上游只接受 0~32（实测：32 通过、64 起 403），
// 我们固定生成 1。
const SESSION_COUNTER = 1n
const SESSION_COUNTER_MAX = 32n

// 生成上游认可的规范 session：前 12 位是倒置时间戳，后 14 位是 base62 随机数。
// 算法与上游 v2.5.0 的 sessionId() 一致（counter 固定 1，落在实测接受区间 0~32 内）。
// 上游 v2.5.0 已把该生成器命名为 sessionId()，这里沿用其命名以免后续同步再冲突；
// canonicalSessionId 仅作为 fork 侧的别名保留。
export function sessionId(timestamp = Date.now()) {
  // 与上游 descending() 一致：value = ~(timestamp * 0x1000 + counter) 取低 48 位十六进制。
  const value = ~(BigInt(timestamp) * 0x1000n + SESSION_COUNTER)
  let time = ""
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }
  const bytes = new Uint8Array(14)
  crypto.getRandomValues(bytes)
  return "ses_" + time + [...bytes].map((byte) => BASE62_CHARS[byte % 62]).join("")
}

export function canonicalSessionId(timestamp = Date.now()) {
  return sessionId(timestamp)
}

// 反解前 12 位 hex 里的 counter（低 12 位）。上游校验的就是这个值。
function sessionCounter(sessionId) {
  const value = BigInt(`0x${sessionId.slice(4, 16)}`)
  return ~value & 0xffffffffffffn & 0xfffn
}

// 格式对还不够：counter 必须在接受区间内，否则上游同样按伪造客户端 403。
// 所以「透传入站值」的条件是格式与 counter 双合规，否则一律重新生成。
function isUpstreamAcceptedSession(value) {
  return SESSION_ID_PATTERN.test(value) && sessionCounter(value) <= SESSION_COUNTER_MAX
}

// 入站会话标识的读取顺序：显式请求头 → OpenAI 标准 body 字段 → 内容派生。
// 只要调用方（或链路上任意一跳）透传了稳定标识就按会话隔离；全部缺失时退回内容
// 派生，避免所有调用方共用一个 session。
const SESSION_HEADER_NAMES = ["x-opencode-session", "x-hermes-session-id"]

// 种子 → 规范 session 的映射。同一会话复用同一个 session，保证上游的提示词缓存
// 亲和稳定；种子不同则不复用。TTL 取 30 分钟，与原来的按 user 缓存一致。
// 实测上游对时间戳新鲜度很宽松（30 天前与 1 天后的前缀都能通过），因此缓存复用
// 生成的 session 不会因为"变旧"而失效。
const SESSION_TTL_MS = 30 * 60 * 1000
const MAX_SESSION_ENTRIES = 5000
const seedSessions = new Map()

function pruneSeedSessions(now) {
  for (const [key, entry] of seedSessions) {
    if (now - entry.at >= SESSION_TTL_MS) seedSessions.delete(key)
    else break
  }
  while (seedSessions.size > MAX_SESSION_ENTRIES) {
    seedSessions.delete(seedSessions.keys().next().value)
  }
}

// 把任意稳定种子归一化成上游认可的 ses_<12 位倒置时间戳><14 位 base62>。
export function deriveSessionId(seed) {
  const value = String(seed ?? "").trim()
  if (!value) return ""
  // 已经是上游认可的格式且 counter 合法才直接透传；格式对但 counter 非法也会 403，
  // 必须重新生成规范值。
  if (isUpstreamAcceptedSession(value)) return value
  const now = Date.now()
  const existing = seedSessions.get(value)
  if (existing && now - existing.at < SESSION_TTL_MS) {
    existing.at = now
    // 重新插入到末尾，让 Map 的迭代顺序即最近使用顺序。
    seedSessions.delete(value)
    seedSessions.set(value, existing)
    return existing.id
  }
  const id = canonicalSessionId(now)
  seedSessions.set(value, { id, at: now })
  pruneSeedSessions(now)
  return id
}

export function inboundSessionSeed(request, payload) {
  for (const name of SESSION_HEADER_NAMES) {
    const value = readHeader(request, name)
    if (value) return value
  }
  if (!payload || typeof payload !== "object") return ""
  const fromBody = payloadSessionSeed(payload)
  if (fromBody) return fromBody
  return contentSessionSeed(payload.messages)
}

function readHeader(request, name) {
  const headers = request?.headers
  if (typeof headers?.get === "function") return String(headers.get(name) || "").trim()
  return String(headers?.[name] || "").trim()
}

// OpenAI 标准会话字段：Chat Completions 的 prompt_cache_key，
// Anthropic 的 metadata.user_id。两者在本生态里都被当作会话标识
// （Sub2API 的 openCodeSessionIDFromPayload 同源读取）。业务字段原样透传，这里只读不写。
//
// 刻意不读顶层的 user 字段：它是"每个终端用户"而不是"每个会话"，
// 拿它当 session 会让同一用户的所有会话共用同一个上游 session，
// 正是需要避免的跨会话提示词缓存串味。
function payloadSessionSeed(payload) {
  for (const value of [payload.prompt_cache_key, payload.metadata?.user_id]) {
    const seed = String(value ?? "").trim()
    if (seed) return seed
  }
  return ""
}

// 内容派生：同一会话的 system 提示与首条 user 消息稳定不变，不同会话首条 user 不同。
function contentSessionSeed(messages) {
  if (!Array.isArray(messages) || !messages.length) return ""
  const systemParts = []
  let firstUser = ""
  for (const message of messages) {
    const role = message?.role
    if (role === "system" || role === "developer") systemParts.push(stringifyContent(message?.content))
    else if (!firstUser && role === "user") firstUser = stringifyContent(message?.content)
  }
  const seed = `${systemParts.join("\u0000")}\u0001${firstUser}`
  return seed.trim().length > 1 ? seed : ""
}

function stringifyContent(content) {
  if (typeof content === "string") return content
  if (content == null) return ""
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

// 无任何入站标识时的兜底：按使用者缓存一个规范 session，避免所有人共用一个。
// 这里同样必须用 sessionId() —— 随机 hex 会被上游判为伪造客户端并 403。
const userSessions = new Map()

export function resolveSession(request, payload, user) {
  const seed = inboundSessionSeed(request, payload)
  if (seed) return deriveSessionId(seed)
  return getSession(user)
}

export function getSession(user) {
  const now = Date.now()
  const existing = userSessions.get(user)
  if (existing && now - existing.at < SESSION_TTL_MS) {
    existing.at = now
    return existing.id
  }
  const id = sessionId(now)
  userSessions.set(user, { id, at: now })
  return id
}
