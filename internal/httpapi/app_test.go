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
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"

	"golang.org/x/crypto/bcrypt"
)

func TestWriteCreationTaskSubmitErrorReportsPersistenceOutage(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	response := httptest.NewRecorder()
	app.writeCreationTaskSubmitError(response, service.ImageTaskPersistenceError{Err: errors.New("database unavailable")})
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "未启动上游请求") {
		t.Fatalf("response body = %q", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "database unavailable") {
		t.Fatalf("response leaked persistence detail: %q", response.Body.String())
	}
}

func TestImageTaskOptionalIntegerParametersRejectFractions(t *testing.T) {
	if value, ok := imagePartialImagesFromBody(1.5); ok || value != 0 {
		t.Fatalf("imagePartialImagesFromBody(1.5) = (%d, %v), want (0, false)", value, ok)
	}
	if value, ok := imagePartialImagesFromBody(float64(0)); !ok || value != 0 {
		t.Fatalf("imagePartialImagesFromBody(0) = (%d, %v), want (0, true)", value, ok)
	}
	if value, ok := imageOutputCompressionFromBody(42.5); ok || value != 0 {
		t.Fatalf("imageOutputCompressionFromBody(42.5) = (%d, %v), want (0, false)", value, ok)
	}
	if value, ok := imagePartialImagesFromBody(float64(2)); !ok || value != 2 {
		t.Fatalf("imagePartialImagesFromBody(2) = (%d, %v), want (2, true)", value, ok)
	}
	if value, ok := imageOutputCompressionFromBody(float64(42)); !ok || value != 42 {
		t.Fatalf("imageOutputCompressionFromBody(42) = (%d, %v), want (42, true)", value, ok)
	}
}

func TestWriteCreationTaskStorageErrorReportsStatePersistenceOutage(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	response := httptest.NewRecorder()
	if !app.writeCreationTaskStorageError(response, service.ImageTaskPersistenceError{Err: errors.New("database unavailable"), TaskStarted: true}) {
		t.Fatal("writeCreationTaskStorageError() did not handle persistence error")
	}
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "刷新后重试") {
		t.Fatalf("response body = %q", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "database unavailable") {
		t.Fatalf("response leaked persistence detail: %q", response.Body.String())
	}
}

func TestWriteCreationTaskSubmitErrorPreservesProtocolStatus(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	response := httptest.NewRecorder()
	app.writeCreationTaskSubmitError(response, protocol.HTTPError{
		Status:  http.StatusRequestEntityTooLarge,
		Message: "Gemini request is too large",
	})
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusRequestEntityTooLarge, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "Gemini request is too large") {
		t.Fatalf("response body = %q", response.Body.String())
	}
}

