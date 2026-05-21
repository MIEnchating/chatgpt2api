package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt2api/internal/backend"
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"

	"golang.org/x/crypto/bcrypt"
)

func TestAppAuthAndSPACompatibility(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	if user["role"] != "user" {
		t.Fatalf("created user = %#v", user)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/users/"+user["id"].(string)+"/key", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("reveal user key status = %d body = %s", res.Code, res.Body.String())
	}
	var revealed map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &revealed); err != nil {
		t.Fatalf("reveal json: %v", err)
	}
	if revealed["key"] != rawKey {
		t.Fatalf("revealed key = %#v, want raw key", revealed["key"])
	}

	req = httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("/auth/session status = %d body = %s", res.Code, res.Body.String())
	}
	var login map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &login); err != nil {
		t.Fatalf("login json: %v", err)
	}
	if login["role"] != "user" {
		t.Fatalf("login role = %#v", login)
	}

	req = httptest.NewRequest(http.MethodGet, "/health", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("/health status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/announcements?target=login", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("/api/announcements status = %d body = %s", res.Code, res.Body.String())
	}
	var announcementsBody map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &announcementsBody); err != nil {
		t.Fatalf("announcements json: %v", err)
	}
	if items := logItems(announcementsBody); len(items) != 0 {
		t.Fatalf("unexpected initial announcements = %#v", announcementsBody)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/announcements", strings.NewReader(`{"title":"通知 A","content":"今晚维护","show_login":true,"show_image":false}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create login announcement status = %d body = %s", res.Code, res.Body.String())
	}
	var createBody map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &createBody); err != nil {
		t.Fatalf("create announcement json: %v", err)
	}
	createdItem, _ := createBody["item"].(map[string]any)
	createdID, _ := createdItem["id"].(string)
	if createdID == "" {
		t.Fatalf("missing created announcement id: %#v", createBody)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/announcements", strings.NewReader(`{"title":"通知 B","content":"画图页公告","show_login":false,"show_image":true}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create image announcement status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/announcements", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin list announcements status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &announcementsBody); err != nil {
		t.Fatalf("admin announcements json: %v", err)
	}
	if items := logItems(announcementsBody); len(items) != 2 {
		t.Fatalf("admin announcements length = %d body = %#v", len(items), announcementsBody)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/announcements?target=login", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("public login announcements status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &announcementsBody); err != nil {
		t.Fatalf("public login announcements json: %v", err)
	}
	items := logItems(announcementsBody)
	if len(items) != 1 || items[0]["title"] != "通知 A" {
		t.Fatalf("unexpected public login announcements = %#v", announcementsBody)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/announcements/"+createdID, strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("disable announcement status = %d body = %s", res.Code, res.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/api/announcements?target=login", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("public login announcements after disable status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &announcementsBody); err != nil {
		t.Fatalf("public login announcements after disable json: %v", err)
	}
	if items := logItems(announcementsBody); len(items) != 0 {
		t.Fatalf("disabled announcement should be hidden: %#v", announcementsBody)
	}

	msgReq := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader("{"))
	msgReq.Header.Set("x-api-key", rawKey)
	msgRes := httptest.NewRecorder()
	app.Handler().ServeHTTP(msgRes, msgReq)
	if msgRes.Code != http.StatusBadRequest {
		t.Fatalf("x-api-key auth did not reach JSON validation, status = %d body = %s", msgRes.Code, msgRes.Body.String())
	}

	for _, path := range []string{"/", "/settings"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `<div id="root"></div>`) {
			t.Fatalf("%s status/body = %d %q", path, res.Code, res.Body.String())
		}
	}
	req = httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing asset status = %d", res.Code)
	}
}

func TestPasswordAccountLogin(t *testing.T) {
	t.Setenv("CHATGPT2API_USER_DEFAULT_CONCURRENT_LIMIT", "2")

	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"admin","password":"AdminPass123!"}`))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin password login status = %d body = %s", res.Code, res.Body.String())
	}
	var login map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &login); err != nil {
		t.Fatalf("login json: %v", err)
	}
	adminToken, _ := login["token"].(string)
	if adminToken == "" || login["role"] != service.AuthRoleAdmin || login["subject_id"] != "admin" || login["username"] != "admin" {
		t.Fatalf("admin login body = %#v", login)
	}
	assertCreationConcurrentLimit(t, login, 0)

	req = httptest.NewRequest(http.MethodGet, "/auth/providers", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("removed providers endpoint status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/register", strings.NewReader(`{"username":"alice","password":"Password123","name":"Alice"}`))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("removed registration endpoint status = %d body = %s", res.Code, res.Body.String())
	}

	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	if app.newAPIKeys != nil {
		_ = app.newAPIKeys.Close()
	}
	app.newAPIKeys = reader
	req = httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"alice","password":"Password123"}`))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("user password login status = %d body = %s", res.Code, res.Body.String())
	}
	var userLogin map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &userLogin); err != nil {
		t.Fatalf("user login json: %v", err)
	}
	if userLogin["role"] != service.AuthRoleUser || userLogin["provider"] != service.AuthProviderNewAPI || userLogin["subject_id"] != "newapi:1" || userLogin["username"] != "alice" || userLogin["name"] != "Alice" || userLogin["role_id"] != service.DefaultManagedRoleID {
		t.Fatalf("user login body = %#v", userLogin)
	}
	assertCreationConcurrentLimit(t, userLogin, 2)
}

func TestProfileAccountNameAndPasswordUpdates(t *testing.T) {
	t.Setenv("CHATGPT2API_USER_DEFAULT_CONCURRENT_LIMIT", "3")

	app := newTestApp(t)
	defer app.Close()

	user, token := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	if user.Name != "Alice" || token == "" {
		t.Fatalf("created user identity=%#v token=%q", user, token)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/profile", strings.NewReader(`{"name":"Alice Updated"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("profile name update status = %d body = %s", res.Code, res.Body.String())
	}
	var profile map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &profile); err != nil {
		t.Fatalf("profile update json: %v", err)
	}
	if profile["name"] != "Alice Updated" || profile["subject_id"] != user.ID {
		t.Fatalf("profile update body = %#v", profile)
	}
	assertCreationConcurrentLimit(t, profile, 3)

	req = httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("session after profile update status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &profile); err != nil {
		t.Fatalf("session after profile update json: %v", err)
	}
	if profile["name"] != "Alice Updated" {
		t.Fatalf("session did not reflect updated name: %#v", profile)
	}
	assertCreationConcurrentLimit(t, profile, 3)

	req = httptest.NewRequest(http.MethodPost, "/api/profile/password", strings.NewReader(`{"current_password":"wrong-password","new_password":"NewPassword123"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("wrong current password status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/password", strings.NewReader(`{"current_password":"Password123","new_password":"NewPassword123"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("password update status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"alice","password":"Password123"}`))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("old password login status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"alice","password":"NewPassword123"}`))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("local user should not use public login after NewAPI login switch, status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestCreationTaskRequiresRelayAIAPIKey(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(`{"client_task_id":"task-log-test","prompt":"test image"}`))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("submit creation task status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("error json: %v", err)
	}
	if detail := util.StringMap(payload["detail"]); detail["error"] != "请先配置 NewAPI 数据库连接，并在 NewAPI 创建指定分组的令牌" {
		t.Fatalf("error body = %#v", payload)
	}
}

func TestProfileRelayKeyReadsNewAPITokenForUserAndGroup(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertHTTPTestNewAPIToken(t, dbURL, 1, 1, "other", "wrong-key", time.Now().Unix()+3600, 10, false)
	insertHTTPTestNewAPIToken(t, dbURL, 2, 1, "draw", "alice-relay", -1, 0, true)
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "draw"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	if app.newAPIKeys != nil {
		_ = app.newAPIKeys.Close()
	}
	app.newAPIKeys = reader

	user, token := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	if user.ID == "" || user.Username != "alice" || token == "" {
		t.Fatalf("created user identity=%#v token=%q", user, token)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/profile/relay-key", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("initial relay key status = %d body = %s", res.Code, res.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &status); err != nil {
		t.Fatalf("relay key status json: %v", err)
	}
	if status["has_key"] != true || status["group"] != "draw" || status["key_preview"] == "sk-alice-relay" {
		t.Fatalf("relay key status = %#v", status)
	}

	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected upstream path: %s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		util.WriteJSON(w, http.StatusOK, map[string]any{
			"object": "list",
			"data": []map[string]any{{
				"id": "codex-gpt-image-2",
			}},
		})
	}))
	defer upstream.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay base URL error = %v", err)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("relay models status = %d body = %s", res.Code, res.Body.String())
	}
	if gotAuth != "Bearer sk-alice-relay" {
		t.Fatalf("upstream Authorization = %q", gotAuth)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/relay-key", strings.NewReader(`{"api_key":"sk-local-write"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("write relay key status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfileBalanceReadsNewAPIUser(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	updateHTTPTestNewAPIUserBalance(t, dbURL, 1, 123456, 789, 42, "codex")
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL, TokenGroup: "codex"})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	if app.newAPIKeys != nil {
		_ = app.newAPIKeys.Close()
	}
	app.newAPIKeys = reader

	user, token := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	if user.ID == "" || user.Username != "alice" || token == "" {
		t.Fatalf("created user identity=%#v token=%q", user, token)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/profile/balance", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("profile balance status = %d body = %s", res.Code, res.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &status); err != nil {
		t.Fatalf("profile balance json: %v", err)
	}
	if status["has_balance"] != true ||
		status["source"] != "newapi" ||
		status["token_group"] != "codex" ||
		status["user_group"] != "codex" ||
		status["username"] != "alice" ||
		status["quota"] != float64(123456) ||
		status["used_quota"] != float64(789) ||
		status["request_count"] != float64(42) {
		t.Fatalf("profile balance = %#v", status)
	}
}

func TestCreationTaskResponseImageRouteIsNotAnAdminTaskResource(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}

	body := `{"client_task_id":"response-image-route","prompt":"生成封面","model":"gpt-5.5","size":"2048x2048","image_resolution":"2k","quality":"high","output_format":"jpeg","output_compression":42,"n":2,"images":["data:image/png;base64,cG5n"],"messages":[{"role":"user","content":"生成封面"}],"visibility":"public"}`
	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/response-image-generations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("response image creation task status = %d body = %s, want 404", res.Code, res.Body.String())
	}
}

func TestRunLoggedImageTaskLogsTextOutputAsFailure(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	identity := service.Identity{ID: "admin", Role: service.AuthRoleAdmin, Name: "Admin"}
	result, err := app.runLoggedImageTask(
		context.Background(),
		identity,
		map[string]any{"model": "gpt-image-2"},
		"/api/creation-tasks/image-generations",
		"文生图",
		func(context.Context, map[string]any) (map[string]any, error) {
			return map[string]any{"output_type": "text", "message": "模型返回文本", "data": []map[string]any{}}, nil
		},
	)
	if err != nil {
		t.Fatalf("runLoggedImageTask() error = %v", err)
	}
	if result["output_type"] != "text" || result["message"] != "模型返回文本" {
		t.Fatalf("runLoggedImageTask() result = %#v", result)
	}
	logs := app.logs.Search(service.LogQuery{Limit: 10})
	item := findLogBySummary(logs, "文生图调用失败")
	if item == nil {
		t.Fatalf("expected text-only image result to write failure log, got %#v", logs)
	}
	detail := util.StringMap(item["detail"])
	if detail["outcome"] != "failed" || util.ToInt(detail["status"], 0) != http.StatusBadGateway {
		t.Fatalf("failure log detail = %#v", detail)
	}
}

