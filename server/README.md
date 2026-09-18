# oc2api

纯 Go 实现的 OpenCode API 代理服务，支持 SSE 流式响应。

## 配置

编辑 `config.yaml`：

| 配置项          | 默认值            | 说明               |
|--------------|----------------|------------------|
| `port`       | `8080`         | 监听端口             |
| `api-key`    | 空              | API 密钥（不设置则匿名访问） |
| `debug`     | `false`        | 调试日志 |
| `timeout-ms` | `300000` (5分钟) | 上游请求超时时间 |
| `base-url`  | `https://opencode.ai` | 上游根地址，支持 `http://` 或 `https://`；环境变量 `BASE_URL` 优先 |

## 配置示例

`config.yaml`：

```yaml
port: 8080
api-key: "change-me"
debug: false
timeout-ms: 300000
base-url: "http://你的反代地址"
```

也可以用环境变量覆盖配置文件中的上游地址：

```bash
BASE_URL="http://你的反代地址" docker compose up -d --build
```

`BASE_URL`/`base-url` 是部署级默认值，可以填写上游根地址，例如 `http://proxy.example`，程序会访问 `/zen/v1/chat/completions` 和 `/zen/v1/models`；也可以直接填写已经带 `/zen/v1` 的地址。支持 `http://` 和 `https://`。

Sub2API 如果需要每个请求选择不同反代，可使用请求级覆盖：

```text
X-OpenCode-Base-URL: http://proxy-a.example
```

或者把地址作为 URL 参数（需要 URL 编码）：

```text
POST /v1/chat/completions?base_url=http%3A%2F%2Fproxy-a.example
```

优先级为：`X-OpenCode-Base-URL` Header > `base_url` URL 参数 > `BASE_URL`/`base-url` > 默认 `https://opencode.ai`。请求级地址只允许 `http://` 和 `https://`，不会被转发给上游。
## 本地部署

```bash
go build -ldflags="-s -w" -trimpath -o main main.go
./main
```

## Docker 部署

```bash
docker compose up -d
```

## Serverless 部署

本地/Docker 部署出口 IP 固定，建议部署到阿里云函数计算、腾讯云函数 等 Serverless 环境实现多出口 IP 轮询，规避 IP 限制。

```bash
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -trimpath -o main main.go
# 将 main + config.yaml 上传至云函数代码空间
# chmod +x ./main
# 启动命令: ./main
# 监听端口: 8080
```

## API

接口与父项目完全一致，详见 [父项目 README](https://github.com/zhuweiyou/oc2api/#api)。
