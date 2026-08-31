package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestRelayCredentialsUseCurrentPayloadFieldsOnly(t *testing.T) {
	payload := map[string]any{
		"api_key":            "current-key",
		"relay_api_key":      "removed-key",
		"token_group":        "current-group",
		"newapi_token_group": "removed-group",
		"token_name":         "current-name",
		"relay_token_name":   "removed-name",
	}
	if got := relayAPIKeyFromPayload(payload); got != "current-key" {
		t.Fatalf("relayAPIKeyFromPayload() = %q, want current-key", got)
	}
	if got := selectedRelayTokenGroupFromPayload(payload); got != "current-group" {
		t.Fatalf("selectedRelayTokenGroupFromPayload() = %q, want current-group", got)
	}
	if got := selectedRelayTokenNameFromPayload(payload); got != "current-name" {
		t.Fatalf("selectedRelayTokenNameFromPayload() = %q, want current-name", got)
	}

	removed := map[string]any{
		"relay_api_key":      "removed-key",
		"newapi_token_group": "removed-group",
		"relay_token_name":   "removed-name",
	}
	if relayAPIKeyFromPayload(removed) != "" || selectedRelayTokenGroupFromPayload(removed) != "" || selectedRelayTokenNameFromPayload(removed) != "" {
		t.Fatalf("removed credential fields must not be accepted: %#v", removed)
	}
}

func TestCustomRelaySelectionUsesItsBaseURLAndKeyWithoutForwardingInternals(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	identity, _, err := app.auth.LoginAdminPassword(testAdminUsername, testAdminPassword)
	if err != nil || identity == nil {
		t.Fatalf("LoginAdminPassword() identity=%#v error=%v", identity, err)
	}
	var received map[string]any
	var authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"id": "completion-1", "choices": []any{}})
	}))
	defer upstream.Close()
	customConfig, err := app.customRelayConfigs.Create(identityScope(*identity), "text", "测试线路", upstream.URL, "sk-custom")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	payload := map[string]any{
		"model": "gpt-5.5", "messages": []map[string]any{{"role": "user", "content": "hello"}},
		"token_name": customConfig.TokenName,
	}
	if err := app.attachRelayAPIKeyForIdentity(context.Background(), *identity, payload); err != nil {
		t.Fatalf("attachRelayAPIKeyForIdentity() error = %v", err)
	}
	if _, _, err := app.relayJSONMaybeStream(context.Background(), "/v1/chat/completions", payload); err != nil {
		t.Fatalf("relayJSONMaybeStream() error = %v", err)
	}
	if authorization != "Bearer sk-custom" {
		t.Fatalf("Authorization = %q", authorization)
	}
	if received["relay_base_url"] != nil || received["api_key"] != nil || received["token_name"] != nil {
		t.Fatalf("request leaked internal credentials: %#v", received)
	}
}

func TestRelayAcquireImageTaskSlotUsesWholeRequestSlot(t *testing.T) {
	called := 0
	released := false
	payload := map[string]any{
		protocol.ImageOutputSlotAcquirerPayloadKey: func(ctx context.Context, index int) (func(), error) {
			if index != 0 {
				t.Fatalf("slot index = %d, want 0", index)
			}
			if err := ctx.Err(); err != nil {
				t.Fatalf("ctx err = %v", err)
			}
			called++
			return func() { released = true }, nil
		},
	}

	release, err := relayAcquireImageTaskSlot(context.Background(), payload)
	if err != nil {
		t.Fatalf("relayAcquireImageTaskSlot() error = %v", err)
	}
	if called != 1 {
		t.Fatalf("acquire calls = %d, want 1", called)
	}
	release()
	if !released {
		t.Fatal("release was not called")
	}
}

func TestRelayImageStreamReleasesSlotOnlyAfterStreamEnds(t *testing.T) {
	items := make(chan map[string]any)
	errs := make(chan error, 1)
	released := make(chan struct{})
	stream := relayImageStreamWithSlotRelease(
		context.Background(),
		&protocol.StreamResult{Items: items, Err: errs, Kind: "openai"},
		func() { close(released) },
	)

	go func() {
		items <- map[string]any{"data": []map[string]any{{"url": "https://example.test/image.png"}}}
		close(items)
	}()
	if item := <-stream.Items; item == nil {
		t.Fatal("wrapped stream dropped image item")
	}
	select {
	case <-released:
		t.Fatal("slot released before upstream stream result arrived")
	default:
	}
	errs <- nil
	close(errs)
	if err := <-stream.Err; err != nil {
		t.Fatalf("wrapped stream error = %v", err)
	}
	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("slot was not released after stream ended")
	}
}

func TestRelayImageStreamReleasesSlotWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	released := make(chan struct{})
	items := make(chan map[string]any)
	errs := make(chan error)
	drained := make(chan struct{})
	stream := relayImageStreamWithSlotRelease(
		ctx,
		&protocol.StreamResult{Items: items, Err: errs, Kind: "openai"},
		func() { close(released) },
	)
	cancel()
	go func() {
		items <- map[string]any{"type": "image_generation.partial_image", "b64_json": "preview"}
		close(items)
		errs <- context.Canceled
		close(errs)
		close(drained)
	}()
	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("slot was not released after stream context cancellation")
	}
	if _, ok := <-stream.Items; ok {
		t.Fatal("wrapped item channel remained open after cancellation")
	}
	if err, ok := <-stream.Err; !ok || err != context.Canceled {
		t.Fatalf("wrapped cancellation error = %v, open=%v", err, ok)
	}
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled stream did not drain its upstream producer")
	}
}

func TestLocalizeRelayImageStreamCancellationDrainsUpstream(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	items := make(chan map[string]any)
	errs := make(chan error)
	drained := make(chan struct{})
	stream := (&App{}).localizeRelayImageStream(ctx, map[string]any{}, &protocol.StreamResult{
		Items: items,
		Err:   errs,
		Kind:  "openai",
	})
	cancel()
	go func() {
		items <- map[string]any{"type": "image_generation.partial_image", "b64_json": "preview"}
		close(items)
		errs <- context.Canceled
		close(errs)
		close(drained)
	}()

	if _, ok := <-stream.Items; ok {
		t.Fatal("localized item channel remained open after cancellation")
	}
	if err, ok := <-stream.Err; !ok || err != context.Canceled {
		t.Fatalf("localized cancellation error = %v, open=%v", err, ok)
	}
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("localized stream did not drain its upstream producer")
	}
}

func TestRelayImageTaskManagedMarkerCannotBeForgedByJSON(t *testing.T) {
	if relayImageTaskSlotIsManaged(map[string]any{relayImageTaskSlotManagedPayloadKey: true}) {
		t.Fatal("JSON boolean forged the internal managed-slot marker")
	}
	if !relayImageTaskSlotIsManaged(map[string]any{relayImageTaskSlotManagedPayloadKey: relayImageTaskSlotManagedMarker{}}) {
		t.Fatal("internal managed-slot marker was not recognized")
	}
}

func TestRelayHTTPClientUsesConfiguredImageTaskTimeout(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"image_task_timeout_seconds": 420}); err != nil {
		t.Fatalf("update image task timeout: %v", err)
	}
	if got := app.relayHTTPClient().Timeout; got != 420*time.Second {
		t.Fatalf("relay HTTP timeout = %s, want %s", got, 420*time.Second)
	}
}

func TestManagedRelayImageTaskDoesNotAcquireSecondSlot(t *testing.T) {
	acquireCalls := 0
	payload := map[string]any{
		"prompt":                            "draw",
		relayImageTaskSlotManagedPayloadKey: relayImageTaskSlotManagedMarker{},
		protocol.ImageOutputSlotAcquirerPayloadKey: func(context.Context, int) (func(), error) {
			acquireCalls++
			return func() {}, nil
		},
	}
	app := &App{}
	_, _, err := app.relayImageGenerations(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "upstream API key is required") {
		t.Fatalf("relayImageGenerations() error = %v", err)
	}
	if acquireCalls != 0 {
		t.Fatalf("managed creation task acquired %d extra slots", acquireCalls)
	}
}

func TestRelayPayloadForGrokUsesOfficialGenerationParameters(t *testing.T) {
	grok := relayPayloadForPath("/v1/images/generations", map[string]any{
		"model":              "grok-imagine-image-2.0",
		"prompt":             "draw",
		"n":                  2,
		"size":               "1024x1024",
		"quality":            "medium",
		"stream":             true,
		"partial_images":     2,
		"aspect_ratio":       "16:9",
		"resolution":         "2k",
		"image_format":       "png",
		"storage_options":    map[string]any{"ttl": 3600},
		"user":               "user-1",
		"response_format":    "B64_JSON",
		"output_format":      "webp",
		"background":         "opaque",
		"moderation":         "low",
		"output_compression": 80,
	})
	for _, key := range []string{
		"size", "quality",
		"image_format", "storage_options", "user", "output_format", "background",
		"moderation", "output_compression",
	} {
		if _, ok := grok[key]; ok {
			t.Fatalf("Grok retained unsupported %s: %#v", key, grok)
		}
	}
	if grok["model"] != "grok-imagine-image-2.0" || grok["prompt"] != "draw" || grok["n"] != 2 {
		t.Fatalf("Grok dropped a supported field: %#v", grok)
	}
	if grok["response_format"] != "b64_json" || grok["aspect_ratio"] != "16:9" || grok["resolution"] != "2k" || grok["stream"] != true || grok["partial_images"] != 2 {
		t.Fatalf("Grok official parameters were not retained: %#v", grok)
	}
}

func assertVideoRequestFieldAbsentRecursively(t *testing.T, value any, field string) {
	t.Helper()
	var walk func(any)
	walk = func(current any) {
		switch typed := current.(type) {
		case map[string]any:
			if _, ok := typed[field]; ok {
				t.Fatalf("field %q leaked in payload: %#v", field, value)
			}
			for _, item := range typed {
				walk(item)
			}
		case []any:
			for _, item := range typed {
				walk(item)
			}
		}
	}
	walk(value)
}

