# oc2api

> ⚠️ **2026-08-21 提醒**：`deepseek-v4-flash-free` 模型已官方下线，不再提供免费额度。如需使用请更换其他模型，如 `big-pickle`、`mimo-v2.5-free`、`hy3-free` 等。

OpenCode Free API 代理，使用一套 Express 业务逻辑，同时支持本地运行、Docker 和 Vercel 部署，并支持 SSE 流式响应。

## 架构

- `server/app.js`：唯一共享的 Express app 和业务逻辑
- `server/index.js`：本地 Node.js 启动入口
- `api/index.js`：Vercel 薄入口，导入同一个 `server/app.js`

## Vercel 部署

### 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FHeatonZ%2Foc2api&env=API_KEY%2CBASE_URL%2CDEBUG&envDefaults=%7B%22API_KEY%22%3A%22change-me%22%2C%22BASE_URL%22%3A%22https%3A%2F%2Fopencode.ai%22%2C%22DEBUG%22%3A%22false%22%7D&envDescription=API_KEY%EF%BC%9AAPI%20%E5%AF%86%E9%92%A5%EF%BC%9BBASE_URL%EF%BC%9AOpenCode%20%E6%88%96%E5%8F%8D%E4%BB%A3%E6%A0%B9%E5%9C%B0%E5%9D%80%EF%BC%88%E6%94%AF%E6%8C%81%20http%2Fhttps%EF%BC%89%EF%BC%9BDEBUG%EF%BC%9A%E8%B0%83%E8%AF%95%E6%97%A5%E5%BF%97%EF%BC%88%E9%BB%98%E8%AE%A4%E5%85%B3%E9%97%AD%EF%BC%89&envLink=https%3A%2F%2Fgithub.com%2FHeatonZ%2Foc2api%23%E9%83%A8%E7%BD%B2)

### 手动部署

1. Fork 本仓库到你的 GitHub
2. 打开 [Vercel Dashboard](https://vercel.com)，点击 **Add New > Project**
3. 选择你 Fork 的仓库，点击 **Import**
4. 在 **Environment Variables** 中添加：
   - `API_KEY` — API 密钥（留空则匿名访问）
   - `BASE_URL` — 可选的 OpenCode/反代根地址，支持 `http://` 或 `https://`；留空默认 `https://opencode.ai`
   - `DEBUG` — 设为 `true` 开启调试日志（可选）
5. 点击 **Deploy**，等待部署完成

部署完成后会得到一个 `https://<项目名>.vercel.app` 的域名。

Sub2API 如果需要每个请求选择不同反代，可在发往本服务的请求中加入：

```text
X-OpenCode-Base-URL: http://proxy-a.example
```

也可以使用 URL 参数（需要 URL 编码）：

```text
POST /v1/chat/completions?base_url=http%3A%2F%2Fproxy-a.example
```

优先级为：`X-OpenCode-Base-URL` Header > `base_url` URL 参数 > Vercel 环境变量 `BASE_URL` > 默认 `https://opencode.ai`。请求级地址只允许 `http://` 和 `https://`。

你可以 Fork 后部署多个 Vercel Project，以创建多个出口 IP 不同的项目，然后在 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/blob/main/README_CN.md#%E5%8A%9F%E8%83%BD%E7%89%B9%E6%80%A7)、[Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api/blob/main/README_CN.md#%E9%83%A8%E7%BD%B2%E6%96%B9%E5%BC%8F)、[QuantumNous/new-api](https://github.com/QuantumNous/new-api/blob/main/README.zh_CN.md#-%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B) 等工具中配置多个域名实现轮询，规避 IP 限制。

## API

兼容 OpenAI API 格式，路径均支持带 `/v1` 前缀或不带：

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

也支持 `X-API-Key`。

## 本地运行

要求 Node.js 24 或更高版本。

```bash
npm install
npm start
```

默认监听 `http://localhost:8080`。也可以通过环境变量配置：

```bash
API_KEY=your-key DEBUG=true PORT=8080 npm start
```

健康检查：

```bash
curl http://localhost:8080/health
```

## Docker 部署

Docker 配置位于项目根目录：

```bash
docker compose up -d --build
```

## 测试

离线测试不访问 OpenCode：

```bash
npm test
```

真实联调测试会向 `big-pickle` 发送两次请求：一次不带 tools 的非流式 `hi`，以及一次带 tools 的流式连续对话，并分别验证本地与 Vercel 入口（共 4 次请求）：

```bash
npm run test:live
```

真实测试可能受到上游限流影响；限流时测试会输出原因并跳过，不影响离线测试。

## 代码检查

```bash
npm run lint          # ESLint 静态检查
npm run format:check  # 检查格式是否规范
npm run format        # 用 Prettier 自动格式化全部文件
```

GitHub Actions 与 Docker 构建都会先执行 lint 和格式检查，不通过则构建失败。

## 免费模型限制

代理仅放行免费模型（`big-pickle` 及所有以 `-free` 结尾的模型），以 `big-pickle` 为例：

```json
{
  "id": "big-pickle",
  "limit": {
    "context": 200000,
    "output": 32000
  }
}
```

- `context`：最大上下文窗口，**200,000** tokens
- `output`：最大单次输出长度，**32,000** tokens

以上限制数据来源于接口 [https://models.opencode.ai/api.json](https://models.opencode.ai/api.json)（`opencode` key 下对应模型的 `limit` 字段），可自行查看核实，以实际使用为准。
