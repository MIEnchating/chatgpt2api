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
	if _, err := app.customRelayConfigs.Update(identityScope(*identity), "text", upstream.URL, "sk-custom"); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	payload := map[string]any{
		"model": "gpt-5.5", "messages": []map[string]any{{"role": "user", "content": "hello"}},
		"token_name": service.CustomRelayTokenName("text"),
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

func TestOfficialVideoRequestPayloadUsesProviderFields(t *testing.T) {
	tests := []struct {
		name   string
		model  string
		input  map[string]any
		want   map[string]any
		absent []string
	}{
		{
			name:   "grok",
			model:  "grok-imagine-video-1.5",
			input:  map[string]any{"seconds": 10, "size": "16:9", "resolution": "1080p", "generate_audio": true, "watermark": true},
			want:   map[string]any{"duration": 10, "aspect_ratio": "16:9", "resolution": "1080p"},
			absent: []string{"generate_audio", "watermark", "metadata"},
		},
		{
			name:   "minimax",
			model:  "MiniMax-Hailuo-2.3",
			input:  map[string]any{"seconds": 6, "resolution": "768P", "watermark": true},
			want:   map[string]any{"duration": 6, "resolution": "768p"},
			absent: []string{"ratio", "generate_audio", "aigc_watermark"},
		},
		{
			name:   "minimax h3 text",
			model:  "MiniMax-H3",
			input:  map[string]any{"seconds": 6, "size": "adaptive", "resolution": "2K", "watermark": true},
			want:   map[string]any{"duration": 6, "aspect_ratio": "adaptive", "resolution": "2K"},
			absent: []string{"aigc_watermark", "generation_mode"},
		},
		{
			name:   "minimax h3 reference",
			model:  "MiniMax-H3",
			input:  map[string]any{"seconds": 6, "size": "adaptive", "reference_image_urls": []string{"data:image/png;base64,reference"}},
			want:   map[string]any{"duration": 6, "aspect_ratio": "adaptive", "first_frame_image": "data:image/png;base64,reference"},
			absent: []string{"generation_mode"},
		},
		{
			name:   "sora official fields only",
			model:  "sora-2-pro",
			input:  map[string]any{"seconds": 20, "size": "1920x1080", "resolution": "1080p", "generate_audio": true, "watermark": true},
			want:   map[string]any{"duration": 20, "aspect_ratio": "16:9", "quality": "1080p"},
			absent: []string{"seconds", "size", "resolution", "generate_audio", "watermark"},
		},
		{
			name:   "cogvideox 3",
			model:  "CogVideoX-3",
			input:  map[string]any{"seconds": 10, "size": "1920x1080", "resolution": "4k", "generate_audio": true, "reference_image_urls": []string{"data:image/png;base64,reference"}},
			want:   map[string]any{"duration": 10, "size": "1920x1080", "quality": "quality", "with_audio": true, "image_url": "data:image/png;base64,reference"},
			absent: []string{"resolution", "input_reference"},
		},
		{
			name:   "cogvideox 3 derives size from resolution",
			model:  "CogVideoX-3",
			input:  map[string]any{"seconds": 10, "resolution": "1080p"},
			want:   map[string]any{"duration": 10, "size": "1920x1080", "quality": "quality"},
			absent: []string{"resolution", "input_reference"},
		},
		{
			name:  "seedance",
			model: "doubao-seedance-2-5-260628",
			input: map[string]any{"seconds": 30, "size": "adaptive", "resolution": "1080p", "generate_audio": true, "watermark": false},
			want:  map[string]any{"duration": 30, "size": "adaptive", "resolution": "1080p", "generate_audio": true, "watermark": false},
		},
		{
			name:   "kling",
			model:  "kling-v3",
			input:  map[string]any{"seconds": 5, "size": "1:1", "resolution": "4k", "generate_audio": true, "watermark": false},
			want:   map[string]any{"duration": 5, "aspect_ratio": "1:1", "mode": "4k", "audio": true},
			absent: []string{"watermark"},
		},
		{
			name:   "kling reference follows first frame ratio",
			model:  "kling-v3",
			input:  map[string]any{"seconds": 5, "size": "16:9", "resolution": "1080p", "reference_image_urls": []string{"https://example.com/first.png", "https://example.com/last.png"}},
			want:   map[string]any{"duration": 5, "mode": "pro", "aspect_ratio": "16:9", "image_urls": []string{"https://example.com/first.png", "https://example.com/last.png"}},
			absent: []string{"image", "image_tail", "input_reference"},
		},
		{
			name:   "hailuo image to video",
			model:  "MiniMax-Hailuo-2.3-Fast",
			input:  map[string]any{"seconds": 6, "resolution": "768P", "reference_image_urls": []string{"https://example.com/frame.png"}},
			want:   map[string]any{"duration": 6, "resolution": "768p", "first_frame_image": "https://example.com/frame.png"},
			absent: []string{"input_reference"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"model": test.model, "prompt": "make a video"}
			for key, value := range test.input {
				payload[key] = value
			}
			got := officialVideoRequestPayload(payload)
			for key, value := range test.want {
				if !reflect.DeepEqual(got[key], value) {
					t.Fatalf("%s = %#v, want %#v (payload %#v)", key, got[key], value, got)
				}
			}
			for _, key := range test.absent {
				if _, ok := got[key]; ok {
					t.Fatalf("unexpected provider field %q in %#v", key, got)
				}
			}
			if isAPIMartVideoPayload(payload) {
				if _, ok := got["metadata"]; ok {
					t.Fatalf("APIMart request retained compatibility metadata: %#v", got)
				}
			}
		})
	}
}

func TestNewAPIVideoRequestPayloadStaysProviderNeutralUntilChannelSelection(t *testing.T) {
	images := []string{"https://cdn.example.com/one.png", "https://cdn.example.com/two.png"}
	videos := []string{"https://cdn.example.com/source.mp4"}
	audios := []string{"https://cdn.example.com/voice.mp3"}
	got := newAPIVideoRequestPayload(map[string]any{
		"model":                "minimax-h3/reference-to-video",
		"provider":             "kie",
		"prompt":               "animate",
		"seconds":              8,
		"size":                 "adaptive",
		"resolution":           "2K",
		"reference_mode":       "reference",
		"generation_mode":      "reference-to-video",
		"reference_image_urls": images,
		"reference_video_urls": videos,
		"reference_audio_urls": audios,
		"video_generate_audio": true,
		"multi_shot":           true,
		"shot_type":            "customize",
	})

	want := map[string]any{
		"model":             "minimax-h3/reference-to-video",
		"prompt":            "animate",
		"seconds":           8,
		"size":              "adaptive",
		"resolution":        "2K",
		"input_reference[]": images,
		"video_reference[]": videos,
		"audio_reference[]": audios,
		"generate_audio":    true,
		"multi_shot":        true,
		"shot_type":         "customize",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("provider-neutral video payload = %#v, want %#v", got, want)
	}
	for _, field := range []string{"provider", "reference_mode", "generation_mode", "duration", "aspect_ratio", "metadata"} {
		assertVideoRequestFieldAbsentRecursively(t, got, field)
	}
}

func TestNewAPIVideoRequestPayloadKeepsSoraReferenceCompatibleWithEitherChannel(t *testing.T) {
	reference := "https://cdn.example.com/frame.png"
	got := newAPIVideoRequestPayload(map[string]any{
		"model": "sora-2", "prompt": "animate", "seconds": 8,
		"size": "1280x720", "resolution": "1080p",
		"reference_image_urls": []string{reference},
	})
	if got["input_reference"] != reference {
		t.Fatalf("Sora neutral reference payload = %#v", got)
	}
	if _, ok := got["input_reference[]"]; ok {
		t.Fatalf("Sora payload retained generic reference array: %#v", got)
	}
	if got["size"] != "1280x720" || got["seconds"] != 8 || got["resolution"] != "1080p" {
		t.Fatalf("Sora neutral parameters = %#v", got)
	}
}

func TestNewAPIVideoRequestPayloadUsesNewAPIResolutionField(t *testing.T) {
	got := newAPIVideoRequestPayload(map[string]any{
		"model": "kling-3.0/motion-control", "prompt": "animate",
		"resolution": "1080p",
	})
	if got["resolution"] != "1080p" {
		t.Fatalf("neutral resolution field = %#v, want resolution", got)
	}
	if _, ok := got["resolution_name"]; ok {
		t.Fatalf("neutral request leaked reference-workbench alias: %#v", got)
	}
}

func TestNewAPIVideoRequestPayloadCapsKIESeedance25Resolution(t *testing.T) {
	got := newAPIVideoRequestPayload(map[string]any{
		"model": "bytedance/seedance-2-5", "prompt": "animate",
		"resolution": "1080p",
	})
	if got["resolution"] != "720p" {
		t.Fatalf("KIE Seedance 2.5 neutral resolution = %#v, want 720p", got)
	}
}

func TestNewAPIVideoRequestPayloadUsesDedicatedNativeContracts(t *testing.T) {
	h3 := newAPIVideoRequestPayload(map[string]any{
		"model": "MiniMax-H3", "prompt": "animate", "seconds": 6,
		"size": "16:9", "resolution": "2K",
	})
	if h3["duration"] != 6 || h3["ratio"] != "16:9" || h3["resolution"] != "2K" {
		t.Fatalf("Metaso H3 native payload = %#v", h3)
	}
	if _, ok := h3["content"]; !ok {
		t.Fatalf("Metaso H3 native payload has no content: %#v", h3)
	}
	for _, field := range []string{"prompt", "seconds", "size", "generation_mode", "protocol"} {
		assertVideoRequestFieldAbsentRecursively(t, h3, field)
	}

	grok := newAPIVideoRequestPayload(map[string]any{
		"model": "grok-imagine-video-1.5", "prompt": "animate", "seconds": 10,
		"size": "16:9", "resolution": "1080p",
	})
	if grok["duration"] != 10 || grok["aspect_ratio"] != "16:9" || grok["resolution"] != "1080p" {
		t.Fatalf("Grok2API native payload = %#v", grok)
	}
	if _, ok := grok["seconds"]; ok {
		t.Fatalf("Grok2API native payload leaked seconds: %#v", grok)
	}
}