func TestRelayVideoMultipartRequestUploadsInputReferenceFile(t *testing.T) {
	req, err := relayVideoMultipartRequest(
		context.Background(),
		"https://relay.example/",
		"sk-test",
		"/v1/videos",
		map[string]any{
			"model":           "MiniMax-H3",
			"prompt":          "make a video",
			"ratio":           "auto",
			"generation_mode": "legacy-client-value",
			"metadata":        map[string]any{"resolution": "768P"},
		},
		"input_reference",
		[]videoMultipartFile{{Filename: "reference.png", ContentType: "image/png", Data: []byte("png-bytes")}},
	)
	if err != nil {
		t.Fatalf("relayVideoMultipartRequest() error = %v", err)
	}
	if req.URL.String() != "https://relay.example/v1/videos" {
		t.Fatalf("request URL = %q", req.URL.String())
	}
	if req.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("Authorization = %q", req.Header.Get("Authorization"))
	}
	reader, err := req.MultipartReader()
	if err != nil {
		t.Fatalf("MultipartReader() error = %v", err)
	}
	fields := map[string]string{}
	var reference []byte
	for {
		part, partErr := reader.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			t.Fatalf("NextPart() error = %v", partErr)
		}
		data, readErr := io.ReadAll(part)
		if readErr != nil {
			t.Fatalf("ReadAll() error = %v", readErr)
		}
		if part.FormName() == "input_reference" {
			reference = data
			if part.FileName() != "reference.png" || part.Header.Get("Content-Type") != "image/png" {
				t.Fatalf("reference headers filename=%q content-type=%q", part.FileName(), part.Header.Get("Content-Type"))
			}
		} else {
			fields[part.FormName()] = string(data)
		}
	}
	if fields["ratio"] != "auto" || fields["generation_mode"] != "legacy-client-value" {
		t.Fatalf("multipart fields = %#v", fields)
	}
	if fields["metadata"] != `{"resolution":"768P"}` {
		t.Fatalf("multipart metadata = %q", fields["metadata"])
	}
	if string(reference) != "png-bytes" {
		t.Fatalf("input_reference = %q", reference)
	}
}

func TestDeclaredVideoContractKeepsPublicURLsAsJSON(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if contentType := r.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
			t.Errorf("Content-Type = %q, want application/json", contentType)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("Decode() error = %v", err)
		}
		if payload["generation_mode"] != "reference-to-video" {
			t.Errorf("generation_mode = %#v", payload["generation_mode"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"video-json","status":"queued"}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	contract, _ := protocol.VideoContractForModel("minimax-h3-768p")
	request := declaredVideoContractRequestPayload(map[string]any{
		"model":                "minimax-h3-768p",
		"prompt":               "public material",
		"reference_mode":       "reference",
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
	}, contract)
	result, err := app.relayVideoSubmitAt(context.Background(), upstream.URL, "sk-test", "/v1/videos", request, contract)
	if err != nil {
		t.Fatalf("relayVideoSubmitAt() error = %v", err)
	}
	if result["id"] != "video-json" {
		t.Fatalf("result = %#v", result)
	}
}

func TestRelayVideoTaskUsesContractProtocolDriver(t *testing.T) {
	tests := []struct {
		name        string
		driver      string
		createPath  string
		queryPrefix string
		created     map[string]any
		completed   map[string]any
		configure   func(*protocol.VideoModelContract)
	}{
		{
			name: "OpenAI Videos", driver: protocol.VideoContractDriverOpenAI,
			createPath: "/v1/videos", queryPrefix: "/v1/videos/",
			created:   map[string]any{"id": "openai-task", "status": "queued"},
			completed: map[string]any{"id": "openai-task", "status": "completed", "video_url": "https://cdn.example.com/openai.mp4"},
		},
		{
			name: "xAI Videos", driver: protocol.VideoContractDriverXAI,
			createPath: "/v1/videos", queryPrefix: "/v1/videos/",
			created:   map[string]any{"request_id": "xai-task"},
			completed: map[string]any{"request_id": "xai-task", "status": "done", "video": map[string]any{"url": "https://cdn.example.com/xai.mp4"}},
			configure: func(contract *protocol.VideoModelContract) {
				contract.Request.GenerationModeField = ""
				contract.Polling.TaskIDFields = []string{"request_id"}
				contract.Polling.SuccessStatuses = []string{"done"}
				contract.Polling.FailureStatuses = []string{"expired"}
				contract.Polling.ResultFields = []string{"video.url"}
			},
		},
		{
			name: "Kling Videos", driver: protocol.VideoContractDriverKling,
			createPath: "/kling/v1/videos/text2video", queryPrefix: "/kling/v1/videos/text2video/",
			created:   map[string]any{"id": "kling-task", "status": "queued"},
			completed: map[string]any{"id": "kling-task", "status": "completed", "video_url": "https://cdn.example.com/kling.mp4"},
			configure: func(contract *protocol.VideoModelContract) {
				contract.Generation.Modes = contract.Generation.Modes[:2]
				contract.Request.GenerationModeField = ""
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract := protocol.DefaultVideoContracts()[0]
			contract.Driver = test.driver
			contract.Artifact = protocol.VideoModelContractArtifact{
				Mode: "response_url",
				Auth: "none",
			}
			contract.Polling.IntervalSeconds = 1
			contract.Polling.TimeoutSeconds = 2
			if test.configure != nil {
				test.configure(&contract)
			}
			contract, err := protocol.NormalizeVideoModelContract(contract)
			if err != nil {
				t.Fatalf("NormalizeVideoModelContract() error = %v", err)
			}
			taskID := videoContractFirstString(test.created, contract.Polling.TaskIDFields)
			progressUpdates := make([]service.VideoTaskProgressUpdate, 0, 2)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer sk-test" {
					t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
				}
				switch {
				case r.Method == http.MethodPost && r.URL.Path == test.createPath:
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Errorf("decode create body: %v", err)
					}
					if body["model"] != "minimax-h3-768p" {
						t.Errorf("model = %#v", body["model"])
					}
					util.WriteJSON(w, http.StatusOK, test.created)
				case r.Method == http.MethodGet && r.URL.Path == test.queryPrefix+taskID:
					util.WriteJSON(w, http.StatusOK, test.completed)
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()

			app := newTestApp(t)
			defer app.Close()
			payload := map[string]any{
				"model": "minimax-h3-768p", "prompt": "city", "generation_mode": "text-to-video",
				"api_key": "sk-test", "relay_base_url": upstream.URL,
				protocol.VideoContractSnapshotPayloadKey: contract,
				service.VideoTaskProgressCallbackPayloadKey: func(update service.VideoTaskProgressUpdate) {
					progressUpdates = append(progressUpdates, update)
				},
			}
			result, err := app.relayVideoTask(context.Background(), payload)
			if err != nil {
				t.Fatalf("relayVideoTask() error = %v", err)
			}
			data := util.AsMapSlice(result["data"])
			if len(data) != 1 || !strings.HasPrefix(util.Clean(data[0]["url"]), "https://cdn.example.com/") {
				t.Fatalf("relayVideoTask() result = %#v", result)
			}
			if len(progressUpdates) < 2 || progressUpdates[len(progressUpdates)-1].UpstreamStatus == "" {
				t.Fatalf("video progress updates = %#v", progressUpdates)
			}
		})
	}
}

func TestDeclaredVideoContractForwardsLocalMixedMaterialsAsMultipart(t *testing.T) {
	const platformBaseURL = "https://platform.example"
	type expectedFile struct {
		name        string
		contentType string
		data        string
	}
	expected := []expectedFile{
		{name: "reference-11111111111111111111111111111111.png", contentType: "image/png", data: "image-bytes"},
		{name: "reference-22222222222222222222222222222222.mp4", contentType: "video/mp4", data: "video-bytes"},
		{name: "reference-33333333333333333333333333333333.mp3", contentType: "audio/mpeg", data: "audio-bytes"},
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("ParseMultipartForm() error = %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.FormValue("generation_mode") != "reference-to-video" {
			t.Errorf("generation_mode = %q", r.FormValue("generation_mode"))
		}
		if got := r.FormValue("reference_image_urls"); got != `["https://cdn.example.com/public.png"]` {
			t.Errorf("public reference_image_urls = %q", got)
		}
		if got := r.FormValue("reference_video_urls"); got != "" {
			t.Errorf("local video URL leaked into form = %q", got)
		}
		if got := r.FormValue("reference_audio_urls"); got != "" {
			t.Errorf("local audio URL leaked into form = %q", got)
		}
		files := r.MultipartForm.File["input_reference[]"]
		if len(files) != len(expected) {
			t.Errorf("multipart files = %d, want %d", len(files), len(expected))
		} else {
			for index, header := range files {
				file, err := header.Open()
				if err != nil {
					t.Errorf("open file %d: %v", index, err)
					continue
				}
				data, _ := io.ReadAll(file)
				_ = file.Close()
				if header.Filename != expected[index].name || header.Header.Get("Content-Type") != expected[index].contentType || string(data) != expected[index].data {
					t.Errorf("file %d = name %q type %q data %q", index, header.Filename, header.Header.Get("Content-Type"), data)
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"video-multipart","status":"queued"}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"base_url": platformBaseURL}); err != nil {
		t.Fatalf("update base URL: %v", err)
	}
	for _, file := range expected {
		if err := os.WriteFile(filepath.Join(app.videoReferenceDir, file.name), []byte(file.data), 0o600); err != nil {
			t.Fatalf("write local reference: %v", err)
		}
	}
	contract, _ := protocol.VideoContractForModel("minimax-h3-768p")
	request := declaredVideoContractRequestPayload(map[string]any{
		"model":          "minimax-h3-768p",
		"prompt":         "mixed material",
		"reference_mode": "reference",
		"reference_image_urls": []string{
			platformBaseURL + "/video-image-references/" + expected[0].name,
			"https://cdn.example.com/public.png",
		},
		"reference_video_urls": []string{platformBaseURL + "/video-references/" + expected[1].name},
		"reference_audio_urls": []string{platformBaseURL + "/audio-references/" + expected[2].name},
	}, contract)
	result, err := app.relayVideoSubmitAt(context.Background(), upstream.URL, "sk-test", "/v1/videos", request, contract)
	if err != nil {
		t.Fatalf("relayVideoSubmitAt() error = %v", err)
	}
	if result["id"] != "video-multipart" {
		t.Fatalf("result = %#v", result)
	}
}

func TestDeclaredVideoContractForwardsRelativeLocalMaterialAsMultipart(t *testing.T) {
	const name = "reference-44444444444444444444444444444444.png"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("ParseMultipartForm() error = %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := r.FormValue("generation_mode"); got != "image-to-video" {
			t.Errorf("generation_mode = %q", got)
		}
		files := r.MultipartForm.File["input_reference[]"]
		if len(files) != 1 || files[0].Filename != name {
			t.Errorf("multipart files = %#v", files)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"video-relative","status":"queued"}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"base_url": ""}); err != nil {
		t.Fatalf("clear base URL: %v", err)
	}
	if err := os.WriteFile(filepath.Join(app.videoReferenceDir, name), []byte("image-bytes"), 0o600); err != nil {
		t.Fatalf("write local reference: %v", err)
	}
	contract, _ := protocol.VideoContractForModel("minimax-h3-768p")
	request := declaredVideoContractRequestPayload(map[string]any{
		"model":           "minimax-h3-768p",
		"prompt":          "relative local material",
		"first_frame_url": "/video-image-references/" + name,
	}, contract)
	result, err := app.relayVideoSubmitAt(context.Background(), upstream.URL, "sk-test", "/v1/videos", request, contract)
	if err != nil {
		t.Fatalf("relayVideoSubmitAt() error = %v", err)
	}
	if result["id"] != "video-relative" {
		t.Fatalf("result = %#v", result)
	}
}