func TestRunLoggedImageTaskLocalizesRelayURLForGallery(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	imageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		if err := encodeHTTPTestPNG(w); err != nil {
			t.Fatalf("encode test image: %v", err)
		}
	}))
	defer imageServer.Close()

	identity := service.Identity{ID: "user-1", Role: service.AuthRoleUser, Name: "Alice"}
	result, err := app.runLoggedImageTask(
		context.Background(),
		identity,
		map[string]any{
			"prompt":     "draw",
			"model":      "codex-gpt-image-2",
			"visibility": service.ImageVisibilityPrivate,
		},
		"/api/creation-tasks/image-generations",
		"文生图",
		func(context.Context, map[string]any) (map[string]any, error) {
			return map[string]any{
				"data": []map[string]any{{
					"url": imageServer.URL + "/image.png",
				}},
			}, nil
		},
	)
	if err != nil {
		t.Fatalf("runLoggedImageTask() error = %v", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 {
		t.Fatalf("result data = %#v", result)
	}
	localURL := util.Clean(data[0]["url"])
	if !strings.HasPrefix(localURL, "/images/") {
		t.Fatalf("image url was not localized: %#v", result)
	}
	if data[0]["output_format"] != "png" {
		t.Fatalf("output_format = %#v, want png in %#v", data[0]["output_format"], data[0])
	}
	access, err := app.images.ImageFileAccess(localURL, service.ImageAccessScope{OwnerID: identity.ID})
	if err != nil {
		t.Fatalf("localized image is not accessible from gallery: %v", err)
	}
	if access.Visibility != service.ImageVisibilityPrivate || access.OwnerID != identity.ID {
		t.Fatalf("localized image access = %#v", access)
	}
}

func TestRelayImagePayloadDropsUnsupportedStreamFields(t *testing.T) {
	payload := relayPayloadForPath("/v1/images/generations", map[string]any{
		"prompt":         "draw",
		"model":          "codex-gpt-image-2",
		"stream":         true,
		"partial_images": 2,
		"messages":       []map[string]any{{"role": "user", "content": "draw"}},
	})
	if _, ok := payload["stream"]; ok {
		t.Fatalf("stream should be dropped for image relay payload: %#v", payload)
	}
	if _, ok := payload["partial_images"]; ok {
		t.Fatalf("partial_images should be dropped for image relay payload: %#v", payload)
	}
	if _, ok := payload["messages"]; ok {
		t.Fatalf("messages should be dropped for image relay payload: %#v", payload)
	}
}

func TestRelayImagePayloadDropsResponseFormat(t *testing.T) {
	payload := relayPayloadForPath("/v1/images/generations", map[string]any{
		"prompt":          "draw",
		"model":           "gpt-image-2",
		"response_format": "url",
	})
	if _, ok := payload["response_format"]; ok {
		t.Fatalf("response_format should not be forwarded to GPT image models: %#v", payload)
	}
}

func TestRelayImagePayloadNormalizesSizeForRelay(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		want     string
		wantDrop bool
	}{
		{name: "portrait ratio", input: "9:16", want: "864x1536"},
		{name: "landscape ratio with x", input: "16x9", want: "1536x864"},
		{name: "preset", input: "2k", want: "2048x2048"},
		{name: "dimensions", input: "1824x1024", want: "1824x1024"},
		{name: "auto", input: "auto", wantDrop: true},
		{name: "unknown", input: "original", wantDrop: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload := relayPayloadForPath("/v1/images/edits", map[string]any{
				"prompt": "draw",
				"model":  "codex-gpt-image-2",
				"size":   tt.input,
			})
			got, ok := payload["size"]
			if tt.wantDrop {
				if ok {
					t.Fatalf("size should be dropped, got %#v in %#v", got, payload)
				}
				return
			}
			if got != tt.want {
				t.Fatalf("payload size = %#v, want %q in %#v", got, tt.want, payload)
			}
		})
	}
}

func TestRelayImagePayloadSanitizesOfficialParameters(t *testing.T) {
	payload := relayPayloadForPath("/v1/images/generations", map[string]any{
		"prompt":             "draw",
		"model":              "codex-gpt-image-2",
		"quality":            "HD",
		"background":         "transparent",
		"moderation":         "strict",
		"response_format":    "json",
		"output_format":      "jpg",
		"output_compression": 120,
	})
	if _, ok := payload["quality"]; ok {
		t.Fatalf("invalid quality should be dropped: %#v", payload)
	}
	if _, ok := payload["background"]; ok {
		t.Fatalf("unsupported background should be dropped: %#v", payload)
	}
	if _, ok := payload["moderation"]; ok {
		t.Fatalf("invalid moderation should be dropped: %#v", payload)
	}
	if _, ok := payload["response_format"]; ok {
		t.Fatalf("invalid response_format should be dropped: %#v", payload)
	}
	if payload["output_format"] != "jpeg" {
		t.Fatalf("output_format = %#v, want jpeg in %#v", payload["output_format"], payload)
	}
	if payload["output_compression"] != 100 {
		t.Fatalf("output_compression = %#v, want clamped 100 in %#v", payload["output_compression"], payload)
	}

	payload = relayPayloadForPath("/v1/images/edits", map[string]any{
		"prompt":             "draw",
		"model":              "codex-gpt-image-2",
		"quality":            "AUTO",
		"background":         "OPAQUE",
		"moderation":         "LOW",
		"response_format":    "b64_json",
		"output_format":      "png",
		"output_compression": 50,
	})
	if payload["quality"] != "auto" || payload["background"] != "opaque" || payload["moderation"] != "low" {
		t.Fatalf("valid enum parameters were not normalized: %#v", payload)
	}
	if _, ok := payload["response_format"]; ok {
		t.Fatalf("response_format should be dropped: %#v", payload)
	}
	if payload["output_format"] != "png" {
		t.Fatalf("output_format = %#v, want png in %#v", payload["output_format"], payload)
	}
	if _, ok := payload["output_compression"]; ok {
		t.Fatalf("png output should not forward output_compression: %#v", payload)
	}

	payload = relayPayloadForPath("/v1/images/generations", map[string]any{
		"prompt":             "draw",
		"model":              "codex-gpt-image-2",
		"output_compression": 42,
	})
	if _, ok := payload["output_compression"]; ok {
		t.Fatalf("output_compression without jpeg/webp output_format should be dropped: %#v", payload)
	}
}

func TestRelayChatPayloadDropsInternalTextCallback(t *testing.T) {
	payload := relayPayloadForPath("/v1/chat/completions", map[string]any{
		"prompt":                             "hello",
		"model":                              "gpt-5.5",
		service.TextOutputCallbackPayloadKey: func(string) {},
	})
	if _, ok := payload[service.TextOutputCallbackPayloadKey]; ok {
		t.Fatalf("text output callback should be dropped: %#v", payload)
	}
	if _, err := json.Marshal(payload); err != nil {
		t.Fatalf("relay payload should be JSON serializable: %v", err)
	}
	auditPayload := cleanAuditPayloadMap(map[string]any{
		"prompt":                             "hello",
		service.TextOutputCallbackPayloadKey: func(string) {},
	})
	if _, ok := auditPayload[service.TextOutputCallbackPayloadKey]; ok {
		t.Fatalf("text output callback should be dropped from audit payload: %#v", auditPayload)
	}
}