func TestOfficialVideoRequestPayloadMapsMiniMaxH3MultimodalReferences(t *testing.T) {
	images := []string{"https://cdn.example.com/character.png"}
	videos := []string{"https://cdn.example.com/motion.mp4"}
	audios := []string{"https://cdn.example.com/voice.mp3"}
	got := officialVideoRequestPayload(map[string]any{
		"model":                "MiniMax-H3",
		"prompt":               "follow the references",
		"seconds":              8,
		"size":                 "16:9",
		"resolution":           "2K",
		"reference_mode":       "reference",
		"reference_image_urls": images,
		"reference_video_urls": videos,
		"reference_audio_urls": audios,
	})
	if got["aspect_ratio"] != "16:9" {
		t.Fatalf("unexpected H3 reference mode payload: %#v", got)
	}
	if _, ok := got["generation_mode"]; ok {
		t.Fatalf("H3 reference payload leaked generation_mode: %#v", got)
	}
	if _, ok := got["input_reference"]; ok {
		t.Fatalf("multimodal references must not be reduced to input_reference: %#v", got)
	}
	for key, want := range map[string]any{
		"image_urls": images,
		"video_urls": videos,
		"audio_urls": audios,
	} {
		if !reflect.DeepEqual(got[key], want) {
			t.Fatalf("%s = %#v, want %#v", key, got[key], want)
		}
	}
	if _, ok := got["metadata"]; ok {
		t.Fatalf("APIMart MiniMax H3 retained compatibility metadata: %#v", got)
	}
}

func TestOfficialVideoRequestPayloadNormalizesMiniMaxH3Values(t *testing.T) {
	reference := officialVideoRequestPayload(map[string]any{
		"model": "MiniMax-H3", "prompt": "follow references", "seconds": 8,
		"size": "adaptive", "resolution": "2K", "reference_mode": "reference",
		"reference_image_urls": []string{"https://cdn.example.com/character.png"},
	})
	if reference["aspect_ratio"] != "adaptive" {
		t.Fatalf("H3 adaptive reference payload = %#v", reference)
	}
	if _, ok := reference["generation_mode"]; ok {
		t.Fatalf("H3 adaptive reference payload leaked generation_mode: %#v", reference)
	}

	textOnly := officialVideoRequestPayload(map[string]any{
		"model": "MiniMax-H3", "prompt": "text only", "seconds": 8,
		"size": "adaptive", "resolution": "768P",
	})
	if textOnly["aspect_ratio"] != "adaptive" {
		t.Fatalf("H3 adaptive text payload = %#v", textOnly)
	}
	if _, ok := textOnly["generation_mode"]; ok {
		t.Fatalf("H3 adaptive text payload leaked generation_mode: %#v", textOnly)
	}
}

func TestOfficialVideoRequestPayloadRecursivelyRemovesGenerationMode(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model":           "minimax-h3",
		"provider":        "apimart",
		"prompt":          "animate",
		"seconds":         6,
		"generation_mode": "reference-to-video",
		"metadata": map[string]any{
			"generation_mode": "image-to-video",
			"parameters": map[string]any{
				"generation_mode": "text-to-video",
			},
		},
	})
	assertVideoRequestFieldAbsentRecursively(t, got, "generation_mode")
}

