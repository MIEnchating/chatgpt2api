package protocol

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNewAPISSOTokenClientValidatesProvisionedKey(t *testing.T) {
	for _, tc := range []struct {
		name string
		data string
		ok   bool
	}{
		{"created", `{"user_id":7,"id":1,"name":"workbench","group":"images","created":true}`, true},
		{"reused", `{"user_id":7,"id":1,"name":"existing","group":"images","created":false}`, true},
		{"other-user", `{"user_id":8,"id":1,"name":"workbench","group":"images","created":true}`, false},
		{"other-group", `{"user_id":7,"id":1,"name":"workbench","group":"private","created":true}`, false},
		{"wrong-created-name", `{"user_id":7,"id":1,"name":"other","group":"images","created":true}`, false},
		{"unnamed", `{"user_id":7,"id":1,"name":"","group":"images","created":false}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			secret := strings.Repeat("s", 32)
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/sso/chatgpt2api/tokens" || r.Header.Get("Authorization") != "Bearer "+secret || r.Header.Get("Content-Type") != "application/json" {
					t.Error("invalid SSO token request")
				}
				var payload map[string]string
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload) != 4 || payload["reference"] != "test-reference" || payload["issuer"] != "https://"+r.Host || payload["group"] != "images" || payload["name"] != "workbench" {
					t.Error("invalid SSO token payload")
				}
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"success":true,"data":` + tc.data + `}`))
			}))
			defer upstream.Close()
			client, err := NewNewAPISSOTokenClient(upstream.URL, secret, "test-reference", 7, upstream.Client())
			if err != nil {
				t.Fatal(err)
			}
			if err := client.EnsureGroupToken(context.Background(), "images", "workbench"); (err == nil) != tc.ok {
				t.Fatalf("EnsureGroupToken() error = %v, want success %v", err, tc.ok)
			}
		})
	}
}

func TestNewAPISSOTokenClientRejectsRedirectsAndPrivateErrors(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"redirect", http.StatusTemporaryRedirect, `{}`, "HTTP 307"},
		{"expired-session", http.StatusUnauthorized, `{"code":"sso_invalid","message":"private-secret"}`, "单点登录已失效"},
		{"forbidden", http.StatusForbidden, `{"code":"token_group_forbidden","message":"private-secret"}`, "无权使用分组"},
		{"name-conflict", http.StatusConflict, `{"code":"token_name_conflict","message":"private-secret"}`, "名称冲突"},
		{"limit", http.StatusConflict, `{"code":"token_limit_reached","message":"private-secret"}`, "数量已达上限"},
		{"server-error", http.StatusInternalServerError, `{"message":"private-secret"}`, "HTTP 500"},
		{"malformed", http.StatusOK, `private-secret`, "响应无效"},
		{"oversized", http.StatusOK, strings.Repeat(" ", 16385), "响应无效"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer upstream.Close()
			client, err := NewNewAPISSOTokenClient(upstream.URL, strings.Repeat("s", 32), "test-reference", 7, upstream.Client())
			if err != nil {
				t.Fatal(err)
			}
			err = client.EnsureGroupToken(context.Background(), "images", "workbench")
			if err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("EnsureGroupToken() error = %v, want sanitized %q", err, tc.want)
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("SSO credential was sent to redirect target")
	}
}