func TestRelativeLocalVideoMaterialRequiresMultipartContract(t *testing.T) {
	const localPath = "/video-image-references/reference-55555555555555555555555555555555.png"
	contract, _ := protocol.VideoContractForModel("minimax-h3-768p")
	request := declaredVideoContractRequestPayload(map[string]any{
		"model": "minimax-h3-768p", "prompt": "animate", "first_frame_url": localPath,
	}, contract)
	if err := validateVideoReferencePayloadURLs(request, contract); err != nil {
		t.Fatalf("declared multipart model rejected relative local material: %v", err)
	}
	urlContract := contract
	urlContract.Transport.LocalMaterial = "url"
	if err := validateVideoReferencePayloadURLs(map[string]any{"model": "missing-contract", "image_url": localPath}, urlContract); err == nil {
		t.Fatal("model without a multipart contract accepted relative local material")
	}
}

func TestLocalVideoReferenceFileRejectsOtherHostsAndUnsafePaths(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"base_url": "https://platform.example"}); err != nil {
		t.Fatalf("update base URL: %v", err)
	}
	for _, rawURL := range []string{
		"https://other.example/video-image-references/reference-11111111111111111111111111111111.png",
		"https://platform.example/video-image-references/../../config.json",
		"https://platform.example/video-image-references/reference-not-a-valid-id.png",
		"/video-image-references/../../config.json",
		"/video-image-references/reference-11111111111111111111111111111111.exe",
		"video-image-references/reference-11111111111111111111111111111111.png",
	} {
		if _, local, err := app.localVideoReferenceFile(rawURL); err != nil || local {
			t.Fatalf("localVideoReferenceFile(%q) = local %v, error %v", rawURL, local, err)
		}
	}
}

func TestRelayGrokImageGenerationUsesNewAPIImageRouteAndAllowlist(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" {
			t.Errorf("upstream path = %q, want /v1/images/generations", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("Authorization = %q, want Bearer sk-test", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode Grok request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"created": 123,
			"data":    []map[string]any{{"url": "https://image.example/grok.jpg"}},
		})
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key":         "sk-test",
		"model":           "grok-imagine-image-2.0",
		"prompt":          "draw",
		"n":               2,
		"response_format": "b64_json",
		"aspect_ratio":    "16:9",
		"resolution":      "2k",
	})
	if err != nil || stream != nil {
		t.Fatalf("relayImageGenerations() result=%#v stream=%#v error=%v", result, stream, err)
	}
	if data := util.AsMapSlice(result["data"]); len(data) != 1 || data[0]["url"] != "https://image.example/grok.jpg" {
		t.Fatalf("Grok result = %#v", result)
	}
	want := map[string]any{
		"model":           "grok-imagine-image-2.0",
		"prompt":          "draw",
		"n":               float64(2),
		"response_format": "b64_json",
		"aspect_ratio":    "16:9",
		"resolution":      "2k",
	}
	if !reflect.DeepEqual(received, want) {
		t.Fatalf("Grok upstream payload = %#v, want %#v", received, want)
	}
}

func TestRelayAgnesImageEditsUsesGenerationExtraBody(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" {
			t.Errorf("upstream path = %q, want /v1/images/generations", r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", r.Header.Get("Content-Type"))
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode Agnes request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"created": 123,
			"data":    []map[string]any{{"url": "https://image.example/agnes.jpg"}},
		})
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	payload := map[string]any{
		"api_key":          "sk-test",
		"model":            "agnes-image-2.1-flash",
		"prompt":           "edit",
		"size":             "2048x1152",
		"image_resolution": "2k",
		"quality":          "medium",
		"n":                1,
	}
	normalizeImagePayloadForModel(payload)
	result, stream, err := app.relayImageEdits(context.Background(), payload, []protocol.UploadedImage{{Data: httpTestAlphaPNGBytes(t, 1, 1), Filename: "source.png", ContentType: "image/png"}})
	if err != nil || stream != nil {
		t.Fatalf("relayImageEdits() result=%#v stream=%#v error=%v", result, stream, err)
	}
	extraBody, ok := received["extra_body"].(map[string]any)
	if !ok {
		t.Fatalf("Agnes extra_body = %#v", received["extra_body"])
	}
	images, ok := extraBody["image"].([]any)
	if !ok || len(images) != 1 || !strings.HasPrefix(util.Clean(images[0]), "data:image/png;base64,") {
		t.Fatalf("Agnes reference images = %#v", extraBody["image"])
	}
	if received["size"] != "2K" || received["ratio"] != "16:9" {
		t.Fatalf("Agnes native parameters = %#v", received)
	}
}

func TestRelayImageJSONResultErrorRequiresUsableImageData(t *testing.T) {
	tests := []struct {
		name    string
		result  map[string]any
		wantErr string
	}{
		{name: "URL", result: map[string]any{"data": []any{map[string]any{"url": "https://image.example/result.png"}}}},
		{name: "base64", result: map[string]any{"data": []any{map[string]any{"b64_json": "encoded"}}}},
		{name: "top-level error", result: map[string]any{"error": map[string]any{"message": "provider rejected request"}, "data": []any{map[string]any{"url": "https://image.example/result.png"}}}, wantErr: "provider rejected request"},
		{name: "metadata-only item", result: map[string]any{"data": []any{map[string]any{"revised_prompt": "draw"}}}, wantErr: "returned no image data"},
		{name: "blank image fields", result: map[string]any{"data": []any{map[string]any{"url": " ", "b64_json": ""}}}, wantErr: "returned no image data"},
		{name: "non-string image fields", result: map[string]any{"data": []any{map[string]any{"url": 123, "b64_json": true}}}, wantErr: "returned no image data"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := relayImageJSONResultError(test.result)
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("relayImageJSONResultError() error = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("relayImageJSONResultError() error = %v, want %q", err, test.wantErr)
			}
		})
	}
}

func TestMarshalGoogleGeminiInlineRequestRejectsPayloadOverOfficialLimit(t *testing.T) {
	_, err := marshalGoogleGeminiInlineRequest(map[string]any{
		"payload": strings.Repeat("x", maxGoogleGeminiInlineRequestBytes),
	})
	if err == nil {
		t.Fatal("oversized Gemini request was accepted")
	}
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("oversized Gemini request error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized Gemini request status = %d, want %d", httpErr.Status, http.StatusRequestEntityTooLarge)
	}
	if !strings.Contains(httpErr.Message, "20 MB") {
		t.Fatalf("oversized Gemini request message = %q, want official limit", httpErr.Message)
	}
}

func TestRelayJSONAtPreservesEncodedRequestBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if body["prompt"] != "draw" {
			t.Errorf("request body = %#v, want prompt", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, err := app.relayJSONAt(context.Background(), app.relayBaseURL(), http.MethodPost, "/v1/test", "sk-test", map[string]any{"prompt": "draw"})
	if err != nil {
		t.Fatalf("relayJSONAt() error = %v", err)
	}
	if result["ok"] != true {
		t.Fatalf("relayJSONAt() result = %#v", result)
	}
}

func TestRelayImageStreamConvertsCompleteJSONResponseWithoutAnotherRequest(t *testing.T) {
	var requestCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if body["stream"] != true {
			t.Errorf("request body = %#v, want stream=true", body)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"created":1710000000,"model":"gpt-image-2","data":[{"url":"https://image.example/one.png"},{"b64_json":"second"}]}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayJSONMaybeStream(context.Background(), "/v1/images/generations", map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
		"stream":  true,
	})
	if err != nil {
		t.Fatalf("relayJSONMaybeStream() error = %v", err)
	}
	if result != nil || stream == nil {
		t.Fatalf("relayJSONMaybeStream() result=%#v stream=%#v, want converted stream", result, stream)
	}
	var items []map[string]any
	for item := range stream.Items {
		items = append(items, item)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("converted stream error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("converted stream items = %#v, want two", items)
	}
	if items[0]["type"] != "image_generation.completed" || items[0]["output_index"] != 0 || items[0]["url"] != "https://image.example/one.png" {
		t.Fatalf("first converted stream item = %#v", items[0])
	}
	if items[1]["type"] != "image_generation.completed" || items[1]["output_index"] != 1 || items[1]["b64_json"] != "second" {
		t.Fatalf("second converted stream item = %#v", items[1])
	}
	if requestCount.Load() != 1 {
		t.Fatalf("request count = %d, want 1", requestCount.Load())
	}
}

func TestRelayImageStreamSniffsSSEWhenProxyUsesJSONContentType(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte{0xef, 0xbb, 0xbf})
		_, _ = io.WriteString(w, " \r\n")
		_, _ = io.WriteString(w, ": keepalive\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"image_generation.completed\",\"output_index\":0,\"b64_json\":\"image\"}\n\n")
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayJSONMaybeStream(context.Background(), "/v1/images/generations", map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
		"stream":  true,
	})
	if err != nil || result != nil || stream == nil {
		t.Fatalf("relayJSONMaybeStream() = result %#v, stream %#v, error %v", result, stream, err)
	}
	item, ok := <-stream.Items
	if !ok || item["type"] != "image_generation.completed" || item["b64_json"] != "image" {
		t.Fatalf("stream item = %#v, %v", item, ok)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("stream error = %v", err)
	}
}

func TestRelayImageNonStreamRejectsEmptyImageData(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"created": 123, "data": []any{}})
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
	})
	if err == nil || !strings.Contains(err.Error(), "returned no image data") {
		t.Fatalf("relayImageGenerations() error = %v, want empty image data failure", err)
	}
	if result == nil || stream != nil {
		t.Fatalf("relayImageGenerations() result=%#v stream=%#v", result, stream)
	}
}

func TestRelayImageStreamReturnsEmbeddedJSONError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"detail":{"message":"upstream quota exhausted"}}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayJSONMaybeStream(context.Background(), "/v1/images/generations", map[string]any{
		"api_key": "sk-test",
		"prompt":  "draw",
		"stream":  true,
	})
	if err == nil || !strings.Contains(err.Error(), "upstream quota exhausted") {
		t.Fatalf("relayJSONMaybeStream() error = %v, want embedded upstream message", err)
	}
	if result != nil || stream != nil {
		t.Fatalf("embedded error returned result=%#v stream=%#v", result, stream)
	}
}