func TestRelayVideoSubmitRecursivelyRemovesGenerationMode(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"video_test","status":"queued"}`))
	}))
	defer server.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": server.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	request := map[string]any{
		"model":           "minimax-h3",
		"prompt":          "animate",
		"generation_mode": "reference-to-video",
		"metadata": map[string]any{
			"parameters": map[string]any{
				"generation_mode": "image-to-video",
			},
			"items": []any{map[string]any{"generation_mode": "text-to-video"}},
		},
	}
	if _, err := app.relayVideoSubmit(context.Background(), "sk-test", request); err != nil {
		t.Fatalf("relayVideoSubmit() error = %v", err)
	}
	assertVideoRequestFieldAbsentRecursively(t, received, "generation_mode")
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

func TestOfficialVideoRequestPayloadNormalizesInvalidMiniMaxH3Enums(t *testing.T) {
	textOnly := officialVideoRequestPayload(map[string]any{
		"model": "MiniMax-H3", "prompt": "text", "seconds": 8,
		"size": "2:1", "resolution": "1080p",
	})
	if textOnly["aspect_ratio"] != "2:1" || textOnly["resolution"] != "2K" {
		t.Fatalf("H3 text enums were not normalized: %#v", textOnly)
	}

	reference := officialVideoRequestPayload(map[string]any{
		"model": "MiniMax-H3", "prompt": "reference", "seconds": 8,
		"size": "2:1", "resolution": "720p", "reference_mode": "reference",
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
	})
	if reference["aspect_ratio"] != "2:1" || reference["resolution"] != "768P" {
		t.Fatalf("H3 reference enums were not normalized: %#v", reference)
	}
}

func TestOfficialVideoRequestPayloadCanonicalizesReferenceProjectAliases(t *testing.T) {
	payload := officialVideoRequestPayload(map[string]any{
		"model":                "kling/text-to-video",
		"prompt":               "a quiet street",
		"seconds":              5,
		"size":                 "16:9",
		"reference_image_urls": []string(nil),
		"reference_video_urls": []string(nil),
		"reference_audio_urls": []string(nil),
		"resolution":           "720p",
	})
	if payload["model"] != "kling-2.6/text-to-video" {
		t.Fatalf("canonical model = %#v, payload=%#v", payload["model"], payload)
	}
	if payload["aspect_ratio"] != "16:9" {
		t.Fatalf("canonical alias did not retain its KIE aspect ratio: %#v", payload)
	}
}

func TestOfficialVideoRequestPayloadMapsSeedanceMultimodalReferences(t *testing.T) {
	images := []string{"https://cdn.example.com/character.png"}
	videos := []string{"https://cdn.example.com/motion.mp4"}
	audios := []string{"https://cdn.example.com/voice.mp3"}
	got := officialVideoRequestPayload(map[string]any{
		"model":                "doubao-seedance-2-0-260128",
		"prompt":               "follow the references",
		"seconds":              8,
		"size":                 "16:9",
		"resolution":           "1080p",
		"reference_mode":       "reference",
		"reference_image_urls": images,
		"reference_video_urls": videos,
		"reference_audio_urls": audios,
	})
	if _, ok := got["input_reference"]; ok {
		t.Fatalf("Seedance multimodal references must not be reduced to input_reference: %#v", got)
	}
	for key, want := range map[string]any{
		"image_urls": images,
		"video_urls": videos,
		"audio_urls": audios,
	} {
		if !reflect.DeepEqual(got[key], want) {
			t.Fatalf("%s = %#v, want %#v", key, got[key], want)
		}
	}
	if _, ok := got["metadata"]; ok {
		t.Fatalf("APIMart Seedance retained compatibility metadata: %#v", got)
	}
	if _, ok := got["content"]; ok {
		t.Fatalf("APIMart Seedance retained compatibility content: %#v", got)
	}
}

func TestOfficialVideoRequestPayloadKIESeedanceUsesOnlyNativeReferenceArrays(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model":                "bytedance/seedance-2",
		"prompt":               "follow the references",
		"seconds":              8,
		"size":                 "16:9",
		"resolution":           "1080p",
		"reference_mode":       "reference",
		"reference_image_urls": []string{"https://cdn.example.com/character.png"},
		"reference_video_urls": []string{"https://cdn.example.com/motion.mp4"},
		"reference_audio_urls": []string{"https://cdn.example.com/voice.mp3"},
	})
	for _, field := range []string{"reference_image_urls", "reference_video_urls", "reference_audio_urls"} {
		if _, ok := videoPayloadField(got, field); !ok {
			t.Fatalf("KIE Seedance lost native %s: %#v", field, got)
		}
	}
	assertVideoRequestFieldAbsentRecursively(t, got, "content")
}

func TestOfficialVideoRequestPayloadMapsAdditionalProviders(t *testing.T) {
	imageURLs := []string{"https://cdn.example.com/first.png", "https://cdn.example.com/last.png"}
	tests := []struct {
		name     string
		payload  map[string]any
		want     map[string]any
		metadata map[string]any
		absent   []string
	}{
		{
			name: "Veo",
			payload: map[string]any{
				"model": "veo-3.1-generate-preview", "prompt": "make a video", "seconds": 8,
				"size": "9:16", "resolution": "4k", "generate_audio": true,
				"reference_image_urls": imageURLs[:1],
			},
			want: map[string]any{"duration": 8, "size": "9:16"},
			metadata: map[string]any{
				"aspectRatio": "9:16", "resolution": "4k", "durationSeconds": 8, "generateAudio": true, "firstFrame": imageURLs[0],
			},
			absent: []string{"resolution", "input_reference", "images"},
		},
		{
			name: "APIMart official Veo named frames",
			payload: map[string]any{
				"model": "veo3.1-official", "prompt": "keep the subject", "seconds": 8,
				"size": "16:9", "reference_mode": "reference", "reference_image_urls": imageURLs,
			},
			want:   map[string]any{"duration": 8, "aspect_ratio": "16:9", "first_frame_image": imageURLs[0], "last_frame_image": imageURLs[1]},
			absent: []string{"seconds", "size", "resolution", "input_reference", "images"},
		},
		{
			name: "Veo 3.1 asset references",
			payload: map[string]any{
				"model": "veo-3.1-generate-preview", "prompt": "keep the products", "seconds": 8,
				"size": "16:9", "resolution": "720p", "reference_mode": "reference",
				"reference_image_urls": imageURLs,
			},
			want: map[string]any{"duration": 8, "size": "16:9"},
			metadata: map[string]any{
				"aspectRatio": "16:9", "resolution": "720p", "durationSeconds": 8, "referenceImages": imageURLs,
			},
			absent: []string{"resolution", "input_reference", "images"},
		},
		{
			name: "Agnes Video 2.5 keyframes",
			payload: map[string]any{
				"model": "agnes-video-2.5", "prompt": "interpolate", "seconds": 8,
				"size": "16:9", "resolution": "720P", "reference_image_urls": imageURLs,
			},
			want:   map[string]any{"seconds": "8", "size": "720P", "mode": "keyframe", "first_frame": imageURLs[0], "last_frame": imageURLs[1], "aspect_ratio": "16:9"},
			absent: []string{"duration", "resolution", "input_reference"},
		},
		{
			name: "Agnes Video 2.5 multimodal references",
			payload: map[string]any{
				"model": "agnes-video-2.5", "prompt": "follow assets", "seconds": 5,
				"size": "9:16", "reference_mode": "reference", "reference_image_urls": imageURLs[:1],
				"reference_video_urls": []string{"https://cdn.example.com/source.mp4"}, "reference_audio_urls": []string{"https://cdn.example.com/voice.mp3"},
			},
			want: map[string]any{
				"seconds": "5", "size": "720P", "mode": "reference", "images": imageURLs[:1], "aspect_ratio": "9:16",
				"audios": []string{"https://cdn.example.com/voice.mp3"},
				"videos": []map[string]any{{"url": "https://cdn.example.com/source.mp4"}},
			},
			absent: []string{"duration", "resolution", "input_reference"},
		},
		{
			name: "Agnes legacy keyframes",
			payload: map[string]any{
				"model": "agnes-video", "prompt": "animate", "seconds": 6, "size": "1280x720", "reference_image_urls": imageURLs,
			},
			want: map[string]any{
				"num_frames": 145, "frame_rate": 24, "width": 1280, "height": 720,
				"extra_body": map[string]any{"image": imageURLs, "mode": "keyframes"},
			},
			absent: []string{"duration", "seconds", "size", "input_reference"},
		},
		{
			name: "Grok2API multimodal image request",
			payload: map[string]any{
				"model": "grok-imagine-video", "prompt": "animate", "seconds": 10,
				"size": "adaptive", "resolution": "1080p", "reference_image_urls": imageURLs,
			},
			want: map[string]any{
				"duration": 10, "resolution": "1080p",
				"reference_images": []map[string]any{{"url": imageURLs[0]}, {"url": imageURLs[1]}},
			},
			absent: []string{"seconds", "size", "aspect_ratio", "image", "input_reference", "generation_mode"},
		},
		{
			name: "CogVideoX 3 native request",
			payload: map[string]any{
				"model": "cogvideox-3", "prompt": "animate", "seconds": 10,
				"size": "9:16", "resolution": "1080p", "generate_audio": true,
				"reference_image_urls": imageURLs,
			},
			want: map[string]any{
				"duration": 10, "quality": "quality", "size": "1080x1920", "with_audio": true,
				"image_url": imageURLs,
			},
			absent: []string{"seconds", "resolution", "input_reference", "generation_mode"},
		},
		{
			name: "Wan 2.7 image to video",
			payload: map[string]any{
				"model": "wan2.7-i2v-plus", "prompt": "make a video", "seconds": 10,
				"resolution": "1080p", "generate_audio": true, "watermark": true,
				"reference_image_urls": imageURLs,
				"reference_audio_urls": []string{"https://cdn.example.com/voice.mp3"},
			},
			want:   map[string]any{"duration": 10, "resolution": "1080P", "image_with_roles": []map[string]string{{"url": imageURLs[0], "role": "first_frame"}, {"url": imageURLs[1], "role": "last_frame"}}},
			absent: []string{"input_reference"},
		},
		{
			name: "Wan text to video",
			payload: map[string]any{
				"model": "wan2.6-t2v", "prompt": "make a video", "seconds": 5,
				"size": "1280x720", "watermark": false,
			},
			want:   map[string]any{"duration": 5, "aspect_ratio": "16:9"},
			absent: []string{"input_reference"},
		},
		{
			name: "Vidu",
			payload: map[string]any{
				"model": "viduq1", "prompt": "make a video", "seconds": 12,
				"size": "16:9", "resolution": "1080p", "reference_image_urls": imageURLs,
			},
			want:   map[string]any{"duration": 12, "resolution": "1080p", "image_urls": imageURLs},
			absent: []string{"size", "input_reference"},
		},
		{
			name: "Jimeng",
			payload: map[string]any{
				"model": "jimeng_v30", "prompt": "make a video", "seconds": 10,
				"size": "9:16", "reference_image_urls": imageURLs,
			},
			want:     map[string]any{"duration": 10, "size": "9:16", "images": imageURLs},
			metadata: map[string]any{"aspect_ratio": "9:16"},
			absent:   []string{"input_reference"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := officialVideoRequestPayload(test.payload)
			for key, want := range test.want {
				if !reflect.DeepEqual(got[key], want) {
					t.Fatalf("%s = %#v, want %#v in %#v", key, got[key], want, got)
				}
			}
			for _, key := range test.absent {
				if _, ok := got[key]; ok {
					t.Fatalf("unexpected provider field %q in %#v", key, got)
				}
			}
			if isAPIMartVideoPayload(test.payload) {
				if _, ok := got["metadata"]; ok {
					t.Fatalf("APIMart request retained compatibility metadata: %#v", got)
				}
			} else if test.metadata != nil && !reflect.DeepEqual(got["metadata"], test.metadata) {
				t.Fatalf("metadata = %#v, want %#v", got["metadata"], test.metadata)
			}
		})
	}
}

func TestInlineVeoReferenceImageConvertsPublicURLForNewAPI(t *testing.T) {
	imageData := httpTestPNGBytes(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(imageData)
	}))
	defer server.Close()

	app := newTestApp(t)
	defer app.Close()
	request := map[string]any{"metadata": map[string]any{
		"firstFrame":      server.URL + "/first.png",
		"lastFrame":       server.URL + "/last.png",
		"referenceImages": []string{server.URL + "/reference.png"},
	}}
	if err := app.inlineVeoReferenceImage(context.Background(), request); err != nil {
		t.Fatalf("inlineVeoReferenceImage() error = %v", err)
	}
	metadata := request["metadata"].(map[string]any)
	for _, field := range []string{"firstFrame", "lastFrame"} {
		if !strings.HasPrefix(util.Clean(metadata[field]), "data:image/png;base64,") {
			t.Fatalf("Veo metadata.%s = %#v, want inline PNG", field, metadata[field])
		}
	}
	images := util.AsStringSlice(metadata["referenceImages"])
	if len(images) != 1 || !strings.HasPrefix(images[0], "data:image/png;base64,") {
		t.Fatalf("Veo referenceImages = %#v, want one inline PNG", images)
	}
}

func TestRelayVideoSubmitInlinesVeoReferenceBeforePostingToNewAPI(t *testing.T) {
	imageData := httpTestPNGBytes(t)
	imageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(imageData)
	}))
	defer imageServer.Close()

	var received map[string]any
	relayServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/videos" {
			t.Errorf("unexpected relay request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode relay request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"video_veo","status":"queued"}`))
	}))
	defer relayServer.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": relayServer.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	request := newAPIVideoRequestPayload(map[string]any{
		"model": "veo-3.1-generate-preview", "protocol": "gemini", "prompt": "animate",
		"seconds": 8, "size": "16:9", "resolution": "720p", "reference_mode": "reference",
		"reference_image_urls": []string{imageServer.URL + "/asset.png"},
	})
	if _, err := app.relayVideoSubmit(context.Background(), "sk-test", request); err != nil {
		t.Fatalf("relayVideoSubmit() error = %v", err)
	}
	metadata := util.StringMap(received["metadata"])
	images := util.AsStringSlice(metadata["referenceImages"])
	if len(images) != 1 || !strings.HasPrefix(images[0], "data:image/png;base64,") {
		t.Fatalf("posted Veo referenceImages = %#v, request=%#v", images, received)
	}
	for _, field := range videoInternalRequestFields {
		assertVideoRequestFieldAbsentRecursively(t, received, field)
	}
}

func TestOfficialVideoRequestPayloadMapsReferenceVideo(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model":                "MiniMax-H3",
		"prompt":               "restyle the source video",
		"seconds":              8,
		"size":                 "adaptive",
		"resolution":           "2K",
		"reference_mode":       "reference",
		"reference_video_urls": []string{"https://media.example.com/source.mp4"},
	})
	if got["aspect_ratio"] != "adaptive" {
		t.Fatalf("reference video was not mapped to H3 reference-to-video: %#v", got)
	}
	if _, ok := got["generation_mode"]; ok {
		t.Fatalf("reference video payload leaked generation_mode: %#v", got)
	}
	if _, ok := got["input_reference"]; ok {
		t.Fatalf("reference video must use reference_video_urls, not input_reference: %#v", got)
	}
}

func TestOfficialVideoRequestPayloadNormalizesMiniMaxH3Resolution(t *testing.T) {
	for input, want := range map[string]string{"768p": "768P", "768": "768P", "2k": "2K", "2048p": "2K"} {
		got := officialVideoRequestPayload(map[string]any{
			"model": "minimax-h3/text-to-video", "prompt": "animate", "seconds": 6,
			"size": "16:9", "resolution": input,
		})
		if got["resolution"] != want {
			t.Fatalf("resolution %q = %#v, want %q; payload=%#v", input, got["resolution"], want, got)
		}
	}
}

