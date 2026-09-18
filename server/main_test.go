package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestZenEndpointWithBaseURL(t *testing.T) {
	oldCfg := Cfg
	Cfg = &Config{}
	defer func() { Cfg = oldCfg }()

	tests := []struct {
		name string
		base string
		path string
		want string
	}{
		{"default-root", "https://opencode.ai", "models", "https://opencode.ai/zen/v1/models"},
		{"http-root", "http://127.0.0.1:9000", "chat/completions", "http://127.0.0.1:9000/zen/v1/chat/completions"},
		{"https-root", "https://proxy.example", "models", "https://proxy.example/zen/v1/models"},
		{"already-api-root", "https://proxy.example/zen/v1", "models", "https://proxy.example/zen/v1/models"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			Cfg.BaseURL = tc.base
			got, err := zenEndpoint(tc.path)
			if err != nil {
				t.Fatalf("zenEndpoint() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("zenEndpoint() = %q, want %q", got, tc.want)
			}
		})
	}

	for _, invalid := range []string{"ftp://proxy.example", "proxy.example", "://bad"} {
		Cfg.BaseURL = invalid
		if _, err := zenEndpoint("models"); err == nil {
			t.Fatalf("zenEndpoint() accepted invalid base URL %q", invalid)
		}
	}

	t.Setenv("BASE_URL", "http://env.example")
	Cfg.BaseURL = "https://config.example"
	got, err := zenEndpoint("models")
	if err != nil {
		t.Fatalf("zenEndpoint() environment override error = %v", err)
	}
	if got != "http://env.example/zen/v1/models" {
		t.Fatalf("zenEndpoint() environment override = %q", got)
	}
}

func TestFetchZenUsesConfiguredHTTPBaseURL(t *testing.T) {
	oldCfg, oldClient := Cfg, zenHTTPClient
	defer func() {
		Cfg = oldCfg
		zenHTTPClient = oldClient
	}()

	var gotPath string
	var gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {\\\"choices\\\":[]}\\n\\ndata: [DONE]\\n\\n"))
	}))
	defer upstream.Close()

	Cfg = &Config{BaseURL: upstream.URL}
	zenHTTPClient = upstream.Client()
	resp, err := fetchZen(context.Background(), &zenRequest{
		Body:    `{"model":"big-pickle"}`,
		Headers: map[string]string{"Content-Type": "application/json"},
	})
	if err != nil {
		t.Fatalf("fetchZen() error = %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fetchZen() status = %d, want 200", resp.StatusCode)
	}
	if gotPath != "/zen/v1/chat/completions" {
		t.Fatalf("upstream path = %q", gotPath)
	}
	if !strings.Contains(gotBody, "big-pickle") {
		t.Fatalf("upstream body = %q", gotBody)
	}
}

func TestRequestBaseURLPriority(t *testing.T) {
	queryReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions?base_url=http%3A%2F%2Fquery.example", nil)
	if got := requestBaseURL(queryReq); got != "http://query.example" {
		t.Fatalf("query base URL = %q", got)
	}

	headerReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions?base_url=http%3A%2F%2Fquery.example", nil)
	headerReq.Header.Set("X-OpenCode-Base-URL", "https://header.example/zen/v1")
	if got := requestBaseURL(headerReq); got != "https://header.example/zen/v1" {
		t.Fatalf("header base URL = %q", got)
	}

	invalidReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions?base_url=ftp%3A%2F%2Fbad.example", nil)
	if _, err := zenEndpoint("models", requestBaseURL(invalidReq)); err == nil {
		t.Fatal("invalid request base URL was accepted")
	}
}

func TestFetchZenUsesRequestBaseURLOverride(t *testing.T) {
	oldCfg, oldClient := Cfg, zenHTTPClient
	defer func() {
		Cfg = oldCfg
		zenHTTPClient = oldClient
	}()

	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {}\\n\\ndata: [DONE]\\n\\n"))
	}))
	defer upstream.Close()

	Cfg = &Config{BaseURL: "https://config.example"}
	zenHTTPClient = upstream.Client()
	resp, err := fetchZen(context.Background(), &zenRequest{
		Body:    `{\"model\":\"big-pickle\"}`,
		Headers: map[string]string{"Content-Type": "application/json"},
	}, upstream.URL)
	if err != nil {
		t.Fatalf("fetchZen() override error = %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fetchZen() override status = %d, want 200", resp.StatusCode)
	}
	if gotPath != "/zen/v1/chat/completions" {
		t.Fatalf("override upstream path = %q", gotPath)
	}
}