func TestRelayImageEditJSONResponseUsesEditCompletedEvent(t *testing.T) {
	stream := relayImageJSONResultStream(map[string]any{
		"created": 1710000000,
		"data":    []map[string]any{{"url": "https://image.example/edit.png"}},
	}, "/v1/images/edits")
	item, ok := <-stream.Items
	if !ok {
		t.Fatal("converted edit stream closed before its completed event")
	}
	if item["type"] != "image_edit.completed" || item["created_at"] != 1710000000 {
		t.Fatalf("converted edit event = %#v", item)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("converted edit stream error = %v", err)
	}
}

func TestRelayErrorMessageSupportsNewAPIShapes(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "OpenAI object", body: `{"error":{"message":"blocked by upstream"}}`, want: "blocked by upstream"},
		{name: "string error", body: `{"error":"provider unavailable"}`, want: "provider unavailable"},
		{name: "detail object", body: `{"detail":{"message":"invalid image"}}`, want: "invalid image"},
		{name: "top-level message", body: `{"message":"quota exhausted"}`, want: "quota exhausted"},
		{name: "detail list", body: `{"detail":[{"message":"field is required"}]}`, want: "field is required"},
		{name: "nested task validation", body: `{"code":"fail_to_fetch_task","message":"{\"detail\":\"3 validation errors for MiniMaxH3Request\\nratio\\nInput should be 'auto' or '16:9'\"}"}`, want: "3 validation errors for MiniMaxH3Request\nratio\nInput should be 'auto' or '16:9'"},
		{name: "SSE error", body: "event: error\ndata: {\"error\":{\"message\":\"stream rejected\"}}\n\n", want: "stream rejected"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := relayErrorMessage([]byte(test.body), "fallback"); got != test.want {
				t.Fatalf("relayErrorMessage() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRelayStreamResultRecognizesTypedUpstreamErrorMessage(t *testing.T) {
	stream := relayStreamResult(io.NopCloser(strings.NewReader(
		"event: upstream_error\n" +
			`data: {"type":"upstream_error","message":"provider stream failed"}` + "\n\n",
	)))
	if item, ok := <-stream.Items; ok {
		t.Fatalf("typed upstream error was emitted as data: %#v", item)
	}
	err := <-stream.Err
	if err == nil || !strings.Contains(err.Error(), "provider stream failed") {
		t.Fatalf("typed upstream stream error = %v", err)
	}
}

func TestGoogleGeminiImagePayloadBuildsNewAPIChatRequest(t *testing.T) {
	body, err := googleGeminiImagePayload(map[string]any{
		"model":          "gemini-3.1-flash-image",
		"prompt":         "edit this image",
		"size":           "2048x1152",
		"quality":        "medium",
		"stream":         true,
		"partial_images": 2,
	}, []protocol.UploadedImage{{Data: []byte("image-bytes"), ContentType: "image/png"}})
	if err != nil {
		t.Fatalf("googleGeminiImagePayload() error = %v", err)
	}
	if body["model"] != "gemini-3.1-flash-image" {
		t.Fatalf("model = %#v", body["model"])
	}
	messages := util.AsMapSlice(body["messages"])
	if len(messages) != 1 {
		t.Fatalf("messages = %#v", body["messages"])
	}
	content, ok := messages[0]["content"].([]map[string]any)
	if !ok || len(content) != 2 || content[1]["type"] != "image_url" {
		t.Fatalf("Gemini image content = %#v", messages[0]["content"])
	}
	extraBody := util.StringMap(body["extra_body"])
	google := util.StringMap(extraBody["google"])
	imageConfig := util.StringMap(google["image_config"])
	if imageConfig["aspect_ratio"] != "16:9" || imageConfig["image_size"] != "2K" {
		t.Fatalf("Gemini image config = %#v", imageConfig)
	}
	for _, key := range []string{"stream", "partial_images", "output_format"} {
		if _, ok := body[key]; ok {
			t.Fatalf("Gemini chat body retained image-route field %s: %#v", key, body)
		}
	}
}

func TestGoogleGeminiImageSizeMatchesReferenceQualityAndPresetMapping(t *testing.T) {
	tests := []struct {
		name    string
		model   string
		payload map[string]any
		want    string
	}{
		{name: "low quality", model: "gemini-3.1-flash-image", payload: map[string]any{"quality": "low"}, want: "1K"},
		{name: "medium quality", model: "gemini-3.1-flash-image", payload: map[string]any{"quality": "medium"}, want: "2K"},
		{name: "high quality wins over preset", model: "gemini-3.1-flash-image", payload: map[string]any{"quality": "high", "size": "2048x1152"}, want: "4K"},
		{name: "2K preset", model: "gemini-3-pro-image", payload: map[string]any{"quality": "auto", "size": "3136x1344"}, want: "2K"},
		{name: "4K preset", model: "gemini-3-pro-image", payload: map[string]any{"quality": "auto", "size": "6272x2688"}, want: "4K"},
		{name: "2.5 omits image size", model: "gemini-2.5-flash-image", payload: map[string]any{"quality": "high", "size": "6272x2688"}, want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := googleGeminiImageSize(test.model, test.payload); got != test.want {
				t.Fatalf("googleGeminiImageSize(%q, %#v) = %q, want %q", test.model, test.payload, got, test.want)
			}
		})
	}
}

func TestNormalizeImagePayloadForModelDropsUnforwardedProviderMetadata(t *testing.T) {
	tests := []struct {
		name     string
		model    string
		retained []string
		dropped  []string
		response any
	}{
		{
			name:     "Gemini keeps image configuration and internal conversation data",
			model:    "GEMINI-3.1-FLASH-IMAGE",
			retained: []string{"size", "image_resolution", "requested_size", "messages", "token_name"},
			dropped:  []string{"quality", "background", "moderation", "stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"},
		},
		{
			name:     "Grok maps application settings to official xAI fields",
			model:    "GROK-IMAGINE-IMAGE-2.0",
			retained: []string{"size", "image_resolution", "requested_size", "messages", "token_name", "response_format", "aspect_ratio", "resolution", "stream", "partial_images"},
			dropped: []string{
				"background", "moderation", "quality",
				"output_format", "output_compression", "input_image_mask",
				"image_format", "storage_options", "user",
			},
			response: "b64_json",
		},
		{
			name:     "Zhipu drops unsupported OpenAI controls",
			model:    "GLM-Image",
			retained: []string{"size", "quality", "messages", "token_name"},
			dropped:  []string{"stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"},
		},
		{
			name:     "Agnes maps quality and ratio to native fields",
			model:    "agnes-image-2.1-flash",
			retained: []string{"size", "ratio", "messages", "token_name"},
			dropped:  []string{"quality", "stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{
				"model": test.model, "size": "1024x1024", "image_resolution": "2k", "requested_size": "1024x1024",
				"quality": "medium", "background": "opaque", "moderation": "low", "stream": true,
				"partial_images": 2, "output_format": "webp", "output_compression": 80,
				"response_format": "B64_JSON", "input_image_mask": "mask", "messages": []any{"history"},
				"token_name": "current-user-key", "aspect_ratio": "16:9", "resolution": "2k",
				"image_format": "png", "storage_options": map[string]any{"ttl": 3600}, "user": "user-1",
			}
			normalizeImagePayloadForModel(payload)
			for _, key := range test.retained {
				if _, ok := payload[key]; !ok {
					t.Errorf("payload dropped %s: %#v", key, payload)
				}
			}
			for _, key := range test.dropped {
				if _, ok := payload[key]; ok {
					t.Errorf("payload retained %s: %#v", key, payload)
				}
			}
			if test.response != nil && payload["response_format"] != test.response {
				t.Errorf("response_format = %#v, want %#v", payload["response_format"], test.response)
			}
			if test.name == "Grok maps application settings to official xAI fields" {
				if payload["aspect_ratio"] != "16:9" || payload["resolution"] != "2k" || payload["stream"] != true || payload["partial_images"] != 2 {
					t.Errorf("Grok official parameters = %#v", payload)
				}
			}
			if test.name == "Zhipu drops unsupported OpenAI controls" && payload["quality"] != "hd" {
				t.Errorf("Zhipu quality = %#v, want hd", payload["quality"])
			}
			if test.name == "Agnes maps quality and ratio to native fields" {
				if payload["size"] != "2K" || payload["ratio"] != "16:9" {
					t.Errorf("Agnes native parameters = %#v", payload)
				}
			}
		})
	}
}

func TestGoogleGeminiAspectRatioUsesModelSpecificOfficialSet(t *testing.T) {
	if got := googleGeminiAspectRatio("gemini-3.1-flash-image", "1:8"); got != "1:8" {
		t.Fatalf("Gemini 3.1 Flash aspect ratio = %q, want 1:8", got)
	}
	if got := googleGeminiAspectRatio("gemini-3.1-flash-lite-image", "1:8"); got == "1:8" {
		t.Fatalf("Gemini Flash Lite retained unsupported extreme ratio %q", got)
	}
	if got := googleGeminiAspectRatio("gemini-3.1-flash-lite-image", "4:5"); got != "4:5" {
		t.Fatalf("Gemini Flash Lite standard aspect ratio = %q, want 4:5", got)
	}
	if got := googleGeminiAspectRatio("gemini-3-pro-image", "4:1"); got == "4:1" {
		t.Fatalf("Gemini Pro retained unsupported extreme ratio %q", got)
	}
}

func TestGoogleGeminiImageItemsExtractsInlineImages(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	items, err := googleGeminiImageItems(map[string]any{
		"choices": []map[string]any{{
			"message": map[string]any{"content": "![image](data:image/webp;base64," + encoded + ")"},
		}},
	}, "draw")
	if err != nil {
		t.Fatalf("googleGeminiImageItems() error = %v", err)
	}
	if len(items) != 1 || items[0]["b64_json"] != encoded || items[0]["output_format"] != "webp" {
		t.Fatalf("Gemini image items = %#v", items)
	}
}

func TestGoogleGeminiImageItemsPreservesEmbeddedUpstreamError(t *testing.T) {
	_, err := googleGeminiImageItems(map[string]any{
		"error": map[string]any{"message": "Gemini quota exhausted"},
	}, "draw")
	if err == nil || !strings.Contains(err.Error(), "Gemini quota exhausted") {
		t.Fatalf("googleGeminiImageItems() error = %v, want embedded upstream message", err)
	}
}