func TestValidateVideoReferencePayloadURLsAllowsSingleInlineFirstFrameAlias(t *testing.T) {
	inline := "data:image/png;base64,AAAA"
	err := validateVideoReferencePayloadURLs(map[string]any{
		"generation_mode":      "image-to-video",
		"input_reference":      inline,
		"reference_image_urls": []string{inline},
	})
	if err != nil {
		t.Fatalf("single inline first frame validation error = %v", err)
	}
}

func TestValidateVideoReferencePayloadURLsRejectsInlineReferenceArrays(t *testing.T) {
	err := validateVideoReferencePayloadURLs(map[string]any{
		"reference_image_urls": []string{"data:image/png;base64,AAAA"},
	})
	if err == nil || !strings.Contains(err.Error(), "公网") {
		t.Fatalf("inline reference validation error = %v, want public URL message", err)
	}
}

func TestValidateVideoReferencePayloadURLsRejectsInlineNamedFrames(t *testing.T) {
	err := validateVideoReferencePayloadURLs(map[string]any{
		"first_frame_url": "data:image/png;base64,AAAA",
	})
	if err == nil || !strings.Contains(err.Error(), "公网") {
		t.Fatalf("inline named-frame validation error = %v, want public URL message", err)
	}
}

func TestValidateVideoReferencePayloadURLsRejectsPrivateSingleURL(t *testing.T) {
	err := validateVideoReferencePayloadURLs(map[string]any{
		"video_url": "http://127.0.0.1/source.mp4",
	})
	if err == nil || !strings.Contains(err.Error(), "公网") {
		t.Fatalf("private single URL validation error = %v, want public URL message", err)
	}
}

func TestValidateVideoReferencePayloadURLsRejectsNestedProviderReferences(t *testing.T) {
	err := validateVideoReferencePayloadURLs(map[string]any{
		"image_with_roles": []map[string]string{{"url": "data:image/png;base64,AAAA", "role": "first_frame"}},
	})
	if err == nil || !strings.Contains(err.Error(), "公网") {
		t.Fatalf("nested reference validation error = %v, want public URL message", err)
	}
}

func TestValidateVideoReferencePayloadURLsAcceptsPublicGrok2APIReferences(t *testing.T) {
	for _, payload := range []map[string]any{
		{"image": map[string]any{"url": "https://cdn.example.com/first.png"}},
		{"reference_images": []map[string]any{
			{"url": "https://cdn.example.com/one.png"},
			{"url": "https://cdn.example.com/two.png"},
		}},
	} {
		if err := validateVideoReferencePayloadURLs(payload); err != nil {
			t.Fatalf("public Grok2API reference rejected: payload=%#v error=%v", payload, err)
		}
	}
}

func TestValidateVideoReferencePayloadURLsRejectsNonPublicGrok2APIReferences(t *testing.T) {
	for _, payload := range []map[string]any{
		{"image": map[string]any{"url": "data:image/png;base64,AAAA"}},
		{"image": map[string]any{"url": "http://127.0.0.1/first.png"}},
		{"reference_images": []map[string]any{{"url": "data:image/png;base64,AAAA"}}},
		{"reference_images": []map[string]any{{"url": "http://10.0.0.1/one.png"}}},
	} {
		err := validateVideoReferencePayloadURLs(payload)
		if err == nil || !strings.Contains(err.Error(), "公网") {
			t.Fatalf("non-public Grok2API reference validation error = %v, payload=%#v", err, payload)
		}
	}
}

func TestValidateVideoReferencePayloadURLsRejectsMetadataBase64References(t *testing.T) {
	err := validateVideoReferencePayloadURLs(map[string]any{
		"metadata": map[string]any{
			"reference_image_urls": []string{"data:image/png;base64,AAAA"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "公网") {
		t.Fatalf("metadata reference validation error = %v, want public URL message", err)
	}
}

func TestOfficialVideoRequestPayloadMapsWanSpecializedModes(t *testing.T) {
	tests := []struct {
		name   string
		model  string
		images []string
		videos []string
		audios []string
		want   map[string]any
	}{
		{
			name: "KIE image to video", model: "wan/2-7-image-to-video",
			images: []string{"https://cdn.example.com/first.png"}, videos: []string{"https://cdn.example.com/clip.mp4"}, audios: []string{"https://cdn.example.com/drive.mp3"},
			want: map[string]any{"first_frame_url": "https://cdn.example.com/first.png", "first_clip_url": "https://cdn.example.com/clip.mp4", "driving_audio_url": "https://cdn.example.com/drive.mp3"},
		},
		{
			name: "KIE R2V", model: "wan/2-7-r2v",
			images: []string{"https://cdn.example.com/character.png"}, videos: []string{"https://cdn.example.com/motion.mp4"}, audios: []string{"https://cdn.example.com/voice.mp3"},
			want: map[string]any{"reference_image": []string{"https://cdn.example.com/character.png"}, "reference_video": []string{"https://cdn.example.com/motion.mp4"}, "reference_voice": "https://cdn.example.com/voice.mp3"},
		},
		{
			name: "KIE video edit", model: "wan/2-7-videoedit",
			images: []string{"https://cdn.example.com/style.png"}, videos: []string{"https://cdn.example.com/source.mp4"},
			want: map[string]any{"reference_image": "https://cdn.example.com/style.png", "video_url": "https://cdn.example.com/source.mp4"},
		},
		{
			name: "KIE video to video", model: "wan/2-6-video-to-video",
			videos: []string{"https://cdn.example.com/source.mp4"},
			want:   map[string]any{"video_urls": []string{"https://cdn.example.com/source.mp4"}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": test.model, "prompt": "make a video", "seconds": 5, "resolution": "720p", "reference_mode": "reference",
				"reference_image_urls": test.images, "reference_video_urls": test.videos, "reference_audio_urls": test.audios,
			})
			metadata, _ := got["metadata"].(map[string]any)
			for key, want := range test.want {
				if !reflect.DeepEqual(got[key], want) || !reflect.DeepEqual(metadata[key], want) {
					t.Fatalf("%s not mapped consistently: request=%#v metadata=%#v want=%#v", key, got[key], metadata[key], want)
				}
			}
		})
	}
}

func TestOfficialVideoRequestPayloadMapsSpecialProviderReferences(t *testing.T) {
	tests := []struct {
		name, model string
		images      []string
		videos      []string
		audios      []string
		want        map[string]any
	}{
		{
			name: "Kling motion", model: "kling-2.6/motion-control",
			images: []string{"https://cdn.example.com/character.png"}, videos: []string{"https://cdn.example.com/motion.mp4"},
			want: map[string]any{"input_urls": []string{"https://cdn.example.com/character.png"}, "video_urls": []string{"https://cdn.example.com/motion.mp4"}},
		},
		{
			name: "Kling omni transformation", model: "kling-3.0-omni/transformation",
			videos: []string{"https://cdn.example.com/source.mp4"},
			want:   map[string]any{"video_urls": []string{"https://cdn.example.com/source.mp4"}},
		},
		{
			name: "Gemini omni", model: "gemini-omni-video",
			images: []string{"https://cdn.example.com/style.png"}, videos: []string{"https://cdn.example.com/source.mp4"},
			want: map[string]any{"image_urls": []string{"https://cdn.example.com/style.png"}, "video_list": []map[string]any{{"url": "https://cdn.example.com/source.mp4", "start": 0, "ends": 10}}},
		},
		{
			name: "SkyReels", model: "skyreels-v4",
			images: []string{"https://cdn.example.com/style.png"}, videos: []string{"https://cdn.example.com/source.mp4"}, audios: []string{"https://cdn.example.com/voice.mp3"},
			want: map[string]any{
				"ref_images": []map[string]any{{"tag": "@image1", "type": "image", "image_urls": []string{"https://cdn.example.com/style.png"}, "audio_url": "https://cdn.example.com/voice.mp3"}},
				"ref_videos": []map[string]string{{"tag": "@video1", "type": "reference", "video_url": "https://cdn.example.com/source.mp4"}},
			},
		},
		{
			name: "Infinitalk", model: "infinitalk/from-audio",
			images: []string{"https://cdn.example.com/avatar.png"}, audios: []string{"https://cdn.example.com/voice.mp3"},
			want: map[string]any{"image_url": "https://cdn.example.com/avatar.png", "audio_url": "https://cdn.example.com/voice.mp3"},
		},
		{
			name: "Topaz video", model: "topaz/video-upscale",
			videos: []string{"https://cdn.example.com/source.mp4"},
			want:   map[string]any{"video_url": "https://cdn.example.com/source.mp4"},
		},
		{
			name: "Flux 3 video", model: "flux-3-video",
			images: []string{"https://cdn.example.com/style.png"}, videos: []string{"https://cdn.example.com/source.mp4"},
			want: map[string]any{"image_urls": []string{"https://cdn.example.com/style.png"}, "video_url": "https://cdn.example.com/source.mp4"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{
				"model": test.model, "prompt": "make a video", "seconds": 5, "size": "16:9", "resolution": "720p", "reference_mode": "reference",
				"reference_image_urls": test.images, "reference_video_urls": test.videos, "reference_audio_urls": test.audios,
			}
			got := officialVideoRequestPayload(payload)
			metadata, _ := got["metadata"].(map[string]any)
			for key, want := range test.want {
				if !reflect.DeepEqual(got[key], want) {
					t.Fatalf("%s = %#v, want %#v; payload=%#v", key, got[key], want, got)
				}
				if !isAPIMartVideoPayload(payload) && !reflect.DeepEqual(metadata[key], want) {
					t.Fatalf("%s not mapped into KIE metadata: metadata=%#v want=%#v", key, metadata[key], want)
				}
			}
			if isAPIMartVideoPayload(payload) {
				if _, ok := got["metadata"]; ok {
					t.Fatalf("APIMart request retained compatibility metadata: %#v", got)
				}
			}
		})
	}
}

func TestOfficialVideoRequestPayloadForwardsReferenceWorkbenchAudioControls(t *testing.T) {
	for _, model := range []string{"viduq3-pro", "viduq3-turbo", "pixverse-v6"} {
		got := officialVideoRequestPayload(map[string]any{
			"model": model, "prompt": "animate", "seconds": 5,
			"size": "16:9", "resolution": "720p", "generate_audio": true,
		})
		if got["audio"] != true {
			t.Fatalf("%s audio = %#v; payload=%#v", model, got["audio"], got)
		}
	}
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0-omni/transformation", "prompt": "transform", "seconds": 5,
		"generate_audio": true, "reference_video_urls": []string{"https://cdn.example.com/source.mp4"},
	})
	if got["audio"] != true {
		t.Fatalf("Kling Omni transformation audio = %#v; payload=%#v", got["audio"], got)
	}
}

