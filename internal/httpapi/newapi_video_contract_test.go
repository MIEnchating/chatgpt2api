package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func newAPIExampleVideoContracts(t *testing.T) map[string]protocol.VideoModelContract {
	t.Helper()
	data, err := os.ReadFile("../../docs/examples/newapi-video-contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var document videoModelContractTransferDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if document.Version != 4 {
		t.Fatalf("contract version = %d", document.Version)
	}
	contracts := make(map[string]protocol.VideoModelContract)
	for _, item := range document.Contracts {
		contract, err := protocol.NormalizeVideoModelContract(item.Contract)
		if err != nil {
			t.Fatal(err)
		}
		for _, model := range contract.Models {
			contracts[model] = contract
		}
	}
	return contracts
}

func TestNewAPIVideoContractRequestsMatchPluginFixtures(t *testing.T) {
	contracts := newAPIExampleVideoContracts(t)
	data, err := os.ReadFile("testdata/newapi-video-contract-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string         `json:"name"`
		Input   map[string]any `json:"input"`
		Request map[string]any `json:"request"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, test := range cases {
		t.Run(test.Name, func(t *testing.T) {
			contract, ok := contracts[util.Clean(test.Input["model"])]
			if !ok {
				t.Fatal("missing example contract")
			}
			request := declaredVideoContractRequestPayload(test.Input, contract)
			if contract.Driver == protocol.VideoContractDriverVolcengine {
				request, err = newAPIDoubaoVideoRequest(request, test.Input, contract)
				if err != nil {
					t.Fatal(err)
				}
			}
			actual, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			want, _ := json.Marshal(test.Request)
			if string(actual) != string(want) {
				t.Fatalf("request = %s, want %s", actual, want)
			}
		})
	}
}

func TestNewAPIVideoContractDownloadsAuthenticatedContentWithoutResultURL(t *testing.T) {
	for model, contract := range newAPIExampleVideoContracts(t) {
		t.Run(model, func(t *testing.T) {
			contract.Polling.IntervalSeconds = 1
			const content = "test-video-content"
			polls, downloads := 0, 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-only" {
					t.Error("missing authenticated New API request")
				}
				switch r.Method + " " + r.URL.Path {
				case "POST /v1/videos":
					if contract.Driver == protocol.VideoContractDriverVolcengine {
						var posted map[string]any
						if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
							t.Error(err)
						}
						content := util.AsMapSlice(videoJSONPathValue(posted, "metadata.content"))
						if len(content) != 2 || content[0]["role"] != "first_frame" || content[1]["role"] != "last_frame" {
							t.Errorf("Seedance frame roles were lost: %#v", posted)
						}
					}
					util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "object": "video", "status": "queued", "progress": 0})
				case "GET /v1/videos/video_public":
					polls++
					status, progress := "in_progress", 37
					if polls > 1 {
						status, progress = "completed", 100
					}
					util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "object": "video", "status": status, "progress": progress})
				case "GET /v1/videos/video_public/content":
					downloads++
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte(content))
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()
			app := newTestApp(t)
			defer app.Close()
			var updates []service.VideoTaskProgressUpdate
			result, err := app.relayVideoTask(context.Background(), map[string]any{
				"model": model, "prompt": "A paper boat", "seconds": 8, "size": "16:9", "resolution": "720p",
				"api_key": "test-only", "relay_base_url": upstream.URL, "client_task_id": "local-video", "owner_id": "test-owner",
				"first_frame_url": "https://media.example/first.png", "last_frame_url": "https://media.example/last.png",
				protocol.VideoContractSnapshotPayloadKey:    contract,
				service.VideoTaskProgressCallbackPayloadKey: func(update service.VideoTaskProgressUpdate) { updates = append(updates, update) },
			})
			if err != nil {
				t.Fatal(err)
			}
			items := util.AsMapSlice(result["data"])
			if len(items) != 1 || downloads != 1 || len(updates) != 3 {
				t.Fatalf("result=%#v downloads=%d updates=%#v", result, downloads, updates)
			}
			url := util.Clean(items[0]["video_url"])
			if !strings.HasPrefix(url, "/videos/") {
				t.Fatalf("video URL = %q", url)
			}
			stored, err := os.ReadFile(filepath.Join(app.videoDir, filepath.Base(url)))
			if err != nil || string(stored) != content {
				t.Fatalf("stored video = %q, err = %v", stored, err)
			}
		})
	}
}

func TestNewAPIVideoCompletedErrorPreservesProviderReason(t *testing.T) {
	contract := newAPIExampleVideoContracts(t)["grok-imagine-video"]
	const reason = "The generated video was blocked by content moderation."
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "status": "queued"})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/content") {
			t.Error("attempted to download a missing artifact")
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"id": "video_public", "status": "completed", "error": map[string]any{"code": "moderation_blocked", "message": reason}})
	}))
	defer upstream.Close()
	app := newTestApp(t)
	defer app.Close()
	_, err := app.relayVideoTask(context.Background(), map[string]any{
		"model": "grok-imagine-video", "prompt": "A paper boat", "api_key": "test-only", "relay_base_url": upstream.URL,
		protocol.VideoContractSnapshotPayloadKey: contract,
	})
	if err == nil || !strings.Contains(err.Error(), reason) {
		t.Fatalf("error = %v", err)
	}
}
