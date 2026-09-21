import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { once } from "node:events"
import test from "node:test"

import vercelApp from "../../api/index.js"
import localApp from "../../server/index.js"
import app, { __test } from "../../server/app.js"

const CUSTOM_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
}

test("local and Vercel entries export the same Express app", () => {
  assert.strictEqual(localApp, app)
  assert.strictEqual(vercelApp, app)
})

test("health and OPTIONS responses work through the Express app", async (t) => {
  const server = await listen(app)
  t.after(() => close(server))

  const health = await request(server.url, { path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.text).status, "ok")
  assert.equal(health.headers["access-control-allow-origin"], "*")
  assert.equal(health.headers["x-powered-by"], undefined)

  const options = await request(server.url, {
    method: "OPTIONS",
    path: "/v1/chat/completions",
  })
  assert.equal(options.status, 204)
  assert.equal(options.headers["access-control-allow-methods"], "GET, POST, OPTIONS")
})

test("invalid JSON returns an OpenAI error instead of Express HTML", async (t) => {
  const previousApiKey = process.env.API_KEY
  delete process.env.API_KEY
  const server = await listen(app)
  t.after(() => {
    close(server)
    restoreEnv("API_KEY", previousApiKey)
  })

  const response = await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: "{",
  })

  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.text), {
    error: { message: "Invalid JSON body", type: "invalid_request_error" },
  })
})

test("API key authentication rejects missing and wrong keys with 401", async (t) => {
  const previousApiKey = process.env.API_KEY
  const previousFetch = globalThis.fetch
  process.env.API_KEY = "sk-test"
  globalThis.fetch = async () =>
    new Response(mockSSEBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  const server = await listen(app)
  t.after(() => {
    close(server)
    restoreEnv("API_KEY", previousApiKey)
    globalThis.fetch = previousFetch
  })

  const payload = {
    method: "POST",
    path: "/v1/chat/completions",
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      stream: false,
    }),
  }

  const noAuth = await request(server.url, {
    ...payload,
    headers: { "content-type": "application/json" },
  })
  assert.equal(noAuth.status, 401)
  assert.deepEqual(JSON.parse(noAuth.text), {
    error: { message: "Invalid API key", type: "authentication_error" },
  })

  const wrongKey = await request(server.url, {
    ...payload,
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
  })
  assert.equal(wrongKey.status, 401)

  const validKey = await request(server.url, {
    ...payload,
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
  })
  assert.equal(validKey.status, 200)
})

test("normalizers apply the same content rules to every model", () => {
  const normalizer = __test.createOpenAIStreamNormalizer("custom-model")
  const normalized = normalizer.normalize({
    choices: [
      {
        index: 0,
        delta: {
          content: "<think>hidden</think>hi",
          reasoning: "trace",
          reasoning_content: "legacy",
        },
      },
    ],
  })

  assert.equal(normalized.model, "custom-model")
  assert.equal(normalized.choices[0].delta.content, "hi")
  assert.equal(normalized.choices[0].delta.reasoning_content, undefined)
  assert.equal(normalized.choices[0].delta.reasoning, undefined)

  const request = __test.buildZenRequest(
    "custom-model",
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }],
    true,
    null,
    null,
    "low",
    "ses_test",
    32,
    0.7,
  )
  const body = JSON.parse(request.body)
  assert.equal(body.reasoning_effort, "low")
  assert.equal(body.temperature, 0.7)
  assert.equal(body.messages[0].content[0].type, "image_url")
})

test("non-stream and stream requests share the same upstream business path", async (t) => {
  const previousFetch = globalThis.fetch
  const previousApiKey = process.env.API_KEY
  const calls = []
  delete process.env.API_KEY
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(mockSSEBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }

  const server = await listen(app)
  t.after(() => {
    close(server)
    globalThis.fetch = previousFetch
    restoreEnv("API_KEY", previousApiKey)
  })

  const basePayload = {
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 32,
  }
  const nonStream = await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...basePayload,
      stream: false,
      tools: [CUSTOM_TOOL],
      tool_choice: "none",
    }),
  })
  assert.equal(nonStream.status, 200)
  assert.match(nonStream.headers["x-request-id"] || "", /^req_/)
  assert.match(nonStream.headers["access-control-expose-headers"] || "", /x-request-id/i)
  const completion = JSON.parse(nonStream.text)
  assert.equal(completion.model, "big-pickle")
  assert.equal(completion.choices[0].message.content, "hi")
  assert.equal(completion.choices[0].message.reasoning, undefined)
  assert.equal(completion.choices[0].message.reasoning_content, undefined)

  const upstreamBody = JSON.parse(calls[0].init.body)
  assert.equal(upstreamBody.model, "big-pickle")
  assert.equal(upstreamBody.stream, true)
  assert.equal(upstreamBody.tool_choice, "none")
  assert.ok(upstreamBody.tools.some((tool) => tool.function?.name === "get_weather"))

  const stream = await request(server.url, {
    method: "POST",
    path: "/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...basePayload, stream: true }),
  })
  assert.equal(stream.status, 200)
  assert.match(stream.headers["content-type"], /text\/event-stream/)
  assert.match(stream.text, /data:/)
  assert.match(stream.text, /\[DONE\]/)
  assert.equal(calls.length, 2)
})