func TestGoogleGeminiImageItemsReportsBlockedResponse(t *testing.T) {
	_, err := googleGeminiImageItems(map[string]any{
		"choices": []map[string]any{{
			"finish_reason": "SAFETY",
			"message":       map[string]any{"role": "assistant", "content": ""},
		}},
		"prompt_feedback": map[string]any{"block_reason": "PROHIBITED_CONTENT"},
	}, "draw")
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadGateway {
		t.Fatalf("blocked Gemini response error = %T %v, want HTTP 502", err, err)
	}
	if !strings.Contains(httpErr.Message, "SAFETY") || !strings.Contains(httpErr.Message, "PROHIBITED_CONTENT") {
		t.Fatalf("blocked Gemini response message = %q", httpErr.Message)
	}
}

func TestValidProtocolImageCountUsesModelLimit(t *testing.T) {
	for _, value := range []any{nil, 1, float64(15), "2"} {
		if !validProtocolImageCount(value, "gpt-image-2") {
			t.Errorf("validProtocolImageCount(%#v, gpt-image-2) = false, want true", value)
		}
	}
	for _, value := range []any{0, 16, 1.5, "invalid"} {
		if validProtocolImageCount(value, "gpt-image-2") {
			t.Errorf("validProtocolImageCount(%#v, gpt-image-2) = true, want false", value)
		}
	}
	if !validProtocolImageCount(15, "gemini-3.1-flash-image") || validProtocolImageCount(16, "gemini-3.1-flash-image") {
		t.Fatal("Gemini image request did not enforce the reference workbench API limit")
	}
}

func TestRelayImageGenerationsUsesChatCompletionsForGemini(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	var requestCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("upstream path = %q, want /v1/chat/completions", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode Gemini request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body["model"] != "gemini-3.1-flash-image" || len(util.AsMapSlice(body["messages"])) == 0 {
			t.Errorf("Gemini request body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"gemini-3.1-flash-image","choices":[{"message":{"role":"assistant","content":"![image](data:image/png;base64,` + encoded + `)"}}]}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key": "sk-test",
		"model":   "gemini-3.1-flash-image",
		"prompt":  "draw",
		"n":       2,
	})
	if err != nil {
		t.Fatalf("relayImageGenerations() error = %v", err)
	}
	if stream != nil {
		t.Fatal("Gemini image route returned an unexpected image SSE stream")
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 2 || data[0]["b64_json"] != encoded || data[1]["b64_json"] != encoded {
		t.Fatalf("Gemini relay result = %#v", result)
	}
	if requestCount.Load() != 2 {
		t.Fatalf("Gemini request count = %d, want 2", requestCount.Load())
	}
}

func TestRelayGoogleGeminiBatchFailurePreservesSuccessfulSiblingsBeforeReleasingSlot(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("successful-image"))
	var requestCount atomic.Int32
	secondStarted := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch requestCount.Add(1) {
		case 1:
			<-secondStarted
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"message":"Gemini upstream failed"}}`))
		case 2:
			close(secondStarted)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"model":"gemini-3.1-flash-image","choices":[{"message":{"role":"assistant","content":"![image](data:image/png;base64,` + encoded + `)"}}]}`))
		default:
			t.Errorf("unexpected Gemini request count: %d", requestCount.Load())
		}
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	released := make(chan struct{})
	result, stream, err := app.relayImageGenerations(context.Background(), map[string]any{
		"api_key": "sk-test",
		"model":   "gemini-3.1-flash-image",
		"prompt":  "draw",
		"n":       2,
		protocol.ImageOutputSlotAcquirerPayloadKey: func(context.Context, int) (func(), error) {
			return func() { close(released) }, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "Gemini upstream failed") {
		t.Fatalf("relayImageGenerations() error = %v, want upstream failure", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["b64_json"] != encoded || stream != nil {
		t.Fatalf("partial Gemini batch result = %#v, stream = %#v", result, stream)
	}
	if requestCount.Load() != 2 {
		t.Fatalf("Gemini request count = %d, want 2", requestCount.Load())
	}
	select {
	case <-released:
	default:
		t.Fatal("Gemini batch slot was not released after all requests exited")
	}
}

func TestRelayImageEditsSendsFourteenGeminiReferencesThroughNewAPIChat(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("edited-image"))
	var requestCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("upstream path = %q, want /v1/chat/completions", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode Gemini edit request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		messages := util.AsMapSlice(body["messages"])
		if len(messages) != 1 {
			t.Errorf("Gemini edit messages = %#v", body["messages"])
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		content := util.AsMapSlice(messages[0]["content"])
		imageCount := 0
		for _, part := range content {
			if part["type"] == "image_url" {
				imageCount++
			}
		}
		if imageCount != 14 {
			t.Errorf("Gemini edit image parts = %d, want 14 in %#v", imageCount, content)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"![image](data:image/png;base64,` + encoded + `)"}}]}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	images := make([]protocol.UploadedImage, 14)
	for index := range images {
		images[index] = protocol.UploadedImage{
			Filename:    fmt.Sprintf("reference-%02d.png", index+1),
			ContentType: "image/png",
			Data:        []byte(fmt.Sprintf("image-%02d", index+1)),
		}
	}
	result, stream, err := app.relayImageEdits(context.Background(), map[string]any{
		"api_key": "sk-test",
		"model":   "gemini-3.1-flash-image",
		"prompt":  "combine these references",
		"n":       1,
	}, images)
	if err != nil {
		t.Fatalf("relayImageEdits() error = %v", err)
	}
	if stream != nil {
		t.Fatal("Gemini edit route returned an unexpected stream")
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["b64_json"] != encoded {
		t.Fatalf("Gemini edit relay result = %#v", result)
	}
	if requestCount.Load() != 1 {
		t.Fatalf("Gemini edit request count = %d, want 1", requestCount.Load())
	}
}

func TestRelayGrokImageEditsUsesReferenceJSONContract(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/edits" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			t.Fatalf("Grok edit request = %s %s content-type=%q", r.Method, r.URL.Path, r.Header.Get("Content-Type"))
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode Grok edit body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"url": "https://image.example/edit.png"}}})
	}))
	defer upstream.Close()
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, stream, err := app.relayImageEdits(context.Background(), map[string]any{
		"api_key": "sk-test", "model": "grok-imagine-image", "prompt": "edit", "size": "16:9", "quality": "high",
	}, []protocol.UploadedImage{{Data: []byte("image"), ContentType: "image/png"}})
	if err != nil || stream != nil || len(util.AsMapSlice(result["data"])) != 1 {
		t.Fatalf("Grok edit result=%#v stream=%#v error=%v", result, stream, err)
	}
	images := util.AsMapSlice(received["images"])
	if len(images) != 1 || !strings.HasPrefix(util.Clean(images[0]["url"]), "data:image/png;base64,") || received["resolution"] != "2k" {
		t.Fatalf("Grok edit payload = %#v", received)
	}
}

func TestValidateRelayImageReferenceCountLeavesGenericLimitsToProviderAdapters(t *testing.T) {
	tests := []struct {
		name    string
		model   string
		count   int
		wantErr bool
	}{
		{name: "Gemini generic request is not capped", model: "gemini-3.1-flash-image", count: 15},
		{name: "OpenAI generic request is not capped", model: "gpt-image-2", count: 15},
		{name: "Grok generic request is not capped", model: "grok-imagine-image-2.0", count: 15},
		{name: "Zhipu remains text only", model: "glm-image", count: 1, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRelayImageReferenceCount(test.model, test.count)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateRelayImageReferenceCount(%q, %d) error = %v, wantErr %v", test.model, test.count, err, test.wantErr)
			}
			if err != nil {
				var httpErr protocol.HTTPError
				if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadRequest {
					t.Fatalf("validation error = %T %v, want HTTP 400", err, err)
				}
			}
		})
	}
}

func TestRelayImageGenerationsReturnsNewAPIColonParseErrorWithoutRetry(t *testing.T) {
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request %d: %v", requestCount, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body["stream"] != true || body["partial_images"] != float64(2) {
			t.Errorf("request body = %#v, want stream with partial images", body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid character ':' looking for beginning of value (request id: 202607300220530891561808268d9d6K2BvRB98)"}}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	payload := map[string]any{
		"api_key":        "sk-test",
		"prompt":         "draw",
		"stream":         true,
		"partial_images": 2,
	}

	result, stream, err := app.relayImageGenerations(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "invalid character ':' looking for beginning of value") {
		t.Fatalf("relayImageGenerations() error = %v, want original upstream error", err)
	}
	if stream != nil {
		t.Fatal("failed request returned an unexpected stream")
	}
	if result != nil {
		t.Fatalf("failed request result = %#v, want nil", result)
	}
	if requestCount != 1 {
		t.Fatalf("request count = %d, want 1", requestCount)
	}
	if payload["stream"] != true || payload["partial_images"] != 2 {
		t.Fatalf("original payload mutated: %#v", payload)
	}
}

func TestRelayMultipartRequestNormalizesOctetStreamImageContentType(t *testing.T) {
	req, err := relayMultipartRequest(
		context.Background(),
		"https://relay.example",
		"/v1/images/edits",
		"sk-test",
		map[string]any{"prompt": "edit"},
		[]protocol.UploadedImage{{
			Filename:    "source.png",
			ContentType: "application/octet-stream",
			Data:        []byte("\x89PNG\r\n\x1a\npng-bytes"),
		}},
	)
	if err != nil {
		t.Fatalf("relayMultipartRequest() error = %v", err)
	}
	reader, err := req.MultipartReader()
	if err != nil {
		t.Fatalf("MultipartReader() error = %v", err)
	}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("NextPart() error = %v", err)
		}
		if part.FormName() != "image" {
			continue
		}
		if got := strings.TrimSpace(part.Header.Get("Content-Type")); got != "image/png" {
			t.Fatalf("image Content-Type = %q, want image/png", got)
		}
		return
	}
	t.Fatal("multipart image part not found")
}

func TestRelayMultipartRequestForwardsMaskAsFile(t *testing.T) {
	maskData := httpTestAlphaPNGBytes(t, 12, 12)
	req, err := relayMultipartRequest(
		context.Background(),
		"https://relay.example",
		"/v1/images/edits",
		"sk-test",
		map[string]any{
			"prompt":           "edit",
			"input_image_mask": "data:image/png;base64," + base64.StdEncoding.EncodeToString(maskData),
		},
		[]protocol.UploadedImage{{Filename: "source.png", ContentType: "image/png", Data: httpTestPNGBytes(t)}},
	)
	if err != nil {
		t.Fatalf("relayMultipartRequest() error = %v", err)
	}
	reader, err := req.MultipartReader()
	if err != nil {
		t.Fatalf("MultipartReader() error = %v", err)
	}
	foundMask := false
	for {
		part, nextErr := reader.NextPart()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			t.Fatalf("NextPart() error = %v", nextErr)
		}
		if part.FormName() == "input_image_mask" {
			t.Fatal("legacy input_image_mask field was forwarded upstream")
		}
		if part.FormName() != "mask" {
			continue
		}
		foundMask = true
		if part.FileName() != "mask.png" || part.Header.Get("Content-Type") != "image/png" {
			t.Fatalf("mask headers = filename %q content-type %q", part.FileName(), part.Header.Get("Content-Type"))
		}
		got, readErr := io.ReadAll(part)
		if readErr != nil {
			t.Fatalf("read mask: %v", readErr)
		}
		if !bytes.Equal(got, maskData) {
			t.Fatal("forwarded mask bytes differ from request")
		}
	}
	if !foundMask {
		t.Fatal("multipart mask file was not forwarded")
	}
}