func TestRelayVideoMultipartRequestUploadsInputReferenceFile(t *testing.T) {
	req, err := relayVideoMultipartRequest(
		context.Background(),
		"https://relay.example/",
		"sk-test",
		map[string]any{
			"model":           "MiniMax-H3",
			"prompt":          "make a video",
			"ratio":           "auto",
			"generation_mode": "legacy-client-value",
			"metadata":        map[string]any{"resolution": "768P"},
		},
		protocol.UploadedImage{Filename: "reference.png", ContentType: "image/png", Data: []byte("png-bytes")},
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

func TestRelayVideoSubmitConvertsDataURLToMultipart(t *testing.T) {
	imageData := httpTestAlphaPNGBytes(t, 256, 256)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/videos" {
			t.Errorf("upstream path = %q, want /v1/videos", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("Authorization = %q, want Bearer sk-test", got)
		}
		if err := r.ParseMultipartForm(int64(len(imageData)) + (1 << 20)); err != nil {
			t.Errorf("ParseMultipartForm() error = %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.FormValue("aspect_ratio") != "adaptive" || r.FormValue("generation_mode") != "" {
			t.Errorf("multipart form = %#v", r.MultipartForm.Value)
		}
		for _, field := range []string{"first_frame_url", "first_frame_image"} {
			if value := r.FormValue(field); value != "" {
				t.Errorf("multipart request leaked Base64 %s: %q", field, value)
			}
		}
		file, header, err := r.FormFile("input_reference")
		if err != nil {
			t.Errorf("FormFile(input_reference) error = %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		defer file.Close()
		got, err := io.ReadAll(file)
		if err != nil {
			t.Errorf("ReadAll(input_reference) error = %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !bytes.Equal(got, imageData) || header.Header.Get("Content-Type") != "image/png" {
			t.Errorf("input_reference bytes=%d content-type=%q", len(got), header.Header.Get("Content-Type"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"video-task-1","status":"queued"}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	request := officialVideoRequestPayload(map[string]any{
		"model":                "MiniMax-H3",
		"prompt":               "make a video",
		"seconds":              6,
		"size":                 "adaptive",
		"reference_image_urls": []string{"data:image/png;base64," + base64.StdEncoding.EncodeToString(imageData)},
	})
	result, err := app.relayVideoSubmit(context.Background(), "sk-test", request)
	if err != nil {
		t.Fatalf("relayVideoSubmit() error = %v", err)
	}
	if result["id"] != "video-task-1" {
		t.Fatalf("relayVideoSubmit() result = %#v", result)
	}
}

func TestRemoveMultipartVideoReferenceAliasesRejectsSecondInlineFrame(t *testing.T) {
	first := "data:image/png;base64,AAAA"
	request := map[string]any{
		"first_frame_image": first,
		"last_frame_image":  "data:image/png;base64,BBBB",
		"metadata": map[string]any{
			"first_frame_image": first,
			"last_frame_image":  "data:image/png;base64,BBBB",
		},
	}
	err := removeMultipartVideoReferenceAliases(request, first)
	if err == nil || !strings.Contains(err.Error(), "公网") {
		t.Fatalf("second inline frame error = %v, want public URL guidance", err)
	}
}

func TestValidateVideoReferenceImageUsesOfficialLimits(t *testing.T) {
	tests := []struct {
		name      string
		model     string
		size      string
		width     int
		height    int
		wantError bool
	}{
		{name: "minimax h3 minimum dimensions", model: "MiniMax-H3", width: 256, height: 256},
		{name: "minimax h3 rejects short edge", model: "MiniMax-H3", width: 255, height: 256, wantError: true},
		{name: "minimax h3 rejects extreme ratio", model: "MiniMax-H3", width: 256, height: 700, wantError: true},
		{name: "seedance accepts boundary ratio", model: "doubao-seedance-2-5-260628", width: 400, height: 1000},
		{name: "seedance rejects extreme ratio", model: "doubao-seedance-2-5-260628", width: 399, height: 1000, wantError: true},
		{name: "kling 3 minimum dimensions", model: "kling-v3", width: 300, height: 300},
		{name: "kling 3 rejects short edge", model: "kling-v3", width: 299, height: 300, wantError: true},
		{name: "kling 3 rejects extreme ratio", model: "kling-v3", width: 300, height: 751, wantError: true},
		{name: "sora matching size", model: "sora-2", size: "1280x720", width: 1280, height: 720},
		{name: "sora accepts a reference with a different output size", model: "sora-2", size: "1280x720", width: 720, height: 1280},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateVideoReferenceImage(test.model, test.size, httpTestAlphaPNGBytes(t, test.width, test.height))
			if (err != nil) != test.wantError {
				t.Fatalf("validateVideoReferenceImage() error = %v, wantError %v", err, test.wantError)
			}
		})
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

func TestRelayJSONPreservesEncodedRequestBody(t *testing.T) {
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
	result, err := app.relayJSON(context.Background(), http.MethodPost, "/v1/test", "sk-test", map[string]any{"prompt": "draw"})
	if err != nil {
		t.Fatalf("relayJSON() error = %v", err)
	}
	if result["ok"] != true {
		t.Fatalf("relayJSON() result = %#v", result)
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

func TestVideoErrorMessageSupportsUpstreamShapes(t *testing.T) {
	tests := []struct {
		state map[string]any
		want  string
	}{
		{state: map[string]any{"error": "provider unavailable"}, want: "provider unavailable"},
		{state: map[string]any{"detail": map[string]any{"error": map[string]any{"message": "content blocked"}}}, want: "content blocked"},
		{state: map[string]any{"last_error": map[string]any{"message": "polling failed"}}, want: "polling failed"},
		{state: map[string]any{"failure_reason": "invalid reference image"}, want: "invalid reference image"},
		{state: map[string]any{"message": `{"detail":"ratio must be 16:9"}`}, want: "ratio must be 16:9"},
		{state: map[string]any{"msg": "success", "data": map[string]any{"state": "failed", "failMsg": "provider rejected duration"}}, want: "provider rejected duration"},
		{state: map[string]any{"data": map[string]any{"status": "failed", "error": map[string]any{"message": "reference image is required"}}}, want: "reference image is required"},
	}
	for _, test := range tests {
		if got := videoErrorMessage(test.state); got != test.want {
			t.Errorf("videoErrorMessage(%#v) = %q, want %q", test.state, got, test.want)
		}
	}
}

func TestVideoRelayTaskStatusSupportsProviderShapes(t *testing.T) {
	tests := []struct {
		name  string
		state map[string]any
		want  string
	}{
		{name: "OpenAI", state: map[string]any{"status": "in_progress"}, want: "processing"},
		{name: "KIE", state: map[string]any{"code": 200, "data": map[string]any{"state": "success"}}, want: "completed"},
		{name: "APIMart", state: map[string]any{"data": map[string]any{"status": "cancelled"}}, want: "failed"},
		{name: "Metaso", state: map[string]any{"task": map[string]any{"status": "processing"}}, want: "processing"},
		{name: "nested JSON", state: map[string]any{"result": `{"task_status":"done"}`}, want: "completed"},
		{name: "URL implies completion", state: map[string]any{"data": map[string]any{"result": map[string]any{"videos": []any{map[string]any{"url": "https://cdn.example.com/out.mp4"}}}}}, want: "completed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := videoRelayTaskStatus(test.state); got != test.want {
				t.Fatalf("videoRelayTaskStatus(%#v) = %q, want %q", test.state, got, test.want)
			}
		})
	}
}

func TestVideoCreateTaskIDSupportsCurrentProviderShapes(t *testing.T) {
	tests := []struct {
		name    string
		created map[string]any
		want    string
	}{
		{name: "OpenAI id", created: map[string]any{"id": "video_openai"}, want: "video_openai"},
		{name: "task id", created: map[string]any{"task_id": "task_shared"}, want: "task_shared"},
		{name: "Agnes video id", created: map[string]any{"video_id": "video_agnes"}, want: "video_agnes"},
		{name: "KIE nested task", created: map[string]any{"data": map[string]any{"taskId": "task_kie"}}, want: "task_kie"},
		{name: "APIMart list", created: map[string]any{"data": []any{map[string]any{"task_id": "task_apimart"}}}, want: "task_apimart"},
		{name: "encoded provider response", created: map[string]any{"response": `{"videoId":"video_encoded"}`}, want: "video_encoded"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := videoCreateTaskID(test.created, 0); got != test.want {
				t.Fatalf("videoCreateTaskID(%#v) = %q, want %q", test.created, got, test.want)
			}
		})
	}
}

func TestVideoResultURLSupportsProviderShapes(t *testing.T) {
	baseURL := "https://relay.example"
	tests := []struct {
		name  string
		state map[string]any
		want  string
	}{
		{name: "KIE result JSON", state: map[string]any{"data": map[string]any{"resultJson": `{"resultUrls":["https://cdn.example.com/kie.mp4"]}`}}, want: "https://cdn.example.com/kie.mp4"},
		{name: "APIMart result", state: map[string]any{"data": map[string]any{"result": map[string]any{"videos": []any{map[string]any{"video_url": "https://cdn.example.com/apimart.mp4"}}}}}, want: "https://cdn.example.com/apimart.mp4"},
		{name: "Gemini operation", state: map[string]any{"response": map[string]any{"generateVideoResponse": map[string]any{"generatedVideos": []any{map[string]any{"video": map[string]any{"uri": "https://cdn.example.com/veo.mp4"}}}}}}, want: "https://cdn.example.com/veo.mp4"},
		{name: "relative metadata URL", state: map[string]any{"metadata": map[string]any{"url": "/v1/videos/task/content"}}, want: "https://relay.example/v1/videos/task/content"},
		{name: "content fallback", state: map[string]any{"status": "completed"}, want: "https://relay.example/v1/videos/public-task/content"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := videoResultURL(test.state, baseURL, "public-task"); got != test.want {
				t.Fatalf("videoResultURL(%#v) = %q, want %q", test.state, got, test.want)
			}
		})
	}
}

func TestRelayVideoTaskHandlesNestedKIEResponse(t *testing.T) {
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
			_, _ = w.Write([]byte(`{"id":"public-task","status":"queued"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/public-task":
			_, _ = w.Write([]byte(`{"code":200,"msg":"success","data":{"taskId":"upstream-task","state":"success","resultJson":"{\"resultUrls\":[\"https://cdn.example.com/generated.mp4\"]}"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, err := app.relayVideoTask(context.Background(), map[string]any{
		"api_key": "sk-test", "model": "minimax-h3/text-to-video", "prompt": "animate",
		"seconds": 6, "size": "16:9", "resolution": "768P",
	})
	if err != nil {
		t.Fatalf("relayVideoTask() error = %v", err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["url"] != "https://cdn.example.com/generated.mp4" {
		t.Fatalf("relayVideoTask() result = %#v", result)
	}
	if requestCount != 2 {
		t.Fatalf("request count = %d, want 2", requestCount)
	}
}

func TestRelayVideoTaskHandlesNestedAPIMartFailure(t *testing.T) {
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
			_, _ = w.Write([]byte(`{"id":"public-task","status":"queued"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/public-task":
			_, _ = w.Write([]byte(`{"code":200,"message":"success","data":{"id":"upstream-task","status":"failed","error":{"message":"reference image is required"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, err := app.relayVideoTask(context.Background(), map[string]any{
		"api_key": "sk-test", "model": "minimax-h3", "provider": "apimart",
		"prompt": "animate", "seconds": 6, "size": "16:9", "resolution": "768P",
	})
	if err == nil || !strings.Contains(err.Error(), "reference image is required") {
		t.Fatalf("relayVideoTask() result=%#v error=%v", result, err)
	}
	if requestCount != 2 {
		t.Fatalf("request count = %d, want 2", requestCount)
	}
}

func TestRelayVideoTaskRejectsFailedCreateResponseWithTaskID(t *testing.T) {
	requestCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost || r.URL.Path != "/v1/videos" {
			t.Errorf("unexpected relay request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"id":"provider-task","status":"failed","error":{"message":"property generation_mode should not exist"}}`))
	}))
	defer upstream.Close()

	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
		t.Fatalf("update relay URL: %v", err)
	}
	result, err := app.relayVideoTask(context.Background(), map[string]any{
		"api_key": "sk-test", "model": "minimax-h3", "provider": "apimart",
		"prompt": "animate", "seconds": 6, "size": "16:9", "resolution": "768P",
	})
	if err == nil || !strings.Contains(err.Error(), "property generation_mode should not exist") {
		t.Fatalf("relayVideoTask() result=%#v error=%v", result, err)
	}
	if requestCount != 1 {
		t.Fatalf("request count = %d, want create request only", requestCount)
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

func TestOfficialVideoRequestPayloadMapsReferenceProjectKIEUtilityModels(t *testing.T) {
	tests := []struct {
		name   string
		model  string
		images []string
		videos []string
		audios []string
		want   map[string]any
		absent []string
	}{
		{name: "wan speech", model: "wan/2-2-a14b-speech-to-video-turbo", images: []string{"https://cdn.example.com/face.png"}, audios: []string{"https://cdn.example.com/voice.mp3"}, want: map[string]any{"image_url": "https://cdn.example.com/face.png", "audio_url": "https://cdn.example.com/voice.mp3"}},
		{name: "wan animate", model: "wan/2-2-animate-move", images: []string{"https://cdn.example.com/subject.png"}, videos: []string{"https://cdn.example.com/motion.mp4"}, want: map[string]any{"image_url": "https://cdn.example.com/subject.png", "video_url": "https://cdn.example.com/motion.mp4"}},
		{name: "kling avatar", model: "kling/ai-avatar-pro", images: []string{"https://cdn.example.com/avatar.png"}, audios: []string{"https://cdn.example.com/speech.mp3"}, want: map[string]any{"image_url": "https://cdn.example.com/avatar.png", "audio_url": "https://cdn.example.com/speech.mp3"}, absent: []string{"duration", "seconds", "size", "resolution"}},
		{name: "topaz", model: "topaz/video-upscale", videos: []string{"https://cdn.example.com/source.mp4"}, want: map[string]any{"video_url": "https://cdn.example.com/source.mp4"}, absent: []string{"duration", "seconds", "size", "resolution"}},
		{name: "infinitalk", model: "infinitalk/from-audio", images: []string{"https://cdn.example.com/portrait.png"}, audios: []string{"https://cdn.example.com/voice.mp3"}, want: map[string]any{"image_url": "https://cdn.example.com/portrait.png", "audio_url": "https://cdn.example.com/voice.mp3"}, absent: []string{"duration", "seconds", "size"}},
		{name: "grok image video", model: "grok-imagine/image-to-video", images: []string{"https://cdn.example.com/frame.png"}, want: map[string]any{"image_urls": []string{"https://cdn.example.com/frame.png"}, "mode": "normal"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{"model": test.model, "prompt": "animate", "seconds": 5, "size": "16:9", "resolution": "720p", "reference_mode": "reference", "reference_image_urls": test.images, "reference_video_urls": test.videos, "reference_audio_urls": test.audios})
			metadata, _ := got["metadata"].(map[string]any)
			for key, want := range test.want {
				if !reflect.DeepEqual(metadata[key], want) && !reflect.DeepEqual(got[key], want) {
					t.Errorf("%s = %#v, want %#v; payload=%#v", key, metadata[key], want, got)
				}
			}
			for _, key := range test.absent {
				if _, ok := got[key]; ok {
					t.Errorf("unexpected %s in payload: %#v", key, got)
				}
			}
		})
	}
}

func TestOfficialVideoRequestPayloadForwardsKIEGrokMode(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "grok-imagine/text-to-video", "prompt": "animate", "seconds": 30,
		"size": "16:9", "resolution": "1080p", "video_mode": "spicy",
	})
	if got["mode"] != "spicy" {
		t.Fatalf("mode = %#v, want spicy; payload=%#v", got["mode"], got)
	}
}

func TestOfficialVideoRequestPayloadMapsKIEGrokImageReferences(t *testing.T) {
	images := make([]string, 10)
	for index := range images {
		images[index] = fmt.Sprintf("https://cdn.example.com/grok-%d.png", index)
	}
	got := officialVideoRequestPayload(map[string]any{
		"model": "grok-imagine/image-to-video", "prompt": "animate", "seconds": 8,
		"size": "16:9", "resolution": "1080p", "reference_image_urls": images,
	})
	metadata, _ := got["metadata"].(map[string]any)
	refs, _ := metadata["image_urls"].([]string)
	if len(refs) != 9 {
		t.Fatalf("image_urls length = %d, want 9; payload=%#v", len(refs), got)
	}
}

func TestOfficialVideoRequestPayloadUsesModelSpecificReferenceFields(t *testing.T) {
	image := "https://cdn.example.com/frame.png"
	video := "https://cdn.example.com/source.mp4"
	audio := "https://cdn.example.com/voice.mp3"

	h3Image := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3/image-to-video", "prompt": "animate", "seconds": 5,
		"size": "16:9", "resolution": "768P", "reference_image_urls": []string{image, "https://cdn.example.com/last.png"},
	})
	if h3Image["first_frame_url"] != image || h3Image["last_frame_url"] != "https://cdn.example.com/last.png" || h3Image["aspect_ratio"] != nil {
		t.Fatalf("MiniMax H3 image payload = %#v", h3Image)
	}
	if _, ok := h3Image["generation_mode"]; ok {
		t.Fatalf("MiniMax H3 image payload leaked generation_mode: %#v", h3Image)
	}

	h3Reference := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3/reference-to-video", "prompt": "animate", "seconds": 5,
		"size": "16:9", "resolution": "768P", "reference_mode": "first-frame",
		"reference_image_urls": []string{image}, "reference_video_urls": []string{video},
		"reference_audio_urls": []string{audio},
	})
	if h3Reference["first_frame_url"] != nil {
		t.Fatalf("MiniMax H3 reference payload = %#v", h3Reference)
	}
	if _, ok := h3Reference["generation_mode"]; ok {
		t.Fatalf("MiniMax H3 reference payload leaked generation_mode: %#v", h3Reference)
	}
	if refs, _ := h3Reference["reference_image_urls"].([]string); len(refs) != 1 {
		t.Fatalf("MiniMax H3 reference images = %#v", h3Reference)
	}

	happyHorse := officialVideoRequestPayload(map[string]any{
		"model": "happyhorse/image-to-video", "prompt": "animate", "seconds": 5,
		"reference_image_urls": []string{image, "https://cdn.example.com/second.png"},
	})
	if refs, _ := happyHorse["image_urls"].([]string); len(refs) != 2 {
		t.Fatalf("HappyHorse image references = %#v", happyHorse)
	}

	gemini := officialVideoRequestPayload(map[string]any{
		"model": "gemini-omni-video", "prompt": "animate", "seconds": 6,
		"reference_audio_urls": []string{audio},
	})
	if _, ok := gemini["audio_ids"]; ok {
		t.Fatalf("Gemini Omni must not map public audio URLs to audio_ids: %#v", gemini)
	}
}

func TestOfficialVideoRequestPayloadNormalizesStaleReferenceModeForImageModels(t *testing.T) {
	image := "https://cdn.example.com/frame.png"
	got := officialVideoRequestPayload(map[string]any{
		"model": "sora-2", "prompt": "animate", "seconds": 8,
		"reference_mode": "reference", "reference_image_urls": []string{image},
	})
	if !reflect.DeepEqual(got["image_urls"], []string{image}) {
		t.Fatalf("Sora image reference = %#v, payload=%#v", got["image_urls"], got)
	}
	if _, ok := got["referenceImages"]; ok {
		t.Fatalf("Sora retained multimodal reference metadata: %#v", got)
	}
}

func TestOfficialVideoRequestPayloadOmitsDurationForGeminiOmniFlashPreview(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "gemini-omni-flash-preview", "prompt": "animate", "seconds": 8,
		"size": "16:9", "resolution": "720p",
	})
	if _, ok := got["seconds"]; ok {
		t.Fatalf("Gemini Omni Flash leaked compatibility seconds: %#v", got)
	}
	if _, ok := got["duration"]; ok {
		t.Fatalf("Gemini Omni Flash leaked unsupported duration: %#v", got)
	}
	if got["aspect_ratio"] != "16:9" || got["resolution"] != "720p" {
		t.Fatalf("Gemini Omni Flash controls = %#v", got)
	}

	kie := officialVideoRequestPayload(map[string]any{
		"model": "gemini-omni-video", "prompt": "animate", "seconds": 8,
	})
	if kie["duration"] != "8" {
		t.Fatalf("KIE Gemini Omni duration = %#v, want string 8; payload=%#v", kie["duration"], kie)
	}
}

func TestOfficialVideoRequestPayloadOmitsDurationForOmniFlashExtVideoReference(t *testing.T) {
	video := "https://cdn.example.com/source.mp4"
	withVideo := officialVideoRequestPayload(map[string]any{
		"model": "omni-flash-ext", "prompt": "restyle", "seconds": 8,
		"reference_video_urls": []string{video},
	})
	for _, key := range []string{"duration", "seconds"} {
		if _, ok := withVideo[key]; ok {
			t.Fatalf("Omni Flash Ext retained %s with a video reference: %#v", key, withVideo)
		}
	}
	if !reflect.DeepEqual(withVideo["video_urls"], []string{video}) {
		t.Fatalf("Omni Flash Ext video_urls = %#v, payload=%#v", withVideo["video_urls"], withVideo)
	}
	if _, ok := withVideo["metadata"]; ok {
		t.Fatalf("APIMart Omni Flash Ext retained compatibility metadata: %#v", withVideo)
	}

	textOnly := officialVideoRequestPayload(map[string]any{
		"model": "omni-flash-ext", "prompt": "animate", "seconds": 8,
	})
	if textOnly["duration"] != 8 {
		t.Fatalf("Omni Flash Ext text duration = %#v, payload=%#v", textOnly["duration"], textOnly)
	}
}

func TestOfficialVideoRequestPayloadUsesAPIMartVeoAudioField(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "veo3.1-official", "prompt": "animate", "seconds": 8,
		"generate_audio": true,
	})
	if got["generate_audio"] != true {
		t.Fatalf("APIMart Veo generate_audio = %#v, payload=%#v", got["generate_audio"], got)
	}
	if _, ok := got["metadata"]; ok {
		t.Fatalf("APIMart Veo retained compatibility metadata: %#v", got)
	}
}

func TestOfficialVideoRequestPayloadNormalizesVeoResolution(t *testing.T) {
	for _, test := range []struct {
		model, resolution, want string
	}{
		{"veo-3.1-generate-preview", "1440p", "720p"},
		{"veo-3.1-generate-preview", "2k", "1080p"},
		{"veo-3.1-generate-preview", "4k", "4k"},
		{"veo-3-generate-preview", "4k", "1080p"},
	} {
		t.Run(test.model+"/"+test.resolution, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": test.model, "prompt": "animate", "seconds": 8, "resolution": test.resolution,
			})
			metadata, _ := got["metadata"].(map[string]any)
			if metadata["resolution"] != test.want {
				t.Fatalf("resolution = %#v, want %q; payload=%#v", metadata["resolution"], test.want, got)
			}
		})
	}
}

func TestOfficialVideoRequestPayloadMapsAPIMartKlingOmniReferences(t *testing.T) {
	images := []string{"https://cdn.example.com/character.png"}
	videos := []string{"https://cdn.example.com/source.mp4"}
	wantVideos := []map[string]string{{
		"video_url": videos[0], "refer_type": "base", "keep_original_sound": "no",
	}}
	for _, model := range []string{"kling-v3-omni", "kling-video-o1"} {
		t.Run(model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": model, "prompt": "follow the references", "seconds": 5,
				"reference_image_urls": images, "reference_video_urls": videos,
			})
			if !reflect.DeepEqual(got["image_urls"], images) {
				t.Fatalf("%s image references were not mapped: %#v", model, got)
			}
			if !reflect.DeepEqual(got["video_list"], wantVideos) {
				t.Fatalf("%s video references were not mapped: %#v", model, got)
			}
			if _, ok := got["metadata"]; ok {
				t.Fatalf("APIMart Kling Omni retained compatibility metadata: %#v", got)
			}
		})
	}
}