func TestRelayImageTaskResultCollectsStream(t *testing.T) {
	items := make(chan map[string]any, 1)
	errCh := make(chan error, 1)
	items <- map[string]any{
		"object":  "image.generation.result",
		"created": 123,
		"model":   "codex-gpt-image-2",
		"index":   0,
		"data":    []map[string]any{{"url": "https://example.test/image.png"}},
	}
	close(items)
	errCh <- nil
	close(errCh)

	var progress []map[string]any
	result, err := relayImageTaskResult(
		map[string]any{"image_output_callback": func(data []map[string]any) { progress = data }},
		nil,
		&protocol.StreamResult{Items: items, Err: errCh, Kind: "openai"},
		nil,
	)
	if err != nil {
		t.Fatalf("relayImageTaskResult() error = %v", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["url"] != "https://example.test/image.png" {
		t.Fatalf("stream result data = %#v", result)
	}
	if result["model"] != "codex-gpt-image-2" || util.ToInt(result["created"], 0) != 123 {
		t.Fatalf("stream result metadata = %#v", result)
	}
	if len(progress) != 1 || progress[0]["url"] != "https://example.test/image.png" {
		t.Fatalf("progress callback data = %#v", progress)
	}
}

func TestRelayStreamResultReturnsUpstreamErrorFrame(t *testing.T) {
	stream := relayStreamResult(io.NopCloser(strings.NewReader(
		"data: {\"error\":{\"message\":\"stream disconnected before completion\"}}\n\n",
	)))

	if item, ok := <-stream.Items; ok {
		t.Fatalf("unexpected stream item: %#v", item)
	}
	err := <-stream.Err
	if err == nil || err.Error() != "stream disconnected before completion" {
		t.Fatalf("stream error = %v", err)
	}
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadGateway {
		t.Fatalf("stream error type = %T %#v", err, err)
	}
}

func TestCollectRelayChatTaskStreamPublishesProgress(t *testing.T) {
	items := make(chan map[string]any, 2)
	errCh := make(chan error, 1)
	items <- map[string]any{
		"created": 123,
		"model":   "gpt-5.5",
		"choices": []map[string]any{{"delta": map[string]any{"content": "你"}}},
	}
	items <- map[string]any{
		"choices": []map[string]any{{"delta": map[string]any{"content": "好"}}},
	}
	close(items)
	errCh <- nil
	close(errCh)

	var progress []string
	result, err := collectRelayChatTaskStream(
		map[string]any{service.TextOutputCallbackPayloadKey: func(text string) { progress = append(progress, text) }},
		&protocol.StreamResult{Items: items, Err: errCh, Kind: "openai"},
	)
	if err != nil {
		t.Fatalf("collectRelayChatTaskStream() error = %v", err)
	}
	data := util.AsMapSlice(result["data"])
	if result["output_type"] != "text" || len(data) != 1 || data[0]["text_response"] != "你好" {
		t.Fatalf("stream result = %#v", result)
	}
	if len(progress) != 2 || progress[0] != "你" || progress[1] != "你好" {
		t.Fatalf("progress = %#v", progress)
	}
}

func TestRecordGeneratedImagesForPayloadStoresReusableRequestMetadata(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	rel := "2026/05/12/reusable.png"
	imagePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := writeHTTPTestPNG(imagePath); err != nil {
		t.Fatalf("writeHTTPTestPNG() error = %v", err)
	}

	app.recordGeneratedImagesForPayload(
		service.Identity{ID: "admin", Role: service.AuthRoleAdmin, Name: "Admin"},
		[]string{rel},
		service.ImageVisibilityPublic,
		map[string]any{
			"prompt":             "复用这个提示词",
			"model":              "gpt-image-2",
			"quality":            "high",
			"image_resolution":   "2k",
			"size":               "2048x2048",
			"output_format":      "jpeg",
			"output_compression": 42,
			"background":         "opaque",
			"moderation":         "low",
			"input_image_mask":   "mask-id",
			"images": []protocol.UploadedImage{
				{Filename: "source.png", ContentType: "image/png", Data: []byte("reference-bytes")},
			},
			"share_prompt_parameters": true,
			"share_reference_images":  true,
		},
	)

	list := app.images.ListImages("http://127.0.0.1:8000", "", "", service.ImageAccessScope{Public: true})
	items := list["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatalf("ListImages() = %#v", list)
	}
	item := items[0]
	if item["prompt"] != "复用这个提示词" ||
		item["model"] != "gpt-image-2" ||
		item["quality"] != "high" ||
		item["resolution_preset"] != "2k" ||
		item["requested_size"] != "2048x2048" ||
		item["output_format"] != "jpeg" ||
		item["output_compression"] != 42 ||
		item["background"] != "opaque" ||
		item["moderation"] != "low" ||
		item["input_image_mask"] != "mask-id" {
		t.Fatalf("reusable metadata = %#v", item)
	}
	referenceURLs, ok := item["reference_image_urls"].([]string)
	if !ok || len(referenceURLs) != 1 || !strings.Contains(referenceURLs[0], "/image-references/") {
		t.Fatalf("reference_image_urls = %#v", item["reference_image_urls"])
	}
	parsedReferenceURL, err := url.Parse(referenceURLs[0])
	if err != nil {
		t.Fatalf("parse reference url: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, parsedReferenceURL.RequestURI(), nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.String() != "reference-bytes" {
		t.Fatalf("public reference status/body = %d %q", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("reference Content-Type = %q, want image/png", got)
	}
}

func TestDirectImageGenerationUsesCreationLimiter(t *testing.T) {
	t.Skip("direct image generation now proxies to RelayAI instead of the local image engine")

	t.Setenv("CHATGPT2API_USER_DEFAULT_CONCURRENT_LIMIT", "2")
	app := newTestApp(t)
	defer app.Close()
	_, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "image-user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}

	app.engine.ImageTokenProvider = func(context.Context) (string, error) {
		return "test-token", nil
	}
	app.engine.ImageClientFactory = func(string) *backend.Client {
		return nil
	}

	var mu sync.Mutex
	active := 0
	maxActive := 0
	release := make(chan struct{})
	app.engine.StreamImageOutputsFunc = func(ctx context.Context, client *backend.Client, request protocol.ConversationRequest, index, total int) (<-chan protocol.ImageOutput, <-chan error) {
		out := make(chan protocol.ImageOutput)
		errCh := make(chan error, 1)
		go func() {
			defer close(out)
			defer close(errCh)
			mu.Lock()
			active++
			if active > maxActive {
				maxActive = active
			}
			mu.Unlock()
			select {
			case <-release:
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
			out <- protocol.ImageOutput{
				Kind:    "result",
				Model:   request.Model,
				Index:   index,
				Total:   total,
				Created: int64(index),
				Data:    []map[string]any{{"url": fmt.Sprintf("https://example.test/%d.png", index)}},
			}
			mu.Lock()
			active--
			mu.Unlock()
			errCh <- nil
		}()
		return out, errCh
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"draw","model":"gpt-image-2","n":3,"response_format":"url"}`))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		app.Handler().ServeHTTP(res, req)
	}()

	waitForHTTPTestCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return maxActive >= 2
	})
	time.Sleep(120 * time.Millisecond)
	mu.Lock()
	gotMaxActive := maxActive
	mu.Unlock()
	if gotMaxActive != 2 {
		t.Fatalf("max concurrent direct image outputs = %d, want 2", gotMaxActive)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("direct image generation request did not finish")
	}
	if res.Code != http.StatusOK {
		t.Fatalf("direct image generation status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestDirectImageGenerationDoesNotLimitAdminToken(t *testing.T) {
	t.Skip("direct image generation now proxies to RelayAI instead of the local image engine")

	t.Setenv("CHATGPT2API_USER_DEFAULT_CONCURRENT_LIMIT", "2")
	app := newTestApp(t)
	defer app.Close()

	app.engine.ImageTokenProvider = func(context.Context) (string, error) {
		return "test-token", nil
	}
	app.engine.ImageClientFactory = func(string) *backend.Client {
		return nil
	}

	var mu sync.Mutex
	active := 0
	maxActive := 0
	release := make(chan struct{})
	app.engine.StreamImageOutputsFunc = func(ctx context.Context, client *backend.Client, request protocol.ConversationRequest, index, total int) (<-chan protocol.ImageOutput, <-chan error) {
		out := make(chan protocol.ImageOutput)
		errCh := make(chan error, 1)
		go func() {
			defer close(out)
			defer close(errCh)
			mu.Lock()
			active++
			if active > maxActive {
				maxActive = active
			}
			mu.Unlock()
			select {
			case <-release:
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
			out <- protocol.ImageOutput{
				Kind:    "result",
				Model:   request.Model,
				Index:   index,
				Total:   total,
				Created: int64(index),
				Data:    []map[string]any{{"url": fmt.Sprintf("https://example.test/%d.png", index)}},
			}
			mu.Lock()
			active--
			mu.Unlock()
			errCh <- nil
		}()
		return out, errCh
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"draw","model":"gpt-image-2","n":3,"response_format":"url"}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		app.Handler().ServeHTTP(res, req)
	}()

	waitForHTTPTestCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return maxActive >= 3
	})
	mu.Lock()
	gotMaxActive := maxActive
	mu.Unlock()
	if gotMaxActive != 3 {
		t.Fatalf("max concurrent admin image outputs = %d, want 3", gotMaxActive)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("admin image generation request did not finish")
	}
	if res.Code != http.StatusOK {
		t.Fatalf("admin image generation status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestEmptyCollectionEndpointsReturnArrays(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	for _, tc := range []struct {
		name string
		path string
		keys []string
	}{
		{name: "images", path: "/api/images", keys: []string{"items", "groups"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Header.Set("Authorization", adminAuthHeader(t, app))
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != http.StatusOK {
				t.Fatalf("%s status = %d body = %s", tc.path, res.Code, res.Body.String())
			}
			var payload map[string]any
			if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
				t.Fatalf("%s json: %v", tc.path, err)
			}
			for _, key := range tc.keys {
				items, ok := payload[key].([]any)
				if !ok || items == nil || len(items) != 0 {
					t.Fatalf("%s %q = %#v, want empty array", tc.path, key, payload[key])
				}
			}
		})
	}
}

func TestRedactAccountPayloadCoversRefreshResults(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	identity := service.Identity{
		Role: service.AuthRoleUser,
		APIPermissions: []string{
			service.APIPermissionKey(http.MethodGet, "/api/accounts"),
			service.APIPermissionKey(http.MethodPost, "/api/accounts/refresh"),
		},
	}
	payload := map[string]any{
		"items": []map[string]any{{
			"id":           "account-1",
			"access_token": "token-1",
		}},
		"errors": []map[string]string{{
			"access_token": "token-2",
			"error":        "failed",
		}},
		"results": []map[string]any{{
			"access_token": "token-3",
			"success":      false,
			"message":      "failed",
		}},
	}

	app.redactAccountPayloadForIdentity(identity, payload)

	items := payload["items"].([]map[string]any)
	if _, ok := items[0]["access_token"]; ok {
		t.Fatalf("items should not expose access_token: %#v", items[0])
	}
	errors := payload["errors"].([]map[string]string)
	if _, ok := errors[0]["access_token"]; ok {
		t.Fatalf("errors should not expose access_token: %#v", errors[0])
	}
	if errors[0]["account_id"] != util.SHA1Short("token-2", 16) {
		t.Fatalf("error account_id = %#v, want hash", errors[0]["account_id"])
	}
	results := payload["results"].([]map[string]any)
	if _, ok := results[0]["access_token"]; ok {
		t.Fatalf("results should not expose access_token: %#v", results[0])
	}
	if results[0]["account_id"] != util.SHA1Short("token-3", 16) {
		t.Fatalf("result account_id = %#v, want hash", results[0]["account_id"])
	}
}

func TestRBACImageDeletePermissionAllowsDelegatedUser(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "image-operator", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	imageRel := "delegated-delete.png"
	imagePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(imageRel))
	if err := writeHTTPTestPNG(imagePath); err != nil {
		t.Fatalf("write test image: %v", err)
	}
	app.images.RecordGeneratedImages([]string{imageRel}, "another-owner", "Another Owner", service.ImageVisibilityPrivate)

	req := httptest.NewRequest(http.MethodDelete, "/api/images", strings.NewReader(`{"paths":["delegated-delete.png"]}`))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("default user delete status = %d body = %s", res.Code, res.Body.String())
	}

	role, err := app.auth.CreateRole(map[string]any{
		"name":            "image manager",
		"menu_paths":      []string{"/image-manager"},
		"api_permissions": []string{service.APIPermissionKey(http.MethodDelete, "/api/images")},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	updated := app.auth.UpdateUser(user["id"].(string), map[string]any{"role_id": role["id"]})
	if updated == nil {
		t.Fatal("UpdateUser() returned nil")
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/images", strings.NewReader(`{"paths":["delegated-delete.png"]}`))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("granted user delete status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("delete json: %v", err)
	}
	if deleted, _ := payload["deleted"].(float64); int(deleted) != 1 {
		t.Fatalf("deleted = %#v body = %#v", payload["deleted"], payload)
	}
	if _, err := os.Stat(imagePath); !os.IsNotExist(err) {
		t.Fatalf("image path still exists or stat failed unexpectedly: %v", err)
	}
}

func TestLoginPageImageUploadSettings(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/app-meta", nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("app meta status = %d body = %s", res.Code, res.Body.String())
	}
	var meta map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &meta); err != nil {
		t.Fatalf("app meta json: %v", err)
	}
	if meta["login_page_image_url"] != "" || meta["login_page_image_mode"] != "contain" {
		t.Fatalf("initial app meta = %#v", meta)
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	_ = writer.WriteField("login_page_image_action", "replace")
	_ = writer.WriteField("login_page_image_mode", "cover")
	_ = writer.WriteField("login_page_image_zoom", "1.25")
	_ = writer.WriteField("login_page_image_position_x", "40")
	_ = writer.WriteField("login_page_image_position_y", "60")
	part, err := writer.CreateFormFile("login_page_image_file", "panel.png")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if err := encodeHTTPTestPNG(part); err != nil {
		t.Fatalf("encode upload png: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/settings/login-page-image", body)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("upload status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("upload json: %v", err)
	}
	config, _ := payload["config"].(map[string]any)
	imageURL, _ := config["login_page_image_url"].(string)
	if !strings.HasPrefix(imageURL, "/login-page-images/") {
		t.Fatalf("uploaded image url = %#v in %#v", imageURL, payload)
	}
	if config["login_page_image_mode"] != "cover" || config["login_page_image_zoom"] != float64(1.25) {
		t.Fatalf("login page image config = %#v", config)
	}

	req = httptest.NewRequest(http.MethodGet, imageURL, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("uploaded image static status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/app-meta", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("app meta after upload status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &meta); err != nil {
		t.Fatalf("app meta after upload json: %v", err)
	}
	if meta["login_page_image_url"] != imageURL || meta["login_page_image_mode"] != "cover" {
		t.Fatalf("app meta after upload = %#v", meta)
	}
}

func TestModelConfigAllowsAuthenticatedUserWithoutExplicitPermission(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	req := httptest.NewRequest(http.MethodGet, "/api/model-config", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("model config status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("model config json: %v", err)
	}
	config, _ := payload["config"].(map[string]any)
	if config["default_image_model"] == "" || config["default_chat_model"] == "" {
		t.Fatalf("model config = %#v", payload)
	}
}

func TestImageManagementIsScopedByOwner(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	owner := service.AuthOwner{ID: "linuxdo:123", Name: "alice", Provider: service.AuthProviderLinuxDo}
	_, sessionKey, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession() error = %v", err)
	}
	aliceRel := "2026/04/29/alice.png"
	bobRel := "2026/04/29/bob.png"
	legacyRel := "2026/04/29/legacy.png"
	for _, rel := range []string{aliceRel, bobRel, legacyRel} {
		path := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir image dir: %v", err)
		}
		if err := writeHTTPTestPNG(path); err != nil {
			t.Fatalf("write image %s: %v", rel, err)
		}
	}
	app.images.RecordImageOwners([]string{aliceRel}, owner.ID)
	app.images.RecordImageOwners([]string{bobRel}, "linuxdo:456")

	req := httptest.NewRequest(http.MethodGet, "/api/images", nil)
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("linuxdo images status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("linuxdo images json: %v", err)
	}
	items := logItems(list)
	if len(items) != 1 || items[0]["path"] != aliceRel {
		t.Fatalf("linuxdo scoped images = %#v", list)
	}
	if items[0]["owner_name"] != owner.Name || items[0]["visibility"] != service.ImageVisibilityPrivate {
		t.Fatalf("linuxdo image metadata = %#v", items[0])
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(`{"path":"`+aliceRel+`","visibility":"public"}`))
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("linuxdo publish image status = %d body = %s", res.Code, res.Body.String())
	}
	var visibilityBody map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &visibilityBody); err != nil {
		t.Fatalf("visibility json: %v", err)
	}
	updatedItem, _ := visibilityBody["item"].(map[string]any)
	if updatedItem["visibility"] != service.ImageVisibilityPublic || updatedItem["owner_name"] != owner.Name {
		t.Fatalf("publish image response = %#v", visibilityBody)
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(`{"path":"`+bobRel+`","visibility":"public"}`))
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("linuxdo publish other image status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=public", nil)
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("public images status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("public images json: %v", err)
	}
	if items := logItems(list); len(items) != 1 || items[0]["path"] != aliceRel || items[0]["owner_name"] != owner.Name {
		t.Fatalf("public scoped images = %#v", list)
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(`{"path":"`+aliceRel+`","visibility":"private"}`))
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("linuxdo unpublish image status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=public", nil)
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("public images after unpublish status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("public images after unpublish json: %v", err)
	}
	if items := logItems(list); len(items) != 0 {
		t.Fatalf("unpublished image should leave public gallery: %#v", list)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images?scope=public", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin public gallery status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("admin public gallery json: %v", err)
	}
	items = logItems(list)
	if len(items) != 3 {
		t.Fatalf("admin public gallery should see all images, got %#v", list)
	}
	seenPaths := make(map[string]bool, len(items))
	for _, item := range items {
		path, _ := item["path"].(string)
		seenPaths[path] = true
	}
	if !seenPaths[aliceRel] || !seenPaths[bobRel] || !seenPaths[legacyRel] {
		t.Fatalf("admin public gallery paths = %#v", items)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/images", strings.NewReader(`{"paths":["`+bobRel+`","`+aliceRel+`"]}`))
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("linuxdo delete images status = %d body = %s", res.Code, res.Body.String())
	}
	if _, err := os.Stat(filepath.Join(app.config.ImagesDir(), filepath.FromSlash(aliceRel))); err != nil {
		t.Fatalf("alice image should not be deleted by Linuxdo user, stat error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(app.config.ImagesDir(), filepath.FromSlash(bobRel))); err != nil {
		t.Fatalf("bob image should not be deleted, stat error = %v", err)
	}

	_, localKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "local user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey(local) error = %v", err)
	}
	req = httptest.NewRequest(http.MethodDelete, "/api/images", strings.NewReader(`{"paths":["`+aliceRel+`"]}`))
	req.Header.Set("Authorization", "Bearer "+localKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("local user delete images status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/images", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin images status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("admin images json: %v", err)
	}
	if items := logItems(list); len(items) != 3 {
		t.Fatalf("admin should see owned and legacy images, got %#v", list)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/images", strings.NewReader(`{"paths":["`+aliceRel+`"]}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin delete images status = %d body = %s", res.Code, res.Body.String())
	}
	var deleteBody map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &deleteBody); err != nil {
		t.Fatalf("admin delete images json: %v", err)
	}
	if deleteBody["deleted"] != float64(1) || deleteBody["missing"] != float64(0) {
		t.Fatalf("admin delete images body = %#v", deleteBody)
	}
	if _, err := os.Stat(filepath.Join(app.config.ImagesDir(), filepath.FromSlash(aliceRel))); !os.IsNotExist(err) {
		t.Fatalf("alice image should be deleted by admin, stat error = %v", err)
	}
}

func TestManagedImageFilesRequireOwnerOrPublicAccess(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	owner := service.AuthOwner{ID: "linuxdo:123", Name: "alice", Provider: service.AuthProviderLinuxDo}
	_, aliceKey, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(alice) error = %v", err)
	}
	_, bobKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "bob", service.AuthOwner{ID: "linuxdo:456", Name: "bob", Provider: service.AuthProviderLinuxDo})
	if err != nil {
		t.Fatalf("CreateAPIKey(bob) error = %v", err)
	}

	rel := "2026/05/01/1777664437_f5b9d1d2cd2a380307ca9fb32c1a84d1.png"
	imagePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		t.Fatalf("mkdir image dir: %v", err)
	}
	if err := writeHTTPTestPNG(imagePath); err != nil {
		t.Fatalf("write image: %v", err)
	}
	app.images.RecordGeneratedImages([]string{rel}, owner.ID, owner.Name, service.ImageVisibilityPrivate, service.GeneratedImageMetadata{
		ReferenceImages: []service.GeneratedImageReference{
			{Filename: "private-source.png", ContentType: "image/png", Data: []byte("private-reference")},
		},
	})
	privateList := app.images.ListImages("http://127.0.0.1:8000", "", "", service.ImageAccessScope{All: true})
	privateItems := privateList["items"].([]map[string]any)
	if len(privateItems) != 1 {
		t.Fatalf("private image list = %#v", privateList)
	}
	privateReferenceURLs, ok := privateItems[0]["reference_image_urls"].([]string)
	if !ok || len(privateReferenceURLs) != 1 {
		t.Fatalf("private reference urls = %#v", privateItems[0])
	}
	parsedPrivateReferenceURL, err := url.Parse(privateReferenceURLs[0])
	if err != nil {
		t.Fatalf("parse private reference url: %v", err)
	}
	privateReferencePath := parsedPrivateReferenceURL.RequestURI()

	req := httptest.NewRequest(http.MethodGet, "/images/2026/05/01", nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("image directory listing status = %d body = %q, want 404", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/images/"+rel, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous private image status = %d body = %q, want 401", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, privateReferencePath, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous private reference status = %d body = %q, want 401", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, privateReferencePath, nil)
	req.Header.Set("Authorization", "Bearer "+bobKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("other user private reference status = %d body = %q, want 404", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, privateReferencePath, nil)
	req.Header.Set("Authorization", "Bearer "+aliceKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.String() != "private-reference" {
		t.Fatalf("owner private reference status/body = %d %q", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/images/"+rel, nil)
	req.Header.Set("Authorization", "Bearer "+bobKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("other user private image status = %d body = %q, want 404", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/images/"+rel, nil)
	req.Header.Set("Authorization", "Bearer "+aliceKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("owner private image status = %d body = %q", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); !strings.Contains(got, "image/png") {
		t.Fatalf("owner private image Content-Type = %q, want image/png", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/images/"+rel, nil)
	req.AddCookie(&http.Cookie{Name: authSessionCookieName, Value: aliceKey})
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("owner private image cookie status = %d body = %q", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodHead, "/images/"+rel, nil)
	req.Header.Set("Authorization", "Bearer "+aliceKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("owner private image HEAD status = %d body = %q", res.Code, res.Body.String())
	}
	if res.Body.Len() != 0 {
		t.Fatalf("owner private image HEAD body length = %d, want 0", res.Body.Len())
	}

	if _, err := app.images.UpdateImageVisibility(rel, service.ImageVisibilityPublic, service.ImageAccessScope{OwnerID: owner.ID}); err != nil {
		t.Fatalf("publish image: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, "/images/"+rel, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("anonymous public image status = %d body = %q", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, privateReferencePath, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous unshared public reference status = %d body = %q, want 401", res.Code, res.Body.String())
	}

	if _, err := app.images.UpdateImageVisibility(rel, service.ImageVisibilityPublic, service.ImageAccessScope{OwnerID: owner.ID}, service.ImageVisibilityUpdateOptions{SharePromptParams: true, ShareReferences: true}); err != nil {
		t.Fatalf("publish reference metadata: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, privateReferencePath, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.String() != "private-reference" {
		t.Fatalf("anonymous shared public reference status/body = %d %q", res.Code, res.Body.String())
	}
}

func TestImageVisibilityImportsExternalImageURL(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	ownerID := util.Clean(user["id"])
	imageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		if err := encodeHTTPTestPNG(w); err != nil {
			t.Fatalf("encode test image: %v", err)
		}
	}))
	defer imageServer.Close()

	req := httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(fmt.Sprintf(`{"path":%q,"visibility":"public"}`, imageServer.URL+"/relay.png")))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("import external image visibility status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("visibility json: %v", err)
	}
	item := util.StringMap(payload["item"])
	localPath := util.Clean(item["path"])
	if localPath == "" || strings.HasPrefix(localPath, "http") || item["visibility"] != service.ImageVisibilityPublic {
		t.Fatalf("imported visibility item = %#v", item)
	}
	access, err := app.images.ImageFileAccess(localPath, service.ImageAccessScope{OwnerID: ownerID})
	if err != nil {
		t.Fatalf("imported image is not accessible: %v", err)
	}
	if access.Visibility != service.ImageVisibilityPublic || access.OwnerID != ownerID {
		t.Fatalf("imported image access = %#v", access)
	}
}

func TestImageVisibilityImportsDataURL(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	ownerID := util.Clean(user["id"])
	var imageData bytes.Buffer
	if err := encodeHTTPTestPNG(&imageData); err != nil {
		t.Fatalf("encode test image: %v", err)
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageData.Bytes())

	req := httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(fmt.Sprintf(`{"path":%q,"visibility":"public"}`, dataURL)))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("import data URL visibility status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("visibility json: %v", err)
	}
	item := util.StringMap(payload["item"])
	localPath := util.Clean(item["path"])
	if localPath == "" || strings.HasPrefix(localPath, "data:") || item["visibility"] != service.ImageVisibilityPublic {
		t.Fatalf("imported data URL visibility item = %#v", item)
	}
	access, err := app.images.ImageFileAccess(localPath, service.ImageAccessScope{OwnerID: ownerID})
	if err != nil {
		t.Fatalf("imported data URL image is not accessible: %v", err)
	}
	if access.Visibility != service.ImageVisibilityPublic || access.OwnerID != ownerID {
		t.Fatalf("imported data URL image access = %#v", access)
	}
}

func TestImageVisibilityAcceptsThumbnailURL(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	owner := service.AuthOwner{ID: "linuxdo:123", Name: "alice", Provider: service.AuthProviderLinuxDo}
	_, rawKey, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession() error = %v", err)
	}
	rel := "2026/05/01/1777664437_f5b9d1d2cd2a380307ca9fb32c1a84d1.png"
	imagePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		t.Fatalf("mkdir image dir: %v", err)
	}
	if err := writeHTTPTestPNG(imagePath); err != nil {
		t.Fatalf("write image: %v", err)
	}
	app.images.RecordGeneratedImages([]string{rel}, owner.ID, owner.Name, service.ImageVisibilityPrivate)
	list := app.images.ListImages("https://gallery.example", "", "", service.ImageAccessScope{OwnerID: owner.ID})
	items, _ := list["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatalf("ListImages() = %#v", list)
	}
	thumbnailURL := util.Clean(items[0]["thumbnail_url"])
	if !strings.Contains(thumbnailURL, "/image-thumbnails/") {
		t.Fatalf("thumbnail_url = %q", thumbnailURL)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(fmt.Sprintf(`{"path":%q,"visibility":"public"}`, thumbnailURL)))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("publish thumbnail URL status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("visibility json: %v", err)
	}
	item := util.StringMap(payload["item"])
	if item["path"] != rel || item["visibility"] != service.ImageVisibilityPublic {
		t.Fatalf("published thumbnail URL item = %#v", item)
	}
}

func TestImageThumbnailsAreGeneratedOnDemand(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	rel := "2026/04/29/sample.png"
	imagePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		t.Fatalf("mkdir image dir: %v", err)
	}
	if err := writeHTTPTestPNG(imagePath); err != nil {
		t.Fatalf("write image: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/images", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("/api/images status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("/api/images json: %v", err)
	}
	items := logItems(list)
	if len(items) != 1 {
		t.Fatalf("/api/images items = %#v", list)
	}
	thumbnailURL, _ := items[0]["thumbnail_url"].(string)
	if !strings.Contains(thumbnailURL, "/image-thumbnails/") {
		t.Fatalf("thumbnail_url = %q, want lazy thumbnail route", thumbnailURL)
	}
	parsedThumbnailURL, err := url.Parse(thumbnailURL)
	if err != nil {
		t.Fatalf("parse thumbnail URL: %v", err)
	}
	if !strings.HasSuffix(parsedThumbnailURL.Path, ".jpg") {
		t.Fatalf("thumbnail path = %q, want .jpg suffix", parsedThumbnailURL.Path)
	}
	if parsedThumbnailURL.Query().Get("v") == "" {
		t.Fatalf("thumbnail URL = %q, want cache-busting query", thumbnailURL)
	}
	thumbPath := filepath.Join(app.config.ImageThumbnailsDir(), filepath.FromSlash(rel)+".jpg")
	if _, err := os.Stat(thumbPath); !os.IsNotExist(err) {
		t.Fatalf("/api/images should not create thumbnail synchronously, stat error = %v", err)
	}

	req = httptest.NewRequest(http.MethodGet, parsedThumbnailURL.Path, nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("thumbnail status = %d body = %s", res.Code, res.Body.String())
	}
	if res.Body.Len() == 0 {
		t.Fatal("thumbnail body is empty")
	}
	if got := res.Header().Get("Cache-Control"); got != imageThumbnailCacheControl {
		t.Fatalf("thumbnail Cache-Control = %q, want %q", got, imageThumbnailCacheControl)
	}
	if got := res.Header().Get("Content-Type"); !strings.Contains(got, "image/jpeg") {
		t.Fatalf("thumbnail Content-Type = %q, want image/jpeg", got)
	}
	if _, err := os.Stat(thumbPath); err != nil {
		t.Fatalf("thumbnail was not created on demand: %v", err)
	}
}

func TestManagedImageThumbnailsRequireOwnerOrPublicAccess(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	owner := service.AuthOwner{ID: "linuxdo:123", Name: "alice", Provider: service.AuthProviderLinuxDo}
	_, aliceKey, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(alice) error = %v", err)
	}
	_, bobKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "bob", service.AuthOwner{ID: "linuxdo:456", Name: "bob", Provider: service.AuthProviderLinuxDo})
	if err != nil {
		t.Fatalf("CreateAPIKey(bob) error = %v", err)
	}

	rel := "2026/05/01/private.png"
	imagePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		t.Fatalf("mkdir image dir: %v", err)
	}
	if err := writeHTTPTestPNG(imagePath); err != nil {
		t.Fatalf("write image: %v", err)
	}
	app.images.RecordGeneratedImages([]string{rel}, owner.ID, owner.Name, service.ImageVisibilityPrivate)
	thumbnailPath := "/image-thumbnails/" + rel + ".jpg"

	req := httptest.NewRequest(http.MethodGet, thumbnailPath, nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous private thumbnail status = %d body = %q, want 401", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, thumbnailPath, nil)
	req.Header.Set("Authorization", "Bearer "+bobKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("other user private thumbnail status = %d body = %q, want 404", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, thumbnailPath, nil)
	req.Header.Set("Authorization", "Bearer "+aliceKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("owner private thumbnail status = %d body = %q", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); !strings.Contains(got, "image/jpeg") {
		t.Fatalf("owner private thumbnail Content-Type = %q, want image/jpeg", got)
	}

	req = httptest.NewRequest(http.MethodGet, thumbnailPath, nil)
	req.AddCookie(&http.Cookie{Name: authSessionCookieName, Value: aliceKey})
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("owner private thumbnail cookie status = %d body = %q", res.Code, res.Body.String())
	}

	if _, err := app.images.UpdateImageVisibility(rel, service.ImageVisibilityPublic, service.ImageAccessScope{OwnerID: owner.ID}); err != nil {
		t.Fatalf("publish image: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, thumbnailPath, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("anonymous public thumbnail status = %d body = %q", res.Code, res.Body.String())
	}
}

func TestAuthSessionCookieLifecycle(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", res.Code, res.Body.String())
	}
	cookie := findResponseCookie(res.Result(), authSessionCookieName)
	if cookie == nil || cookie.Value == "" || cookie.Path != "/" || !cookie.HttpOnly {
		t.Fatalf("login cookie = %#v", cookie)
	}
	if got := cookie.SameSite; got != http.SameSiteLaxMode {
		t.Fatalf("login cookie SameSite = %v, want Lax", got)
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	req.AddCookie(cookie)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logout status = %d body = %s", res.Code, res.Body.String())
	}
	cleared := findResponseCookie(res.Result(), authSessionCookieName)
	if cleared == nil || cleared.MaxAge >= 0 || cleared.Value != "" {
		t.Fatalf("logout cookie = %#v", cleared)
	}
}

func TestAuthSessionCookieUsesRelayAIParentDomain(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	for _, host := range []string{"relayai.tech", "image.relayai.tech"} {
		req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
		req.Host = host
		req.Header.Set("X-Forwarded-Proto", "https")
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("login %s status = %d body = %s", host, res.Code, res.Body.String())
		}
		cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "relayai.tech")
		if cookie == nil || cookie.Value == "" || cookie.Path != "/" || !cookie.HttpOnly || !cookie.Secure {
			t.Fatalf("login %s domain cookie = %#v", host, cookie)
		}
		if got := cookie.SameSite; got != http.SameSiteLaxMode {
			t.Fatalf("login %s cookie SameSite = %v, want Lax", host, got)
		}
	}
}

func TestAuthSessionCookieDomainOverride(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Setenv("CHATGPT2API_AUTH_COOKIE_DOMAIN", "accounts.example.test")

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
	req.Host = "relayai.tech"
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", res.Code, res.Body.String())
	}
	cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "accounts.example.test")
	if cookie == nil || cookie.Value == "" {
		t.Fatalf("override domain cookie = %#v", cookie)
	}
}

func TestAuthSessionCanRestoreFromSharedCookie(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
	req.Host = "relayai.tech"
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", res.Code, res.Body.String())
	}
	cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "relayai.tech")
	if cookie == nil || cookie.Value == "" {
		t.Fatalf("login domain cookie = %#v", cookie)
	}

	req = httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	req.Host = "image.relayai.tech"
	req.AddCookie(&http.Cookie{Name: authSessionCookieName, Value: cookie.Value})
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("session status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("session json: %v", err)
	}
	if payload["token"] != cookie.Value || payload["username"] != testAdminUsername {
		t.Fatalf("session payload = %#v", payload)
	}
	refreshed := findResponseCookieByDomain(res.Result(), authSessionCookieName, "relayai.tech")
	if refreshed == nil || refreshed.Value != cookie.Value {
		t.Fatalf("session refreshed cookie = %#v", refreshed)
	}
}

