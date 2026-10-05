import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { once } from "node:events"
import test from "node:test"

import app from "../../server/app.js"
import { config } from "../../server/config.js"
import { requestBaseURL, resolveBaseURL, zenEndpoint } from "../../server/zen.js"

function listen(handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  return once(server, "listening").then(() => ({ server, url: `http://127.0.0.1:${server.address().port}` }))
}

function close(server) {
  if (!server.listening) return Promise.resolve()
  server.close()
  return once(server, "close")
}

function request(baseURL, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(path, baseURL), { method, headers }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }))
    })
    outgoing.on("error", reject)
    if (body !== undefined) outgoing.end(body)
    else outgoing.end()
  })
}

function sseBody() {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
}

test("request base URL validates scheme and builds Zen paths", () => {
  assert.equal(resolveBaseURL("https://relay.example/"), "https://relay.example")
  assert.equal(zenEndpoint("chat/completions", "https://relay.example/v1"), "https://relay.example/v1/chat/completions")
  assert.equal(zenEndpoint("models", "https://relay.example/zen/v1"), "https://relay.example/zen/v1/models")
  assert.throws(() => resolveBaseURL("ftp://relay.example"), /http/)
  assert.equal(requestBaseURL(new Request("http://local/v1/models?base_url=https%3A%2F%2Fquery.example")), "")
  assert.equal(
    requestBaseURL(new Request("http://local", { headers: { "x-opencode-base-url": "https://header.example" } })),
    "https://header.example",
  )
})

test("chat routes to per-request Header, never to base_url query", async (t) => {
  const oldFetch = globalThis.fetch
  const oldKey = config.apiKey
  const calls = []
  config.apiKey = undefined
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(sseBody(), { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  const { server, url } = await listen(app)
  t.after(async () => {
    await close(server)
    globalThis.fetch = oldFetch
    config.apiKey = oldKey
  })
  const result = await request(url, {
    method: "POST",
    path: "/v1/chat/completions?base_url=https%3A%2F%2Fquery.example",
    headers: { "content-type": "application/json", "x-opencode-base-url": "https://header.example" },
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(result.status, 200)
  assert.equal(calls[0].url, "https://header.example/zen/v1/chat/completions")
})

test("models endpoint routes to request Header", async (t) => {
  const oldFetch = globalThis.fetch
  const oldKey = config.apiKey
  const calls = []
  config.apiKey = undefined
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ data: [{ id: "big-pickle" }] }), { status: 200 })
  }
  const { server, url } = await listen(app)
  t.after(async () => {
    await close(server)
    globalThis.fetch = oldFetch
    config.apiKey = oldKey
  })
  const result = await request(url, {
    path: "/v1/models",
    headers: { "x-opencode-base-url": "https://header.example" },
  })
  assert.equal(result.status, 200)
  assert.equal(calls[0], "https://header.example/zen/v1/models")
})