func TestValidateRelayImageMaskUsesOfficialEditConstraints(t *testing.T) {
	images := []protocol.UploadedImage{{Filename: "source.png", ContentType: "image/png", Data: httpTestPNGBytes(t)}}
	mask := "data:image/png;base64," + base64.StdEncoding.EncodeToString(httpTestAlphaPNGBytes(t, 12, 12))

	payload := map[string]any{"input_image_mask": mask}
	if err := validateRelayImageMask("/v1/images/edits", "gpt-image-2", payload, images); err != nil {
		t.Fatalf("valid GPT Image mask error = %v", err)
	}
	if !strings.HasPrefix(util.Clean(payload["input_image_mask"]), "data:image/png;base64,") {
		t.Fatalf("normalized mask = %#v", payload["input_image_mask"])
	}

	tests := []struct {
		name   string
		path   string
		model  string
		images []protocol.UploadedImage
		mask   string
		want   string
	}{
		{name: "generation route", path: "/v1/images/generations", model: "gpt-image-2", mask: mask, want: "only supported"},
		{name: "Gemini route", path: "/v1/images/edits", model: "gemini-3.1-flash-image", images: images, mask: mask, want: "does not support mask"},
		{name: "Grok route", path: "/v1/images/edits", model: "grok-imagine-image", images: images, mask: mask, want: "does not support mask"},
		{name: "dimension mismatch", path: "/v1/images/edits", model: "gpt-image-2", images: images, mask: "data:image/png;base64," + base64.StdEncoding.EncodeToString(httpTestAlphaPNGBytes(t, 4, 4)), want: "same dimensions"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRelayImageMask(test.path, test.model, map[string]any{"input_image_mask": test.mask}, test.images)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validateRelayImageMask() error = %v, want %q", err, test.want)
			}
			var httpErr protocol.HTTPError
			if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadRequest {
				t.Fatalf("validation error = %T %v, want HTTP 400", err, err)
			}
		})
	}
}

func TestNormalizeUploadedImageContentTypeRejectsOctetStream(t *testing.T) {
	if got := normalizeUploadedImageContentType("application/octet-stream"); got != "" {
		t.Fatalf("normalizeUploadedImageContentType(octet-stream) = %q, want empty", got)
	}
	if got := normalizeUploadedImageContentType("image/jpeg; charset=binary"); got != "image/jpeg" {
		t.Fatalf("normalizeUploadedImageContentType(jpeg) = %q, want image/jpeg", got)
	}
}

func TestRelayStreamResultAcceptsImageFrameBeyondLegacyScannerLimit(t *testing.T) {
	encodedImage := strings.Repeat("a", 5*1024*1024)
	stream := relayStreamResult(io.NopCloser(strings.NewReader(
		`data: {"type":"image_generation.completed","b64_json":"` + encodedImage + `"}` + "\n\n",
	)))

	item, ok := <-stream.Items
	if !ok {
		t.Fatalf("stream closed before large image frame: %v", <-stream.Err)
	}
	if got := len(item["b64_json"].(string)); got != len(encodedImage) {
		t.Fatalf("large image length = %d, want %d", got, len(encodedImage))
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("relayStreamResult() error = %v", err)
	}

	required := base64.StdEncoding.EncodedLen(40*1024*1024) + 1024
	if relayStreamMaxTokenSize < required {
		t.Fatalf("scanner limit = %d, need at least %d bytes for a 40 MiB image frame", relayStreamMaxTokenSize, required)
	}
}

func TestRelayStreamResultIgnoresWrappedHeartbeatAndDuplicateDataPrefix(t *testing.T) {
	stream := relayStreamResult(io.NopCloser(strings.NewReader(strings.Join([]string{
		"data: : PING",
		"",
		`data: data: {"type":"image_generation.completed","b64_json":"image"}`,
		"",
		"data: [DONE]",
		"",
	}, "\n"))))

	item, ok := <-stream.Items
	if !ok {
		t.Fatalf("stream closed before completed image: %v", <-stream.Err)
	}
	if item["type"] != "image_generation.completed" || item["b64_json"] != "image" {
		t.Fatalf("stream item = %#v", item)
	}
	if err := <-stream.Err; err != nil {
		t.Fatalf("relayStreamResult() error = %v", err)
	}
}

func TestRelayDecodeJSONResponseLimitsSuccessfulBody(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Body:       io.NopCloser(strings.NewReader(`{"data":"` + strings.Repeat("a", 32) + `"}`)),
	}
	_, err := relayDecodeJSONResponseWithLimits(resp, 16, 8)
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("relayDecodeJSONResponseWithLimits() error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusBadGateway || httpErr.Message != "upstream response is too large" {
		t.Fatalf("oversized success error = %#v", httpErr)
	}

	required := int64(4*base64.StdEncoding.EncodedLen(40*1024*1024) + 1*1024*1024)
	if relayJSONSuccessMaxBytes < required {
		t.Fatalf("success response limit = %d, need at least %d bytes for four 40 MiB images", relayJSONSuccessMaxBytes, required)
	}
}

func TestRelayDecodeJSONResponsePreservesNewAPIErrorMessage(t *testing.T) {
	const message = "upstream rejected the image request (request id: req_test_123)"
	resp := &http.Response{
		StatusCode: http.StatusBadGateway,
		Status:     "502 Bad Gateway",
		Body: io.NopCloser(strings.NewReader(
			`{"error":{"message":"` + message + `","type":"openai_error","param":"","code":"bad_response"}}`,
		)),
	}

	_, err := relayDecodeJSONResponse(resp)
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("relayDecodeJSONResponse() error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusBadGateway || httpErr.Message != message {
		t.Fatalf("NewAPI upstream error = %#v", httpErr)
	}
}

func TestRelayDecodeJSONResponseLimitsErrorBody(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Status:     "429 Too Many Requests",
		Body:       io.NopCloser(strings.NewReader(strings.Repeat("x", 17))),
	}
	_, err := relayDecodeJSONResponseWithLimits(resp, 64, 16)
	var httpErr protocol.HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("relayDecodeJSONResponseWithLimits() error = %T %v, want protocol.HTTPError", err, err)
	}
	if httpErr.Status != http.StatusTooManyRequests || httpErr.Message != "upstream error response is too large" {
		t.Fatalf("oversized upstream error = %#v", httpErr)
	}
}

func TestNormalizeKIEImagePayloadUsesReferenceProjectFields(t *testing.T) {
	tests := []struct {
		name  string
		model string
		input map[string]any
		want  map[string]any
	}{
		{
			name:  "Seedream named size and resolution",
			model: "bytedance/seedream-v4-text-to-image",
			input: map[string]any{"size": "16:9", "resolution": "2k", "n": 2, "requested_size": "16:9"},
			want:  map[string]any{"image_size": "landscape_16_9", "image_resolution": "2K", "max_images": 2},
		},
		{
			name:  "Flux ratio and resolution",
			model: "flux-2/pro-text-to-image",
			input: map[string]any{"size": "1280x720", "resolution": "2k"},
			want:  map[string]any{"aspect_ratio": "16:9", "resolution": "2K"},
		},
		{
			name:  "Ideogram string count",
			model: "ideogram/v3-text-to-image",
			input: map[string]any{"size": "1:1", "n": 1},
			want:  map[string]any{"image_size": "square_hd"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"model": test.model}
			for key, value := range test.input {
				payload[key] = value
			}
			normalizeImagePayloadForModel(payload)
			for key, want := range test.want {
				if !reflect.DeepEqual(payload[key], want) {
					t.Fatalf("%s = %#v, want %#v; payload=%#v", key, payload[key], want, payload)
				}
			}
			if _, ok := payload["requested_size"]; ok {
				t.Fatalf("requested_size leaked: %#v", payload)
			}
		})
	}
}

func TestRelayPayloadKeepsKIEImageResolutionAndDropsCompatibilityFields(t *testing.T) {
	payload := map[string]any{
		"model":            "bytedance/seedream-v4-text-to-image",
		"prompt":           "a lighthouse",
		"image_size":       "16:9",
		"image_resolution": "2k",
		"stream":           true,
		"response_format":  "url",
	}
	normalizeImagePayloadForModel(payload)
	got := relayPayloadForPath("/v1/images/generations", payload)
	if got["image_resolution"] != "2K" {
		t.Fatalf("image_resolution = %#v, want 2K", got["image_resolution"])
	}
	if _, ok := got["stream"]; ok {
		t.Fatalf("KIE stream compatibility field leaked: %#v", got)
	}
	if _, ok := got["response_format"]; ok {
		t.Fatalf("KIE response_format compatibility field leaked: %#v", got)
	}
	if _, ok := got["size"]; ok {
		t.Fatalf("generic size field leaked into KIE payload: %#v", got)
	}
}

func TestNormalizeKIEImagePayloadReferenceFieldVariants(t *testing.T) {
	tests := []struct {
		model string
		want  string
	}{
		{"google/nano-banana-edit", "image_urls"},
		{"grok-imagine/extend", "image_url"},
		{"recraft/remove-background", "image"},
		{"topaz/image-upscale", "image_url"},
		{"topaz/video-upscale", "video_url"},
		{"ideogram/v3-remix", "image_url"},
	}
	for _, test := range tests {
		payload := map[string]any{"model": test.model, "image_url": "https://cdn.example.com/source.png", "video_url": "https://cdn.example.com/source.mp4", "prompt": "edit"}
		normalizeImagePayloadForModel(payload)
		if _, ok := payload[test.want]; !ok {
			t.Fatalf("%s missing %s in %#v", test.model, test.want, payload)
		}
	}
}