func TestLogoutClearsSharedAndHostOnlyAuthCookies(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
	req.Host = "relayai.tech"
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", res.Code, res.Body.String())
	}
	cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "relayai.tech")
	if cookie == nil || cookie.Value == "" {
		t.Fatalf("login domain cookie = %#v", cookie)
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	req.Host = "relayai.tech"
	req.AddCookie(&http.Cookie{Name: authSessionCookieName, Value: cookie.Value})
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logout status = %d body = %s", res.Code, res.Body.String())
	}
	shared := findResponseCookieByDomain(res.Result(), authSessionCookieName, "relayai.tech")
	if shared == nil || shared.MaxAge >= 0 || shared.Value != "" {
		t.Fatalf("shared logout cookie = %#v", shared)
	}
	hostOnly := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
	if hostOnly == nil || hostOnly.MaxAge >= 0 || hostOnly.Value != "" {
		t.Fatalf("host-only logout cookie = %#v", hostOnly)
	}
}

func TestLoginAllowsCredentialedLoopbackFrontend(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
	req.Host = "127.0.0.1:8000"
	req.Header.Set("Origin", "http://localhost:5173")
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want frontend origin", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
	if cookie := findResponseCookie(res.Result(), authSessionCookieName); cookie == nil || cookie.Value == "" {
		t.Fatalf("login cookie = %#v", cookie)
	}
}

