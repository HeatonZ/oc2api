import assert from "node:assert/strict"
import test from "node:test"

import {
  areToolsDisabled,
  buildUpstreamRequest,
  canonicalSessionId,
  deriveSessionId,
  gateTool,
  getSession,
  inboundSessionSeed,
  isAllowedModelId,
  resolveSession,
} from "../../server/zen.js"

test("免费层必要条件：UA、session、门禁工具、强制流式", () => {
  const request = buildUpstreamRequest({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }, "ses_test")
  const body = JSON.parse(request.body)

  assert.equal(body.stream, true, "stream:false 会被上游 403，必须强制 true")
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(request.headers["User-Agent"], "opencode/latest/2.0.29/cli")
  assert.equal(request.headers.Authorization, "Bearer public")
  assert.equal(request.headers["x-opencode-client"], "cli")
  assert.equal(request.headers["x-opencode-project"], "global")
  assert.equal(request.headers["x-opencode-request"], undefined, "V2 不发送旧版非标准 request ID，会导致 403")
  for (const header of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "X-Session-Id"]) {
    assert.equal(request.headers[header], "ses_test", `${header} 必须复用同一会话`)
  }

  const names = body.tools.map((tool) => tool.function.name)
  assert.deepEqual(names, ["shell", "read"], "V2 使用 shell/read 而不是 bash/read")
  assert.equal(body.tool_choice, undefined, "V2 不接受显式 none，禁用语义由响应层强制执行")
})

test("业务字段原样透传，只有门禁相关字段被补齐", () => {
  const payload = {
    model: "mimo-v2.6-flash-free",
    messages: [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ],
    temperature: 0.3,
    top_p: 0.9,
    stop: ["\n"],
    max_tokens: 128,
    response_format: { type: "json_object" },
  }
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)

  assert.deepEqual(body.messages, payload.messages)
  assert.equal(body.temperature, 0.3)
  assert.equal(body.top_p, 0.9)
  assert.deepEqual(body.stop, ["\n"])
  assert.equal(body.max_tokens, 128)
  assert.deepEqual(body.response_format, { type: "json_object" })
  assert.equal(body.model, "mimo-v2.6-flash-free")
})

test("危险键名不转发给上游，同时不影响正常字段", () => {
  // JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，展开后会原样进 body。
  // 实测不会污染本地原型，但这类字段没有任何透传价值，一律剥掉。
  const payload = JSON.parse(
    '{"model":"big-pickle","messages":[],"temperature":0.5,' +
      '"__proto__":{"polluted":"yes"},"constructor":{"x":1},"prototype":{"y":2}}',
  )
  const raw = buildUpstreamRequest(payload, "ses_x").body
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.ok(!raw.includes(`"${key}"`), `${key} 不应出现在上游 body 里`)
  }
  const body = JSON.parse(raw)
  assert.equal(body.temperature, 0.5, "正常字段必须保留")
  assert.equal(body.model, "big-pickle")
  assert.equal(Object.prototype.polluted, undefined, "本地原型不能被污染")
})

test("用户自带工具时保留用户定义，并沿用用户的 tool_choice", () => {
  const weather = { type: "function", function: { name: "get_weather", parameters: { type: "object" } } }
  const body = JSON.parse(
    buildUpstreamRequest(
      { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [weather], tool_choice: "auto" },
      "ses_x",
    ).body,
  )
  const names = body.tools.map((tool) => tool.function.name)
  assert.ok(names.includes("oc2api_get_weather") && names.includes("shell") && names.includes("read"))
  assert.equal(body.tool_choice, "auto")

  // 同名客户端工具通过别名保留，不再占用或被覆盖成门禁定义。
  const custom = { type: "function", function: { name: "shell", description: "mine", parameters: { type: "object" } } }
  const request = buildUpstreamRequest(
    { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [custom] },
    "ses_x",
  )
  const replaced = JSON.parse(request.body)
  const clientShell = replaced.tools.find((tool) => tool.function.name === "oc2api_shell")
  assert.match(clientShell.function.description, /mine/)
  assert.deepEqual(clientShell.function.parameters, custom.function.parameters)
  assert.equal(request.toolAliases.get("oc2api_shell"), "shell")
  assert.deepEqual(
    replaced.tools.find((tool) => tool.function.name === "shell"),
    gateTool("shell"),
  )
  assert.equal(replaced.tools.filter((tool) => tool.function.name === "shell").length, 1)
})