func TestOfficialVideoRequestPayloadMapsKlingMotionControlModes(t *testing.T) {
	base := map[string]any{
		"prompt": "follow motion", "seconds": 5,
		"reference_image_urls": []string{"https://cdn.example.com/character.png"},
		"reference_video_urls": []string{"https://cdn.example.com/motion.mp4"},
	}
	tests := []struct {
		model, resolution, want string
	}{
		{"kling-v3-motion-control", "720p", "std"},
		{"kling-v3-motion-control", "1080p", "pro"},
		{"kling-3.0/motion-control", "720p", "720p"},
		{"kling-3.0/motion-control", "1080p", "1080p"},
	}
	for _, test := range tests {
		t.Run(test.model+"/"+test.resolution, func(t *testing.T) {
			payload := make(map[string]any, len(base)+2)
			for key, value := range base {
				payload[key] = value
			}
			payload["model"] = test.model
			payload["resolution"] = test.resolution
			got := officialVideoRequestPayload(payload)
			if got["mode"] != test.want {
				t.Fatalf("mode = %#v, want %q; payload=%#v", got["mode"], test.want, got)
			}
			if _, ok := got["duration"]; ok {
				t.Fatalf("motion control retained duration: %#v", got)
			}
		})
	}
}

func TestGeminiOmniPublicAudioIsRejectedBeforeRelay(t *testing.T) {
	if !isGeminiOmniVideoModel("gemini-omni-video") || !isGeminiOmniVideoModel("omni-flash-ext") {
		t.Fatal("Gemini Omni model detection should include KIE and APIMart variants")
	}
	if isGeminiOmniVideoModel("kling-v3") {
		t.Fatal("Kling must not be classified as Gemini Omni")
	}
}