func TestVideoCreationRouteRemovesInternalFieldsBeforeNewAPI(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	contract := protocol.DefaultVideoContracts()[0]
	contract.Polling.IntervalSeconds = 1
	if err := protocol.ReplaceVideoContracts([]protocol.VideoModelContract{contract}); err != nil {
		t.Fatalf("install video contract: %v", err)
	}
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })

	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertHTTPTestNewAPIToken(t, dbURL, 1, 1, "video", "video-relay-token", -1, 0, true)
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	if app.newAPIKeys != nil {
		_ = app.newAPIKeys.Close()
	}
	app.newAPIKeys = reader

	received := make(chan map[string]any, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode NewAPI video request: %v", err)
				http.Error(w, "invalid request", http.StatusBadRequest)
				return
			}
			received <- body
			_, _ = w.Write([]byte(`{"id":"video-public","status":"queued"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/video-public":
			_, _ = w.Write([]byte(`{"id":"video-public","status":"completed","video_url":"https://cdn.example.com/generated.mp4"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	if _, err := app.config.Update(map[string]any{
		"relay_base_url": upstream.URL,
		"video_models":   []string{"minimax-h3-768p"},
	}); err != nil {
		t.Fatalf("configure video route: %v", err)
	}

	_, token := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	requestBody := `{
		"client_task_id":"video-contract-route",
		"model":"minimax-h3-768p",
		"provider":"apimart",
		"video_provider":"apimart",
		"channel_protocol":"apimart",
		"protocol":"apimart",
		"prompt":"animate",
		"seconds":5,
		"size":"16:9",
		"resolution":"768p",
		"generation_mode":"text-to-video",
		"metadata":{"generation_mode":"nested-metadata"},
		"undeclared_option":{"generation_mode":"nested-value"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/video-generations", strings.NewReader(requestBody))
	req.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(req, token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("video creation status = %d body = %s", res.Code, res.Body.String())
	}

	var posted map[string]any
	select {
	case posted = <-received:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for NewAPI video request")
	}
	if posted["model"] != "minimax-h3-768p" || posted["prompt"] != "animate" || posted["duration"] != float64(5) || posted["generation_mode"] != "text-to-video" {
		t.Fatalf("NewAPI video request lost supported fields: %#v", posted)
	}
	for _, field := range []string{"reference_mode", "provider", "video_provider", "channel_protocol", "protocol", "channel_base_url", "provider_base_url"} {
		assertVideoRequestFieldAbsentRecursively(t, posted, field)
	}
	if _, ok := posted["metadata"]; ok {
		t.Fatalf("NewAPI video request leaked client metadata: %#v", posted)
	}
	if _, ok := posted["undeclared_option"]; ok {
		t.Fatalf("undeclared advanced field leaked into NewAPI request: %#v", posted)
	}
}

func TestAppAuthAndSPACompatibility(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	identity, sessionToken := createPasswordUserSession(t, app, "frontend-user", "Password123", "Frontend")

	req := httptest.NewRequest(http.MethodGet, "/api/auth/users/"+identity.ID+"/key", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("removed user key route status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("Bearer session status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	req.Header.Set("x-api-key", sessionToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("x-api-key session status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	setRequestAuthCookie(req, sessionToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("Cookie session status = %d body = %s", res.Code, res.Body.String())
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

	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/v1/chat/completions"},
		{http.MethodPost, "/v1/responses"},
		{http.MethodPost, "/v1/messages"},
		{http.MethodPost, "/v1/images/generations"},
		{http.MethodPost, "/v1/images/edits"},
		{http.MethodPost, "/v1/videos"},
		{http.MethodGet, "/v1/videos/task-1"},
		{http.MethodGet, "/v1/models"},
	} {
		msgReq := httptest.NewRequest(route.method, route.path, strings.NewReader("{}"))
		msgReq.Header.Set("x-api-key", sessionToken)
		msgRes := httptest.NewRecorder()
		app.Handler().ServeHTTP(msgRes, msgReq)
		if msgRes.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d body = %s", route.method, route.path, msgRes.Code, msgRes.Body.String())
		}
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

func TestAnnouncementManagementAndVisibility(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, userToken := createPasswordUserSession(t, app, "announcement_user", "Password123!", "Announcement User")

	req := httptest.NewRequest(http.MethodGet, "/api/announcements", nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous announcements status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/announcements", nil)
	setRequestAuthCookie(req, "Bearer "+userToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("user announcements status = %d body = %s", res.Code, res.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatalf("user announcements json: %v", err)
	}
	if items := logItems(response); len(items) != 0 {
		t.Fatalf("initial announcements = %#v", response)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/announcements", strings.NewReader(`{"content":"越权公告"}`))
	setRequestAuthCookie(req, "Bearer "+userToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("user create announcement status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/announcements", strings.NewReader(`{"title":"维护通知","content":"今晚 23:00 进行维护","enabled":true}`))
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin create announcement status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatalf("create announcement json: %v", err)
	}
	created, _ := response["item"].(map[string]any)
	createdID, _ := created["id"].(string)
	if createdID == "" || created["title"] != "维护通知" {
		t.Fatalf("created announcement = %#v", response)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/announcements", nil)
	setRequestAuthCookie(req, "Bearer "+userToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("visible announcements status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatalf("visible announcements json: %v", err)
	}
	items := logItems(response)
	if len(items) != 1 || items[0]["id"] != createdID {
		t.Fatalf("visible announcements = %#v", response)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/admin/announcements/"+createdID, strings.NewReader(`{"enabled":false}`))
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("disable announcement status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/announcements", nil)
	setRequestAuthCookie(req, "Bearer "+userToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("announcements after disable status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatalf("announcements after disable json: %v", err)
	}
	if items := logItems(response); len(items) != 0 {
		t.Fatalf("disabled announcement remains visible = %#v", response)
	}
}

func TestAnnouncementPreferencesArePersonal(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, firstToken := createPasswordUserSession(t, app, "announcement-pref-a", "Password123!", "First User")
	_, secondToken := createPasswordUserSession(t, app, "announcement-pref-b", "Password123!", "Second User")

	req := httptest.NewRequest(http.MethodPost, "/api/profile/announcement-preferences", strings.NewReader(`{"version":"announcement-1:v1","action":"today","local_date":"2026-07-15"}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("update announcement preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/announcement-preferences", nil)
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "2026-07-15") {
		t.Fatalf("first preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/announcement-preferences", nil)
	setRequestAuthCookie(req, "Bearer "+secondToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("second preferences status = %d body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "announcement-1:v1") {
		t.Fatalf("second user saw first user's preferences: %s", res.Body.String())
	}
}

func TestImageGenerationPreferencesArePersonal(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{
		"text_models":  []string{"text-allowed"},
		"image_models": []string{"image-allowed"},
		"video_models": []string{"video-allowed"},
		"audio_models": []string{"audio-allowed"},
	}); err != nil {
		t.Fatalf("configure model whitelist: %v", err)
	}

	_, firstToken := createPasswordUserSession(t, app, "image-pref-a", "Password123!", "First User")
	_, secondToken := createPasswordUserSession(t, app, "image-pref-b", "Password123!", "Second User")

	req := httptest.NewRequest(http.MethodGet, "/api/profile/image-generation-preferences", nil)
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"api_mode":"images"`) || !strings.Contains(res.Body.String(), `"stream":false`) || !strings.Contains(res.Body.String(), `"partial_images":1`) {
		t.Fatalf("default image generation preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/profile/image-generation-preferences", strings.NewReader(`{"api_mode":"responses","stream":true,"partial_images":2,"response_format_b64_json":true,"codex_cli_compatibility":true,"system_prompt":"系统","video_system_prompt":"视频系统","audio_instructions":"自然、温暖、适合旁白。","default_text_model":"text-allowed","default_image_model":"image-allowed","default_video_model":"video-allowed","default_audio_model":"audio-allowed","canvas_default_image_count":4,"default_audio_voice":"coral","default_audio_format":"wav","default_audio_speed":1.25}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"api_mode":"responses"`) || !strings.Contains(res.Body.String(), `"partial_images":2`) || !strings.Contains(res.Body.String(), `"audio_instructions":"自然、温暖、适合旁白。"`) || !strings.Contains(res.Body.String(), `"default_video_model":"video-allowed"`) || !strings.Contains(res.Body.String(), `"canvas_default_image_count":4`) || !strings.Contains(res.Body.String(), `"default_audio_voice":"coral"`) || !strings.Contains(res.Body.String(), `"default_audio_format":"wav"`) || !strings.Contains(res.Body.String(), `"default_audio_speed":1.25`) {
		t.Fatalf("update image generation preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/profile/image-generation-preferences", strings.NewReader(`{"default_text_relay_token_names":["text-key","text-backup"],"default_image_relay_token_names":["image-key"],"default_video_relay_token_names":["video-key"],"default_audio_relay_token_names":["audio-key"]}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"default_text_relay_token_names":["text-key","text-backup"]`) || !strings.Contains(res.Body.String(), `"default_image_relay_token_names":["image-key"]`) || !strings.Contains(res.Body.String(), `"default_video_relay_token_names":["video-key"]`) || !strings.Contains(res.Body.String(), `"default_audio_relay_token_names":["audio-key"]`) || !strings.Contains(res.Body.String(), `"system_prompt":"系统"`) {
		t.Fatalf("update relay token preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/profile/image-generation-preferences", strings.NewReader(`{"default_text_relay_token_names":["must-not-be-saved"],"partial_images":4}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "partial_images must be an integer between 0 and 3") {
		t.Fatalf("invalid mixed preference patch status = %d body = %s", res.Code, res.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-generation-preferences", nil)
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"default_text_relay_token_names":["text-key","text-backup"]`) || strings.Contains(res.Body.String(), "must-not-be-saved") {
		t.Fatalf("invalid mixed preference patch changed data status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/profile/image-generation-preferences", strings.NewReader(`{"stream":false,"partial_images":3,"response_format_b64_json":false,"codex_cli_compatibility":false,"workbench":{"image_model":"image-allowed","image_size":"2048x1152","image_size_mode":"ratio","image_aspect_ratio":"16:9","image_resolution":"2k","image_custom_ratio":"16:9","image_custom_width":"2048","image_custom_height":"1152","image_snap_to_multiple_16":true,"image_quality":"high","image_count":3,"image_output_format":"webp","image_output_compression":"88","video_model":"video-allowed","video_size":"1920x1080","video_seconds":"10","video_resolution":"1080p","video_generate_audio":true,"video_watermark":true}}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"partial_images":3`) || !strings.Contains(res.Body.String(), `"image_model":"image-allowed"`) || !strings.Contains(res.Body.String(), `"image_size":"2048x1152"`) || !strings.Contains(res.Body.String(), `"image_count":3`) || !strings.Contains(res.Body.String(), `"video_model":"video-allowed"`) || !strings.Contains(res.Body.String(), `"video_generate_audio":true`) || !strings.Contains(res.Body.String(), `"default_text_relay_token_names":["text-key","text-backup"]`) {
		t.Fatalf("update creation workbench preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/profile/image-generation-preferences", strings.NewReader(`{"workbench":{"image_model":"image-disabled","image_size":"1024x1024","image_size_mode":"ratio","image_aspect_ratio":"1:1","image_resolution":"auto","image_custom_ratio":"16:9","image_custom_width":"1024","image_custom_height":"1024","image_snap_to_multiple_16":true,"image_quality":"","image_count":1,"image_output_format":"png","image_output_compression":"","video_model":"video-allowed","video_size":"1280x720","video_seconds":"6","video_resolution":"720p","video_generate_audio":false,"video_watermark":false}}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "workbench.image_model is not enabled by the administrator") {
		t.Fatalf("disabled workbench model status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/profile/image-generation-preferences", strings.NewReader(`{"partial_images":1,"default_video_model":"video-disabled"}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "default_video_model is not enabled by the administrator") {
		t.Fatalf("disabled personal model status = %d body = %s", res.Code, res.Body.String())
	}

	if _, err := app.config.Update(map[string]any{"video_models": []string{"video-replacement"}}); err != nil {
		t.Fatalf("replace video model whitelist: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-generation-preferences", nil)
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"default_video_model":""`) {
		t.Fatalf("removed personal model fallback status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/image-generation-preferences", nil)
	setRequestAuthCookie(req, "Bearer "+secondToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), `"stream":true`) || strings.Contains(res.Body.String(), `"response_format_b64_json":true`) || strings.Contains(res.Body.String(), `"codex_cli_compatibility":true`) || strings.Contains(res.Body.String(), `"default_text_relay_token_names":["text-key"`) {
		t.Fatalf("second user saw first user's preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/profile/image-generation-preferences", strings.NewReader(`{"partial_images":4}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "partial_images must be an integer between 0 and 3") {
		t.Fatalf("invalid partial_images status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/profile/image-generation-preferences", strings.NewReader(`{"api_mode":"legacy","partial_images":1}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "api_mode must be images, responses, or chat") {
		t.Fatalf("invalid api_mode status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/profile/image-generation-preferences", strings.NewReader(`{"partial_images":1,"canvas_default_image_count":16,"default_audio_format":"mp3","default_audio_speed":1}`))
	setRequestAuthCookie(req, "Bearer "+firstToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "canvas_default_image_count") {
		t.Fatalf("invalid canvas default image count status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestPasswordAccountLogin(t *testing.T) {
	t.Setenv("USER_DEFAULT_CONCURRENT_LIMIT", "2")

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
	adminCookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
	if adminCookie == nil || adminCookie.Value == "" || login["token"] != nil || login["role"] != service.AuthRoleAdmin || login["subject_id"] != "admin" || login["username"] != "admin" {
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
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
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

func TestCreationTaskRequiresRelayAIAPIKey(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(`{"client_task_id":"task-log-test","prompt":"test image"}`))
	setRequestAuthCookie(req, "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("submit creation task status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("error json: %v", err)
	}
	if detail := util.StringMap(payload["detail"]); detail["error"] != "请先配置数据库连接，并创建指定分组的令牌" {
		t.Fatalf("error body = %#v", payload)
	}
}

func TestCreationTaskRejectsMalformedJSONBeforeRelayLookup(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(`{"client_task_id":`))
	setRequestAuthCookie(req, "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("malformed creation task status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("error json: %v", err)
	}
	if detail := util.StringMap(payload["detail"]); detail["error"] != "invalid json body" {
		t.Fatalf("error body = %#v", payload)
	}
}

func TestCreationTaskRejectsInvalidImageCountBeforeRelayLookup(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	for _, count := range []string{"0", "16", "1.5", "true"} {
		req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(`{"client_task_id":"invalid-count","prompt":"draw","n":`+count+`}`))
		setRequestAuthCookie(req, "Bearer "+rawKey)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "n must be between 1 and 15") {
			t.Fatalf("n=%s status = %d body = %s", count, res.Code, res.Body.String())
		}
	}
}

func TestProfileRelayKeyReadsNewAPITokenForUserAndGroup(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	insertHTTPTestNewAPITokenNamed(t, dbURL, 1, 1, "other", "secondary", "other-group-relay", time.Now().Unix()+3600, 10, false)
	insertHTTPTestNewAPITokenNamed(t, dbURL, 2, 1, "draw", "primary", "alice-relay", -1, 0, true)
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
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

	req := httptest.NewRequest(http.MethodGet, "/api/profile/relay-key?group=draw&token_name=secondary", nil)
	setRequestAuthCookie(req, "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("initial relay key status = %d body = %s", res.Code, res.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &status); err != nil {
		t.Fatalf("relay key status json: %v", err)
	}
	groups, _ := status["groups"].([]any)
	names, _ := status["token_names"].([]any)
	if status["has_key"] != true || status["group"] != "other" || status["token_name"] != "secondary" || status["key_preview"] == "sk-other-group-relay" || len(groups) != 2 || groups[0] != "other" || groups[1] != "draw" || len(names) != 2 || names[0] != "secondary" || names[1] != "primary" {
		t.Fatalf("relay key status = %#v", status)
	}

	var gotAuth string
	const upstreamModelDelay = 25 * time.Millisecond
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected upstream path: %s", r.URL.Path)
		}
		time.Sleep(upstreamModelDelay)
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

	req = httptest.NewRequest(http.MethodGet, "/api/profile/upstream-models?token_name=primary", nil)
	setRequestAuthCookie(req, "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("relay models status = %d body = %s", res.Code, res.Body.String())
	}
	if gotAuth != "Bearer sk-alice-relay" {
		t.Fatalf("upstream Authorization = %q", gotAuth)
	}
	callLog := findLogBySummary(app.logs.Search(service.LogQuery{Limit: 20}), "上游模型列表调用完成")
	if callLog == nil {
		t.Fatal("upstream model request did not create a business log")
	}
	if duration := util.ToInt(util.StringMap(callLog["detail"])["duration_ms"], 0); duration < int(upstreamModelDelay.Milliseconds()) {
		t.Fatalf("upstream model duration_ms = %d, want at least %d", duration, upstreamModelDelay.Milliseconds())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profile/upstream-models?token_name=missing", nil)
	setRequestAuthCookie(req, "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "missing") {
		t.Fatalf("missing named token status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/profile/relay-key", strings.NewReader(`{"api_key":"sk-local-write"}`))
	setRequestAuthCookie(req, "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("write relay key status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfileCustomRelayConfigsVisibilityAndSecretRedaction(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, userToken, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	res := request(http.MethodGet, "/api/profile/custom-relay-configs", userToken, "")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"configurable":false`) {
		t.Fatalf("default user custom config status = %d body = %s", res.Code, res.Body.String())
	}
	res = request(http.MethodPost, "/api/profile/custom-relay-configs", userToken, `{"kind":"image","name":"用户线路","base_url":"https://api.example.test","api_key":"sk-user-secret"}`)
	if res.Code != http.StatusForbidden {
		t.Fatalf("disabled user update status = %d body = %s", res.Code, res.Body.String())
	}

	adminToken := adminSessionToken(t, app)
	res = request(http.MethodPost, "/api/profile/custom-relay-configs", adminToken, `{"kind":"image","name":"主线路","base_url":"https://api.example.test/v1/","api_key":"sk-admin-secret"}`)
	if res.Code != http.StatusCreated || strings.Contains(res.Body.String(), "sk-admin-secret") || !strings.Contains(res.Body.String(), `"configured":true`) {
		t.Fatalf("admin update status = %d body = %s", res.Code, res.Body.String())
	}
	res = request(http.MethodPost, "/api/profile/custom-relay-configs", adminToken, `{"kind":"image","name":"备用线路","base_url":"https://backup.example.test/v1","api_key":"sk-admin-backup"}`)
	if res.Code != http.StatusCreated || strings.Contains(res.Body.String(), "sk-admin-backup") {
		t.Fatalf("admin second config status = %d body = %s", res.Code, res.Body.String())
	}
	res = request(http.MethodGet, "/api/profile/custom-relay-configs", adminToken, "")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"configurable":true`) || strings.Count(res.Body.String(), `"kind":"image"`) != 2 || strings.Contains(res.Body.String(), "sk-admin-secret") {
		t.Fatalf("admin config status = %d body = %s", res.Code, res.Body.String())
	}

	if _, err := app.config.Update(map[string]any{"allow_user_custom_relay_config": true}); err != nil {
		t.Fatal(err)
	}
	res = request(http.MethodPost, "/api/profile/custom-relay-configs", userToken, `{"kind":"text","name":"文本线路","base_url":"https://text.example.test","api_key":"sk-user-secret"}`)
	if res.Code != http.StatusCreated || strings.Contains(res.Body.String(), "sk-user-secret") {
		t.Fatalf("enabled user update status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestSettingsDoesNotExposeRelayDatabaseCredentials(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	if _, err := app.config.Update(map[string]any{
		"relay_database_driver":   "postgres",
		"relay_database_host":     "db.internal",
		"relay_database_port":     "5433",
		"relay_database_name":     "newapi",
		"relay_database_user":     "reader",
		"relay_database_password": "top-secret",
	}); err != nil {
		t.Fatalf("configure relay database: %v", err)
	}

	for _, testCase := range []struct {
		method string
		body   string
	}{
		{method: http.MethodGet},
		{method: http.MethodPost, body: `{}`},
	} {
		req := httptest.NewRequest(testCase.method, "/api/settings", strings.NewReader(testCase.body))
		setRequestAuthCookie(req, adminSessionToken(t, app))
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s settings status = %d body = %s", testCase.method, res.Code, res.Body.String())
		}
		if strings.Contains(res.Body.String(), "top-secret") {
			t.Fatalf("%s settings response leaked database password: %s", testCase.method, res.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %s settings response: %v", testCase.method, err)
		}
		responseConfig := util.StringMap(payload["config"])
		for _, key := range []string{"relay_database_url", "relay_database_password"} {
			if _, ok := responseConfig[key]; ok {
				t.Fatalf("%s settings response leaked %s: %#v", testCase.method, key, responseConfig)
			}
		}
		if responseConfig["relay_database_password_configured"] != true {
			t.Fatalf("%s settings response missing password configured state: %#v", testCase.method, responseConfig)
		}
	}
}

func TestPromptSourcesDoNotRequireSettingsPermission(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	sources := []any{
		map[string]any{
			"id":      "custom-source",
			"label":   "Custom source",
			"url":     "https://example.test/prompts.json",
			"format":  "generic-json",
			"enabled": true,
		},
	}
	if _, err := app.config.Update(map[string]any{"prompt_sources": sources}); err != nil {
		t.Fatalf("configure prompt sources: %v", err)
	}

	_, userToken := createPasswordUserSession(t, app, "prompt-reader", "Password123", "Prompt Reader")
	request := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		setRequestAuthCookie(req, userToken)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}

	settingsResponse := request("/api/settings")
	if settingsResponse.Code != http.StatusForbidden {
		t.Fatalf("settings status = %d body = %s", settingsResponse.Code, settingsResponse.Body.String())
	}

	promptSourcesResponse := request("/api/prompt-sources")
	if promptSourcesResponse.Code != http.StatusOK || !strings.Contains(promptSourcesResponse.Body.String(), "custom-source") {
		t.Fatalf("prompt sources status = %d body = %s", promptSourcesResponse.Code, promptSourcesResponse.Body.String())
	}
	if strings.Contains(promptSourcesResponse.Body.String(), "relay_database") {
		t.Fatalf("prompt sources response leaked unrelated settings: %s", promptSourcesResponse.Body.String())
	}

	anonymousRequest := httptest.NewRequest(http.MethodGet, "/api/prompt-sources", nil)
	anonymousResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(anonymousResponse, anonymousRequest)
	if anonymousResponse.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous prompt sources status = %d body = %s", anonymousResponse.Code, anonymousResponse.Body.String())
	}
}

func TestAudioGenerationRouteValidatesParameters(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, body := range []string{
		`{"input":"","response_format":"mp3"}`,
		`{"input":"hello","response_format":"zip"}`,
		`{"input":"hello","response_format":"mp3","speed":5}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/audio-generations", strings.NewReader(body))
		setRequestAuthCookie(req, adminSessionToken(t, app))
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d response = %s", body, res.Code, res.Body.String())
		}
	}
}

func TestWorkflowRoutesExposePublicTemplatesWithoutEditRights(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, aliceToken := createPasswordUserSession(t, app, "workflow_alice", "Password123!", "Alice")
	_, bobToken := createPasswordUserSession(t, app, "workflow_bob", "Password123!", "Bob")

	req := httptest.NewRequest(http.MethodPost, "/api/workflows", strings.NewReader(`{
		"scope":"public","name":"海报流程",
		"mode":"multi_image_series","series_config":{"target_count":"6","prompt_model":"gpt-5.2","prompt_channel_id":"text-token","prompt_instruction":"保持统一","concurrency":"2","review_required":true},
		"variables":[{"id":"subject","key":"subject","label":"主题","type":"text","required":true,"default_value":"","options":[]}],
		"config":{"model":"gpt-image-1.5","image_model":"gpt-image-1.5","quality":"high","size":"1024x1024","count":"1","api_mode":"images","timeout":"600","system_prompt":"","prompt_template":"{{subject}} 海报","negative_prompt":"低清晰度"}
	}`))
	setRequestAuthCookie(req, "Bearer "+aliceToken)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create workflow status = %d body = %s", res.Code, res.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode workflow: %v", err)
	}
	createdItem := util.StringMap(created["item"])
	workflowID := util.Clean(createdItem["id"])
	seriesConfig := util.StringMap(createdItem["series_config"])
	config := util.StringMap(createdItem["config"])
	if createdItem["mode"] != "multi_image_series" || util.Clean(seriesConfig["target_count"]) != "6" || util.Clean(seriesConfig["concurrency"]) != "2" || !util.ToBool(seriesConfig["review_required"]) || util.Clean(config["quality"]) != "high" {
		t.Fatalf("workflow series contract was not preserved: %#v", createdItem)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/workflows", nil)
	setRequestAuthCookie(req, "Bearer "+bobToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"editable":false`) {
		t.Fatalf("public list status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/workflows/"+workflowID, nil)
	setRequestAuthCookie(req, "Bearer "+bobToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("foreign delete status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestWorkflowAgentDraftRouteValidatesPromptBeforeRelaySelection(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/workflows/agent-draft", strings.NewReader(`{"prompt":"   ","scope":"private"}`))
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "请输入工作流需求") {
		t.Fatalf("agent draft status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestWorkflowAgentPayloadMatchesReferenceContract(t *testing.T) {
	payload := workflowAgentPayload(service.WorkflowAgentDraftRequest{
		Prompt:     "创建商品海报工作流",
		ChannelID:  " text-token ",
		References: []string{"data:image/png;base64,AAAA"},
	}, "text-model")
	if payload["model"] != "text-model" || payload["token_name"] != "text-token" || payload["temperature"] != 0.2 {
		t.Fatalf("workflow agent payload = %#v", payload)
	}
	messages := util.AsMapSlice(payload["messages"])
	if len(messages) != 2 || util.Clean(messages[0]["content"]) != service.WorkflowAgentSystemPrompt {
		t.Fatalf("workflow agent messages = %#v", payload["messages"])
	}
}

func TestImageProxyRequiresAuthenticationAndRejectsInvalidURLs(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	adminToken := adminSessionToken(t, app)
	_, userToken := createPasswordUserSession(t, app, "proxy-user", "Password123", "Proxy User")

	req := httptest.NewRequest(http.MethodGet, "/api/proxy-image?url=https%3A%2F%2Fexample.com%2Fimage.png", nil)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous proxy status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/proxy-image?url=file%3A%2F%2F%2Fetc%2Fpasswd", nil)
	setRequestAuthCookie(req, userToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("default user proxy status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/proxy-image?url=file%3A%2F%2F%2Fetc%2Fpasswd", nil)
	setRequestAuthCookie(req, adminToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid URL proxy status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/proxy-image?url=http%3A%2F%2F127.0.0.1%2Fimage.png", nil)
	setRequestAuthCookie(req, adminToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadGateway {
		t.Fatalf("private host proxy status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfileBalanceReadsNewAPIUser(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "alice", "alice@example.test")
	updateHTTPTestNewAPIUserBalance(t, dbURL, 1, 123456, 789, 42, "codex")
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
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
	setRequestAuthCookie(req, "Bearer "+token)
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
		status["user_group"] != "codex" ||
		status["username"] != "alice" ||
		status["quota"] != float64(123456) ||
		status["used_quota"] != float64(789) ||
		status["request_count"] != float64(42) {
		t.Fatalf("profile balance = %#v", status)
	}
}

func TestLogsEndpointUsesDefaultLogView(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"default_log_view": "business"}); err != nil {
		t.Fatalf("Update(default_log_view) error = %v", err)
	}
	if err := app.logs.Add("新增账号", map[string]any{"module": "accounts", "operation_type": "新增"}); err != nil {
		t.Fatalf("Add(business log) error = %v", err)
	}
	if err := app.logs.Add("GET /api/profile", map[string]any{"method": "GET", "path": "/api/profile", "module": "profile", "status": 200, "log_level": "info"}); err != nil {
		t.Fatalf("Add(noisy audit log) error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/logs", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logs status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("logs json: %v", err)
	}
	if summaries := logPayloadSummaries(logItems(payload)); !reflect.DeepEqual(summaries, []string{"新增账号"}) {
		t.Fatalf("default logs summaries = %#v", summaries)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs?view=all", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logs all status = %d body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("logs all json: %v", err)
	}
	if summaries := logPayloadSummaries(logItems(payload)); !reflect.DeepEqual(summaries, []string{"GET /api/profile", "新增账号"}) {
		t.Fatalf("all logs summaries = %#v", summaries)
	}
}

func TestChatCompletionsCallLogIncludesUpstreamAccountPreview(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	const fullToken = "secret-upstream-token-for-log-test"
	ctx, tracker := protocol.WithAccountUsageTracker(context.Background())
	tracker.Record(fullToken)
	app.logCall(ctx, service.Identity{ID: "user-1", Role: service.AuthRoleUser, Name: "frontend"}, "文本生成", http.MethodPost, "/v1/chat/completions", "gpt-5", time.Now(), "success", http.StatusOK, "", nil, auditRequestCapture{})

	logs := app.logs.Search(service.LogQuery{Limit: 10})
	item := findLogBySummary(logs, "文本生成调用完成")
	if item == nil {
		t.Fatalf("expected chat completions log, got %#v", logs)
	}
	detail := util.StringMap(item["detail"])
	if util.Clean(detail["upstream_account_id"]) == "" || util.Clean(detail["upstream_token_preview"]) == "" {
		t.Fatalf("log detail missing upstream singleton fields: %#v", detail)
	}
	accounts := util.AsMapSlice(detail["upstream_accounts"])
	if len(accounts) != 1 || accounts[0]["account_id"] != detail["upstream_account_id"] || accounts[0]["token_preview"] != detail["upstream_token_preview"] {
		t.Fatalf("log detail upstream accounts = %#v, detail = %#v", accounts, detail)
	}
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal log item: %v", err)
	}
	if strings.Contains(string(encoded), fullToken) {
		t.Fatalf("log JSON leaked full upstream token: %s", encoded)
	}
}

func TestRunLoggedChatTaskCreatesAccountUsageTrackerForLogs(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	const fullToken = "task-chat-upstream-token-for-log-test"
	dbURL := newHTTPTestNewAPIDatabase(t)
	insertHTTPTestNewAPIUser(t, dbURL, 1, "frontend", "frontend@example.test")
	insertHTTPTestNewAPIToken(t, dbURL, 1, 1, "codex", fullToken, -1, 0, true)
	reader, err := service.NewNewAPITokenReader(service.NewAPITokenReaderConfig{DatabaseURL: dbURL})
	if err != nil {
		t.Fatalf("NewNewAPITokenReader() error = %v", err)
	}
	if app.newAPIKeys != nil {
		_ = app.newAPIKeys.Close()
	}
	app.newAPIKeys = reader

	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected upstream path: %s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		util.WriteJSON(w, http.StatusBadGateway, map[string]any{"error": map[string]any{"message": "upstream refused chat task"}})
	}))
	defer upstream.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay base URL error = %v", err)
	}

	_, err = app.runLoggedChatTask(context.Background(), service.Identity{ID: "user-1", Role: service.AuthRoleUser, Name: "frontend"}, map[string]any{
		"model":    "gpt-5",
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})
	if err == nil {
		t.Fatal("runLoggedChatTask() error = nil, want upstream error")
	}
	if gotAuth != "Bearer sk-"+fullToken {
		t.Fatalf("upstream Authorization = %q", gotAuth)
	}
	logs := app.logs.Search(service.LogQuery{Limit: 20})
	item := findLogBySummary(logs, "文本生成调用失败")
	if item == nil {
		t.Fatalf("expected failed chat task log, got %#v", logs)
	}
	detail := util.StringMap(item["detail"])
	if detail["endpoint"] != "/api/creation-tasks/chat-completions" || util.Clean(detail["upstream_account_id"]) == "" || util.Clean(detail["upstream_token_preview"]) == "" {
		t.Fatalf("chat task log detail missing upstream account fields: %#v", detail)
	}
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal log item: %v", err)
	}
	if strings.Contains(string(encoded), fullToken) {
		t.Fatalf("chat task log JSON leaked full upstream token: %s", encoded)
	}
}

func TestCreationTaskResponseImageRouteIsNotAnAdminTaskResource(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	body := `{"client_task_id":"response-image-route","prompt":"生成封面","model":"gpt-5.5","size":"2048x2048","image_resolution":"2k","quality":"high","output_format":"jpeg","output_compression":42,"n":2,"images":["data:image/png;base64,cG5n"],"messages":[{"role":"user","content":"生成封面"}],"visibility":"public"}`
	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/response-image-generations", strings.NewReader(body))
	setRequestAuthCookie(req, "Bearer "+rawKey)
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
	if err == nil {
		t.Fatal("runLoggedImageTask() error = nil, want empty image result failure")
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
	t.Setenv("IMAGE_BASE_URL", "https://image.yunmian.tech")
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
	if !strings.HasPrefix(localURL, "https://image.yunmian.tech/images/") {
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

func TestRunLoggedImageTaskLocalizesPartialResultOnUpstreamFailure(t *testing.T) {
	t.Setenv("IMAGE_BASE_URL", "https://image.yunmian.tech")
	app := newTestApp(t)
	defer app.Close()

	identity := service.Identity{ID: "user-partial", Role: service.AuthRoleUser, Name: "Alice"}
	result, err := app.runLoggedImageTask(
		context.Background(),
		identity,
		map[string]any{
			"prompt":     "draw",
			"model":      "gemini-3.1-flash-image",
			"visibility": service.ImageVisibilityPrivate,
		},
		"/api/creation-tasks/image-generations",
		"文生图",
		func(context.Context, map[string]any) (map[string]any, error) {
			return map[string]any{
				"data": []map[string]any{{
					"b64_json": base64.StdEncoding.EncodeToString(httpTestPNGBytes(t)),
				}},
			}, errors.New("second image failed")
		},
	)
	if err == nil || !strings.Contains(err.Error(), "second image failed") {
		t.Fatalf("runLoggedImageTask() error = %v, want partial upstream failure", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 {
		t.Fatalf("partial result data = %#v", result)
	}
	localURL := util.Clean(data[0]["url"])
	if !strings.HasPrefix(localURL, "https://image.yunmian.tech/images/") || util.Clean(data[0]["b64_json"]) != "" {
		t.Fatalf("partial image was not localized: %#v", result)
	}
	if _, accessErr := app.images.ImageFileAccess(localURL, service.ImageAccessScope{OwnerID: identity.ID}); accessErr != nil {
		t.Fatalf("localized partial image is not accessible from gallery: %v", accessErr)
	}
}

func TestRunLoggedImageTaskPersistsCompletedImageAfterRequestCancellation(t *testing.T) {
	t.Setenv("IMAGE_BASE_URL", "https://image.yunmian.tech")
	app := newTestApp(t)
	defer app.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result, err := app.runLoggedImageTask(
		ctx,
		service.Identity{ID: "user-cancelled", Role: service.AuthRoleUser, Name: "Alice"},
		map[string]any{
			"prompt":     "draw",
			"model":      "gemini-3.1-flash-image",
			"visibility": service.ImageVisibilityPrivate,
		},
		"/api/creation-tasks/image-generations",
		"文生图",
		func(context.Context, map[string]any) (map[string]any, error) {
			return map[string]any{
				"data": []map[string]any{{
					"b64_json": base64.StdEncoding.EncodeToString(httpTestPNGBytes(t)),
				}},
			}, context.Canceled
		},
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("runLoggedImageTask() error = %v, want context.Canceled", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || util.Clean(data[0]["url"]) == "" || util.Clean(data[0]["b64_json"]) != "" {
		t.Fatalf("completed image was not localized after cancellation: %#v", result)
	}
	access, accessErr := app.images.ImageFileAccess(util.Clean(data[0]["url"]), service.ImageAccessScope{OwnerID: "user-cancelled"})
	if accessErr != nil || access.Info.Size() == 0 {
		t.Fatalf("localized image file is unavailable after cancellation: info=%#v error=%v", access.Info, accessErr)
	}
}

func TestRelayStoredImageFormatUsesActualImageBytes(t *testing.T) {
	var encoded bytes.Buffer
	imageValue := image.NewRGBA(image.Rect(0, 0, 2, 1))
	imageValue.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := jpeg.Encode(&encoded, imageValue, nil); err != nil {
		t.Fatalf("encode JPEG: %v", err)
	}

	actualFormat := relayStoredImageFormat(
		map[string]any{"output_format": "png"},
		map[string]any{"output_format": "png"},
		"image/png",
		"https://example.test/image.png",
		encoded.Bytes(),
	)
	if actualFormat != "jpeg" {
		t.Fatalf("relayStoredImageFormat() = %q, want jpeg", actualFormat)
	}

	unspecified := util.StringMap(relayImageQualityCheck(encoded.Bytes(), actualFormat, map[string]any{})["quality_check"])
	if requested := util.Clean(unspecified["requested_output_format"]); requested != "" {
		t.Fatalf("unspecified request invented requested format %q: %#v", requested, unspecified)
	}
	if _, ok := unspecified["output_format_matched"]; ok {
		t.Fatalf("unspecified request should not compare output formats: %#v", unspecified)
	}

	explicit := util.StringMap(relayImageQualityCheck(encoded.Bytes(), actualFormat, map[string]any{"output_format": "png"})["quality_check"])
	if explicit["requested_output_format"] != "png" || explicit["actual_output_format"] != "jpeg" || explicit["output_format_matched"] != false {
		t.Fatalf("explicit format mismatch was not reported: %#v", explicit)
	}
}

func TestRunLoggedImageTaskHoldsSlotThroughLocalization(t *testing.T) {
	t.Setenv("IMAGE_BASE_URL", "https://image.yunmian.tech")
	app := newTestApp(t)
	defer app.Close()

	localizationStarted := make(chan struct{}, 1)
	allowLocalization := make(chan struct{})
	var allowOnce sync.Once
	imageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case localizationStarted <- struct{}{}:
		default:
		}
		<-allowLocalization
		w.Header().Set("Content-Type", "image/png")
		if err := encodeHTTPTestPNG(w); err != nil {
			t.Errorf("encode test image: %v", err)
		}
	}))
	defer imageServer.Close()
	defer allowOnce.Do(func() { close(allowLocalization) })

	releases := make(chan struct{}, 2)
	payload := map[string]any{
		"prompt":     "draw",
		"model":      "gpt-image-2",
		"visibility": service.ImageVisibilityPrivate,
		protocol.ImageOutputSlotAcquirerPayloadKey: func(ctx context.Context, index int) (func(), error) {
			if index != 0 {
				return nil, fmt.Errorf("slot index = %d, want 0", index)
			}
			return func() { releases <- struct{}{} }, nil
		},
	}
	type taskResult struct {
		result map[string]any
		err    error
	}
	done := make(chan taskResult, 1)
	go func() {
		result, err := app.runLoggedImageTask(
			context.Background(),
			service.Identity{ID: "user-slot", Role: service.AuthRoleUser, Name: "Alice"},
			payload,
			"/api/creation-tasks/image-generations",
			"文生图",
			func(_ context.Context, current map[string]any) (map[string]any, error) {
				if !relayImageTaskSlotIsManaged(current) {
					return nil, errors.New("runLoggedImageTask did not mark the slot as managed")
				}
				return map[string]any{"data": []map[string]any{{"url": imageServer.URL + "/image.png"}}}, nil
			},
		)
		done <- taskResult{result: result, err: err}
	}()

	select {
	case <-localizationStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for image localization")
	}
	select {
	case <-releases:
		t.Fatal("creation slot released before image localization completed")
	default:
	}
	select {
	case early := <-done:
		t.Fatalf("runLoggedImageTask returned before localization was released: %#v", early)
	default:
	}

	allowOnce.Do(func() { close(allowLocalization) })
	var completed taskResult
	select {
	case completed = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for logged image task completion")
	}
	if completed.err != nil {
		t.Fatalf("runLoggedImageTask() error = %v", completed.err)
	}
	if len(util.AsMapSlice(completed.result["data"])) != 1 {
		t.Fatalf("runLoggedImageTask() result = %#v", completed.result)
	}
	if len(releases) != 0 {
		t.Fatalf("slot released before terminal task commit: %d", len(releases))
	}
	completionRelease, ok := payload[service.ImageOutputCompletionReleasePayloadKey].(func())
	if !ok {
		t.Fatalf("completion release missing after handler completion: %#v", payload)
	}
	delete(payload, service.ImageOutputCompletionReleasePayloadKey)
	completionRelease()
	if len(releases) != 1 {
		t.Fatalf("slot release count = %d, want 1", len(releases))
	}
	if _, ok := payload[relayImageTaskSlotManagedPayloadKey]; ok {
		t.Fatalf("managed slot marker leaked after task completion: %#v", payload)
	}
}

func TestRunLoggedImageTaskReleasesSlotOnceOnError(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	releases := make(chan struct{}, 2)
	payload := map[string]any{
		"model": "gpt-image-2",
		protocol.ImageOutputSlotAcquirerPayloadKey: func(context.Context, int) (func(), error) {
			return func() { releases <- struct{}{} }, nil
		},
	}
	_, err := app.runLoggedImageTask(
		context.Background(),
		service.Identity{ID: "user-slot-error", Role: service.AuthRoleUser, Name: "Alice"},
		payload,
		"/api/creation-tasks/image-generations",
		"文生图",
		func(context.Context, map[string]any) (map[string]any, error) {
			return nil, errors.New("upstream failed")
		},
	)
	if err == nil || err.Error() != "upstream failed" {
		t.Fatalf("runLoggedImageTask() error = %v", err)
	}
	if len(releases) != 0 {
		t.Fatalf("slot released before error task commit: %d", len(releases))
	}
	completionRelease, ok := payload[service.ImageOutputCompletionReleasePayloadKey].(func())
	if !ok {
		t.Fatalf("completion release missing on error: %#v", payload)
	}
	completionRelease()
	if len(releases) != 1 {
		t.Fatalf("slot release count on error = %d, want 1", len(releases))
	}
}

func TestRelayImagePayloadDropsPartialImagesWithoutStream(t *testing.T) {
	payload := relayPayloadForPath("/v1/images/generations", map[string]any{
		"prompt":                            "draw",
		"model":                             "codex-gpt-image-2",
		"stream":                            false,
		"partial_images":                    2,
		"messages":                          []map[string]any{{"role": "user", "content": "draw"}},
		relayImageTaskSlotManagedPayloadKey: relayImageTaskSlotManagedMarker{},
		service.ImageOutputCompletionReleasePayloadKey: func() {},
	})
	if _, ok := payload["stream"]; ok {
		t.Fatalf("false stream should be dropped for image relay payload: %#v", payload)
	}
	if _, ok := payload["partial_images"]; ok {
		t.Fatalf("partial_images should be dropped when stream is false: %#v", payload)
	}
	if _, ok := payload["messages"]; ok {
		t.Fatalf("messages should be dropped for image relay payload: %#v", payload)
	}
	if _, ok := payload[relayImageTaskSlotManagedPayloadKey]; ok {
		t.Fatalf("managed slot marker should be dropped from relay payload: %#v", payload)
	}
	if _, ok := payload[service.ImageOutputCompletionReleasePayloadKey]; ok {
		t.Fatalf("completion release should be dropped from relay payload: %#v", payload)
	}
}

func TestPublicImageGenerationRouteIsNotExposed(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"gemini-3.1-flash-image","prompt":"draw","input_image_mask":"data:image/png;base64,bWFzaw=="}`))
	setRequestAuthCookie(req, adminSessionToken(t, app))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("generation mask status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestImageEditTaskRouteRejectsUnsupportedProviderMaskBeforeTokenLookup(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for key, value := range map[string]string{
		"model":  "gemini-3.1-flash-image",
		"prompt": "edit",
	} {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("WriteField(%s) error = %v", key, err)
		}
	}
	imagePart, err := writer.CreateFormFile("image", "source.png")
	if err != nil {
		t.Fatalf("CreateFormFile(image) error = %v", err)
	}
	if _, err := imagePart.Write(httpTestPNGBytes(t)); err != nil {
		t.Fatalf("write image: %v", err)
	}
	maskPart, err := writer.CreateFormFile("mask", "mask.png")
	if err != nil {
		t.Fatalf("CreateFormFile(mask) error = %v", err)
	}
	if _, err := maskPart.Write(httpTestAlphaPNGBytes(t, 12, 12)); err != nil {
		t.Fatalf("write mask: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-edits", body)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "does not support mask editing through NewAPI") {
		t.Fatalf("unsupported provider mask status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestImageTaskRouteRejectsInvalidOptionalIntegerParameters(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	tests := []struct {
		name  string
		field string
		value string
		want  string
	}{
		{name: "fractional partial images", field: "partial_images", value: "1.5", want: "partial_images must be an integer between 0 and 3"},
		{name: "too many partial images", field: "partial_images", value: "4", want: "partial_images must be an integer between 0 and 3"},
		{name: "negative compression", field: "output_compression", value: "-1", want: "output_compression must be an integer between 0 and 100"},
		{name: "compression overflow", field: "output_compression", value: "101", want: "output_compression must be an integer between 0 and 100"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"model":"gpt-image-2","prompt":"draw","%s":%s}`, test.field, test.value)
			req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(body))
			setRequestAuthCookie(req, adminSessionToken(t, app))
			req.Header.Set("Content-Type", "application/json")
			res := httptest.NewRecorder()
			app.Handler().ServeHTTP(res, req)
			if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), test.want) {
				t.Fatalf("status = %d body = %s, want %q", res.Code, res.Body.String(), test.want)
			}
		})
	}
}

func TestRelayImagePayloadKeepsStreamAndPartialImagesWhenRequested(t *testing.T) {
	payload := relayPayloadForPath("/v1/images/generations", map[string]any{
		"prompt":         "draw",
		"model":          "gpt-image-2",
		"stream":         true,
		"partial_images": 2,
	})
	if payload["stream"] != true {
		t.Fatalf("stream should be kept when requested: %#v", payload)
	}
	if payload["partial_images"] != 2 {
		t.Fatalf("partial_images = %#v, want 2 in %#v", payload["partial_images"], payload)
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
		{name: "4k preset", input: "4k", want: "2880x2880"},
		{name: "2k landscape", input: "2048x1152", want: "2048x1152"},
		{name: "4k landscape", input: "3840x2160", want: "3840x2160"},
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
		t.Fatalf("unsupported transparent background should be dropped: %#v", payload)
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
	if payload["response_format"] != "b64_json" {
		t.Fatalf("response_format = %#v, want b64_json: %#v", payload["response_format"], payload)
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
		"type":         "image_generation.completed",
		"object":       "image.generation.result",
		"created":      123,
		"model":        "codex-gpt-image-2",
		"output_index": 0,
		"data":         []map[string]any{{"url": "https://example.test/image.png"}},
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

func TestCollectRelayImageTaskStreamSeparatesPreviewsAndCompletedOutputs(t *testing.T) {
	items := make(chan map[string]any, 3)
	errCh := make(chan error, 1)
	items <- map[string]any{
		"type":                "image_generation.partial_image",
		"partial_image_index": 2,
		"b64_json":            "preview-first",
	}
	items <- map[string]any{"type": "image_generation.completed", "b64_json": "final-first"}
	items <- map[string]any{"type": "image_generation.completed", "b64_json": "final-second"}
	close(items)
	errCh <- nil
	close(errCh)

	progress := make([][]map[string]any, 0, 3)
	result, err := collectRelayImageTaskStream(
		map[string]any{
			"n": 2,
			"image_output_callback": func(data []map[string]any) {
				progress = append(progress, cloneRelayImageData(data))
			},
		},
		&protocol.StreamResult{Items: items, Err: errCh, Kind: "openai"},
	)
	if err != nil {
		t.Fatalf("collectRelayImageTaskStream() error = %v", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 2 || util.Clean(data[0]["b64_json"]) != "final-first" || util.Clean(data[1]["b64_json"]) != "final-second" {
		t.Fatalf("completed stream data = %#v", data)
	}
	for _, item := range data {
		if _, exists := item["preview"]; exists {
			t.Fatalf("preview marker leaked into final stream data: %#v", data)
		}
	}
	if len(progress) != 3 {
		t.Fatalf("progress callbacks = %d, want 3: %#v", len(progress), progress)
	}
	if len(progress[0]) != 1 || !util.ToBool(progress[0][0]["preview"]) || util.Clean(progress[0][0]["b64_json"]) != "preview-first" {
		t.Fatalf("partial progress = %#v", progress[0])
	}
	if len(progress[1]) != 1 || util.ToBool(progress[1][0]["preview"]) || util.Clean(progress[1][0]["b64_json"]) != "final-first" {
		t.Fatalf("first completed progress = %#v", progress[1])
	}
}

func TestCollectRelayImageTaskStreamKeepsCompletedOutputsWithTerminalUpstreamError(t *testing.T) {
	items := make(chan map[string]any, 1)
	errCh := make(chan error, 1)
	items <- map[string]any{
		"type":         "image_generation.completed",
		"output_index": 0,
		"url":          "https://example.test/completed.png",
	}
	close(items)
	errCh <- protocol.HTTPError{Status: http.StatusBadGateway, Message: "provider stream failed"}
	close(errCh)

	result, err := collectRelayImageTaskStream(
		map[string]any{"n": 2},
		&protocol.StreamResult{Items: items, Err: errCh, Kind: "openai"},
	)
	if err == nil || err.Error() != "provider stream failed" {
		t.Fatalf("collectRelayImageTaskStream() error = %v, want upstream error", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || util.Clean(data[0]["url"]) != "https://example.test/completed.png" {
		t.Fatalf("completed output was lost after stream error: %#v", result)
	}
}

func TestRelayImageStreamAccumulatorIgnoresLatePreviewForCompletedSlot(t *testing.T) {
	accumulator := newRelayImageStreamAccumulator(1)
	accumulator.apply(
		map[string]any{"type": "image_generation.partial_image", "output_index": 0},
		[]map[string]any{{"b64_json": "preview"}},
	)
	if data := accumulator.finalData(); len(data) != 0 {
		t.Fatalf("partial image entered final data: %#v", data)
	}
	accumulator.apply(
		map[string]any{"type": "image_generation.completed", "output_index": 0},
		[]map[string]any{{"b64_json": "final"}},
	)
	accumulator.apply(
		map[string]any{"type": "image_generation.partial_image", "output_index": 0},
		[]map[string]any{{"b64_json": "late-preview"}},
	)
	accumulator.apply(
		map[string]any{"type": "image_generation.progress", "output_index": 0},
		[]map[string]any{{"b64_json": "non-terminal"}},
	)

	data := accumulator.finalData()
	if len(data) != 1 || util.Clean(data[0]["b64_json"]) != "final" || util.ToBool(data[0]["preview"]) {
		t.Fatalf("completed slot was overwritten: %#v", data)
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

func TestChatCompletionTaskDataPreservesNativeToolCallsAndReasoning(t *testing.T) {
	result := map[string]any{
		"choices": []map[string]any{{
			"message": map[string]any{
				"role":              "assistant",
				"content":           nil,
				"reasoning_content": "先检查画布",
				"tool_calls": []map[string]any{{
					"id":   "call-1",
					"type": "function",
					"function": map[string]any{
						"name":      "get_canvas_summary",
						"arguments": "{}",
					},
				}},
			},
		}},
	}

	data := chatCompletionTaskData(result)
	if data["reasoning_content"] != "先检查画布" {
		t.Fatalf("reasoning_content = %#v", data["reasoning_content"])
	}
	calls := util.AsMapSlice(data["tool_calls"])
	if len(calls) != 1 || calls[0]["id"] != "call-1" || util.Clean(util.StringMap(calls[0]["function"])["name"]) != "get_canvas_summary" {
		t.Fatalf("tool_calls = %#v", calls)
	}
}

func TestCollectRelayChatTaskStreamReassemblesToolCalls(t *testing.T) {
	items := make(chan map[string]any, 2)
	errCh := make(chan error, 1)
	items <- map[string]any{
		"choices": []map[string]any{{"delta": map[string]any{
			"reasoning_content": "读取",
			"tool_calls": []map[string]any{{
				"index": 0,
				"id":    "call-1",
				"type":  "function",
				"function": map[string]any{
					"name":      "get_node",
					"arguments": "{\"nodeId\":",
				},
			}},
		}}},
	}
	items <- map[string]any{
		"choices": []map[string]any{{"delta": map[string]any{
			"reasoning_content": "节点",
			"tool_calls": []map[string]any{{
				"index": 0,
				"function": map[string]any{
					"arguments": "\"node-1\"}",
				},
			}},
		}}},
	}
	close(items)
	errCh <- nil
	close(errCh)

	result, err := collectRelayChatTaskStream(map[string]any{}, &protocol.StreamResult{Items: items, Err: errCh, Kind: "openai"})
	if err != nil {
		t.Fatalf("collectRelayChatTaskStream() error = %v", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["reasoning_content"] != "读取节点" {
		t.Fatalf("stream data = %#v", data)
	}
	calls := util.AsMapSlice(data[0]["tool_calls"])
	if len(calls) != 1 {
		t.Fatalf("stream tool_calls = %#v", calls)
	}
	function := util.StringMap(calls[0]["function"])
	if calls[0]["id"] != "call-1" || function["name"] != "get_node" || function["arguments"] != "{\"nodeId\":\"node-1\"}" {
		t.Fatalf("reassembled tool call = %#v", calls[0])
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

	referenceData := httpTestPNGBytes(t)
	app.recordGeneratedImagesForPayload(
		service.Identity{ID: "admin", Role: service.AuthRoleAdmin, Name: "Admin"},
		[]string{rel},
		service.ImageVisibilityPublic,
		map[string]any{
			"prompt":             "复用这个提示词",
			"generation_source":  service.ImageGenerationSourceCanvas,
			"model":              "gpt-image-2",
			"quality":            "high",
			"image_resolution":   "2k",
			"size":               "2048x2048",
			"output_format":      "jpeg",
			"output_compression": 42,
			"moderation":         "low",
			"input_image_mask":   "mask-id",
			"images": []protocol.UploadedImage{
				{Filename: "source.png", ContentType: "image/png", Data: referenceData},
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
		item["generation_source"] != service.ImageGenerationSourceCanvas ||
		item["model"] != "gpt-image-2" ||
		item["quality"] != "high" ||
		item["resolution_preset"] != "2k" ||
		item["requested_size"] != "2048x2048" ||
		item["output_format"] != "jpeg" ||
		item["output_compression"] != 42 ||
		item["moderation"] != "low" {
		t.Fatalf("reusable metadata = %#v", item)
	}
	if _, ok := item["input_image_mask"]; ok {
		t.Fatalf("raw mask data must not be stored as reusable metadata: %#v", item)
	}
	if _, ok := item["background"]; ok {
		t.Fatalf("background should not be stored as reusable metadata: %#v", item)
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
	if res.Code != http.StatusOK || !bytes.Equal(res.Body.Bytes(), referenceData) {
		t.Fatalf("public reference status = %d or body differs from source", res.Code)
	}
	if got := res.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("reference Content-Type = %q, want image/png", got)
	}
}

func TestImageGenerationSourceFromPayloadPrefersWorkflowContext(t *testing.T) {
	if got := imageGenerationSourceFromPayload(map[string]any{
		"generation_source": service.ImageGenerationSourceCanvas,
		"workflow_context":  map[string]any{"workflow_id": "workflow-1"},
	}); got != service.ImageGenerationSourceWorkflow {
		t.Fatalf("workflow source = %q, want %q", got, service.ImageGenerationSourceWorkflow)
	}
	if got := imageGenerationSourceFromPayload(map[string]any{"generation_source": service.ImageGenerationSourceCanvas}); got != service.ImageGenerationSourceCanvas {
		t.Fatalf("canvas source = %q, want %q", got, service.ImageGenerationSourceCanvas)
	}
	if got := imageGenerationSourceFromPayload(nil); got != service.ImageGenerationSourceWorkbench {
		t.Fatalf("default source = %q, want %q", got, service.ImageGenerationSourceWorkbench)
	}
}

func TestRecordGeneratedImagesForPayloadPreservesDetectedOutputFormat(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	var encoded bytes.Buffer
	imageValue := image.NewRGBA(image.Rect(0, 0, 2, 1))
	if err := jpeg.Encode(&encoded, imageValue, nil); err != nil {
		t.Fatalf("encode JPEG: %v", err)
	}
	imageURL, err := app.images.SaveImageBytes(context.Background(), encoded.Bytes(), "", "admin", "Admin", "png")
	if err != nil {
		t.Fatalf("SaveImageBytes() error = %v", err)
	}

	app.recordGeneratedImagesForPayload(
		service.Identity{ID: "admin", Role: service.AuthRoleAdmin, Name: "Admin"},
		[]string{imageURL},
		service.ImageVisibilityPrivate,
		map[string]any{"prompt": "format check", "model": "grok-imagine-image", "output_format": "png"},
	)

	list := app.images.ListImages("", "", "", service.ImageAccessScope{All: true})
	items := list["items"].([]map[string]any)
	if len(items) != 1 || items[0]["output_format"] != "jpeg" {
		t.Fatalf("actual JPEG format was overwritten by request metadata: %#v", list)
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
			setRequestAuthCookie(req, adminSessionToken(t, app))
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
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

func TestSiteIconUploadSettings(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	_ = writer.WriteField("site_icon_action", "replace")
	part, err := writer.CreateFormFile("site_icon_file", "brand.png")
	if err != nil {
		t.Fatalf("CreateFormFile() error = %v", err)
	}
	if err := encodeHTTPTestPNG(part); err != nil {
		t.Fatalf("encode upload png: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/settings/site-icon", body)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("site icon upload status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("site icon upload json: %v", err)
	}
	config, _ := payload["config"].(map[string]any)
	iconURL, _ := config["site_icon_url"].(string)
	if !strings.HasPrefix(iconURL, "/site-icons/") {
		t.Fatalf("site icon url = %#v in %#v", iconURL, payload)
	}

	req = httptest.NewRequest(http.MethodGet, iconURL, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.HasPrefix(res.Header().Get("Content-Type"), "image/png") {
		t.Fatalf("site icon static response = %d %q", res.Code, res.Header().Get("Content-Type"))
	}

	req = httptest.NewRequest(http.MethodGet, "/api/app-meta", nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("site icon app meta json: %v", err)
	}
	if payload["site_icon_url"] != iconURL {
		t.Fatalf("site icon app meta = %#v", payload)
	}

	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	_ = writer.WriteField("site_icon_action", "remove")
	if err := writer.Close(); err != nil {
		t.Fatalf("remove multipart close: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/settings/site-icon", body)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("site icon remove status = %d body = %s", res.Code, res.Body.String())
	}
	if _, err := os.Stat(filepath.Join(app.config.SiteIconsDir(), filepath.Base(iconURL))); !os.IsNotExist(err) {
		t.Fatalf("removed site icon still exists or stat failed: %v", err)
	}
}

func TestModelConfigAllowsAuthenticatedUserWithoutExplicitPermission(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, token := createPasswordUserSession(t, app, "alice", "Password123", "Alice")
	req := httptest.NewRequest(http.MethodGet, "/api/model-config", nil)
	setRequestAuthCookie(req, "Bearer "+token)
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
	if config["default_image_model"] == "" {
		t.Fatalf("model config = %#v", payload)
	}
	if config["default_text_model"] == "" || config["default_audio_model"] == "" {
		t.Fatalf("model config omitted text or audio defaults: %#v", payload)
	}
	if _, ok := config["chat_models"]; ok {
		t.Fatalf("model config leaked chat models: %#v", payload)
	}
	if _, ok := config["default_chat_model"]; ok {
		t.Fatalf("model config leaked chat default: %#v", payload)
	}
}

func TestImageVisibilityRejectsExternalImageURLWithoutFetching(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	requested := make(chan struct{}, 1)
	imageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested <- struct{}{}
		w.Header().Set("Content-Type", "image/png")
		if err := encodeHTTPTestPNG(w); err != nil {
			t.Fatalf("encode test image: %v", err)
		}
	}))
	defer imageServer.Close()

	req := httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(fmt.Sprintf(`{"path":%q,"visibility":"public"}`, imageServer.URL+"/relay.png")))
	setRequestAuthCookie(req, "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "external image URLs cannot be imported") {
		t.Fatalf("external image visibility status = %d body = %s", res.Code, res.Body.String())
	}
	select {
	case <-requested:
		t.Fatal("external image server was requested")
	default:
	}
}

func TestImageVisibilityImportsDataURL(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	ownerID := util.Clean(user["id"])
	var imageData bytes.Buffer
	if err := encodeHTTPTestPNG(&imageData); err != nil {
		t.Fatalf("encode test image: %v", err)
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageData.Bytes())

	req := httptest.NewRequest(http.MethodPatch, "/api/images/visibility", strings.NewReader(fmt.Sprintf(`{"path":%q,"visibility":"public"}`, dataURL)))
	setRequestAuthCookie(req, "Bearer "+rawKey)
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
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

func TestAuthSessionCookieLifecycle(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"`+testAdminUsername+`","password":"`+testAdminPassword+`"}`))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", res.Code, res.Body.String())
	}
	cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
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
	cleared := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
	if cleared == nil || cleared.MaxAge >= 0 || cleared.Value != "" {
		t.Fatalf("logout cookie = %#v", cleared)
	}
}

func TestAuthSessionCookieIsHostOnly(t *testing.T) {
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
		cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, "")
		if cookie == nil || cookie.Value == "" || cookie.Path != "/" || !cookie.HttpOnly || !cookie.Secure {
			t.Fatalf("login %s host-only cookie = %#v", host, cookie)
		}
		if got := cookie.SameSite; got != http.SameSiteLaxMode {
			t.Fatalf("login %s cookie SameSite = %v, want Lax", host, got)
		}
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
	if cookie := findResponseCookieByDomain(res.Result(), authSessionCookieName, ""); cookie == nil || cookie.Value == "" {
		t.Fatalf("login cookie = %#v", cookie)
	}
}

func TestCredentialedCORSAllowsSameHostnameAcrossPorts(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/auth/session", nil)
	req.Host = "studio.example.test:8001"
	req.Header.Set("Origin", "https://studio.example.test:8002")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "https://studio.example.test:8002" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want request origin", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
}

func TestCredentialedCORSRejectsNonHTTPOrigin(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/auth/session", nil)
	req.Host = "studio.example.test"
	req.Header.Set("Origin", "chrome-extension://studio.example.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers"} {
		if got := res.Header().Get(header); got != "" {
			t.Fatalf("%s = %q, want empty", header, got)
		}
	}
}

func TestUnconfiguredSiblingSubdomainDoesNotAllowCredentialedCORS(t *testing.T) {
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
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want empty", got)
	}
}

func TestUnconfiguredSiblingSubdomainWithForwardedHostDoesNotAllowCredentialedCORS(t *testing.T) {
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
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want empty", got)
	}
}

func TestForgedForwardedHostDoesNotAllowCredentialedCORS(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/auth/session", nil)
	req.Host = "image.relayai.tech"
	req.Header.Set("X-Forwarded-Host", "evil.example")
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want empty", got)
	}
}

func TestUnconfiguredSiblingSubdomainBehindProxyDoesNotAllowCredentialedCORS(t *testing.T) {
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
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want empty", got)
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

func TestCredentialedImageVisibilityPreflightAllowsPatchContentType(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodOptions, "/api/images/visibility", nil)
	req.Host = "127.0.0.1:8000"
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", http.MethodPatch)
	req.Header.Set("Access-Control-Request-Headers", "content-type")
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
	if got := res.Header().Get("Access-Control-Allow-Headers"); got != "content-type" {
		t.Fatalf("Access-Control-Allow-Headers = %q, want content-type", got)
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

func TestUserKeyRoutesAreNotExposed(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/auth/users"},
		{http.MethodPost, "/api/auth/users"},
		{http.MethodGet, "/api/auth/users/key-1/key"},
		{http.MethodPost, "/api/auth/users/key-1"},
		{http.MethodDelete, "/api/auth/users/key-1"},
		{http.MethodGet, "/api/admin/users/key-1/key"},
		{http.MethodPost, "/api/admin/users/key-1/reset-key"},
	} {
		req := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
		setRequestAuthCookie(req, adminSessionToken(t, app))
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d body = %s", route.method, route.path, res.Code, res.Body.String())
		}
	}
}

func TestProfileAPIKeyRouteIsNotExposed(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/profile/api-key", nil)
		setRequestAuthCookie(req, adminSessionToken(t, app))
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusNotFound {
			t.Fatalf("%s profile API key status = %d body = %s", method, res.Code, res.Body.String())
		}
	}
}

func TestRemovedProfileAndProxyRoutesAreNotExposed(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)

	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/profile"},
		{http.MethodPost, "/api/profile"},
		{http.MethodPost, "/api/profile/password"},
		{http.MethodGet, "/api/proxy"},
		{http.MethodPost, "/api/proxy"},
	} {
		req := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d body = %s", route.method, route.path, res.Code, res.Body.String())
		}
	}
}

func TestManagedUserDetailReadRouteIsNotExposed(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/unused-detail", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("managed user detail GET status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestProfilePromptFavoritesAlwaysExcludeAdultContent(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	user, token := createPasswordUserSession(t, app, "alice", "Password123", "Alice")

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
	setRequestAuthCookie(req, "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("nsfw favorite status = %d body = %s", res.Code, res.Body.String())
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
	setRequestAuthCookie(req, "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", res.Code, res.Body.String())
	}
	var list map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &list); err != nil {
		t.Fatalf("list json: %v", err)
	}
	if items := logItems(list); len(items) != 0 {
		t.Fatalf("user saw historical nsfw favorites: %#v", list)
	}
}

func TestManagedUsersDefaultSortsByCreatedAtBeforePagination(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/admin/users?page=1&page_size=2", nil)
	query, err := parseManagedUsersQuery(req)
	if err != nil {
		t.Fatalf("parseManagedUsersQuery() error = %v", err)
	}
	if query.SortBy != "created_at" || query.SortOrder != "desc" {
		t.Fatalf("default sort = %s %s, want created_at desc", query.SortBy, query.SortOrder)
	}

	items := []map[string]any{
		{"id": "user_z", "created_at": "2026-01-01 10:00:00"},
		{"id": "user_a", "created_at": "2026-01-03 10:00:00"},
		{"id": "user_m", "created_at": "2026-01-02 10:00:00"},
	}
	sortManagedUsers(items, query)
	start := (query.Page - 1) * query.PageSize
	pageItems := items[start : start+query.PageSize]
	got := []string{util.Clean(pageItems[0]["id"]), util.Clean(pageItems[1]["id"])}
	want := []string{"user_a", "user_m"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("default page ids = %#v, want %#v; sorted items = %#v", got, want, items)
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
	defaultUsers := []map[string]any{enabledOne, disabledOne, enabledTwo}
	sort.SliceStable(defaultUsers, func(i, j int) bool {
		leftCreated := util.Clean(defaultUsers[i]["created_at"])
		rightCreated := util.Clean(defaultUsers[j]["created_at"])
		if leftCreated != rightCreated {
			return leftCreated > rightCreated
		}
		return util.Clean(defaultUsers[i]["id"]) > util.Clean(defaultUsers[j]["id"])
	})
	expectedDefaultIDs := []string{
		util.Clean(defaultUsers[0]["id"]),
		util.Clean(defaultUsers[1]["id"]),
		util.Clean(defaultUsers[2]["id"]),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users?page=1&page_size=3", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	if len(items) != len(expectedDefaultIDs) || payload["sort_by"] != "created_at" || payload["sort_order"] != "desc" {
		t.Fatalf("default sorted metadata/items = %#v", payload)
	}
	for index, item := range items {
		if item["id"] != expectedDefaultIDs[index] {
			t.Fatalf("default sorted ids = %#v, want %#v", items, expectedDefaultIDs)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/users?page=2&page_size=2", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid page status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestCreationTaskPollingDisablesCaching(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/creation-tasks?ids=missing", nil)
	setRequestAuthCookie(req, "Bearer "+rawKey)
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

func TestAutomaticProfileReadsAvoidGenericAuditNoise(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, rawKey, err := createTestUserSession(app, "automatic-read", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/profile/image-generation-preferences", nil)
	setRequestAuthCookie(req, "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("preferences status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs?view=all", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logs status = %d body = %s", res.Code, res.Body.String())
	}
	var logs map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &logs); err != nil {
		t.Fatalf("logs json: %v", err)
	}
	if auditLog := findHTTPAuditLogByPath(logItems(logs), "/api/profile/image-generation-preferences"); auditLog != nil {
		t.Fatalf("automatic preference read should not create a generic audit log: %#v", auditLog)
	}
}

func TestAPIAuditLogCapturesRequestMetadata(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users?page=1", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
	req.Header.Set("User-Agent", "chatgpt2api-test")
	req.RemoteAddr = "203.0.113.10:12345"
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("users status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs?username=admin&method=GET&status=200&summary=%2Fapi%2Fadmin%2Fusers&view=all", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	item := findLogByDetail(items, "path", "/api/admin/users")
	if item == nil {
		t.Fatalf("expected audit log for /api/admin/users, got %#v", items)
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

	_, rawKey, err := createTestUserSession(app, "frontend", service.AuthOwner{})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(`{"client_task_id":"noise-test","prompt":"test image"}`))
	setRequestAuthCookie(req, "Bearer "+rawKey)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("submit creation task status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/creation-tasks?ids=noise-test", nil)
	setRequestAuthCookie(req, "Bearer "+rawKey)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("poll creation task status = %d body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/logs?view=all", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
		{"time": time.Now().AddDate(0, 0, -2).Format("2006-01-02 15:04:05"), "type": "event", "summary": "旧日志", "detail": map[string]any{"status": "success"}},
		{"time": time.Now().Format("2006-01-02 15:04:05"), "type": "event", "summary": "新日志", "detail": map[string]any{"status": 200}},
	} {
		if err := logStore.AppendLog(item); err != nil {
			t.Fatalf("AppendLog() error = %v", err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/logs/governance", nil)
	setRequestAuthCookie(req, adminSessionToken(t, app))
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
	setRequestAuthCookie(req, adminSessionToken(t, app))
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

func TestNewAppStartsLogRetentionCleaner(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("ADMIN_USERNAME", testAdminUsername)
	t.Setenv("ADMIN_PASSWORD", testAdminPassword)
	t.Setenv("STORAGE_BACKEND", "sqlite")
	t.Setenv("STORAGE_DATABASE_URL", "")
	t.Setenv("LOG_RETENTION_DAYS", "1")
	t.Setenv("LOG_CLEANUP_SCHEDULE_ENABLED", "true")
	t.Setenv("LOG_CLEANUP_HOUR", fmt.Sprint(time.Now().Hour()))
	unsetTestEnv(t, "REGISTRATION_ENABLED")

	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir data dir: %v", err)
	}
	backend, err := storage.NewBackendFromEnv(dataDir)
	if err != nil {
		t.Fatalf("NewBackendFromEnv() error = %v", err)
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
	if closer, ok := backend.(interface{ Close() error }); ok {
		if err := closer.Close(); err != nil {
			t.Fatalf("close seed backend: %v", err)
		}
	}

	app, err := NewApp()
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}
	defer app.Close()

	waitForHTTPTestCondition(t, func() bool {
		items := app.logs.Search(service.LogQuery{Limit: 10})
		return len(items) == 1 && items[0]["summary"] == "新日志"
	})
}

func logPayloadSummaries(items []map[string]any) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, util.Clean(item["summary"]))
	}
	return out
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

func adminSessionToken(t *testing.T, app *App) string {
	t.Helper()
	identity, token, err := app.auth.LoginAdminPassword(testAdminUsername, testAdminPassword)
	if err != nil {
		t.Fatalf("admin LoginPassword() error = %v", err)
	}
	if identity == nil || identity.Role != service.AuthRoleAdmin || token == "" {
		t.Fatalf("admin LoginPassword() identity=%#v token=%q", identity, token)
	}
	return token
}

func setRequestAuthCookie(req *http.Request, token string) {
	token = strings.TrimSpace(token)
	if len(token) > len("Bearer ") && strings.EqualFold(token[:len("Bearer ")], "Bearer ") {
		token = strings.TrimSpace(token[len("Bearer "):])
	}
	req.AddCookie(&http.Cookie{Name: authSessionCookieName, Value: token})
}

func createTestUserSession(app *App, name string, owner service.AuthOwner) (map[string]any, string, error) {
	if owner.Name != "" {
		name = owner.Name
	}
	username := "test-" + util.NewHex(8)
	identity, token, err := app.auth.UpsertNewAPISession(service.NewAPIUser{
		ID:          atomic.AddInt64(&nextHTTPTestUserID, 1),
		Username:    username,
		DisplayName: name,
	})
	if err != nil {
		return nil, "", err
	}
	return map[string]any{"id": identity.ID, "name": identity.Name, "username": identity.Username}, token, nil
}

var nextHTTPTestUserID int64 = 1000

func createPasswordUserSession(t *testing.T, app *App, username, _ string, name string) (*service.Identity, string) {
	t.Helper()
	userID := atomic.AddInt64(&nextHTTPTestUserID, 1)
	if username == "alice" {
		userID = 1
	}
	identity, token, err := app.auth.UpsertNewAPISession(service.NewAPIUser{ID: userID, Username: username, DisplayName: name})
	if err != nil {
		t.Fatalf("UpsertNewAPISession(%s) error = %v", username, err)
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
	insertHTTPTestNewAPITokenNamed(t, dbURL, id, userID, group, "token", key, expiredTime, remainQuota, unlimited)
}

func insertHTTPTestNewAPITokenNamed(t *testing.T, dbURL string, id, userID int, group, name, key string, expiredTime int64, remainQuota int, unlimited bool) {
	t.Helper()
	db := openHTTPTestNewAPIDatabase(t, dbURL)
	defer db.Close()
	if _, err := db.Exec("INSERT INTO tokens (id, user_id, `key`, status, name, expired_time, remain_quota, unlimited_quota, `group`, deleted_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)", id, userID, key, name, expiredTime, remainQuota, unlimited, group); err != nil {
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

func TestProfileAssetsAreSyncedPerAccount(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	_, aliceToken := createPasswordUserSession(t, app, "asset-alice", "Password123", "Asset Alice")
	_, bobToken := createPasswordUserSession(t, app, "asset-bob", "Password123", "Asset Bob")
	body := `{"items":[{"id":"asset-text","kind":"text","title":"镜头提示词","content":"电影感近景","visibility":"public","tags":["电影"],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},{"id":"asset-audio","kind":"audio","title":"参考音频","url":"/videos/references/a.mp3","mimeType":"audio/mpeg","bytes":2048,"durationMs":4300,"visibility":"private","source":"画布","note":"节奏参考","tags":[]}]}`
	req := httptest.NewRequest(http.MethodPut, "/api/profile/assets", strings.NewReader(body))
	setRequestAuthCookie(req, "Bearer "+aliceToken)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("replace assets status = %d body = %s", res.Code, res.Body.String())
	}

	for _, test := range []struct {
		name  string
		token string
		want  int
	}{{"owner", aliceToken, 2}, {"other", bobToken, 0}} {
		req = httptest.NewRequest(http.MethodGet, "/api/profile/assets", nil)
		setRequestAuthCookie(req, "Bearer "+test.token)
		res = httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s list status = %d body = %s", test.name, res.Code, res.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("%s list json: %v", test.name, err)
		}
		if items := logItems(payload); len(items) != test.want {
			t.Fatalf("%s assets = %#v, want %d", test.name, items, test.want)
		} else if test.name == "owner" {
			audio := items[0]
			textAsset := items[0]
			if util.Clean(audio["id"]) != "asset-audio" {
				audio = items[1]
			}
			if util.Clean(textAsset["id"]) != "asset-text" {
				textAsset = items[1]
			}
			if util.Clean(audio["mimeType"]) != "audio/mpeg" || util.ToInt(audio["bytes"], 0) != 2048 || util.ToInt(audio["durationMs"], 0) != 4300 || util.Clean(audio["source"]) != "画布" || util.Clean(audio["note"]) != "节奏参考" {
				t.Fatalf("owner asset metadata = %#v", audio)
			}
			if !strings.HasPrefix(util.Clean(textAsset["storageKey"]), "server:") || util.Clean(textAsset["mimeType"]) != "text/plain; charset=utf-8" || util.ToInt(textAsset["bytes"], 0) != len([]byte("电影感近景")) {
				t.Fatalf("text asset storage metadata = %#v", textAsset)
			}
		}
	}

	bobBody := `{"items":[{"id":"bob-private","kind":"text","title":"Bob private","content":"private","visibility":"private","tags":[]},{"id":"bob-public","kind":"text","title":"Bob public","content":"public","visibility":"public","tags":[]}]}`
	req = httptest.NewRequest(http.MethodPut, "/api/profile/assets", strings.NewReader(bobBody))
	setRequestAuthCookie(req, "Bearer "+bobToken)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("replace bob assets status = %d body = %s", res.Code, res.Body.String())
	}

	visibleItems := func(name, authHeader string) []map[string]any {
		t.Helper()
		req = httptest.NewRequest(http.MethodGet, "/api/profile/assets?scope=visible", nil)
		setRequestAuthCookie(req, authHeader)
		res = httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s status = %d body = %s", name, res.Code, res.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("%s json: %v", name, err)
		}
		return logItems(payload)
	}

	bobVisible := visibleItems("other visible", "Bearer "+bobToken)
	if len(bobVisible) != 3 {
		t.Fatalf("other visible assets = %#v, want 3", bobVisible)
	}
	bobByID := map[string]map[string]any{}
	for _, item := range bobVisible {
		bobByID[util.Clean(item["id"])] = item
	}
	if bobByID["asset-audio"] != nil || bobByID["asset-text"] == nil || bobByID["bob-private"] == nil || bobByID["bob-public"] == nil {
		t.Fatalf("ordinary visibility set = %#v", bobVisible)
	}
	if util.Clean(bobByID["asset-text"]["ownerName"]) != "Asset Alice" || util.ToBool(bobByID["asset-text"]["owned"]) || !util.ToBool(bobByID["bob-private"]["owned"]) {
		t.Fatalf("ordinary ownership metadata = %#v", bobVisible)
	}

	adminVisible := visibleItems("admin visible", adminSessionToken(t, app))
	if len(adminVisible) != 4 {
		t.Fatalf("admin visible assets = %#v, want 4", adminVisible)
	}
	adminByID := map[string]map[string]any{}
	for _, item := range adminVisible {
		adminByID[util.Clean(item["id"])] = item
	}
	if adminByID["asset-audio"] == nil || adminByID["asset-text"] == nil || adminByID["bob-private"] == nil || adminByID["bob-public"] == nil {
		t.Fatalf("admin visibility set = %#v", adminVisible)
	}
}

func newTestApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("ADMIN_USERNAME", testAdminUsername)
	t.Setenv("ADMIN_PASSWORD", testAdminPassword)
	t.Setenv("STORAGE_BACKEND", "sqlite")
	t.Setenv("STORAGE_DATABASE_URL", "")
	app, err := NewApp()
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}
	return app
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

func httpTestPNGBytes(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := encodeHTTPTestPNG(&data); err != nil {
		t.Fatalf("encodeHTTPTestPNG() error = %v", err)
	}
	return data.Bytes()
}

func httpTestAlphaPNGBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	imageData := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			alpha := uint8(255)
			if x == 0 && y == 0 {
				alpha = 0
			}
			imageData.SetNRGBA(x, y, color.NRGBA{R: 255, G: 255, B: 255, A: alpha})
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, imageData); err != nil {
		t.Fatalf("encode alpha PNG: %v", err)
	}
	return data.Bytes()
}
