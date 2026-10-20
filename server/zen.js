// OpenCode V2 上游客户端。免费层的硬门槛（均对真实上游逐项验证过）：
//   1. User-Agent 必须形如 opencode/<channel>/<version>/<client>，其他一律 403；
//   2. 必须带 x-opencode-session，且其前 12 位 hex 必须是「倒置毫秒时间戳」
//      ~(BigInt(Date.now()) * 4096n + counter)；格式不符或前缀是随机值一律 403；
//   3. 请求体必须含内置 read 门禁工具（名字与参数 schema 保持 V2 read 形态，
//      改名或空 properties 都会被 403）；只带 read 必定放行，缺 read 一律 403；
//   4. stream 必须为 true，stream:false 一律 403；
//   5. 显式 tool_choice:none 也会被 403，改用保留工具描述并在响应层禁止工具调用。
// 除此之外上游就是标准 OpenAI 协议，本模块只补齐上述条件，业务字段原样透传。
// 客户端工具名双向映射（oc2api_ 前缀别名），schema、调用 ID 与工具结果保持不变。
//
// 第 2 条按调用方会话动态取值：入站 x-opencode-session / x-hermes-session-id
// 优先，其次 body 的 prompt_cache_key / metadata.user_id，再次由 system 提示与
// 首条 user 消息内容派生。任何种子都先归一化成上游认可的
// ses_<12 位倒置时间戳><14 位 base62> 再发出——不做归一化直接透传 UUID 会被 403，
// 而用随机 hex / sha256 摘要充当前缀同样会被判为伪造客户端（见 canonicalSessionId）。
//
// fork 定制（上游未吸收，同步时必须重新移植）：
//   a. 可配置上游 base URL，且支持请求级覆盖：
//      X-OpenCode-Base-URL Header > BASE_URL env > ZEN_API_BASE_URL > 默认地址；
//   b. 会话标识按调用方透传的稳定标识派生，而不是按 user 复用（见 resolveSession）。
import { debugLog } from "./log.js"

const DEFAULT_BASE_URL = "https://opencode.ai"
// Optional shared Zen relay; request Header and BASE_URL remain higher priority.
const ZEN_API_BASE_URL = (process.env.ZEN_API_BASE_URL || "").trim()
// V2 把 API 路径从 /zen/v1 换成了 /inference/v1：2026-10-15 实测 /zen/v1 返回
// 403 FreeTierError，同一请求打 /inference/v1 返回 200。两者都当作"已含版本路径"，
// 避免重复拼接。
const ZEN_API_PATH = "/inference/v1"
const VERSION_PATH_SUFFIXES = ["/inference/v1", "/zen/v1", "/v1"]

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
  if (VERSION_PATH_SUFFIXES.some((suffix) => base.endsWith(suffix))) return `${base}/${relativePath}`
  return `${base}${ZEN_API_PATH}/${relativePath}`
}

// 对齐 App.useragent：opencode/<channel>/<version>/<client>。
// 版本号是上游的硬门槛，不是装饰：实测 /inference/v1/chat/completions 用
// opencode/latest/1.17.9/cli 会拿到 426 UpgradeRequired，原文
// "OpenCode 1.18.0 or newer is required to use the free tier"；1.18.0 起放行。
// 2.0.32 是 2026-10-20 opencode2api 对齐的真实客户端版本，直接跟随，
// 避免版本号随上游门槛上移后再次静默失效。
const ZEN_USER_AGENT = "opencode/latest/2.0.32/cli"

// 上游免费层要求的客户端最低版本（426 原文）。仅用于启动自检与日志提示。
export const ZEN_MIN_CLIENT_VERSION = "1.18.0"

// 建立连接与模型列表的超时。注意：响应头之后的读取由 openai.js 的看门狗负责。
const CONNECT_TIMEOUT_MS = Number(process.env.ZEN_CONNECT_TIMEOUT_MS || 60 * 1000)
if (!Number.isFinite(CONNECT_TIMEOUT_MS) || CONNECT_TIMEOUT_MS < 1 || CONNECT_TIMEOUT_MS > 600000) {
  throw new Error("ZEN_CONNECT_TIMEOUT_MS must be between 1 and 600000 milliseconds")
}

// 上游只把 read 当作必需门禁：实测只带 read 必定放行，只带 shell/edit/write/glob 等一律 403。
// 少注入一个门禁就少一个与客户端工具重名的干扰源，所以只保留 read。
const GATE_TOOL_NAMES = ["read"]

// 这些键名在 JS 里有特殊含义，用户塞进请求体没有任何意义，一律不转发给上游。
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"]

// 旧版「禁止调用」描述。上游不校验文案（空描述同样放行），用最直白的旧写法，
// 不再拼 V2 的业务原句，避免和客户端工具的描述混淆模型。
// 现保留为导出的备用文案：自定义门禁工具名时可用，避免调用点再拼字符串。
export const GATE_TOOL_DESCRIPTION =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead."

// 上游 2.0.32 真实 read 的描述与参数文案。与 opencode2api 的 opencode_tools.json
// 逐字对齐：描述只影响模型观感，但保持与真实客户端一致可减少形状差异面。
const GATE_READ_DESCRIPTION =
  "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files."

