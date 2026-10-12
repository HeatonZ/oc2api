import assert from "node:assert/strict"
import test from "node:test"

import {
  buildUpstreamRequest,
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
  assert.match(request.headers["User-Agent"], /^opencode\//)
  assert.equal(request.headers.Authorization, "Bearer public")
  assert.equal(request.headers["x-opencode-session"], "ses_test")

  const names = body.tools.map((tool) => tool.function.name)
  assert.ok(names.includes("bash") && names.includes("read"), "缺少 bash/read 会 403")
  assert.equal(body.tool_choice, "none", "无用户工具时必须禁止选中门禁工具")
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
  assert.ok(names.includes("get_weather") && names.includes("bash") && names.includes("read"))
  assert.equal(body.tool_choice, "auto")

  // 用户自带 bash 时不能被门禁版本覆盖
  const custom = { type: "function", function: { name: "bash", description: "mine", parameters: { type: "object" } } }
  const replaced = JSON.parse(
    buildUpstreamRequest({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [custom] }, "ses_x")
      .body,
  )
  assert.equal(replaced.tools.find((tool) => tool.function.name === "bash").function.description, "mine")
  assert.equal(replaced.tools.filter((tool) => tool.function.name === "bash").length, 1)
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
  assert.match(first, /^ses_[0-9a-f]{26}$/)
  assert.equal(getSession(user), first, "同一使用者应复用 session")
  assert.notEqual(getSession("user-b"), first)
})

test("deriveSessionId 把任意种子归一化成上游要求的 ses_<26 位小写 hex>", () => {
  // 上游只接受 ses_ + 恰好 26 位小写 hex；UUID / 25 位 / 大写 hex 均被 403（实测）。
  assert.match(deriveSessionId("gwk_2ca5cd69b10b15e3b0bcbb76"), /^ses_[0-9a-f]{26}$/)
  assert.match(deriveSessionId("550e8400-e29b-41d4-a716-446655440000"), /^ses_[0-9a-f]{26}$/)
  assert.match(deriveSessionId("任意中文会话标识"), /^ses_[0-9a-f]{26}$/)
  assert.equal(deriveSessionId(""), "")
  assert.equal(deriveSessionId(null), "")
  // 已合规的值原样保留，不做二次哈希（避免上游缓存桶漂移）。
  assert.equal(deriveSessionId("ses_0123456789abcdef0123456789"), "ses_0123456789abcdef0123456789")
  // 稳定：同种子同值；隔离：不同种子不同值。
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
  assert.match(withHeader, /^ses_[0-9a-f]{26}$/)
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
  assert.match(resolveSession({}, { messages: [] }, "anonymous"), /^ses_[0-9a-f]{26}$/)
})

test("buildUpstreamRequest 发出的 session 始终符合上游格式", () => {
  for (const seed of ["gwk_abc", "550e8400-e29b-41d4-a716-446655440000", "中文", "ses_0123456789abcdef0123456789"]) {
    const request = buildUpstreamRequest({ model: "big-pickle", messages: [] }, deriveSessionId(seed))
    assert.match(request.headers["x-opencode-session"], /^ses_[0-9a-f]{26}$/)
  }
})

test("门禁工具定义带有禁止调用提示（不把描述当成强制保证）", () => {
  const tool = gateTool("bash")
  assert.equal(tool.type, "function")
  assert.equal(tool.function.name, "bash")
  assert.deepEqual(tool.function.parameters, { type: "object", properties: {} })
  assert.match(tool.function.description, /do not call/i)
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