func TestNormalizeKIEImagePayloadMapsArrayReferencesToSingleImageContracts(t *testing.T) {
	const source = "https://cdn.example.com/source.png"
	for _, model := range []string{"qwen/image-to-image", "ideogram/v3-remix"} {
		payload := map[string]any{
			"model":      model,
			"image_urls": []string{source},
		}
		normalizeImagePayloadForModel(payload)
		if got := payload["image_url"]; got != source {
			t.Fatalf("%s image_url = %#v, want %q; payload=%#v", model, got, source, payload)
		}
		if _, ok := payload["image_urls"]; ok {
			t.Fatalf("%s leaked image_urls: %#v", model, payload)
		}
	}
	characterEdit := map[string]any{
		"model":                "ideogram/character-edit",
		"image_url":            source,
		"reference_image_urls": []string{"https://cdn.example.com/character.png"},
	}
	normalizeImagePayloadForModel(characterEdit)
	if characterEdit["image_url"] != source {
		t.Fatalf("character edit base image = %#v, want %q; payload=%#v", characterEdit["image_url"], source, characterEdit)
	}
	if refs, ok := characterEdit["reference_image_urls"].([]string); !ok || len(refs) != 1 {
		t.Fatalf("character edit reference images = %#v, want one preserved reference; payload=%#v", characterEdit["reference_image_urls"], characterEdit)
	}
}

func TestValidateKIEImageRequiredInputKeepsAdditionalInputsStrict(t *testing.T) {
	tests := []struct {
		name     string
		model    string
		payload  map[string]any
		uploaded int
		wantErr  string
	}{
		{name: "v3 edit requires mask", model: "ideogram/v3-edit", uploaded: 1, wantErr: "mask_url"},
		{name: "character edit requires mask", model: "ideogram/character-edit", uploaded: 1, payload: map[string]any{"reference_image_urls": []string{"https://cdn.example.com/character.png"}}, wantErr: "mask_url"},
		{name: "character edit requires independent reference", model: "ideogram/character-edit", uploaded: 1, payload: map[string]any{"mask_url": "https://cdn.example.com/mask.png"}, wantErr: "reference_image_urls"},
		{name: "character remix requires base image", model: "ideogram/character-remix", payload: map[string]any{"reference_image_urls": []string{"https://cdn.example.com/character.png"}}, wantErr: "参考图片"},
		{name: "character remix requires reference", model: "ideogram/character-remix", payload: map[string]any{"image_url": "https://cdn.example.com/source.png"}, wantErr: "reference_image_urls"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateKIEImageRequiredInput(test.model, test.payload, test.uploaded)
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("error = %v, want message containing %q", err, test.wantErr)
			}
		})
	}
	if err := validateKIEImageRequiredInput("ideogram/v3-edit", map[string]any{"mask_url": "https://cdn.example.com/mask.png"}, 1); err != nil {
		t.Fatalf("v3 edit with uploaded base and mask should pass: %v", err)
	}
	if err := validateKIEImageRequiredInput("ideogram/character-edit", map[string]any{
		"mask_url":             "https://cdn.example.com/mask.png",
		"reference_image_urls": []string{"https://cdn.example.com/character.png"},
	}, 1); err != nil {
		t.Fatalf("character edit with all required inputs should pass: %v", err)
	}
}

func TestValidateKIEImageReferenceURLsRejectsInlineAndPrivateSources(t *testing.T) {
	tests := []map[string]any{
		{"model": "qwen/image-to-image", "image_url": "data:image/png;base64,AAAA"},
		{"model": "topaz/image-upscale", "image_url": "http://127.0.0.1/source.png"},
		{"model": "ideogram/v3-edit", "image_url": "https://cdn.example.com/source.png", "mask_url": "https://cdn.example.com/mask.png", "reference_image_urls": []string{"https://cdn.example.com/ref.png"}},
	}
	for index, payload := range tests {
		if index == 2 {
			payload["mask_url"] = "data:image/png;base64,AAAA"
		}
		if err := validateKIEImageReferenceURLs(util.Clean(payload["model"]), payload); err == nil {
			t.Fatalf("case %d unexpectedly accepted non-public image reference: %#v", index, payload)
		}
	}
	if err := validateKIEImageReferenceURLs("qwen/image-to-image", map[string]any{"image_url": "https://cdn.example.com/source.png"}); err != nil {
		t.Fatalf("public KIE image reference rejected: %v", err)
	}
}

func TestNormalizeKIEIdeogramCharacterRemixKeepsBaseAndReferenceImages(t *testing.T) {
	payload := map[string]any{
		"model":                "ideogram/character-remix",
		"image_url":            "https://cdn.example.com/source.png",
		"reference_image_urls": []string{"https://cdn.example.com/character.png"},
	}
	normalizeImagePayloadForModel(payload)
	if payload["image_url"] != "https://cdn.example.com/source.png" {
		t.Fatalf("base image_url = %#v", payload["image_url"])
	}
	refs, ok := payload["reference_image_urls"].([]string)
	if !ok || len(refs) != 1 || refs[0] != "https://cdn.example.com/character.png" {
		t.Fatalf("reference_image_urls = %#v", payload["reference_image_urls"])
	}
}

func TestNormalizeKIEIdeogramEditMapsMaskAlias(t *testing.T) {
	payload := map[string]any{
		"model":     "ideogram/v3-edit",
		"image_url": "https://cdn.example.com/source.png",
		"mask_urls": []string{"https://cdn.example.com/mask.png"},
	}
	normalizeImagePayloadForModel(payload)
	if payload["mask_url"] != "https://cdn.example.com/mask.png" {
		t.Fatalf("mask_url = %#v", payload["mask_url"])
	}
	if _, ok := payload["mask_urls"]; ok {
		t.Fatalf("mask_urls alias leaked: %#v", payload)
	}
}

func TestNormalizeKIEImagePayloadStrictModelDifferences(t *testing.T) {
	const source = "https://cdn.example.com/source.png"
	tests := []struct {
		name   string
		model  string
		input  map[string]any
		want   map[string]any
		absent []string
	}{
		{
			name:   "Grok image to image has only image URLs",
			model:  "grok-imagine/image-to-image",
			input:  map[string]any{"size": "16:9", "image_url": source},
			want:   map[string]any{"image_urls": []string{source}},
			absent: []string{"size", "aspect_ratio"},
		},
		{
			name:   "Qwen image to image has no image size",
			model:  "qwen/image-to-image",
			input:  map[string]any{"size": "16:9", "image_url": source},
			want:   map[string]any{"image_url": source},
			absent: []string{"size", "image_size"},
		},
		{
			name:   "Nano Banana lite uses image URLs",
			model:  "nano-banana-2-lite",
			input:  map[string]any{"image_url": source},
			want:   map[string]any{"image_urls": []string{source}},
			absent: []string{"image_input"},
		},
		{
			name:  "Auto resolution remains lowercase",
			model: "bytedance/seedream-v4-text-to-image",
			input: map[string]any{"resolution": "auto"},
			want:  map[string]any{"image_resolution": "auto"},
		},
		{
			name:  "Seedream layer decomposition uses dedicated contract",
			model: "seedream/5-pro-layer-decomposition",
			input: map[string]any{
				"image_urls":   []string{"https://cdn.example.com/source.png"},
				"quality":      "medium",
				"aspect_ratio": "16:9",
			},
			want: map[string]any{
				"image_url":     "https://cdn.example.com/source.png",
				"size":          "1.5K",
				"output_format": "png",
			},
			absent: []string{"image_urls", "quality", "aspect_ratio", "image_size", "resolution"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"model": test.model, "prompt": "edit"}
			for key, value := range test.input {
				payload[key] = value
			}
			normalizeImagePayloadForModel(payload)
			for key, want := range test.want {
				if !reflect.DeepEqual(payload[key], want) {
					t.Fatalf("%s = %#v, want %#v; payload=%#v", key, payload[key], want, payload)
				}
			}
			for _, key := range test.absent {
				if _, ok := payload[key]; ok {
					t.Fatalf("unexpected %s in payload %#v", key, payload)
				}
			}
		})
	}
}

func TestNormalizeKIEImagePayloadDerivesImageResolutionFromSize(t *testing.T) {
	tests := []struct {
		model string
		size  string
		want  string
	}{
		{model: "bytedance/seedream-v4-text-to-image", size: "1920x1080", want: "2K"},
		{model: "flux-2/pro-text-to-image", size: "4096x4096", want: "2K"},
		{model: "gpt-image-2-text-to-image", size: "1024x1024", want: "1K"},
		{model: "nano-banana-2", size: "2048x2048", want: "2K"},
		{model: "wan/2-7-image", size: "3840x2160", want: "4K"},
	}
	for _, test := range tests {
		t.Run(test.model, func(t *testing.T) {
			payload := map[string]any{"model": test.model, "size": test.size}
			normalizeImagePayloadForModel(payload)
			field := "resolution"
			if strings.Contains(test.model, "seedream") {
				field = "image_resolution"
			}
			if got := payload[field]; got != test.want {
				t.Fatalf("%s = %#v, want %q; payload=%#v", field, got, test.want, payload)
			}
		})
	}
	legacy := map[string]any{"model": "bytedance/seedream", "size": "16:9"}
	normalizeImagePayloadForModel(legacy)
	if legacy["image_size"] != "landscape_16_9" {
		t.Fatalf("bytedance/seedream image_size = %#v", legacy["image_size"])
	}
}

func TestNormalizeKIEImagePayloadClearsStaleReferenceAliases(t *testing.T) {
	payload := map[string]any{
		"model":                "qwen/image-to-image",
		"image_url":            "https://cdn.example.com/source.png",
		"reference_video_urls": []string{"https://cdn.example.com/video.mp4"},
		"reference_audio_urls": []string{"https://cdn.example.com/audio.mp3"},
		"input_urls":           []string{"https://cdn.example.com/other.png"},
	}
	normalizeImagePayloadForModel(payload)
	if payload["image_url"] != "https://cdn.example.com/source.png" {
		t.Fatalf("image_url = %#v", payload["image_url"])
	}
	for _, key := range []string{"reference_video_urls", "reference_audio_urls", "input_urls"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("stale alias %s leaked: %#v", key, payload)
		}
	}
}