test("同名 read/shell 保留客户端 schema，别名不撞已有工具，历史与指定选择同步映射", () => {
  const read = Object.freeze({
    type: "function",
    function: Object.freeze({
      name: "read",
      description: "Read client file",
      strict: true,
      parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    }),
  })
  const shell = {
    type: "function",
    function: { name: "shell", parameters: { type: "object", properties: { script: { type: "string" } } } },
  }
  const existing = ["oc2api_read", "oc2api_read_1"].map((name) => ({
    type: "function",
    function: { name, parameters: { type: "object" } },
  }))
  const payload = {
    model: "big-pickle",
    messages: [
      { role: "user", content: "Use read and shell" },
      {
        role: "assistant",
        tool_calls: [
          { id: "A", type: "function", function: { name: "read", arguments: '{"file_path":"README.md"}' } },
          { id: "B", type: "function", function: { name: "shell", arguments: '{"script":"echo OK"}' } },
        ],
      },
      { role: "tool", tool_call_id: "A", content: "file content" },
      { role: "tool", tool_call_id: "B", content: "OK" },
      { role: "assistant", function_call: { name: "read", arguments: '{"file_path":"README.md"}' } },
      { role: "function", name: "read", content: "legacy result" },
    ],
    tools: [read, shell, ...existing],
    tool_choice: { type: "function", function: { name: "read" } },
  }
  const snapshot = JSON.stringify(payload)
  const request = buildUpstreamRequest(payload, "ses_x")
  const body = JSON.parse(request.body)
  assert.deepEqual(Object.fromEntries(request.toolAliases), {
    oc2api_shell: "shell",
    oc2api_read_2: "read",
    oc2api_oc2api_read: "oc2api_read",
    oc2api_oc2api_read_1: "oc2api_read_1",
  })
  assert.equal(new Set(body.tools.map((tool) => tool.function.name)).size, body.tools.length)
  assert.deepEqual(
    body.tools.find((tool) => tool.function.name === "oc2api_read_2").function.parameters,
    read.function.parameters,
  )
  assert.equal(body.tools.find((tool) => tool.function.name === "oc2api_read_2").function.strict, true)
  assert.deepEqual(
    body.tools.find((tool) => tool.function.name === "read"),
    gateTool("read"),
  )
  assert.deepEqual(
    body.tools.find((tool) => tool.function.name === "shell"),
    gateTool("shell"),
  )
  assert.equal(body.tool_choice.function.name, "oc2api_read_2")
  assert.deepEqual(
    body.messages[1].tool_calls.map((call) => call.function.name),
    ["oc2api_read_2", "oc2api_shell"],
  )
  assert.deepEqual(
    body.messages[1].tool_calls.map((call) => call.id),
    ["A", "B"],
  )
  assert.deepEqual(body.messages.slice(2, 4), payload.messages.slice(2, 4))
  assert.equal(body.messages[4].function_call.name, "oc2api_read_2")
  assert.equal(body.messages[5].name, "oc2api_read_2")
  assert.equal(JSON.stringify(payload), snapshot, "不能修改调用者的定义、历史或参数")
  assert.ok(request.clientToolNames.includes("oc2api_oc2api_read"))
  assert.ok(!request.clientToolNames.includes("read"))
})

test("所有客户端工具包括 edit/write 都隔离，允许列表选择与长名字保持合法映射", () => {
  const longA = "a".repeat(64)
  const longB = "a".repeat(63) + "b"
  const names = ["read", "shell", "edit", "write", "glob", "grep", "get_weather", longA, longB]
  const tools = names.map((name) => ({
    type: "function",
    function: {
      name,
      description: "Client definition",
      parameters: { type: "object", properties: { file_path: { type: "string" } } },
    },
  }))
  const payload = {
    model: "big-pickle",
    messages: [],
    tools,
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [
        { type: "function", name: "edit" },
        { type: "function", function: { name: "write" } },
      ],
    },
  }
  const request = buildUpstreamRequest(payload, "ses_x")
  const body = JSON.parse(request.body)
  assert.equal(request.toolAliases.size, names.length)
  assert.equal(new Set(body.tools.map((tool) => tool.function.name)).size, body.tools.length)
  for (const tool of body.tools.slice(0, tools.length)) {
    assert.match(tool.function.name, /^[A-Za-z0-9_-]{1,64}$/)
    const original = request.toolAliases.get(tool.function.name)
    assert.ok(names.includes(original))
    assert.notEqual(tool.function.name, original)
    assert.deepEqual(
      tool.function.parameters,
      tools.find((source) => source.function.name === original).function.parameters,
    )
  }
  assert.equal(body.tool_choice.tools[0].name, "oc2api_edit")
  assert.equal(body.tool_choice.tools[1].function.name, "oc2api_write")
  assert.equal(body.tool_choice.mode, "auto")
  assert.deepEqual(body.tools.slice(-2), [gateTool("shell"), gateTool("read")])
})

