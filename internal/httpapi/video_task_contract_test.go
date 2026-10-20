package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestVideoCreationRecordsServerSelectedContractAndPublishedRevision(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	app.tasks.SetVideoHandler(func(context.Context, service.Identity, map[string]any) (map[string]any, error) {
		return map[string]any{"output_type": "video", "data": []any{}}, nil
	})
	adminToken := adminSessionToken(t, app)
	request := func(token, method, path string, body any) (int, map[string]any) {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		setRequestAuthCookie(req, token)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		var result map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode response %d: %s", response.Code, response.Body.String())
		}
		return response.Code, result
	}
	contract := protocol.DefaultVideoContracts()[0]
	contract.Name = "Task contract"
	contract.Models = []string{"task-contract-video"}
	created, err := app.videoContracts.Create(contract, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.config.Update(map[string]any{"video_models": contract.Models}); err != nil {
		t.Fatal(err)
	}
	status, response := request(adminToken, http.MethodPost, "/api/profile/custom-relay-configs", map[string]any{
		"kind": "video", "name": "Test video key", "base_url": "https://relay.example", "api_key": "sk-test-video",
	})
	if status != http.StatusCreated {
		t.Fatalf("create relay = %d, %#v", status, response)
	}
	tokenName := util.Clean(util.StringMap(response["item"])["token_name"])
	submit := func(id string, revision int, name string) {
		t.Helper()
		status, result := request(adminToken, http.MethodPost, "/api/creation-tasks/video-generations", map[string]any{
			"client_task_id": id, "model": contract.Models[0], "prompt": "animate", "seconds": 5, "size": "16:9", "resolution": "768p", "generation_mode": "text-to-video", "token_name": tokenName,
			"video_contract": map[string]any{"id": "spoofed", "name": "Spoofed", "revision": 999},
		})
		if status != http.StatusOK {
			t.Fatalf("submit = %d, %#v", status, result)
		}
		reference := util.StringMap(result["video_contract"])
		if reference["id"] != created.ID || reference["name"] != name || util.ToInt(reference["revision"], 0) != revision {
			t.Fatalf("contract reference = %#v", reference)
		}
	}
	submit("before-publish", 1, contract.Name)
	contract.Name = "Published task contract"
	status, response = request(adminToken, http.MethodPost, "/api/admin/video-model-contracts/"+created.ID+"/publish", map[string]any{"contract": contract, "enabled": true})
	if status != http.StatusOK {
		t.Fatalf("publish = %d, %#v", status, response)
	}
	submit("after-publish", 2, contract.Name)
	status, response = request(adminToken, http.MethodGet, "/api/creation-tasks?ids=before-publish", nil)
	items := util.AsMapSlice(response["items"])
	if status != http.StatusOK || len(items) != 1 || util.ToInt(util.StringMap(items[0]["video_contract"])["revision"], 0) != 1 {
		t.Fatalf("historical task = %d, %#v", status, response)
	}
	_, userToken := createPasswordUserSession(t, app, "video-viewer", "Password123", "Viewer")
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		path := "/api/admin/video-model-contracts"
		if method == http.MethodPost {
			path += "/" + created.ID + "/publish"
		}
		status, response = request(userToken, method, path, map[string]any{"contract": contract, "enabled": true})
		if status != http.StatusForbidden {
			t.Fatalf("non-admin %s = %d, %#v", method, status, response)
		}
	}
}