func TestRelayAISubdomainAllowsCredentialedCORS(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/auth/session", nil)
	req.Host = "relayai.tech"
	req.Header.Set("Origin", "https://image.relayai.tech")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "https://image.relayai.tech" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want image origin", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
}

func TestRelayAISubdomainAllowsCredentialedCORSWithForwardedHost(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/auth/session", nil)
	req.Host = "127.0.0.1:8000"
	req.Header.Set("X-Forwarded-Host", "relayai.tech")
	req.Header.Set("Origin", "https://image.relayai.tech")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "https://image.relayai.tech" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want image origin", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
}

func TestRelayAISubdomainAllowsCredentialedCORSBehindProxyHost(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/images/2026/05/21/sample.png", nil)
	req.Host = "chatgpt2api"
	req.Header.Set("Origin", "https://image.relayai.tech")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "https://image.relayai.tech" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want image origin", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
}

func TestCredentialedLoginPreflightAllowsContentType(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/auth/login", nil)
	req.Host = "127.0.0.1:8000"
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want request origin", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Headers"); got != "content-type" {
		t.Fatalf("Access-Control-Allow-Headers = %q, want content-type", got)
	}
}

func TestCredentialedImageVisibilityPreflightAllowsPatchAuthorization(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/api/images/visibility", nil)
	req.Host = "127.0.0.1:8000"
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", http.MethodPatch)
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want request origin", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Methods"); got != http.MethodPatch {
		t.Fatalf("Access-Control-Allow-Methods = %q, want PATCH", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Headers"); got != "authorization,content-type" {
		t.Fatalf("Access-Control-Allow-Headers = %q, want authorization,content-type", got)
	}
}