test("max_tokens 缺省时才补默认值，用户显式传 0 之外的值不覆盖", () => {
  const explicit = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [], max_tokens: 7 }, "ses_x").body)
  assert.equal(explicit.max_tokens, 7)

  const fallback = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [] }, "ses_x").body)
  assert.equal(fallback.max_tokens, 32000)

  const completion = JSON.parse(
    buildUpstreamRequest({ model: "big-pickle", messages: [], max_completion_tokens: 9 }, "ses_x").body,
  )
  assert.equal(completion.max_completion_tokens, 9)
  assert.equal(completion.max_tokens, undefined, "已有 max_completion_tokens 时不应再补 max_tokens")
})

test("模型白名单只放行 big-pickle 与 -free 结尾", () => {
  assert.equal(isAllowedModelId("big-pickle"), true)
  assert.equal(isAllowedModelId("mimo-v2.6-flash-free"), true)
  assert.equal(isAllowedModelId("gpt-6-astra"), false)
  assert.equal(isAllowedModelId("-free"), true)
  assert.equal(isAllowedModelId(""), false)
  assert.equal(isAllowedModelId(null), false)
})

test("session 符合上游格式且同一使用者复用直到过期", () => {
  const user = "user-a"
  const first = getSession(user)
  // 上游只认这种形状：ses_ + 12 位十六进制 + 14 位 base62，共 30 字符
  assert.match(first, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(first.length, 30)
  assert.equal(getSession(user), first, "同一使用者应复用 session")
  assert.notEqual(getSession("user-b"), first)
})

// 上游解析前 12 位 hex 为 ~(BigInt(Date.now()) * 4096n + counter) 截断到 48 位，
// 并校验其中的 counter（低 12 位）落在接受区间内；高 36 位（时间戳）实测不被校验。
// 随机 hex / sha256 摘要的低 12 位是任意值，绝大多数落在区间外，于是被判为非
// OpenCode 客户端并回 403 FreeTierError。实测对照：规范前缀 200，随机 hex 与
// sha256 派生 403；counter 0~32 通过、64 起 403。这里按上游算法反解 counter 校验。
const MASK48 = (1n << 48n) - 1n
const MAX_ACCEPTED_COUNTER = 32n

function decodeCounter(sessionId) {
  const value = BigInt(`0x${sessionId.slice(4, 16)}`)
  return ~value & MASK48 & 0xfffn
}

test("session 前缀编码的是上游认可的倒置时间戳", () => {
  const before = BigInt(Date.now())
  const id = canonicalSessionId()
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "必须是 ses_ + 12 位 hex + 14 位 base62")
  const after = BigInt(Date.now())
  // 高 36 位是时间戳：可反解回当前时间（按 2^36 取模）。
  const decoded = ((~BigInt(`0x${id.slice(4, 16)}`) & MASK48) >> 12n) + (before & ~((1n << 36n) - 1n))
  assert.ok(
    decoded >= before - 4096n && decoded <= after + 4096n,
    `前缀高 36 位应解码为当前毫秒时间戳，实际 ${decoded}（期望 ${before}~${after}）`,
  )
  // 低 12 位是 counter，必须落在上游接受的区间内——这是通过校验的关键。
  const counter = decodeCounter(id)
  assert.ok(counter <= MAX_ACCEPTED_COUNTER, `counter 必须 <= ${MAX_ACCEPTED_COUNTER}，实际 ${counter}`)
})

