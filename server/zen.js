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
import { createHash } from "node:crypto"

import { debugLog } from "./log.js"

const DEFAULT_BASE_URL = "https://opencode.ai"
// Optional shared Zen relay; request Header and BASE_URL remain higher priority.
const ZEN_API_BASE_URL = (process.env.ZEN_API_BASE_URL || "").trim()
// V2 把 API 路径从 /zen/v1 换成了 /inference/v1：2026-10-15 实测 /zen/v1 返回
// 403 FreeTierError，同一请求打 /inference/v1 返回 200。两者都当作"已含版本路径"，
// 避免重复拼接。
const ZEN_API_PATH = "/inference/v1"
const VERSION_PATH_SUFFIXES = ["/inference/v1", "/zen/v1", "/v1"]

export function normalizeZenBase(raw) {
  const base = String(raw || "")
    .trim()
    .replace(/\/+$/, "")
  let url
  try {
    url = new URL(base)
  } catch {
    return base
  }
  if (url.hostname !== "opencode.ai" && !url.hostname.endsWith(".opencode.ai")) return base
  const rest = url.pathname.replace(/^\/zen(?=\/|$)/, "")
  // /zen/go 是付费 Go 网关，和免费层无关，不改写。
  if (rest === url.pathname || rest === "/go" || rest.startsWith("/go/")) return base
  url.pathname = `/inference${rest}`
  return url.toString().replace(/\/+$/, "")
}

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
  // opencode.ai 上的 /zen* 改写到 /inference；resin 路径反代/自建中继原样保留。
  return normalizeZenBase(value)
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

// 供诊断端点展示，避免部署后无法确认实际打到了哪个上游。
export const zenBaseUrl = ZEN_API_BASE_URL

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
// OpenCode 客户端并回 403 FreeTierError。
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
// 同一个毫秒内允许创建的 id 数；取反后低 12 位必须落在 [0xFF0, 0xFFF]。
const MAX_PER_MILLISECOND = 16

let lastMillisecond = 0
let counterInMillisecond = 0

// 生成上游认可的规范 session：前 12 位是倒置时间戳，后 14 位是 base62 随机数。
// 算法与上游 v3.0.0 的 sessionId() 一致（同毫秒内 counter 递增，落在接受区间 0~32 内）。
// 上游 v2.5.0 已把该生成器命名为 sessionId()，这里沿用其命名以免后续同步再冲突；
// canonicalSessionId 仅作为 fork 侧的别名保留。
export function sessionId(timestamp = Date.now()) {
  if (timestamp !== lastMillisecond) {
    lastMillisecond = timestamp
    counterInMillisecond = 0
  }
  const counter = counterInMillisecond++ % MAX_PER_MILLISECOND
  // 与上游 descending() 一致：value = ~(timestamp * 0x1000 + counter) 取低 48 位十六进制。
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(counter))
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

// 会话粒度必须是「一段对话」而不是「一个使用者」：上游按 x-opencode-session 把回合
// 落到同一台后端，prompt cache 也只按这个 id 命中。所以这里按「使用者 + 对话种子」
// 缓存，两段并行对话不会互相顶掉缓存（上游 v3.0.0 的做法，fork 沿用同一思路）。

// 判断一个 id 是不是 OpenCode 真的可能生成出来的：形状对，且低 12 位是取反后的小序号。
// 客户端塞进来的哈希截断或随便拼的字符串都会被上游 403。
export function isRealSessionId(id) {
  if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) return false
  const low = Number.parseInt(id.slice(13, 16), 16)
  return Number.isInteger(low) && 0xfff - low < MAX_PER_MILLISECOND
}

// 入站会话标识的读取顺序：显式请求头 → OpenAI 标准 body 字段 → 内容派生。
// 保留这个导出是为了兼容 fork 既有调用点与测试；新代码用 sessionSeed()。
export function inboundSessionSeed(request, payload) {
  for (const name of ["x-opencode-session", "x-hermes-session-id"]) {
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
  const seed = `${systemParts.join(" ")}${firstUser}`
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

// 一段对话的种子。优先级从「调用方明确指定」到「从内容推断」：
//   1. 客户端自己带的合法 x-opencode-session —— OpenCode / Claude Code 等会带；
//   2. 调用方给的会话标识头（x-session-affinity、X-Session-Id、conversation-id，
//      以及 Sub2API 边车可能注入的 x-hermes-session-id）；
//   3. body 的 prompt_cache_key / metadata.user_id（Codex 的 thread、Anthropic 的 user_id）；
//   4. system + 首条 user 内容派生 —— 多轮对话里它比末条稳定。
// 不同来源加不同前缀，避免「客户端 id 恰好等于某个会话头」时被合并。
export function sessionSeed(request, payload) {
  for (const name of ["x-opencode-session", "x-opencode-session-id"]) {
    const value = readHeader(request, name)
    if (isRealSessionId(value)) return value
  }
  for (const name of ["x-hermes-session-id", "x-session-affinity", "x-session-id", "conversation-id"]) {
    const value = readHeader(request, name)
    if (value) return `header:${value.slice(0, 200)}`
  }
  const fromBody = payload && typeof payload === "object" ? payloadSessionSeed(payload) : ""
  if (fromBody) return `cache:${fromBody.slice(0, 200)}`
  const fromContent = contentSessionSeed(payload?.messages)
  if (fromContent) return `first:${createHash("sha256").update(fromContent).digest("hex")}`
  return ""
}

// 对外入口：按「使用者 + 这段对话」取 session。
// 使用者参与 seed，否则两个调用方首句相同就会共用同一份上游缓存；
// 调用方自己给了合规 id 时原样沿用（不能被我们改掉）。
export function sessionFor(user, request, payload) {
  const seed = sessionSeed(request, payload)
  if (isRealSessionId(seed)) return seed
  return getSession(`${user || "anonymous"} ${seed}`)
}

// 兼容 fork 原有调用点（handler 用 resolveSession）。
export function resolveSession(request, payload, user) {
  return sessionFor(user, request, payload)
}

// 种子 → 规范 session 的映射。同一会话复用同一个 session，保证上游提示词缓存亲和稳定。
// TTL 30 分钟；实测上游对时间戳新鲜度很宽松（30 天前与 1 天后都能通过），
// 所以缓存复用不会因为"变旧"而失效。
const SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_CACHE_LIMIT = 1000
const sessions = new Map()

// 种子已经是合规 id 时直接沿用；否则生成一个并记住。
export function getSession(seed) {
  const key = String(seed ?? "").trim()
  if (!key) return ""
  if (isRealSessionId(key)) return key

  const now = Date.now()
  const existing = sessions.get(key)
  if (existing) {
    // 重新插入，让 Map 的迭代顺序成为最近使用顺序。
    sessions.delete(key)
    if (now - existing.at >= SESSION_TTL_MS) return remember(key, sessionId(now), now)
    existing.at = now
    sessions.set(key, existing)
    return existing.id
  }
  return remember(key, sessionId(now), now)
}

// 兼容 fork 原有调用点：把任意种子归一化成合规 id。
export function deriveSessionId(seed) {
  return getSession(seed)
}

function remember(seed, id, at) {
  sessions.set(seed, { id, at })
  while (sessions.size > SESSION_CACHE_LIMIT) {
    sessions.delete(sessions.keys().next().value)
  }
  return id
}