func TestOfficialVideoRequestPayloadKeepsSoraAndAPIMartHappyHorseImages(t *testing.T) {
	image := "https://cdn.example.com/frame.png"
	sora := officialVideoRequestPayload(map[string]any{
		"model": "sora-2", "prompt": "animate", "seconds": 4,
		"size": "1280x720", "reference_image_urls": []string{image},
	})
	if !reflect.DeepEqual(sora["image_urls"], []string{image}) {
		t.Fatalf("Sora reference image was discarded: %#v", sora)
	}

	grok := officialVideoRequestPayload(map[string]any{
		"model": "grok-imagine-video-1.5", "prompt": "animate", "seconds": 6,
		"size": "16:9", "resolution": "1080p", "reference_image_urls": []string{image},
	})
	grokImage, _ := grok["image"].(map[string]any)
	if grokImage["url"] != image {
		t.Fatalf("Grok 1.5 reference image was discarded: %#v", grok)
	}
	if _, ok := grok["image_urls"]; ok {
		t.Fatalf("Grok2API request leaked KIE image_urls: %#v", grok)
	}

	grokMulti := officialVideoRequestPayload(map[string]any{
		"model": "grok-imagine-video", "prompt": "animate", "seconds": 6,
		"size": "16:9", "resolution": "720p", "reference_image_urls": []string{image, "https://cdn.example.com/second.png"},
	})
	wantGrokMulti := []map[string]any{{"url": image}, {"url": "https://cdn.example.com/second.png"}}
	if !reflect.DeepEqual(grokMulti["reference_images"], wantGrokMulti) {
		t.Fatalf("Grok2API reference_images = %#v, want %#v; payload=%#v", grokMulti["reference_images"], wantGrokMulti, grokMulti)
	}

	happyHorse := officialVideoRequestPayload(map[string]any{
		"model": "happyhorse-1-1", "prompt": "", "seconds": 5,
		"size": "16:9", "resolution": "720p", "reference_image_urls": []string{image},
	})
	refs, _ := happyHorse["image_urls"].([]string)
	if len(refs) != 1 || refs[0] != image || happyHorse["size"] != "16:9" || happyHorse["resolution"] != "720P" {
		t.Fatalf("HappyHorse 1.1 APIMart payload = %#v", happyHorse)
	}
}