test("deriveSessionId 把任意种子归一化成上游认可的 session", () => {
  // 必须同时满足：格式正确 + 前缀编码了倒置时间戳。随机 hex 会被上游 403（实测）。
  for (const seed of ["gwk_2ca5cd69b10b15e3b0bcbb76", "550e8400-e29b-41d4-a716-446655440000", "任意中文会话标识"]) {
    const id = deriveSessionId(seed)
    assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.ok(decodeCounter(id) <= MAX_ACCEPTED_COUNTER, "前缀 counter 必须落在上游接受区间内")
  }
  assert.equal(deriveSessionId(""), "")
  assert.equal(deriveSessionId(null), "")
  // 已合规（格式 + counter 都在上游接受区间内）的值原样保留，不做二次哈希。
  const canonical = "ses_ecc41b777ffe" + "a".repeat(14)
  assert.equal(deriveSessionId(canonical), canonical)
  // 格式对但 counter 落在区间外（0x654 > 32）的值不能透传，必须重新生成。
  assert.notEqual(deriveSessionId("ses_0123456789abcdef0123456789"), "ses_0123456789abcdef0123456789")
  assert.ok(decodeCounter(deriveSessionId("ses_0123456789abcdef0123456789")) <= MAX_ACCEPTED_COUNTER)
  // 稳定：同种子复用同一 session（保证上游提示词缓存亲和）；隔离：不同种子不同值。
  assert.equal(deriveSessionId("conv-a"), deriveSessionId("conv-a"))
  assert.notEqual(deriveSessionId("conv-a"), deriveSessionId("conv-b"))
})

test("inboundSessionSeed 优先级：请求头 → body 字段 → 内容派生", () => {
  const headers = new Map([["x-opencode-session", "ses_from_header_00000000000000"]])
  const request = { headers: { get: (k) => headers.get(k) } }
  const payload = { prompt_cache_key: "pck-from-body", messages: [{ role: "user", content: "hi" }] }
  assert.equal(inboundSessionSeed(request, payload), "ses_from_header_00000000000000")

  // 无头时读 body 的 prompt_cache_key。
  assert.equal(inboundSessionSeed({}, payload), "pck-from-body")
  // metadata.user_id（Anthropic 风格）次之。
  assert.equal(inboundSessionSeed({}, { metadata: { user_id: "meta-user" } }), "meta-user")
  // 都没有时按内容派生。
  const seed = inboundSessionSeed({}, { messages: [{ role: "user", content: "unique-first-turn" }] })
  assert.match(seed, /unique-first-turn/)

  // 顶层 user 不参与：它是"每个用户"而不是"每个会话"。
  const onlyUser = { user: "terminal-user-1", messages: [{ role: "user", content: "x" }] }
  assert.equal(payloadSessionSeedIsNotUser(onlyUser), true)
})

function payloadSessionSeedIsNotUser(payload) {
  // 同一 user 的两条不同会话必须得到不同 seed。
  const a = inboundSessionSeed({}, { ...payload, messages: [{ role: "user", content: "turn-A" }] })
  const b = inboundSessionSeed({}, { ...payload, messages: [{ role: "user", content: "turn-B" }] })
  return a !== b && a !== "terminal-user-1" && b !== "terminal-user-1"
}