export function gateTool(name) {
  // 名字和参数 schema 必须保持 V2 read 的形态：改名、空 properties 都会被上游 403。
  // 描述用 2.0.32 的真实文案；参数名与 required 维持实测放行的形态。
  return {
    type: "function",
    function: {
      name,
      description: GATE_READ_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to read" },
          offset: {
            type: "integer",
            minimum: 0,
            description: "The line or directory entry to start reading from (1-based)",
          },
          limit: {
            type: "integer",
            minimum: 0,
            description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: false,
    },
  }
}

export function areToolsDisabled(payload) {
  return payload.tool_choice === "none" || !Array.isArray(payload.tools) || payload.tools.length === 0
}

// 上游还校验 edit 等其它内置工具；只改 read/shell 仍会拒绝完整客户端工具集。
// 所有客户端工具统一使用上游别名，schema、调用 ID 和工具结果保持不变。
function withGateTools(tools) {
  const clientTools = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool === "object") : []
  const present = new Set(clientTools.map((tool) => tool?.function?.name))
  const names = new Map()
  for (const tool of clientTools) {
    const name = tool?.function?.name
    if (typeof name !== "string" || !name || names.has(name)) continue
    const base = `oc2api_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 60)
    let alias = base
    let suffix = 1
    while (present.has(alias)) {
      const tail = `_${suffix++}`
      alias = `${base.slice(0, 64 - tail.length)}${tail}`
    }
    present.add(alias)
    names.set(name, alias)
  }
  const result = clientTools.map((tool) => {
    const renamed = renameToolCall(tool, names)
    if (renamed === tool) return tool
    return {
      ...renamed,
      function: {
        ...renamed.function,
        description: `Client tool "${tool.function.name}"; use "${renamed.function.name}" for the client's "${tool.function.name}" operation. ${tool.function.description || ""}`,
      },
    }
  })
  result.push(...GATE_TOOL_NAMES.map(gateTool))
  return { tools: result, names, aliases: new Map([...names].map(([name, alias]) => [alias, name])) }
}

function renameToolCall(call, names) {
  const name = names.get(call?.function?.name)
  return name ? { ...call, function: { ...call.function, name } } : call
}

function renameToolChoice(choice, names) {
  const renamed = renameToolCall(choice, names)
  if (!Array.isArray(renamed?.tools)) return renamed
  return {
    ...renamed,
    tools: renamed.tools.map((tool) => {
      const next = renameToolCall(tool, names)
      return names.has(next?.name) ? { ...next, name: names.get(next.name) } : next
    }),
  }
}

function renameMessageTools(message, names) {
  let next = message
  if (Array.isArray(message?.tool_calls)) {
    next = { ...next, tool_calls: message.tool_calls.map((call) => renameToolCall(call, names)) }
  }
  const legacyName = names.get(message?.function_call?.name)
  if (legacyName) next = { ...next, function_call: { ...message.function_call, name: legacyName } }
  // 上游对历史消息 role:"tool" 上的 name 支持不一致：GLM 直接 400
  // （`[unsupported_parameter] messages[n]: "name" is not supported`），DeepSeek 则容忍。
  // 该字段在 OpenAI 规范里可选，靠 tool_call_id 已能定位工具结果，
  // 所以一律不发 name：既避开 GLM 的 400，也不改变其它模型的行为。
  if (message?.role === "tool" && next.name !== undefined) {
    next = { ...next }
    delete next.name
  }
  // 老式 role:"function" 消息的 name 是必填（标识被调用的函数），必须保留并改名。
  if (message?.role === "function" && names.has(message.name)) next = { ...next, name: names.get(message.name) }
  return next
}

export function isAllowedModelId(id) {
  return typeof id === "string" && (id === "big-pickle" || id.endsWith("-free"))
}

// 上游只接受流式；下游是否流式由响应层决定，与这里无关。
export function buildUpstreamRequest(payload, sessionId) {
  const toolsDisabled = areToolsDisabled(payload)
  const adapted = withGateTools(toolsDisabled ? [] : payload.tools)
  const body = {
    ...payload,
    tools: adapted.tools,
    stream: true,
    stream_options: { include_usage: true },
  }

  // 危险键名不转发：JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，
  // 展开后原样带到上游 body 里（实测不污染本地原型，但没有任何透传价值）。
  for (const key of DANGEROUS_KEYS) delete body[key]

  // V2 拒绝 none。禁用时不提供用户工具、只留下带禁止调用提示的保留工具，
  // 响应层再拒绝任何工具调用，不能仅靠提示词保证下游的禁用语义。
  if (toolsDisabled || payload.tool_choice == null) delete body.tool_choice
  else body.tool_choice = renameToolChoice(payload.tool_choice, adapted.names)

  // 必须无条件走一遍消息改写：即使没有客户端工具（names 为空），
  // role:"tool" 上的 name 也要剥掉，否则 GLM 会 400。
  body.messages = payload.messages.map((message) => renameMessageTools(message, adapted.names))

  // 兼容既有 camelCase 别名；上游和官方 SDK 使用 snake_case，不能只影响本地过滤。
  const reasoningEffort = payload.reasoning_effort ?? payload.reasoningEffort
  delete body.reasoningEffort
  if (reasoningEffort != null && reasoningEffort !== "") body.reasoning_effort = reasoningEffort
  else delete body.reasoning_effort

  if (body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = 32000

  return {
    body: JSON.stringify(body),
    toolAliases: adapted.aliases,
    reservedToolNames: [...GATE_TOOL_NAMES],
    toolNames: body.tools.map((tool) => tool?.function?.name).filter(Boolean),
    clientToolNames: body.tools
      .map((tool) => tool?.function?.name)
      .filter((name) => name && !GATE_TOOL_NAMES.includes(name)),
    headers: {
      // 真实 2.x CLI 的 fetch 把 Accept 写成两者并列（opencode2api 对齐 2.0.32 后
      // 也是这个形态）；只写 text/event-stream 与真实客户端不一致。
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": ZEN_USER_AGENT,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-session": sessionId,
      "x-opencode-session-id": sessionId,
      "x-session-affinity": sessionId,
      "X-Session-Id": sessionId,
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
