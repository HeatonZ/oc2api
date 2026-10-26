# oc2api

OpenCode 免费模型的 OpenAI 兼容代理，纯 Go 实现，支持 SSE 流式，可部署到 Vercel、Docker 或本地。

```mermaid
flowchart TD
    client["客户端<br/>Claude Code / Codex / DSH 等"]
    gateway["聚合网关<br/>CLIProxyAPI / SUB2API / NEWAPI"]
    a["oc2api 实例 A<br/>出口 IP 1"]
    b["oc2api 实例 B<br/>出口 IP 2"]
    c["oc2api 实例 C<br/>出口 IP 3"]
    zen["OpenCode Zen<br/>免费模型"]

    client --> gateway
    gateway -->|轮询 / 负载| a
    gateway -->|轮询 / 负载| b
    gateway -->|轮询 / 负载| c
    a --> zen
    b --> zen
    c --> zen
```

免费额度按出口网络计量。把多个实例填进 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、
[Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)、[QuantumNous/new-api](https://github.com/QuantumNous/new-api)
做轮询，就能把额度摊到多个出口上。用每个实例的 `/ip` 核对出口是否真的不同。

## 部署方式

<details>
<summary><b>1. Vercel</b> — 一键部署，或导入仓库手动部署</summary>

<br>

**一键部署：**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fzhuweiyou%2Foc2api&env=API_KEY%2CDEBUG&envDefaults=%7B%22API_KEY%22%3A%22sk-zhu%22%2C%22DEBUG%22%3A%22false%22%7D&envDescription=API_KEY%EF%BC%9AAPI%20%E5%AF%86%E9%92%A5%EF%BC%88%E7%95%99%E7%A9%BA%E5%88%99%E5%8C%BF%E5%90%8D%E8%AE%BF%E9%97%AE%EF%BC%89%EF%BC%9BDEBUG%EF%BC%9A%E8%AE%BE%E4%B8%BA%20true%20%E5%BC%80%E5%90%AF%E8%B0%83%E8%AF%95%E6%97%A5%E5%BF%97&envLink=https%3A%2F%2Fgithub.com%2Fzhuweiyou%2Foc2api%23vercel-%E9%83%A8%E7%BD%B2)

**手动部署：**