func TestOfficialVideoRequestPayloadMapsNamedAndTailFrames(t *testing.T) {
	first := "https://cdn.example.com/first.png"
	last := "https://cdn.example.com/last.png"
	tests := []struct {
		model, firstField, lastField string
	}{
		{"bytedance/v1-lite-image-to-video", "image_url", "end_image_url"},
		{"hailuo/02-image-to-video-standard", "image_url", "end_image_url"},
		{"wan/2-7-image-to-video", "first_frame_url", "last_frame_url"},
		{"kling/v2-1-pro", "image_url", "tail_image_url"},
	}
	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": tt.model, "prompt": "animate", "seconds": 5,
				"reference_mode": "first-frame", "reference_image_urls": []string{first, last},
			})
			if got[tt.firstField] != first || got[tt.lastField] != last {
				t.Fatalf("frame fields not mapped: %#v", got)
			}
		})
	}
	seedance := officialVideoRequestPayload(map[string]any{
		"model": "bytedance/seedance-2", "prompt": "animate", "seconds": 5,
		"reference_mode": "first-frame", "reference_image_urls": []string{first, last},
	})
	if _, ok := seedance["first_frame_url"]; ok {
		t.Fatalf("Seedance 2 leaked first_frame_url: %#v", seedance)
	}
	if _, ok := seedance["last_frame_url"]; ok {
		t.Fatalf("Seedance 2 leaked last_frame_url: %#v", seedance)
	}
	if refs, ok := seedance["reference_image_urls"].([]string); !ok || len(refs) != 2 {
		t.Fatalf("Seedance 2 reference_image_urls = %#v", seedance["reference_image_urls"])
	}
}

func TestOfficialVideoRequestPayloadKeepsKling30Images(t *testing.T) {
	images := []string{"https://cdn.example.com/first.png", "https://cdn.example.com/second.png"}
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0/video", "prompt": "animate", "seconds": 5,
		"reference_image_urls": images,
	})
	if !reflect.DeepEqual(got["image_urls"], images) {
		t.Fatalf("Kling 3.0 image_urls = %#v, want %#v; payload=%#v", got["image_urls"], images, got)
	}
}

func TestOfficialVideoRequestPayloadMapsAPIMartKling30Turbo(t *testing.T) {
	image := "https://cdn.example.com/frame.png"
	withImage := officialVideoRequestPayload(map[string]any{
		"model": "kling-3-0-turbo", "prompt": "animate", "seconds": 17,
		"size": "1536x864", "resolution": "1440p",
		"reference_image_urls": []string{image, "https://cdn.example.com/ignored.png"},
		"negative_prompt":      "blur", "multi_shot": true, "generate_audio": true,
	})
	if withImage["first_frame_image"] != image {
		t.Fatalf("Kling 3.0 Turbo first frame = %#v; payload=%#v", withImage["first_frame_image"], withImage)
	}
	for _, key := range []string{"size", "aspect_ratio", "image_tail", "negative_prompt", "multi_shot", "sound"} {
		if _, ok := withImage[key]; ok {
			t.Fatalf("Kling 3.0 Turbo retained unsupported %s: %#v", key, withImage)
		}
	}

	textOnly := officialVideoRequestPayload(map[string]any{
		"model": "kling-3-0-turbo", "prompt": "animate", "seconds": 17,
		"size": "1536x864", "resolution": "1440p",
	})
	for key, want := range map[string]any{"duration": 17, "aspect_ratio": "16:9", "resolution": "1440p"} {
		if !reflect.DeepEqual(textOnly[key], want) {
			t.Fatalf("%s = %#v, want %#v; payload=%#v", key, textOnly[key], want, textOnly)
		}
	}
}

func TestOfficialVideoRequestPayloadUsesExplicitKlingMode(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0/video", "prompt": "animate", "seconds": 5,
		"resolution": "720p", "video_mode": "4k",
	})
	if got["mode"] != "4K" {
		t.Fatalf("Kling mode = %#v, want 4K; payload=%#v", got["mode"], got)
	}
}

func TestOfficialVideoRequestPayloadPreservesKIEKlingTurboWorkbenchControls(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling/v3-turbo-text-to-video", "prompt": "animate", "seconds": 17,
		"size": "16:9", "resolution": "1440p",
	})
	for key, want := range map[string]any{"duration": "17", "aspect_ratio": "16:9", "resolution": "1440p"} {
		if !reflect.DeepEqual(got[key], want) {
			t.Fatalf("%s = %#v, want %#v; payload=%#v", key, got[key], want, got)
		}
	}
}

func TestOfficialVideoRequestPayloadMapsKIEKling26Controls(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-2.6/text-to-video", "prompt": "animate", "seconds": 17,
		"size": "1536x864", "resolution": "1440p", "generate_audio": true,
	})
	for key, want := range map[string]any{"duration": "17", "aspect_ratio": "16:9", "sound": true} {
		if !reflect.DeepEqual(got[key], want) {
			t.Fatalf("%s = %#v, want %#v; payload=%#v", key, got[key], want, got)
		}
	}
}

func TestOfficialVideoRequestPayloadOmitsKIEHailuoTextOnlyControls(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "hailuo/02-text-to-video-standard", "prompt": "animate", "seconds": 5,
	})
	if _, ok := got["ratio"]; ok {
		t.Fatalf("Hailuo text payload retained ratio: %#v", got)
	}
	if _, ok := got["resolution"]; ok {
		t.Fatalf("Hailuo text payload retained resolution: %#v", got)
	}
}

func TestOfficialVideoRequestPayloadKeepsWan25AndWan26Duration(t *testing.T) {
	for _, model := range []string{"wan/2-5-image-to-video", "wan/2-6-image-to-video"} {
		got := officialVideoRequestPayload(map[string]any{
			"model": model, "prompt": "animate", "seconds": 10,
			"resolution": "720p", "reference_image_urls": []string{"https://cdn.example.com/frame.png"},
		})
		if got["duration"] != "10" {
			t.Fatalf("%s duration = %#v, want string 10; payload=%#v", model, got["duration"], got)
		}
	}
	got := officialVideoRequestPayload(map[string]any{
		"model": "wan/2-2-a14b-image-to-video-turbo", "prompt": "animate", "seconds": 10,
		"resolution": "720p", "reference_image_urls": []string{"https://cdn.example.com/frame.png"},
	})
	if _, ok := got["duration"]; ok {
		t.Fatalf("Wan 2.2 retained unsupported duration: %#v", got)
	}
}

func TestOfficialVideoRequestPayloadKeepsNativeWanImageResolution(t *testing.T) {
	for _, model := range []string{"wan2-5-image-to-video", "wan2-6-i2v-flash"} {
		t.Run(model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": model, "prompt": "animate", "seconds": 10,
				"resolution": "1080p", "reference_image_urls": []string{"https://cdn.example.com/frame.png"},
			})
			if got["resolution"] != "1080p" {
				t.Fatalf("%s resolution = %#v, payload=%#v", model, got["resolution"], got)
			}
			if got["size"] != nil {
				t.Fatalf("%s used size for resolution: %#v", model, got)
			}
		})
	}
}

func TestOfficialVideoRequestPayloadUsesWan27KIENamedFrames(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "wan/2-7-image-to-video", "prompt": "animate", "seconds": 10,
		"resolution": "1080p", "reference_image_urls": []string{"https://cdn.example.com/first.png", "https://cdn.example.com/ignored-tail.png"},
	})
	metadata, _ := got["metadata"].(map[string]any)
	if metadata["first_frame_url"] != "https://cdn.example.com/first.png" {
		t.Fatalf("Wan 2.7 KIE first frame = %#v, payload=%#v", metadata["first_frame_url"], got)
	}
	if metadata["last_frame_url"] != "https://cdn.example.com/ignored-tail.png" {
		t.Fatalf("Wan 2.7 KIE last frame = %#v, payload=%#v", metadata["last_frame_url"], got)
	}
}

func TestOfficialVideoRequestPayloadMapsNativeWanAudioReference(t *testing.T) {
	audio := "https://cdn.example.com/voice.mp3"
	for _, model := range []string{"wan2-5-image-to-video", "wan2-6-i2v-flash"} {
		t.Run(model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": model, "prompt": "animate", "seconds": 10,
				"reference_image_urls": []string{"https://cdn.example.com/frame.png"},
				"reference_audio_urls": []string{audio},
			})
			if got["audio_url"] != audio {
				t.Fatalf("%s audio_url = %#v, payload=%#v", model, got["audio_url"], got)
			}
			if _, ok := got["metadata"]; ok {
				t.Fatalf("APIMart Wan retained compatibility metadata: %#v", got)
			}
		})
	}
}

func TestOfficialVideoRequestPayloadMapsNativeWan27VideoReference(t *testing.T) {
	video := "https://cdn.example.com/source.mp4"
	got := officialVideoRequestPayload(map[string]any{
		"model": "wan2.7-i2v-plus", "prompt": "animate", "seconds": 10,
		"reference_image_urls": []string{"https://cdn.example.com/frame.png"},
		"reference_video_urls": []string{video},
	})
	if !reflect.DeepEqual(got["video_urls"], []string{video}) {
		t.Fatalf("Wan 2.7 video_urls = %#v, payload=%#v", got["video_urls"], got)
	}
	if _, ok := got["metadata"]; ok {
		t.Fatalf("APIMart Wan 2.7 retained compatibility metadata: %#v", got)
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