func TestImageThumbnailRejectsTraversal(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	outsideThumbnailRoot := filepath.Join(app.config.DataDir, "secret.png.jpg")
	if err := os.WriteFile(outsideThumbnailRoot, []byte("secret"), 0o644); err != nil {
		t.Fatalf("write outside thumbnail root: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/image-thumbnails/../secret.png.jpg", nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("thumbnail traversal status = %d body = %q, want 404", res.Code, res.Body.String())
	}
}

func TestLinuxDoUserCanManageOwnKeys(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	owner := service.AuthOwner{ID: "linuxdo:123", Name: "linuxdo_user", Provider: service.AuthProviderLinuxDo, LinuxDoLevel: "3"}
	_, sessionKey, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession() error = %v", err)
	}
	_, otherKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "other user key", service.AuthOwner{ID: "linuxdo:456", Name: "other", Provider: service.AuthProviderLinuxDo})
	if err != nil || otherKey == "" {
		t.Fatalf("CreateAPIKey(other) key=%q err=%v", otherKey, err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/users", nil)
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("linuxdo initial list status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("initial list json: %v", err)
	}
	if rawItems, ok := list["items"].([]any); !ok || len(rawItems) != 0 {
		t.Fatalf("linuxdo initial list should be empty array, got %#v", list)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/auth/users", strings.NewReader(`{"name":"linuxdo api"}`))
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("linuxdo create key status = %d body = %s", res.Code, res.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("create key json: %v", err)
	}
	item, _ := created["item"].(map[string]any)
	if item["owner_id"] != owner.ID || item["provider"] != service.AuthProviderLinuxDo {
		t.Fatalf("created key owner = %#v", item)
	}
	firstKey, _ := created["key"].(string)
	firstID, _ := item["id"].(string)

	req = httptest.NewRequest(http.MethodPost, "/api/auth/users", strings.NewReader(`{"name":"linuxdo api refreshed"}`))
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("linuxdo reset key status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("reset key json: %v", err)
	}
	item, _ = created["item"].(map[string]any)
	resetKey, _ := created["key"].(string)
	if item["id"] != firstID || resetKey == "" || resetKey == firstKey {
		t.Fatalf("reset key did not rotate in place: item=%#v key=%q first=%q", item, resetKey, firstKey)
	}
	if app.auth.Authenticate(firstKey) != nil {
		t.Fatal("old Linuxdo API key still authenticated after reset")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/auth/users", nil)
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("linuxdo list keys status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("list keys json: %v", err)
	}
	if items := logItems(list); len(items) != 1 || items[0]["owner_id"] != owner.ID {
		t.Fatalf("linuxdo scoped list = %#v", list)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/auth/users", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin list keys status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("admin list json: %v", err)
	}
	if items := logItems(list); len(items) != 2 {
		t.Fatalf("admin should see all API keys, got %#v", list)
	}

	_, unownedKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "legacy user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey(unowned) error = %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/auth/users", strings.NewReader(`{"name":"should fail"}`))
	req.Header.Set("Authorization", "Bearer "+unownedKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("unowned user key manage status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfileAPIKeyIsPersonalAndPermissionIndependent(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, _ := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	role, err := app.auth.CreateRole(map[string]any{
		"name":            "creative only",
		"menu_paths":      []string{"/image"},
		"api_permissions": []string{service.APIPermissionKey("GET", "/v1/models")},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	if updated := app.auth.UpdateUser(user.ID, map[string]any{"role_id": role["id"]}); updated == nil {
		t.Fatal("UpdateUser(role) returned nil")
	}
	_, userSession, err := app.auth.LoginPassword("alice", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword(user) error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/users", nil)
	req.Header.Set("Authorization", "Bearer "+userSession)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("restricted user /api/auth/users status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/api-key", nil)
	req.Header.Set("Authorization", "Bearer "+userSession)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("profile key list status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("profile key list json: %v", err)
	}
	if items := logItems(list); len(items) != 0 {
		t.Fatalf("new profile key list should be empty: %#v", list)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/api-key", strings.NewReader(`{"name":"Alice API"}`))
	req.Header.Set("Authorization", "Bearer "+userSession)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("profile key create status = %d body = %s", res.Code, res.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("profile key create json: %v", err)
	}
	item, _ := created["item"].(map[string]any)
	firstID, _ := item["id"].(string)
	firstKey, _ := created["key"].(string)
	if firstID == "" || firstKey == "" || item["owner_id"] != user.ID || item["role"] != service.AuthRoleUser {
		t.Fatalf("profile key create body = %#v", created)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/api-key", strings.NewReader(`{"name":"Alice API rotated"}`))
	req.Header.Set("Authorization", "Bearer "+userSession)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("profile key rotate status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("profile key rotate json: %v", err)
	}
	item, _ = created["item"].(map[string]any)
	rotatedKey, _ := created["key"].(string)
	if item["id"] != firstID || rotatedKey == "" || rotatedKey == firstKey {
		t.Fatalf("profile key rotate body = %#v first=%q", created, firstKey)
	}
	if app.auth.Authenticate(firstKey) != nil {
		t.Fatal("old profile API key still authenticated after rotation")
	}
	if identity := app.auth.Authenticate(rotatedKey); identity == nil || identity.ID != user.ID || identity.RoleID != role["id"] {
		t.Fatalf("rotated profile API identity = %#v", identity)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/api-key", strings.NewReader(`{"name":"Admin API"}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin profile key create status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("admin profile key create json: %v", err)
	}
	adminKey, _ := created["key"].(string)
	item, _ = created["item"].(map[string]any)
	if adminKey == "" || item["role"] != service.AuthRoleAdmin || item["owner_id"] != service.AuthRoleAdmin {
		t.Fatalf("admin profile key body = %#v", created)
	}
	if identity := app.auth.Authenticate(adminKey); identity == nil || identity.Role != service.AuthRoleAdmin {
		t.Fatalf("admin profile API identity = %#v", identity)
	}
}

func TestProfilePromptFavoritesArePersonalAndPermissionIndependent(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, _ := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	role, err := app.auth.CreateRole(map[string]any{
		"name":            "models only",
		"menu_paths":      []string{"/image"},
		"api_permissions": []string{service.APIPermissionKey("GET", "/v1/models")},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	if updated := app.auth.UpdateUser(user.ID, map[string]any{"role_id": role["id"]}); updated == nil {
		t.Fatal("UpdateUser(role) returned nil")
	}
	_, aliceToken, err := app.auth.LoginPassword("alice", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword(alice) error = %v", err)
	}

	other, otherToken := createPasswordUserSession(t, app, "bob", "Password123", "Bob")

	req := httptest.NewRequest(http.MethodGet, "/api/profile/prompt-favorites", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("initial list status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("initial list json: %v", err)
	}
	if items := logItems(list); len(items) != 0 {
		t.Fatalf("initial list should be empty: %#v", list)
	}

	body := `{
		"prompt_id":"banana-prompt-quicker:title:author:1",
		"source":"banana-prompt-quicker",
		"title":"Prompt A",
		"preview":"https://example.test/a.png",
		"reference_image_urls":["https://example.test/ref.png"],
		"prompt":"draw a cat",
		"author":"Alice",
		"mode":"edit",
		"category":"Animals",
		"sub_category":"Cats",
		"source_label":"banana-prompt-quicker",
		"is_nsfw":false,
		"localizations":{"zh-CN":{"title":"提示词 A","prompt":"画猫","category":"动物","sub_category":"猫"}}
	}`
	req = httptest.NewRequest(http.MethodPost, "/api/profile/prompt-favorites", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create favorite status = %d body = %s", res.Code, res.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("create favorite json: %v", err)
	}
	item, _ := created["item"].(map[string]any)
	favoriteID, _ := item["id"].(string)
	if favoriteID == "" || item["title"] != "Prompt A" || item["prompt_id"] != "banana-prompt-quicker:title:author:1" {
		t.Fatalf("create favorite body = %#v", created)
	}
	if items := logItems(created); len(items) != 1 {
		t.Fatalf("created items length = %d body = %#v", len(items), created)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/prompt-favorites", strings.NewReader(strings.Replace(body, "Prompt A", "Prompt A Updated", 1)))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("duplicate favorite status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("duplicate favorite json: %v", err)
	}
	if items := logItems(created); len(items) != 1 || items[0]["title"] != "Prompt A Updated" {
		t.Fatalf("duplicate favorite should update in place: %#v", created)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/prompt-favorites", nil)
	req.Header.Set("Authorization", "Bearer "+otherToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("other list status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("other list json: %v", err)
	}
	if items := logItems(list); len(items) != 0 {
		t.Fatalf("other user saw favorites, user=%s other=%s list=%#v", user.ID, other.ID, list)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/profile/prompt-favorites/"+favoriteID, nil)
	req.Header.Set("Authorization", "Bearer "+otherToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("other delete status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/profile/prompt-favorites/"+favoriteID, nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("delete favorite status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("delete favorite json: %v", err)
	}
	if items := logItems(list); len(items) != 0 {
		t.Fatalf("favorite remained after delete: %#v", list)
	}

	_, unownedKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "legacy user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey(unowned) error = %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/profile/prompt-favorites", nil)
	req.Header.Set("Authorization", "Bearer "+unownedKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("unowned key list status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfilePromptFavoritesAdultContentRequiresPermission(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, _ := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	restrictedRole, err := app.auth.CreateRole(map[string]any{
		"name":            "safe prompt market",
		"menu_paths":      []string{"/image"},
		"api_permissions": []string{service.APIPermissionKey("GET", "/v1/models")},
	})
	if err != nil {
		t.Fatalf("CreateRole(restricted) error = %v", err)
	}
	if updated := app.auth.UpdateUser(user.ID, map[string]any{"role_id": restrictedRole["id"]}); updated == nil {
		t.Fatal("UpdateUser(restricted role) returned nil")
	}
	_, restrictedToken, err := app.auth.LoginPassword("alice", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword(restricted) error = %v", err)
	}

	nsfwBody := `{
		"prompt_id":"banana-prompt-quicker:adult:1",
		"source":"banana-prompt-quicker",
		"title":"Adult Prompt",
		"preview":"https://example.test/adult.png",
		"prompt":"adult prompt",
		"author":"Alice",
		"mode":"generate",
		"category":"NSFW",
		"source_label":"banana-prompt-quicker",
		"is_nsfw":true
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/profile/prompt-favorites", strings.NewReader(nsfwBody))
	req.Header.Set("Authorization", "Bearer "+restrictedToken)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("restricted nsfw favorite status = %d body = %s", res.Code, res.Body.String())
	}

	if _, err := app.prompts.Upsert(user.ID, map[string]any{
		"prompt_id":    "seeded-adult",
		"source":       "banana-prompt-quicker",
		"title":        "Seeded Adult",
		"preview":      "https://example.test/seeded.png",
		"prompt":       "seeded adult prompt",
		"author":       "Alice",
		"mode":         "generate",
		"category":     "NSFW",
		"source_label": "banana-prompt-quicker",
		"is_nsfw":      true,
	}); err != nil {
		t.Fatalf("seed nsfw favorite: %v", err)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/prompt-favorites", nil)
	req.Header.Set("Authorization", "Bearer "+restrictedToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("restricted list status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("restricted list json: %v", err)
	}
	if items := logItems(list); len(items) != 0 {
		t.Fatalf("restricted user saw nsfw favorites: %#v", list)
	}

	adultRole, err := app.auth.CreateRole(map[string]any{
		"name":       "adult prompt market",
		"menu_paths": []string{"/image"},
		"api_permissions": []string{
			service.APIPermissionKey("GET", "/v1/models"),
			service.APIPermissionKey("GET", service.PromptMarketAdultPermissionPath),
		},
	})
	if err != nil {
		t.Fatalf("CreateRole(adult) error = %v", err)
	}
	if updated := app.auth.UpdateUser(user.ID, map[string]any{"role_id": adultRole["id"]}); updated == nil {
		t.Fatal("UpdateUser(adult role) returned nil")
	}
	_, adultToken, err := app.auth.LoginPassword("alice", "Password123")
	if err != nil {
		t.Fatalf("LoginPassword(adult) error = %v", err)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/prompt-favorites", strings.NewReader(nsfwBody))
	req.Header.Set("Authorization", "Bearer "+adultToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("adult nsfw favorite status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("adult create json: %v", err)
	}
	if items := logItems(list); len(items) != 2 {
		t.Fatalf("adult user should see nsfw favorites, got %#v", list)
	}
}

func TestAdminUsersManageLinuxDoUsers(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	owner := service.AuthOwner{ID: "linuxdo:123", Name: "linuxdo_user", Provider: service.AuthProviderLinuxDo, LinuxDoLevel: "3"}
	_, sessionKey, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession() error = %v", err)
	}
	_, ownerAPIKey, err := app.auth.UpsertAPIKeyForOwner("", owner)
	if err != nil {
		t.Fatalf("UpsertAPIKeyForOwner() error = %v", err)
	}
	local, localKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "local user", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey(local) error = %v", err)
	}
	localID, _ := local["id"].(string)
	app.logs.Add("文生图调用完成", map[string]any{
		"subject_id":  owner.ID,
		"key_id":      "linuxdo-session",
		"status":      "success",
		"endpoint":    "/v1/images/generations",
		"duration_ms": 120,
		"urls":        []string{"https://example.test/a.png", "https://example.test/b.png"},
	})
	app.logs.Add("文生图调用失败", map[string]any{
		"subject_id": owner.ID,
		"key_id":     "linuxdo-session",
		"status":     "failed",
		"endpoint":   "/v1/images/generations",
	})
	app.logs.Add("图生图调用完成", map[string]any{
		"key_id":   localID,
		"status":   "success",
		"endpoint": "/api/creation-tasks/image-edits",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	req.Header.Set("Authorization", "Bearer "+sessionKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("linuxdo admin users status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin users status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("admin users json: %v", err)
	}
	linuxdoUser := findHTTPItem(logItems(list), owner.ID)
	if linuxdoUser == nil || linuxdoUser["provider"] != service.AuthProviderLinuxDo || linuxdoUser["has_session"] != true || linuxdoUser["has_api_key"] != true {
		t.Fatalf("linuxdo managed user = %#v in %#v", linuxdoUser, list)
	}
	if linuxdoUser["linuxdo_level"] != "3" {
		t.Fatalf("linuxdo level = %#v", linuxdoUser)
	}
	localUser := findHTTPItem(logItems(list), localID)
	if localUser == nil || localUser["provider"] != service.AuthProviderLocal || localUser["has_api_key"] != true {
		t.Fatalf("local managed user = %#v in %#v", localUser, list)
	}
	if linuxdoUser["call_count"] != float64(2) || linuxdoUser["success_count"] != float64(1) || linuxdoUser["failure_count"] != float64(1) || linuxdoUser["quota_used"] != float64(2) {
		t.Fatalf("linuxdo usage stats = %#v", linuxdoUser)
	}
	if curve, ok := linuxdoUser["usage_curve"].([]any); !ok || len(curve) != 14 {
		t.Fatalf("linuxdo usage curve = %#v", linuxdoUser["usage_curve"])
	}
	if localUser["call_count"] != float64(1) || localUser["quota_used"] != float64(1) {
		t.Fatalf("local usage stats = %#v", localUser)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/users", strings.NewReader(`{"username":"created_local","name":"Created Local","password":"Password123","enabled":true}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create password user status = %d body = %s", res.Code, res.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("create password user json: %v", err)
	}
	createdItem, _ := created["item"].(map[string]any)
	if createdItem["username"] != "created_local" || createdItem["name"] != "Created Local" || createdItem["has_api_key"] != false || createdItem["has_session"] != false {
		t.Fatalf("create password user body = %#v", created)
	}
	if _, ok := created["key"]; ok {
		t.Fatalf("password user creation should not issue an API key: %#v", created)
	}
	createdID, _ := createdItem["id"].(string)
	createdPath := "/api/admin/users/" + url.PathEscape(createdID)

	req = httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"created_local","password":"Password123"}`))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("created local user should not use public login after NewAPI login switch, status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, createdPath+"/key", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("initial password user key reveal status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, createdPath+"/reset-key", strings.NewReader(`{"name":"rotated local"}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("reset local managed key status = %d body = %s", res.Code, res.Body.String())
	}
	var reset map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &reset); err != nil {
		t.Fatalf("reset local managed key json: %v", err)
	}
	rotatedLocalKey, _ := reset["key"].(string)
	if rotatedLocalKey == "" {
		t.Fatalf("reset local managed key body = %#v", reset)
	}
	if identity := app.auth.Authenticate(rotatedLocalKey); identity == nil || identity.ID != createdID {
		t.Fatalf("rotated local managed key identity = %#v", identity)
	}

	ownerPath := "/api/admin/users/" + url.PathEscape(owner.ID)
	req = httptest.NewRequest(http.MethodPost, ownerPath+"/reset-key", strings.NewReader(`{"name":"managed token"}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("reset linuxdo managed key status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, ownerPath+"/key", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("reveal linuxdo managed key status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, ownerPath, strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("disable managed user status = %d body = %s", res.Code, res.Body.String())
	}
	if app.auth.Authenticate(sessionKey) != nil || app.auth.Authenticate(ownerAPIKey) != nil {
		t.Fatal("disabled linuxdo user credentials still authenticate")
	}
	if app.auth.Authenticate(localKey) == nil {
		t.Fatal("disabling linuxdo user should not affect local user")
	}
	disabledLoginItem, disabledLoginKey, err := app.auth.UpsertLinuxDoSession(owner)
	if err != nil {
		t.Fatalf("UpsertLinuxDoSession(disabled) error = %v", err)
	}
	if disabledLoginItem["enabled"] != false {
		t.Fatalf("disabled linuxdo login item = %#v", disabledLoginItem)
	}
	if app.auth.Authenticate(disabledLoginKey) != nil {
		t.Fatal("disabled linuxdo user authenticated after a new login")
	}

	req = httptest.NewRequest(http.MethodPost, ownerPath, strings.NewReader(`{"enabled":true}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("enable managed user status = %d body = %s", res.Code, res.Body.String())
	}
	if app.auth.Authenticate(disabledLoginKey) == nil || app.auth.Authenticate(ownerAPIKey) == nil {
		t.Fatal("enabled linuxdo user credentials should authenticate")
	}

	req = httptest.NewRequest(http.MethodDelete, ownerPath, nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("delete managed user status = %d body = %s", res.Code, res.Body.String())
	}
	if app.auth.Authenticate(disabledLoginKey) != nil || app.auth.Authenticate(ownerAPIKey) != nil {
		t.Fatal("deleted linuxdo user credentials still authenticate")
	}
	if app.auth.Authenticate(localKey) == nil {
		t.Fatal("deleting linuxdo user should not affect local user")
	}
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("delete managed user json: %v", err)
	}
	if findHTTPItem(logItems(list), owner.ID) != nil {
		t.Fatalf("deleted linuxdo user still listed: %#v", list)
	}
}

func TestAdminUsersListPaginationAndFilters(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	enabledOne, err := app.auth.CreatePasswordUser("enabled_one", "Password123", "Enabled One", service.DefaultManagedRoleID, true)
	if err != nil {
		t.Fatalf("CreatePasswordUser(enabled_one) error = %v", err)
	}
	disabledOne, err := app.auth.CreatePasswordUser("disabled_one", "Password123", "Disabled One", service.DefaultManagedRoleID, false)
	if err != nil {
		t.Fatalf("CreatePasswordUser(disabled_one) error = %v", err)
	}
	enabledTwo, err := app.auth.CreatePasswordUser("enabled_two", "Password123", "Enabled Two", service.DefaultManagedRoleID, true)
	if err != nil {
		t.Fatalf("CreatePasswordUser(enabled_two) error = %v", err)
	}
	expectedDefaultIDs := []string{
		enabledOne["id"].(string),
		disabledOne["id"].(string),
		enabledTwo["id"].(string),
	}
	sort.Sort(sort.Reverse(sort.StringSlice(expectedDefaultIDs)))

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users?page=1&page_size=3", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("default sorted users status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("default sorted users json: %v", err)
	}
	items := logItems(payload)
	if len(items) != len(expectedDefaultIDs) || payload["sort_by"] != "id" || payload["sort_order"] != "desc" {
		t.Fatalf("default sorted metadata/items = %#v", payload)
	}
	for index, item := range items {
		if item["id"] != expectedDefaultIDs[index] {
			t.Fatalf("default sorted ids = %#v, want %#v", items, expectedDefaultIDs)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users?page=2&page_size=2", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("paged users status = %d body = %s", res.Code, res.Body.String())
	}
	payload = map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("paged users json: %v", err)
	}
	if payload["total"] != float64(3) || payload["page"] != float64(2) || payload["page_size"] != float64(2) || payload["total_pages"] != float64(2) {
		t.Fatalf("paged metadata = %#v", payload)
	}
	if items := logItems(payload); len(items) != 1 {
		t.Fatalf("paged items length = %d payload = %#v", len(items), payload)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users?page=1&page_size=3&sort_by=username&sort_order=asc", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("username sorted users status = %d body = %s", res.Code, res.Body.String())
	}
	payload = map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("username sorted users json: %v", err)
	}
	items = logItems(payload)
	if payload["sort_by"] != "username" || payload["sort_order"] != "asc" || len(items) != 3 {
		t.Fatalf("username sorted payload = %#v", payload)
	}
	for index, username := range []string{"disabled_one", "enabled_one", "enabled_two"} {
		if items[index]["username"] != username {
			t.Fatalf("username sorted items = %#v", items)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users?page=99&page_size=2", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("clamped users status = %d body = %s", res.Code, res.Body.String())
	}
	payload = map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("clamped users json: %v", err)
	}
	if payload["page"] != float64(2) || payload["total_pages"] != float64(2) {
		t.Fatalf("clamped metadata = %#v", payload)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users?page=1&page_size=20&provider=local&status=disabled&search=disabled_one", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("filtered users status = %d body = %s", res.Code, res.Body.String())
	}
	payload = map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("filtered users json: %v", err)
	}
	items = logItems(payload)
	if payload["total"] != float64(1) || len(items) != 1 || items[0]["username"] != "disabled_one" {
		t.Fatalf("filtered users payload = %#v", payload)
	}
	if _, ok := items[0]["usage_curve"].([]any); !ok {
		t.Fatalf("filtered user missing usage stats: %#v", items[0])
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users?page=0", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid page status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestCreationTaskPollingDisablesCaching(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/creation-tasks?ids=missing", nil)
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("creation task list status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := res.Header().Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q, want no-cache", got)
	}
}

func TestModelsCallLogIncludesUserKeyName(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("models status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logs status = %d body = %s", res.Code, res.Body.String())
	}
	var logs map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &logs); err != nil {
		t.Fatalf("logs json: %v", err)
	}
	items := logItems(logs)
	if len(items) == 0 {
		t.Fatalf("expected models call to write a log event, got %#v", logs)
	}
	item := findLogByDetails(items, map[string]any{
		"endpoint": "/v1/models",
		"outcome":  "success",
	})
	if item == nil {
		t.Fatalf("expected models call log event, got %#v", items)
	}
	if _, ok := item["type"]; ok {
		t.Fatalf("log item should not expose type: %#v", item)
	}
	detail, _ := item["detail"].(map[string]any)
	if detail["endpoint"] != "/v1/models" ||
		detail["path"] != "/v1/models" ||
		detail["method"] != http.MethodGet ||
		detail["status"] != float64(http.StatusOK) ||
		detail["outcome"] != "success" ||
		detail["key_name"] != "frontend" ||
		detail["auth_kind"] != service.AuthKindAPIKey ||
		detail["key_role"] != "user" {
		t.Fatalf("models call log did not include user key identity: %#v", detail)
	}
	if _, ok := detail["session_name"]; ok {
		t.Fatalf("api key log should not include session_name: %#v", detail)
	}
}

func TestProtocolCallLogCapturesUnknownLengthRequestWithoutDuplicateAudit(t *testing.T) {
	t.Skip("direct image generation now proxies to RelayAI instead of the local image engine")

	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}
	app.engine.ImageTokenProvider = func(context.Context) (string, error) {
		return "test-token", nil
	}
	app.engine.ImageClientFactory = func(string) *backend.Client {
		return nil
	}
	app.engine.StreamImageOutputsFunc = func(ctx context.Context, client *backend.Client, request protocol.ConversationRequest, index, total int) (<-chan protocol.ImageOutput, <-chan error) {
		out := make(chan protocol.ImageOutput, 1)
		errCh := make(chan error, 1)
		out <- protocol.ImageOutput{
			Kind:    "result",
			Model:   request.Model,
			Index:   index,
			Total:   total,
			Created: 123,
			Data:    []map[string]any{{"url": "https://example.test/image.png"}},
		}
		close(out)
		errCh <- nil
		close(errCh)
		return out, errCh
	}

	body := `{"prompt":"draw a cat","model":"gpt-image-2","n":1,"response_format":"url"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations?trace=1", io.NopCloser(strings.NewReader(body)))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("image generation status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logs status = %d body = %s", res.Code, res.Body.String())
	}
	var logs map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &logs); err != nil {
		t.Fatalf("logs json: %v", err)
	}
	items := logItems(logs)
	callLog := findLogByDetails(items, map[string]any{"endpoint": "/v1/images/generations", "outcome": "success"})
	if callLog == nil {
		t.Fatalf("expected image call log, got %#v", items)
	}
	detail, _ := callLog["detail"].(map[string]any)
	requestArgs, _ := detail["request_args"].(map[string]any)
	query, _ := requestArgs["query"].(map[string]any)
	requestBody, _ := requestArgs["body"].(map[string]any)
	if query["trace"] != "1" || requestBody["model"] != "gpt-image-2" || requestBody["prompt"] != "draw a cat" {
		t.Fatalf("request args not captured completely: %#v", requestArgs)
	}
	if detail["request_truncated"] != nil {
		t.Fatalf("small request should not be marked truncated: %#v", detail)
	}
	if auditLog := findHTTPAuditLogByPath(items, "/v1/images/generations"); auditLog != nil {
		t.Fatalf("protocol request should not also create generic audit log: %#v", auditLog)
	}
}

func TestAPIAuditLogCapturesRequestMetadata(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/settings?section=logging", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	req.Header.Set("User-Agent", "chatgpt2api-test")
	req.RemoteAddr = "203.0.113.10:12345"
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("settings status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs?username=admin&method=GET&status=200&summary=%2Fapi%2Fsettings", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("audit logs status = %d body = %s", res.Code, res.Body.String())
	}
	var logs map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &logs); err != nil {
		t.Fatalf("audit logs json: %v", err)
	}
	items := logItems(logs)
	if len(items) == 0 {
		t.Fatalf("expected audit log, got %#v", logs)
	}
	item := findLogByDetail(items, "path", "/api/settings")
	if item == nil {
		t.Fatalf("expected audit log for /api/settings, got %#v", items)
	}
	if _, ok := item["type"]; ok {
		t.Fatalf("log item should not expose type: %#v", item)
	}
	detail, _ := item["detail"].(map[string]any)
	if detail["method"] != http.MethodGet || detail["status"] != float64(http.StatusOK) || detail["log_level"] != "info" {
		t.Fatalf("unexpected audit detail = %#v", detail)
	}
	if detail["operation_type"] != "查询" || detail["subject_id"] != testAdminUsername || detail["user_agent"] != "chatgpt2api-test" {
		t.Fatalf("missing audit identity/request fields = %#v", detail)
	}
	if detail["username"] != "管理员" || detail["session_name"] != "登录会话" || detail["auth_kind"] != service.AuthKindSession {
		t.Fatalf("session audit detail should use username/session fields instead of token name: %#v", detail)
	}
	if _, ok := detail["key_name"]; ok {
		t.Fatalf("session audit detail should not expose 登录会话 as key_name: %#v", detail)
	}
	if _, ok := detail["duration_ms"].(float64); !ok {
		t.Fatalf("duration_ms not numeric in audit detail = %#v", detail)
	}
}

func TestCreationTaskSubmitLogsRequestAndPollingAvoidsGenericAuditNoise(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := app.auth.CreateAPIKey(service.AuthRoleUser, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateAPIKey() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(`{"client_task_id":"noise-test","prompt":"test image"}`))
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("submit creation task status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/creation-tasks?ids=noise-test", nil)
	req.Header.Set("Authorization", "Bearer "+rawKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("poll creation task status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logs status = %d body = %s", res.Code, res.Body.String())
	}
	var logs map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &logs); err != nil {
		t.Fatalf("logs json: %v", err)
	}
	items := logItems(logs)
	submitLog := findHTTPAuditLogByPath(items, "/api/creation-tasks/image-generations")
	if submitLog == nil {
		t.Fatalf("creation task submit should create a request log, got %#v", items)
	}
	detail, _ := submitLog["detail"].(map[string]any)
	requestArgs, _ := detail["request_args"].(map[string]any)
	if requestArgs["client_task_id"] != "noise-test" || requestArgs["prompt"] != "test image" {
		t.Fatalf("creation task submit request args = %#v", requestArgs)
	}
	if auditLog := findHTTPAuditLogByPath(items, "/api/creation-tasks"); auditLog != nil {
		t.Fatalf("creation task polling should not create generic audit log: %#v", auditLog)
	}
}

func TestLogGovernanceEndpointCleansOldLogs(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	backend, err := app.config.StorageBackend()
	if err != nil {
		t.Fatalf("StorageBackend() error = %v", err)
	}
	logStore, ok := backend.(storage.LogBackend)
	if !ok {
		t.Fatalf("storage backend %T does not implement LogBackend", backend)
	}
	for _, item := range []map[string]any{
		{"time": "2000-01-01 00:00:00", "type": "event", "summary": "旧日志", "detail": map[string]any{"status": "success"}},
		{"time": time.Now().Format("2006-01-02 15:04:05"), "type": "event", "summary": "新日志", "detail": map[string]any{"status": 200}},
	} {
		if err := logStore.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/logs/governance", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("governance status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("governance json: %v", err)
	}
	governance, _ := payload["governance"].(map[string]any)
	if governance["total"] != float64(2) {
		t.Fatalf("governance total = %#v, want 2 in %#v", governance["total"], payload)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/logs/governance", strings.NewReader(`{"retention_days":1}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("cleanup status = %d body = %s", res.Code, res.Body.String())
	}
	payload = map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("cleanup json: %v", err)
	}
	cleanup, _ := payload["cleanup"].(map[string]any)
	if cleanup["deleted"] != float64(1) || cleanup["remaining"] != float64(1) {
		t.Fatalf("cleanup result = %#v, want deleted 1 remaining 1", cleanup)
	}
}

func TestImageStorageGovernanceEndpointCleansThumbnails(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	rel := "2026/04/29/sample.png"
	imagePath := filepath.Join(app.config.ImagesDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		t.Fatalf("mkdir image dir: %v", err)
	}
	if err := writeHTTPTestPNG(imagePath); err != nil {
		t.Fatalf("write image: %v", err)
	}
	app.images.RecordGeneratedImages([]string{rel}, "admin", "Admin", service.ImageVisibilityPrivate)
	app.images.EnsureThumbnails([]string{rel})
	thumbPath := filepath.Join(app.config.ImageThumbnailsDir(), filepath.FromSlash(rel)+".jpg")
	if _, err := os.Stat(thumbPath); err != nil {
		t.Fatalf("thumbnail was not created: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/images/storage-governance", nil)
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("storage governance status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("storage governance json: %v", err)
	}
	governance, _ := payload["governance"].(map[string]any)
	if governance["images_count"] != float64(1) || governance["thumbnail_files"] != float64(1) {
		t.Fatalf("storage governance = %#v", governance)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/images/storage-governance", strings.NewReader(`{"action":"thumbnails"}`))
	req.Header.Set("Authorization", adminAuthHeader(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("thumbnail cleanup status = %d body = %s", res.Code, res.Body.String())
	}
	payload = map[string]any{}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("thumbnail cleanup json: %v", err)
	}
	cleanup, _ := payload["cleanup"].(map[string]any)
	if cleanup["deleted_thumbnails"] != float64(1) || cleanup["deleted_images"] != float64(0) {
		t.Fatalf("thumbnail cleanup = %#v", cleanup)
	}
	if _, err := os.Stat(imagePath); err != nil {
		t.Fatalf("image should remain after thumbnail cleanup: %v", err)
	}
	if _, err := os.Stat(thumbPath); !os.IsNotExist(err) {
		t.Fatalf("thumbnail still exists, stat error = %v", err)
	}
}

func logItems(payload map[string]any) []map[string]any {
	rawItems, _ := payload["items"].([]any)
	items := make([]map[string]any, 0, len(rawItems))
	for _, raw := range rawItems {
		if item, ok := raw.(map[string]any); ok {
			items = append(items, item)
		}
	}
	return items
}

func findLogBySummary(items []map[string]any, summary string) map[string]any {
	for _, item := range items {
		if item["summary"] == summary {
			return item
		}
	}
	return nil
}

func findHTTPItem(items []map[string]any, id string) map[string]any {
	for _, item := range items {
		if item["id"] == id {
			return item
		}
	}
	return nil
}

func findResponseCookie(res *http.Response, name string) *http.Cookie {
	for _, cookie := range res.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func findResponseCookieByDomain(res *http.Response, name, domain string) *http.Cookie {
	for _, cookie := range res.Cookies() {
		if cookie.Name == name && cookie.Domain == domain {
			return cookie
		}
	}
	return nil
}

func assertCreationConcurrentLimit(t *testing.T, payload map[string]any, want int) {
	t.Helper()
	got, ok := payload["creation_concurrent_limit"].(float64)
	if !ok || got != float64(want) {
		t.Fatalf("creation_concurrent_limit = %#v, want %d in %#v", payload["creation_concurrent_limit"], want, payload)
	}
}

func findLogByDetail(items []map[string]any, key, value string) map[string]any {
	return findLogByDetails(items, map[string]any{key: value})
}

func findHTTPAuditLogByPath(items []map[string]any, path string) map[string]any {
	for _, item := range items {
		detail, _ := item["detail"].(map[string]any)
		if detail["path"] == path && detail["endpoint"] == nil {
			return item
		}
	}
	return nil
}

func findLogByDetails(items []map[string]any, values map[string]any) map[string]any {
	for _, item := range items {
		detail, _ := item["detail"].(map[string]any)
		matches := true
		for key, value := range values {
			if detail[key] != value {
				matches = false
				break
			}
		}
		if matches {
			return item
		}
	}
	return nil
}

const (
	testAdminUsername = "admin"
	testAdminPassword = "AdminPass123!"
)

func adminAuthHeader(t *testing.T, app *App) string {
	t.Helper()
	identity, token, err := app.auth.LoginPassword(testAdminUsername, testAdminPassword)
	if err != nil {
		t.Fatalf("admin LoginPassword() error = %v", err)
	}
	if identity == nil || identity.Role != service.AuthRoleAdmin || token == "" {
		t.Fatalf("admin LoginPassword() identity=%#v token=%q", identity, token)
	}
	return "Bearer " + token
}

func createPasswordUserSession(t *testing.T, app *App, username, password, name string) (*service.Identity, string) {
	t.Helper()
	if _, err := app.auth.CreatePasswordUser(username, password, name, service.DefaultManagedRoleID, true); err != nil {
		t.Fatalf("CreatePasswordUser(%s) error = %v", username, err)
	}
	identity, token, err := app.auth.LoginPassword(username, password)
	if err != nil {
		t.Fatalf("LoginPassword(%s) error = %v", username, err)
	}
	if identity == nil || token == "" {
		t.Fatalf("LoginPassword(%s) identity=%#v token=%q", username, identity, token)
	}
	return identity, token
}

func newHTTPTestNewAPIDatabase(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "newapi.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, email TEXT, display_name TEXT, password TEXT NOT NULL, quota INTEGER NOT NULL DEFAULT 0, used_quota INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0, ` + "`group`" + ` TEXT NOT NULL DEFAULT 'default', status INTEGER NOT NULL, deleted_at TEXT)`,
		"CREATE TABLE tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, `key` TEXT NOT NULL, status INTEGER NOT NULL, name TEXT, expired_time INTEGER NOT NULL, remain_quota INTEGER NOT NULL, unlimited_quota BOOLEAN NOT NULL, `group` TEXT NOT NULL, deleted_at TEXT)",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("create newapi schema: %v", err)
		}
	}
	return "sqlite:///" + filepath.ToSlash(dbPath)
}

func insertHTTPTestNewAPIUser(t *testing.T, dbURL string, id int, username, email string) {
	t.Helper()
	db := openHTTPTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	hash, err := bcrypt.GenerateFromPassword([]byte("Password123"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash newapi password: %v", err)
	}
	if _, err := db.Exec("INSERT INTO users (id, username, email, display_name, password, status, deleted_at) VALUES (?, ?, ?, ?, ?, 1, NULL)", id, username, email, "Alice", string(hash)); err != nil {
		t.Fatalf("insert newapi user: %v", err)
	}
}

func updateHTTPTestNewAPIUserBalance(t *testing.T, dbURL string, id int, quota, usedQuota, requestCount int, group string) {
	t.Helper()
	db := openHTTPTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("UPDATE users SET quota = ?, used_quota = ?, request_count = ?, `group` = ? WHERE id = ?", quota, usedQuota, requestCount, group, id); err != nil {
		t.Fatalf("update newapi user balance: %v", err)
	}
}

func insertHTTPTestNewAPIToken(t *testing.T, dbURL string, id, userID int, group, key string, expiredTime int64, remainQuota int, unlimited bool) {
	t.Helper()
	db := openHTTPTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("INSERT INTO tokens (id, user_id, `key`, status, name, expired_time, remain_quota, unlimited_quota, `group`, deleted_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)", id, userID, key, "token", expiredTime, remainQuota, unlimited, group); err != nil {
		t.Fatalf("insert newapi token: %v", err)
	}
}

func openHTTPTestNewAPIDatabase(t *testing.T, dbURL string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", strings.TrimPrefix(dbURL, "sqlite:///"))
	if err != nil {
		t.Fatalf("open newapi sqlite: %v", err)
	}
	return db
}

func waitForHTTPTestCondition(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}

func newTestApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	t.Setenv("CHATGPT2API_ROOT", root)
	t.Setenv("CHATGPT2API_ADMIN_USERNAME", testAdminUsername)
	t.Setenv("CHATGPT2API_ADMIN_PASSWORD", testAdminPassword)
	t.Setenv("CHATGPT2API_NEWAPI_DATABASE_URL", "")
	t.Setenv("CHATGPT2API_NEWAPI_TOKEN_GROUP", "")
	t.Setenv("CHATGPT2API_AUTH_COOKIE_DOMAIN", "")
	t.Setenv("STORAGE_BACKEND", "sqlite")
	t.Setenv("DATABASE_URL", "")
	app, err := NewApp()
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}
	app.engine.ListModelsFunc = func(context.Context) (map[string]any, error) {
		return map[string]any{"object": "list", "data": []map[string]any{}}, nil
	}
	return app
}

func installHTTPTestImageStream(t *testing.T, app *App) {
	t.Helper()
	installHTTPTestImageStreamFunc(t, app, func(ctx context.Context, client *backend.Client, request protocol.ConversationRequest, index, total int) (<-chan protocol.ImageOutput, <-chan error) {
		return httpTestImageOutputStream(request, index)
	})
}

func installHTTPTestImageStreamFunc(t *testing.T, app *App, fn func(context.Context, *backend.Client, protocol.ConversationRequest, int, int) (<-chan protocol.ImageOutput, <-chan error)) {
	t.Helper()
	app.engine.ImageTokenProvider = func(context.Context) (string, error) {
		return "test-token", nil
	}
	app.engine.ImageClientFactory = func(string) *backend.Client {
		return nil
	}
	app.engine.StreamImageOutputsFunc = fn
}

func httpTestImageOutputStream(request protocol.ConversationRequest, index int) (<-chan protocol.ImageOutput, <-chan error) {
	out := make(chan protocol.ImageOutput, 1)
	errCh := make(chan error, 1)
	out <- protocol.ImageOutput{
		Kind:    "result",
		Model:   request.Model,
		Index:   index,
		Total:   request.N,
		Created: int64(index),
		Data: []map[string]any{{
			"url":      fmt.Sprintf("https://example.test/%d.png", index),
			"b64_json": fmt.Sprintf("image-%d", index),
		}},
	}
	close(out)
	errCh <- nil
	close(errCh)
	return out, errCh
}

func httpTestMessageOnlyImageOutputStream(request protocol.ConversationRequest, index int) (<-chan protocol.ImageOutput, <-chan error) {
	out := make(chan protocol.ImageOutput, 1)
	errCh := make(chan error, 1)
	out <- protocol.ImageOutput{
		Kind:    "message",
		Model:   request.Model,
		Index:   index,
		Total:   request.N,
		Created: int64(index),
		Text:    "text only",
	}
	close(out)
	errCh <- nil
	close(errCh)
	return out, errCh
}

func unsetTestEnv(t *testing.T, key string) {
	t.Helper()
	original, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("Unsetenv(%s): %v", key, err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, original)
			return
		}
		_ = os.Unsetenv(key)
	})
}

func writeHTTPTestPNG(path string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return encodeHTTPTestPNG(file)
}

func encodeHTTPTestPNG(file interface {
	Write([]byte) (int, error)
}) error {
	img := image.NewRGBA(image.Rect(0, 0, 12, 12))
	for y := 0; y < 12; y++ {
		for x := 0; x < 12; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 16), G: uint8(y * 16), B: 180, A: 255})
		}
	}
	return png.Encode(file, img)
}