test("resolveSession：有入站标识按会话隔离，无标识才退回按 user 缓存", () => {
  const payload = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
    ],
  }
  const headers = new Map([["x-hermes-session-id", "gwk_2ca5cd69b10b15e3b0bcbb76"]])
  const withHeader = resolveSession({ headers: { get: (k) => headers.get(k) } }, payload, "anonymous")
  assert.match(withHeader, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  // 同一会话跨轮稳定。
  assert.equal(resolveSession({ headers: { get: (k) => headers.get(k) } }, payload, "anonymous"), withHeader)

  // 不同会话必须不同（这正是修复前的缺陷：全部共用一个 session）。
  const other = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "different" },
    ],
  }
  assert.notEqual(resolveSession({}, other, "anonymous"), resolveSession({}, payload, "anonymous"))

  // 完全无信号时退回按 user 缓存，保持旧行为可用。
  assert.match(resolveSession({}, { messages: [] }, "anonymous"), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test("buildUpstreamRequest 发出的 session 始终符合上游格式", () => {
  for (const seed of ["gwk_abc", "550e8400-e29b-41d4-a716-446655440000", "中文", "ses_0123456789abcdef0123456789"]) {
    const request = buildUpstreamRequest({ model: "big-pickle", messages: [] }, deriveSessionId(seed))
    const session = request.headers["x-opencode-session"]
    assert.match(session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    // 前缀必须编码出上游接受区间内的 counter，否则按伪造客户端 403（实测）。
    assert.ok(decodeCounter(session) <= MAX_ACCEPTED_COUNTER)
  }
})

test("V2 门禁工具保留官方描述前缀、参数 schema 和禁止调用提示", () => {
  for (const [name, required, prefix] of [
    ["shell", "command", "Execute a shell command and return its output."],
    ["read", "path", "Read the contents of a file or directory."],
  ]) {
    const tool = gateTool(name)
    assert.equal(tool.type, "function")
    assert.equal(tool.function.name, name)
    assert.ok(tool.function.description.startsWith(prefix))
    assert.match(tool.function.description, /do not call/i)
    assert.equal(tool.function.parameters.properties[required].type, "string")
    assert.deepEqual(tool.function.parameters.required, [required])
    assert.equal(tool.function.parameters.additionalProperties, false)
    assert.equal(tool.function.strict, false)
  }
  assert.equal(gateTool("shell").function.parameters.properties.background.type, "boolean")
  assert.equal(gateTool("read").function.parameters.properties.offset.minimum, 0)
})

test("禁用工具时不透传 none 或用户工具，也不修改用户消息", () => {
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }]
  for (const input of [{}, { tools: [] }, { tools, tool_choice: "none" }]) {
    const payload = { model: "big-pickle", messages: [{ role: "user", content: "hi" }], ...input }
    const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
    assert.equal(areToolsDisabled(payload), true)
    assert.equal(body.tool_choice, undefined)
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name),
      ["shell", "read"],
    )
    assert.deepEqual(body.messages, payload.messages)
  }
  for (const choice of [undefined, "auto", "required", { type: "function", function: { name: "weather" } }]) {
    const payload = { model: "big-pickle", messages: [], tools, tool_choice: choice }
    assert.equal(areToolsDisabled(payload), false)
    const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
    assert.equal(body.tools[0].function.name, "oc2api_weather")
    assert.deepEqual(body.tools[0].function.parameters, tools[0].function.parameters)
    assert.deepEqual(
      body.tool_choice,
      typeof choice === "object" ? { ...choice, function: { name: "oc2api_weather" } } : choice,
    )
  }
})

test("reasoningEffort 别名恢复上游 snake_case，snake_case 优先", () => {
  for (const [input, expected] of [
    [{ reasoningEffort: "none" }, "none"],
    [{ reasoningEffort: "high" }, "high"],
    [{ reasoning_effort: "low", reasoningEffort: "high" }, "low"],
    [{ reasoning_effort: null, reasoningEffort: "medium" }, "medium"],
    [{ reasoning_effort: "" }, undefined],
    [{}, undefined],
  ]) {
    const body = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [], ...input }, "ses_x").body)
    assert.equal(body.reasoning_effort, expected)
    assert.equal(body.reasoningEffort, undefined)
  }
})

test("session 滑动过期：活跃时复用，空闲满 30 分钟换新", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1 })
  const first = getSession("expiry-test")
  t.mock.timers.tick(29 * 60 * 1000)
  assert.equal(getSession("expiry-test"), first)
  t.mock.timers.tick(29 * 60 * 1000)
  assert.equal(getSession("expiry-test"), first, "按空闲时间而不是创建时间过期")
  t.mock.timers.tick(30 * 60 * 1000)
  assert.notEqual(getSession("expiry-test"), first)
})

test("buildUpstreamRequest 不修改用户工具、消息或参数原对象", () => {
  const weather = Object.freeze({
    type: "function",
    function: Object.freeze({ name: "weather", parameters: { type: "object" } }),
  })
  const payload = Object.freeze({
    model: "big-pickle",
    tools: Object.freeze([weather]),
    messages: Object.freeze([{ role: "user", content: "hi" }]),
    max_tokens: 0,
  })
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
  assert.equal(payload.tools.length, 1)
  assert.equal(body.tools.length, 3)
  assert.equal(body.max_tokens, 0)
  assert.deepEqual(body.messages, payload.messages)
})