function mockSSEBody() {
  return [
    `data: ${JSON.stringify({ id: "chatcmpl-test", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "<think>hidden</think>hi", reasoning: "trace", reasoning_content: "legacy" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
}

async function listen(handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

async function close({ server }) {
  if (!server.listening) return
  server.close()
  await once(server, "close")
}

function request(baseURL, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseURL)
    const requestHeaders = { ...headers }
    if (body !== undefined) requestHeaders["content-length"] = Buffer.byteLength(body)
    const outgoing = httpRequest(url, { method, headers: requestHeaders }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      )
    })
    outgoing.on("error", reject)
    if (body !== undefined) outgoing.write(body)
    outgoing.end()
  })
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

test("resolveBaseURL falls back to env BASE_URL and default, validates scheme and host", () => {
  const previousBaseUrl = process.env.BASE_URL
  try {
    delete process.env.BASE_URL
    assert.equal(__test.resolveBaseURL(""), "https://opencode.ai")
    assert.equal(__test.resolveBaseURL("https://mirror.example.com"), "https://mirror.example.com")
    assert.equal(__test.resolveBaseURL("https://fake.resin.local/v1"), "https://fake.resin.local/v1")

    process.env.BASE_URL = "https://deploy.example.com"
    assert.equal(__test.resolveBaseURL(""), "https://deploy.example.com")
    // 请求级 override 优先于部署级
    assert.equal(__test.resolveBaseURL("https://req.example.net"), "https://req.example.net")

    assert.throws(() => __test.resolveBaseURL("ftp://bad.example.com"), /must use http:\/\/ or https:\/\//)
    assert.throws(() => __test.resolveBaseURL("not-a-url"), /must be a valid http:\/\/ or https:\/\/ URL/)
  } finally {
    restoreEnv("BASE_URL", previousBaseUrl)
  }
})

test("requestBaseURL reads only the request header", () => {
  const withHeader = new Request("http://localhost/v1/models", {
    headers: { "x-opencode-base-url": "https://header.example.com" },
  })
  assert.equal(__test.requestBaseURL(withHeader), "https://header.example.com")

  const withQuery = new Request("http://localhost/v1/models?base_url=https%3A%2F%2Fquery.example.com")
  assert.equal(__test.requestBaseURL(withQuery), "")

  assert.equal(__test.requestBaseURL(new Request("http://localhost/v1/models")), "")
})

test("zenEndpoint builds zen paths from base URL and avoids duplicate /zen/v1", () => {
  assert.equal(__test.zenEndpoint("chat/completions", ""), "https://opencode.ai/zen/v1/chat/completions")
  assert.equal(
    __test.zenEndpoint("chat/completions", "https://mirror.example.com"),
    "https://mirror.example.com/zen/v1/chat/completions",
  )
  assert.equal(
    __test.zenEndpoint("models", "https://mirror.example.com/zen/v1"),
    "https://mirror.example.com/zen/v1/models",
  )
})

test("per-request upstream base URL routes the chat request to the override host", async (t) => {
  const previousFetch = globalThis.fetch
  const previousApiKey = process.env.API_KEY
  const calls = []
  delete process.env.API_KEY
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(mockSSEBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }

  const server = await listen(app)
  t.after(() => {
    close(server)
    globalThis.fetch = previousFetch
    restoreEnv("API_KEY", previousApiKey)
  })

  await request(server.url, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-opencode-base-url": "https://mirror.example.com",
    },
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://mirror.example.com/zen/v1/chat/completions")
})