1. Fork 本仓库到你的 GitHub
2. 打开 [Vercel Dashboard](https://vercel.com)，点击 **Add New > Project**
3. 选择你 Fork 的仓库，点击 **Import**
4. 在 **Environment Variables** 中添加：
   - `API_KEY` — API 密钥（留空则匿名访问）
   - `DEBUG` — 设为 `true` 开启调试日志（可选）
5. 点击 **Deploy**，等待部署完成

部署完成后会得到一个 `https://<项目名>.vercel.app` 的域名。

构建阶段会自动下载 Go 工具链、编译出 linux 二进制并随函数打包（`scripts/build-go.sh`），
首次部署大概 1–2 分钟。Vercel 的 Go runtime 会缓冲整段响应，所以 Vercel 上的流式由
`api/index.js` 这层薄 Node 转发实现，业务逻辑仍然全在 Go 二进制里。

你也可以 Fork 后部署多个 Vercel Project 做轮询、负载分摊；多个项目不保证出口 IP 不同，
需通过各自实例的 `/ip` 核对。

</details>

<details>
<summary><b>2. Docker</b> — 云函数、容器平台或自建服务器</summary>

<br>

**拉取镜像**

现成镜像在 [`ghcr.io/zhuweiyou/oc2api`](https://github.com/zhuweiyou/oc2api/pkgs/container/oc2api)：

```bash
docker pull ghcr.io/zhuweiyou/oc2api:latest

docker run -d --name oc2api --restart unless-stopped \
  -p 8080:8080 \
  -e API_KEY=your-key \
  ghcr.io/zhuweiyou/oc2api:latest
```

`latest` 跟着最新版本走；要固定版本就用具体的版本 tag。

容器监听 `PORT`，默认 `8080`。镜像基于 `scratch`，里面只有静态二进制和 CA 证书。
云函数环境建议把超时调到 300 秒，否则长回答的流式响应会被提前截断。

**本地构建**

镜像定义与编排文件在 `docker/`：

```bash
cd docker && docker compose up -d --build
```

</details>

<details>
<summary><b>3. 本地运行（Go）</b> — 调试与临时使用</summary>

<br>

要求 Go 1.24 或更高版本。

```bash
go run ./cmd/oc2api                # 默认 :8080
API_KEY=your-key PORT=8080 go run ./cmd/oc2api
```

- `PORT`：监听端口，默认 `8080`
- `API_KEY`：请求鉴权，留空则匿名
- `ZEN_API_BASE_URL`：上游站点根地址，默认 `https://opencode.ai`；接口路径由程序拼接，
  自建中继只填根地址即可
- `ZEN_CONNECT_TIMEOUT_MS`：建连、TLS 握手与等响应头的超时，默认 `60000`，允许 `1`–`600000`
- `DEBUG`：设为 `true` 输出调试日志

出口与请求级覆盖（fork 定制）：

- `OC2API_EGRESS_URL`：出口隧道入口，例如 `socks5://egress-filter:1080`。
  必须是 CONNECT 类隧道（SOCKS5 或 HTTP CONNECT）；反向代理会终结 TLS，
  把免费层赖以识别的客户端指纹替换成中间层的，等于让 uTLS 失效。
- `OC2API_EGRESS_USER`：出口鉴权用户名模板，默认 `opencode.{account}`。
  `{account}` 会被替换成请求所带的租约名，用于按账号绑定出口。
- `OC2API_EGRESS_PASS`：出口鉴权密码。
- 请求头 `x-opencode-egress`：按请求指定完整出口地址，优先级最高。
- 请求头 `x-opencode-base-url`：按请求覆盖上游地址。若传入的是旧版反向代理
  地址（`/<token>/opencode.<account>/https/<host>`），会被还原成
  「真实上游 + 按账号出口」，无需逐条迁移已有配置。

`ZEN_API_BASE_URL` 填 `https://opencode.ai/zen/v1` 这类旧写法会被自动改写到
`/inference/v1`；其它主机（例如自建中继）原样使用。`base_url` 查询参数不生效。

同一段对话的每一轮会复用同一个上游 session，从而命中它的 prompt 缓存；换一段对话
或换一个调用方则各自独立。会话来源逐级取：`x-opencode-session` / `x-opencode-session-id`
→ `x-hermes-session-id`、`x-session-affinity`、`X-Session-Id`、`conversation-id`
→ 请求体的 `prompt_cache_key` / `metadata.user_id` → 内容派生。

健康检查：

```bash
curl http://localhost:8080/health
```

</details>

## API

兼容 OpenAI 格式，路径均支持带 `/v1` 前缀或不带：

| 路径                                          | 方法 | 说明                                  |
| --------------------------------------------- | ---- | ------------------------------------- |
| `/v1/chat/completions` 或 `/chat/completions` | POST | Chat 补全（支持 `stream: true` 流式） |
| `/v1/models` 或 `/models`                     | GET  | 模型列表                              |
| `/` 或 `/health`                              | GET  | 健康检查                              |
| `/ip`                                         | GET  | 查询出口 IP                           |

配置 API Key 后，请求携带：

```text
Authorization: Bearer <api-key>
```

也支持 `X-API-Key`。客户端工具、工具选择、多轮工具调用均可正常使用。

## 免费模型

代理只放行 `big-pickle` 及所有以 `-free` 结尾的模型，例如：

| 模型                       | 上下文  | 输出   | 图片输入 |
| -------------------------- | ------- | ------ | -------- |
| `big-pickle`               | 200,000 | 32,000 | ❌       |
| `mimo-v2.6-flash-free`     | 200,000 | 32,000 | ✅       |
| `deepseek-v4.1-flash-free` | 200,000 | 32,000 | ✅       |
| `glm-5.3-flash-free`       | 200,000 | 32,000 | ✅       |

数据来源 [https://models.opencode.ai/api.json](https://models.opencode.ai/api.json)，以实际为准。

### 免费额度

额度由上游按账号/网络计量，代理本身没有配额。用完时上游回 `429` 并带 `Retry-After`（秒），
到期自动恢复；oc2api 会把该头原样透给客户端。

| 状态 | 错误类型                                  | 含义                           |
| ---- | ----------------------------------------- | ------------------------------ |
| 403  | `FreeTierError`                           | 请求不像 OpenCode 客户端       |
| 429  | `FreeUsageLimitError`（带 `Retry-After`） | 额度用尽，或该出口已被上游限流 |

共享出口（云函数、Serverless）容易被别人先用掉额度，表现就是「昨天还好、今天全 429」，
这时换出口才有用。

## 开发

```bash
go test ./...              # 离线单元测试
go vet ./...
golangci-lint run ./...    # lint（配置见 .golangci.yml）
```

实现细节（为什么用 uTLS、免费层的形状要求、Vercel 为什么是薄 Node 层）见 [AGENTS.md](AGENTS.md)。

联调用例会对 `big-pickle`、`mimo-v2.6-flash-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free` 各跑一次多轮连续工具调用（含与内置同名的客户端 `read`），真实请求上游，受免费层限流影响；未设置 `OC2API_LIVE_TEST=1` 时自动跳过。因为依赖真实模型和上游配额，它不纳入 CI 门禁，需要时本地执行。

## 免费层会话标识（x-opencode-session）

免费层会校验 `x-opencode-session`，**格式与语义都要对**，否则一律 `403 FreeTierError`（原文 `OpenCode's free tier can only be used from within OpenCode`）：

- **格式**：`ses_` + 12 位小写 hex + 14 位 base62 字符。UUID、25 位、大写 hex 都会被拒。
- **语义**：前 12 位 hex 按 `~(BigInt(Date.now()) * 4096n + counter)` 截断到 48 位解读，其中低 12 位编码出的毫秒内序号必须落在接受区间内。**光格式对不够**——随机 hex 或 sha256 摘要的低 12 位是任意值，绝大多数落在区间外，会被判为「非 OpenCode 客户端」而拒。v4 实测的边界比 v3 更严：序号 0 形状完全合法却仍被回 429，所以合法区间是 1 起。

因此本代理对入站会话标识做归一化，逐级取种子；已经是合法 `ses_` 值（且序号合规）才原样透传，否则重新生成规范值。同一会话复用同一个 session 以保持上游提示词缓存亲和，TTL 30 分钟。

上游按「一段对话」而不是「一个使用者」归并 session：同一个 id 的回合会落到同一台后端，prompt cache 也只按这个 id 命中。本代理因此把使用者与对话种子一起参与缓存键，两段并行对话不会互相顶掉缓存。
