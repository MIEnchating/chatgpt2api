package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestStorageFileRoutesMatchReferenceLifecycle(t *testing.T) {
	webDAVData := []byte("0123456789")
	deleted := false
	webDAV := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "dav-user" || password != "dav-password" {
			w.Header().Set("WWW-Authenticate", `Basic realm="storage-test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if got := r.Header.Get("Range"); got == "bytes=2-5" {
				w.Header().Set("Content-Range", "bytes 2-5/10")
				w.Header().Set("Content-Length", "4")
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write(webDAVData[2:6])
				return
			}
			w.Header().Set("Content-Length", "10")
			_, _ = w.Write(webDAVData)
		case http.MethodDelete:
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer webDAV.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"storage": model.StorageSetting{
		AllowUserProvider: true, AllowUserGlobalProvider: true,
	}}); err != nil {
		t.Fatalf("enable user storage providers: %v", err)
	}
	alice, aliceToken := createPasswordUserSession(t, app, "storage-alice", "Password123!", "Storage Alice")
	_, bobToken := createPasswordUserSession(t, app, "storage-bob", "Password123!", "Storage Bob")

	request := httptest.NewRequest(http.MethodGet, "/api/storage/config", nil)
	setRequestAuthCookie(request, aliceToken)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated storage config status = %d body = %s", response.Code, response.Body.String())
	}
	var publicPayload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &publicPayload); err != nil {
		t.Fatal(err)
	}
	config := util.StringMap(publicPayload["config"])
	if util.Clean(config["mode"]) != "server_user_or_local" || !util.ToBool(config["localStorageEnabled"]) || !util.ToBool(config["allowUserProvider"]) {
		t.Fatalf("authenticated storage config = %#v", config)
	}

	providerJSON := fmt.Sprintf(`{
		"provider":{"webdav":{"enabled":true,"name":"Alice DAV","type":"webdav",
		"endpoint":%q,"pathPrefix":"canvas","username":"dav-user","password":"dav-password"}}
	}`, webDAV.URL)
	request = httptest.NewRequest(http.MethodPost, "/api/profile/storage-provider", strings.NewReader(providerJSON))
	request.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("save user provider status = %d body = %s", response.Code, response.Body.String())
	}

	objectKey := "canvas/" + alice.ID + "/2026/08/26/video.mp4"
	directJSON := fmt.Sprintf(`{
		"provider":{"enabled":true,"name":"Alice DAV","type":"webdav","endpoint":%q,
		"pathPrefix":"canvas","username":"dav-user","password":"dav-password"},
		"objectKey":%q,"mimeType":"video/mp4","bytes":10
	}`, webDAV.URL, objectKey)
	request = httptest.NewRequest(http.MethodPost, "/api/files/direct", strings.NewReader(directJSON))
	request.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("register direct object status = %d body = %s", response.Code, response.Body.String())
	}
	var directPayload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &directPayload); err != nil {
		t.Fatal(err)
	}
	objectID := util.Clean(util.StringMap(directPayload["object"])["id"])
	if objectID == "" {
		t.Fatalf("direct object response = %#v", directPayload)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/files/"+objectID, nil)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous object info status = %d body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/files/"+objectID, nil)
	setRequestAuthCookie(request, bobToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-user object info status = %d body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/files/"+objectID, nil)
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"direct":true`) {
		t.Fatalf("storage object info status = %d body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/files/"+objectID+"/content", nil)
	setRequestAuthCookie(request, bobToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-user object content status = %d body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/files/"+objectID+"/content", nil)
	request.Header.Set("Range", "bytes=2-5")
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "2345" {
		t.Fatalf("range content status = %d body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Range"); got != "bytes 2-5/10" {
		t.Fatalf("Content-Range = %q", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("GET content Cache-Control = %q", got)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/files/"+objectID+"/content", nil)
	request.Header.Set("Range", "bytes=10-11")
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("invalid range status = %d body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodHead, "/api/files/"+objectID+"/content", nil)
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("HEAD content status = %d body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("HEAD content Cache-Control = %q", got)
	}

	request = httptest.NewRequest(http.MethodDelete, "/api/files/"+objectID, strings.NewReader(`{}`))
	setRequestAuthCookie(request, bobToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-user delete status = %d body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodDelete, "/api/files/"+objectID, strings.NewReader(`{"provider":`))
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || deleted {
		t.Fatalf("malformed delete status = %d deleted = %v body = %s", response.Code, deleted, response.Body.String())
	}

	assetJSON := fmt.Sprintf(`{"item":{"id":"stored-video","kind":"video","title":"Stored video","url":"/api/files/%s/content","storageKey":"server:%s","mimeType":"video/mp4","tags":[]}}`, objectID, objectID)
	request = httptest.NewRequest(http.MethodPost, "/api/profile/assets", strings.NewReader(assetJSON))
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("save referenced asset status = %d body = %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodDelete, "/api/files/"+objectID, strings.NewReader(`{}`))
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict || deleted {
		t.Fatalf("referenced object delete status = %d deleted = %v body = %s", response.Code, deleted, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodDelete, "/api/profile/assets", strings.NewReader(`{"id":"stored-video"}`))
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("delete referenced asset status = %d body = %s", response.Code, response.Body.String())
	}
	workspace, err := app.canvas.Workspace(alice.ID)
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	workspace.Document.Nodes = []service.CanvasNode{{
		ID: "stored-video", Type: "video", Width: 640, Height: 360, ScaleX: 1, ScaleY: 1,
		URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID,
		GenerationVideoModel: defaultVideoModel, GenerationVideoSeconds: 5,
	}}
	savedCanvas, err := app.canvas.SaveAtRevision(alice.ID, workspace.Document)
	if err != nil {
		t.Fatalf("SaveAtRevision(canvas reference) error = %v", err)
	}
	request = httptest.NewRequest(http.MethodDelete, "/api/files/"+objectID, strings.NewReader(`{}`))
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict || deleted {
		t.Fatalf("canvas-referenced object delete status = %d deleted = %v body = %s", response.Code, deleted, response.Body.String())
	}
	if _, err := app.canvas.ClearAtRevision(alice.ID, savedCanvas.ID, savedCanvas.Revision); err != nil {
		t.Fatalf("ClearAtRevision() error = %v", err)
	}

	request = httptest.NewRequest(http.MethodDelete, "/api/files/"+objectID, strings.NewReader(`{}`))
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !deleted {
		t.Fatalf("owner delete status = %d deleted = %v body = %s", response.Code, deleted, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/files/"+objectID, nil)
	setRequestAuthCookie(request, aliceToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("deleted object info status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestStorageRoutesEnforceProviderAndMeasurePermissions(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"storage": model.StorageSetting{AllowUserProvider: true}}); err != nil {
		t.Fatal(err)
	}
	_, userToken := createPasswordUserSession(t, app, "storage-permissions", "Password123!", "Storage Permissions")
	request := httptest.NewRequest(http.MethodGet, "/api/storage/config", nil)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous storage config status = %d body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/profile/storage-provider", strings.NewReader(`{
		"provider":{
			"s3":{"enabled":true,"type":"s3","endpoint":"https://s3.example.test","bucket":"media","accessKeyId":"key","secretAccessKey":"secret"},
			"webdav":{"enabled":true,"type":"webdav","endpoint":"https://dav.example.test","username":"user","password":"secret"}
		}
	}`))
	setRequestAuthCookie(request, userToken)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "cannot be enabled") {
		t.Fatalf("mixed user providers status = %d body = %s", response.Code, response.Body.String())
	}

	for _, testCase := range []struct {
		name       string
		token      string
		wantStatus int
	}{
		{name: "anonymous", wantStatus: http.StatusUnauthorized},
		{name: "ordinary user", token: userToken, wantStatus: http.StatusForbidden},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/settings/storage/measure", strings.NewReader(`{"index":0}`))
			setRequestAuthCookie(request, testCase.token)
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestStorageMeasureHonorsExplicitRolePermission(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	role, err := app.auth.CreateRole(map[string]any{
		"name":            "Storage Capacity Operator",
		"menu_paths":      []string{"/settings"},
		"api_permissions": []string{service.APIPermissionKey(http.MethodPost, "/api/settings/storage/measure")},
	})
	if err != nil {
		t.Fatalf("CreateRole() error = %v", err)
	}
	roleID := util.Clean(role["id"])
	if _, err := app.auth.CreatePasswordUser("storage_operator", "Password123!", "Storage Operator", roleID, true); err != nil {
		t.Fatalf("CreatePasswordUser() error = %v", err)
	}
	identity, token, err := app.auth.LoginPassword("storage_operator", "Password123!")
	if err != nil || identity == nil || token == "" {
		t.Fatalf("LoginPassword() = (%#v, %q, %v)", identity, token, err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/settings/storage/measure", strings.NewReader(`{"index":0}`))
	setRequestAuthCookie(request, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "storage provider does not exist") {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestStorageDirectRouteDoesNotFallThroughToFileResource(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			request := httptest.NewRequest(method, "/api/files/direct", nil)
			setRequestAuthCookie(request, token)
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestProfileStorageMeasureHonorsDisabledUserProviders(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"storage": model.StorageSetting{Mode: "server_local"}}); err != nil {
		t.Fatal(err)
	}
	_, userToken := createPasswordUserSession(t, app, "storage-measure-disabled", "Password123!", "Storage Measure Disabled")

	request := httptest.NewRequest(http.MethodPost, "/api/profile/storage-provider/measure", strings.NewReader(`{
		"provider":{"enabled":true,"type":"webdav","endpoint":"http://127.0.0.1:1","username":"user","password":"secret"}
	}`))
	request.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(request, userToken)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "user storage providers are disabled") {
		t.Fatalf("disabled user provider measure status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestAnonymousStorageRoutesAreNotExposed(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	for _, path := range []string{"/api/anonymous/files/session", "/api/anonymous/files", "/api/anonymous/files/object-id"} {
		request := httptest.NewRequest(http.MethodPost, path, nil)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d body = %s, want 404", path, response.Code, response.Body.String())
		}
	}
}
