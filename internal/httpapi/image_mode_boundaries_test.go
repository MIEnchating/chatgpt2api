package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

type imageModeTestTransport func(*http.Request) (*http.Response, error)

func (f imageModeTestTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestImageAPIModesKeepCustomEndpointCredentials(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	var defaultRequests atomic.Int32
	defaultRelay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defaultRequests.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer defaultRelay.Close()
	if _, err := app.config.Update(map[string]any{"relay_base_url": defaultRelay.URL}); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"responses", "chat"} {
		t.Run(mode, func(t *testing.T) {
			requests := 0
			app.newSafeRelayHTTPClient = func(timeout time.Duration) *http.Client {
				return &http.Client{Timeout: timeout, Transport: imageModeTestTransport(func(r *http.Request) (*http.Response, error) {
					requests++
					wantPath := "/v1/responses"
					if mode == "chat" {
						wantPath = "/v1/chat/completions"
					}
					if r.URL.Host != "custom.example" || r.URL.Path != wantPath || r.Header.Get("Authorization") != "Bearer custom-key" {
						t.Errorf("custom image request = %s, authorization = %q", r.URL, r.Header.Get("Authorization"))
					}
					var request map[string]any
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Fatal(err)
					}
					for _, key := range []string{"api_key", "relay_base_url", relayCustomEndpointPayloadKey} {
						if _, present := request[key]; present {
							t.Errorf("internal field leaked into request: %s", key)
						}
					}
					body := `{"output":[{"type":"image_generation_call","result":"aW1hZ2U="}]}`
					if mode == "chat" {
						body = `{"choices":[{"message":{"images":[{"image_url":{"url":"https://media.example/image.png"}}]}}]}`
					}
					return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
				})}
			}
			result, err := app.relayImageCreationTask(context.Background(), map[string]any{
				"api_mode": mode, "api_key": "custom-key", "relay_base_url": "https://custom.example",
				relayCustomEndpointPayloadKey: true, "model": "gpt-image-2", "prompt": "draw",
			}, nil, false)
			if err != nil || len(util.AsMapSlice(result["data"])) != 1 || requests != 1 {
				t.Fatalf("custom image requests = %d, result = %#v, error = %v", requests, result, err)
			}
		})
	}
	if defaultRequests.Load() != 0 {
		t.Fatalf("custom credentials were sent to default relay %d times", defaultRequests.Load())
	}
}

func TestCustomImageLocalizationRetainsSafeNetworkPolicy(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	var unsafeRequests atomic.Int32
	image := httpTestPNGBytes(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		unsafeRequests.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(image)
	}))
	defer upstream.Close()
	blocked := errors.New("custom media target is blocked")
	app.newSafeRelayHTTPClient = func(timeout time.Duration) *http.Client {
		return &http.Client{Timeout: timeout, Transport: imageModeTestTransport(func(r *http.Request) (*http.Response, error) {
			return nil, blocked
		})}
	}
	result := map[string]any{"data": []map[string]any{{"url": upstream.URL + "/image.png"}}}
	err := app.localizeRelayImageResult(context.Background(), service.Identity{ID: "owner"}, result, map[string]any{relayCustomEndpointPayloadKey: true})
	if !errors.Is(err, blocked) || unsafeRequests.Load() != 0 {
		t.Fatalf("localization error = %v, unsafe requests = %d", err, unsafeRequests.Load())
	}
}

func TestMultipartImageEditPreservesModeAndTaskMetadata(t *testing.T) {
	for _, mode := range []string{"images", "responses", "chat", "invalid-mode"} {
		t.Run(mode, func(t *testing.T) {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			fields := map[string]string{"api_mode": mode, "generation_source": service.ImageGenerationSourceCanvas, "frontend_conversation_id": "conversation-1"}
			for key, value := range fields {
				if err := writer.WriteField(key, value); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-edits", &body)
			request.Header.Set("Content-Type", writer.FormDataContentType())
			parsed, _, err := readMultipartImageBody(httptest.NewRecorder(), request)
			if err != nil {
				t.Fatal(err)
			}
			for key, value := range fields {
				if parsed[key] != value {
					t.Errorf("parsed %s = %#v, want %q", key, parsed[key], value)
				}
			}
		})
	}
}

func TestImageTaskCountValidatedBeforeProviderNormalization(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	for _, model := range []string{"bytedance/seedream-v4-text-to-image", "seedream-4-5", "seedream-5-0-pro"} {
		for _, count := range []string{"1.5", "-1", "99999"} {
			for _, edit := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/edit=%v", model, count, edit), func(t *testing.T) {
					request := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(fmt.Sprintf(`{"model":%q,"prompt":"draw","n":%s}`, model, count)))
					if edit {
						var body bytes.Buffer
						writer := multipart.NewWriter(&body)
						for key, value := range map[string]string{"model": model, "prompt": "edit", "n": count} {
							if err := writer.WriteField(key, value); err != nil {
								t.Fatal(err)
							}
						}
						if err := writer.Close(); err != nil {
							t.Fatal(err)
						}
						request = httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-edits", &body)
						request.Header.Set("Content-Type", writer.FormDataContentType())
					}
					setRequestAuthCookie(request, token)
					response := httptest.NewRecorder()
					app.Handler().ServeHTTP(response, request)
					if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), protocolImageCountRangeMessage()) {
						t.Fatalf("count validation = %d %s", response.Code, response.Body.String())
					}
				})
			}
		}
	}
}

func TestImageTaskPreservesCountForProviderNativeCountField(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	identity := app.auth.Authenticate(token)
	custom, err := app.customRelayConfigs.Create(identityScope(*identity), "image", "count test", "https://custom.example", "test-key", "openai")
	if err != nil {
		t.Fatal(err)
	}
	model := "bytedance/seedream-v4-text-to-image"
	if _, err := app.config.Update(map[string]any{"image_models": []string{model}}); err != nil {
		t.Fatal(err)
	}
	app.newSafeRelayHTTPClient = func(timeout time.Duration) *http.Client {
		return &http.Client{Timeout: timeout, Transport: imageModeTestTransport(func(r *http.Request) (*http.Response, error) {
			return nil, errors.New("test intentionally ends before contacting upstream")
		})}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(fmt.Sprintf(`{"client_task_id":"count-test","model":%q,"prompt":"draw","n":3,"token_name":%q}`, model, custom.TokenName)))
	setRequestAuthCookie(request, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	var task map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || util.ToInt(task["count"], 0) != 3 {
		t.Fatalf("task count = %d %s", response.Code, response.Body.String())
	}
}