func TestNormalizeKIEImagePayloadMatchesReferenceImageContracts(t *testing.T) {
	source := "https://cdn.example.com/source.png"
	tests := []struct {
		name   string
		model  string
		input  map[string]any
		want   map[string]any
		absent []string
	}{
		{
			name:   "legacy Seedream has named size only",
			model:  "bytedance/seedream",
			input:  map[string]any{"size": "16:9", "resolution": "4K", "quality": "high"},
			want:   map[string]any{"image_size": "landscape_16_9"},
			absent: []string{"size", "resolution", "image_resolution", "quality", "aspect_ratio"},
		},
		{
			name:   "Seedream 5 keeps aspect ratio and quality",
			model:  "seedream/5-pro-text-to-image",
			input:  map[string]any{"size": "21:9", "quality": "high", "resolution": "4K"},
			want:   map[string]any{"aspect_ratio": "21:9", "quality": "high"},
			absent: []string{"size", "resolution", "image_resolution", "image_size"},
		},
		{
			name:   "Seedream 5 image edit uses image URLs",
			model:  "seedream/5-lite-image-to-image",
			input:  map[string]any{"size": "4:3", "image_url": source},
			want:   map[string]any{"aspect_ratio": "4:3", "image_urls": []string{source}},
			absent: []string{"size", "image_url", "image_size", "resolution"},
		},
		{
			name:   "Seedream 4.5 uses quality without resolution",
			model:  "seedream/4.5-text-to-image",
			input:  map[string]any{"size": "16:9", "quality": "high", "resolution": "4K"},
			want:   map[string]any{"aspect_ratio": "16:9", "quality": "high"},
			absent: []string{"size", "resolution", "image_resolution", "image_size"},
		},
		{
			name:   "GPT Image 1.5 uses quality without resolution",
			model:  "gpt-image/1.5-text-to-image",
			input:  map[string]any{"size": "1:1", "quality": "high", "resolution": "4K"},
			want:   map[string]any{"aspect_ratio": "1:1", "quality": "high"},
			absent: []string{"size", "resolution", "image_resolution", "image_size"},
		},
		{
			name:   "Qwen image edit maps count and image",
			model:  "qwen/image-edit",
			input:  map[string]any{"size": "1:1", "n": 2, "image_urls": []string{source}},
			want:   map[string]any{"image_size": "square_hd", "num_images": "2", "image_url": source},
			absent: []string{"size", "n", "image_urls", "resolution"},
		},
		{
			name:   "Qwen2 image edit does not invent count or resolution",
			model:  "qwen2/image-edit",
			input:  map[string]any{"size": "1:1", "n": 2, "resolution": "2K", "image_urls": []string{source}},
			want:   map[string]any{"image_size": "square_hd", "image_url": source},
			absent: []string{"size", "n", "num_images", "resolution"},
		},
		{
			name:   "Nano Banana lite has no resolution control",
			model:  "nano-banana-2-lite",
			input:  map[string]any{"size": "16:9", "resolution": "4K", "image_url": source},
			want:   map[string]any{"aspect_ratio": "16:9", "image_urls": []string{source}},
			absent: []string{"size", "resolution", "image_resolution", "image_input"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"model": test.model, "prompt": "test"}
			for key, value := range test.input {
				payload[key] = value
			}
			normalizeImagePayloadForModel(payload)
			for key, want := range test.want {
				if !reflect.DeepEqual(payload[key], want) {
					t.Fatalf("%s = %#v, want %#v; payload=%#v", key, payload[key], want, payload)
				}
			}
			for _, key := range test.absent {
				if _, ok := payload[key]; ok {
					t.Fatalf("unexpected %s in payload %#v", key, payload)
				}
			}
		})
	}
}

func TestNormalizeKIEImagePayloadCoversEveryReferenceImageModel(t *testing.T) {
	type contract struct {
		model, aspect, resolution, count, reference string
		quality, outputFormat                       bool
	}
	contracts := []contract{
		{model: "bytedance/seedream", aspect: "image_size"},
		{model: "bytedance/seedream-v4-edit", aspect: "image_size", resolution: "image_resolution", count: "max_images", reference: "image_urls"},
		{model: "bytedance/seedream-v4-text-to-image", aspect: "image_size", resolution: "image_resolution", count: "max_images"},
		{model: "flux-2/flex-image-to-image", aspect: "aspect_ratio", resolution: "resolution", reference: "input_urls"},
		{model: "flux-2/flex-text-to-image", aspect: "aspect_ratio", resolution: "resolution"},
		{model: "flux-2/pro-image-to-image", aspect: "aspect_ratio", resolution: "resolution", reference: "input_urls"},
		{model: "flux-2/pro-text-to-image", aspect: "aspect_ratio", resolution: "resolution"},
		{model: "gpt-image-2-image-to-image", aspect: "aspect_ratio", resolution: "resolution", reference: "input_urls"},
		{model: "gpt-image-2-text-to-image", aspect: "aspect_ratio", resolution: "resolution"},
		{model: "nano-banana-2", aspect: "aspect_ratio", resolution: "resolution", reference: "image_input", outputFormat: true},
		{model: "nano-banana-2-lite", aspect: "aspect_ratio", reference: "image_urls"},
		{model: "nano-banana-pro", aspect: "aspect_ratio", resolution: "resolution", reference: "image_input", outputFormat: true},
		{model: "wan/2-7-image", aspect: "aspect_ratio", resolution: "resolution", count: "n", reference: "input_urls"},
		{model: "wan/2-7-image-pro", aspect: "aspect_ratio", resolution: "resolution", count: "n", reference: "input_urls"},
		{model: "google/imagen4", aspect: "aspect_ratio"},
		{model: "google/imagen4-fast", aspect: "aspect_ratio"},
		{model: "google/imagen4-ultra", aspect: "aspect_ratio"},
		{model: "google/nano-banana", aspect: "aspect_ratio", outputFormat: true},
		{model: "google/nano-banana-edit", aspect: "aspect_ratio", reference: "image_urls", outputFormat: true},
		{model: "gpt-image/1.5-image-to-image", aspect: "aspect_ratio", reference: "input_urls", quality: true},
		{model: "gpt-image/1.5-text-to-image", aspect: "aspect_ratio", quality: true},
		{model: "grok-imagine-image-2-0/text-to-image", aspect: "aspect_ratio"},
		{model: "grok-imagine/text-to-image", aspect: "aspect_ratio"},
		{model: "grok-imagine/image-to-image", reference: "image_urls"},
		{model: "grok-imagine/extend", reference: "image_url"},
		{model: "ideogram/character", aspect: "image_size", count: "num_images", reference: "reference_image_urls"},
		{model: "ideogram/character-edit", count: "num_images", reference: "image_url"},
		{model: "ideogram/character-remix", aspect: "image_size", count: "num_images", reference: "image_url"},
		{model: "ideogram/v3-edit", reference: "image_url"},
		{model: "ideogram/v3-remix", aspect: "image_size", count: "num_images", reference: "image_url"},
		{model: "ideogram/v3-text-to-image", aspect: "image_size"},
		{model: "qwen/text-to-image", aspect: "image_size", outputFormat: true},
		{model: "qwen/image-edit", aspect: "image_size", count: "num_images", reference: "image_url", outputFormat: true},
		{model: "qwen/image-to-image", reference: "image_url", outputFormat: true},
		{model: "qwen2/image-edit", aspect: "image_size", reference: "image_url", outputFormat: true},
		{model: "qwen2/text-to-image", aspect: "image_size", outputFormat: true},
		{model: "recraft/crisp-upscale", reference: "image"},
		{model: "recraft/remove-background", reference: "image"},
		{model: "seedream/4.5-edit", aspect: "aspect_ratio", reference: "image_urls", quality: true},
		{model: "seedream/4.5-text-to-image", aspect: "aspect_ratio", quality: true},
		{model: "seedream/5-lite-image-to-image", aspect: "aspect_ratio", reference: "image_urls", quality: true},
		{model: "seedream/5-lite-text-to-image", aspect: "aspect_ratio", quality: true},
		{model: "seedream/5-pro-text-to-image", aspect: "aspect_ratio", quality: true},
		{model: "seedream/5-pro-image-to-image", aspect: "aspect_ratio", reference: "image_urls", quality: true},
		{model: "seedream/5-pro-layer-decomposition", reference: "image_url", outputFormat: true},
		{model: "topaz/image-upscale", reference: "image_url"},
		{model: "z-image", aspect: "aspect_ratio"},
	}
	const source = "https://cdn.example.com/source.png"
	for _, test := range contracts {
		t.Run(test.model, func(t *testing.T) {
			payload := map[string]any{
				"model":                test.model,
				"size":                 "16:9",
				"resolution":           "4K",
				"quality":              "high",
				"n":                    2,
				"output_format":        "jpeg",
				"image_url":            source,
				"image_urls":           []string{source},
				"input_urls":           []string{source},
				"reference_image_urls": []string{source},
				"mask_url":             "https://cdn.example.com/mask.png",
				"video_url":            "https://cdn.example.com/source.mp4",
				"audio_url":            "https://cdn.example.com/source.mp3",
			}
			normalizeImagePayloadForModel(payload)
			if test.aspect != "" {
				if _, ok := payload[test.aspect]; !ok {
					t.Fatalf("missing aspect field %s: %#v", test.aspect, payload)
				}
			} else if test.model != "seedream/5-pro-layer-decomposition" {
				for _, field := range []string{"size", "image_size", "aspect_ratio"} {
					if _, ok := payload[field]; ok {
						t.Fatalf("unsupported aspect field %s leaked: %#v", field, payload)
					}
				}
			}
			for _, field := range []string{"resolution", "image_resolution"} {
				if field == test.resolution {
					if _, ok := payload[field]; !ok {
						t.Fatalf("missing resolution field %s: %#v", field, payload)
					}
				} else if _, ok := payload[field]; ok {
					t.Fatalf("unsupported resolution field %s leaked: %#v", field, payload)
				}
			}
			for _, field := range []string{"n", "max_images", "num_images"} {
				if field == test.count {
					if _, ok := payload[field]; !ok {
						t.Fatalf("missing count field %s: %#v", field, payload)
					}
				} else if _, ok := payload[field]; ok {
					t.Fatalf("unsupported count field %s leaked: %#v", field, payload)
				}
			}
			if test.quality {
				if _, ok := payload["quality"]; !ok {
					t.Fatalf("missing quality: %#v", payload)
				}
			} else if _, ok := payload["quality"]; ok {
				t.Fatalf("unsupported quality leaked: %#v", payload)
			}
			if test.outputFormat {
				wantFormat := "jpg"
				if test.model == "seedream/5-pro-layer-decomposition" {
					wantFormat = "png"
				}
				if payload["output_format"] != wantFormat {
					t.Fatalf("output_format = %#v, want %s: %#v", payload["output_format"], wantFormat, payload)
				}
			} else if _, ok := payload["output_format"]; ok {
				t.Fatalf("unsupported output_format leaked: %#v", payload)
			}
			for _, field := range []string{"image_url", "image_urls", "input_urls", "reference_image_urls", "image", "mask_url", "video_url", "audio_url"} {
				if field == test.reference || (test.model == "ideogram/character-remix" && field == "reference_image_urls") || (test.model == "ideogram/character-edit" && (field == "reference_image_urls" || field == "mask_url")) || (test.model == "ideogram/v3-edit" && field == "mask_url") {
					continue
				}
				if _, ok := payload[field]; ok {
					t.Fatalf("unsupported reference field %s leaked: %#v", field, payload)
				}
			}
		})
	}
}
