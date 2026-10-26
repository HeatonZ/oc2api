// oc2api 的 Go 核心：默认起 HTTP 服务；-stdio 走 JSON-RPC（Vercel 由薄 Node 层拉起）。
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"oc2api/internal/chat"
	"oc2api/internal/config"
	"oc2api/internal/httpapi"
	"oc2api/internal/rpc"
	"oc2api/internal/zen"
)

func main() {
	stdio := flag.Bool("stdio", false, "以 stdio JSON-RPC 模式启动（Vercel 上由 Node 薄层拉起）")
	listen := flag.String("listen", "", "监听地址，默认取 PORT（:8080）")
	flag.Parse()

	// 配置只在启动阶段读一次，之后全部靠注入传下去。
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}

	client := zen.New(cfg)
	// 出口与上游按请求解析：Sub2API 里每个账号绑一个租约，不能固定在进程级。
	targets := zen.NewFactory(cfg)
	chats := chat.New(cfg, client, targets)

	if *stdio {
		log.Printf("oc2api go (stdio rpc) v%s upstream=%s timeout=%s egress=%s", config.Version, cfg.ZenAPIBaseURL, cfg.ZenConnectTimeout, egressLabel(cfg.EgressURL))
		if err := rpc.New(cfg, client, targets, chats).ServeStdio(); err != nil {
			log.Fatal(err)
		}
		return
	}

	addr := *listen
	if addr == "" {
		addr = ":" + cfg.Port
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(cfg, client, targets, chats),
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("oc2api go (http) v%s listening on %s upstream=%s timeout=%s egress=%s", config.Version, addr, cfg.ZenAPIBaseURL, cfg.ZenConnectTimeout, egressLabel(cfg.EgressURL))
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// egressLabel 只打印出口入口，不带凭据。
func egressLabel(url string) string {
	if url == "" {
		return "direct"
	}
	return url
}
