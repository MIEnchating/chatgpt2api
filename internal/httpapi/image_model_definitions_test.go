package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestConfiguredImageAliasesUseDeclaredProtocol(t *testing.T) {
	for _, adapter := range []string{"google-gemini-image", "xai-image", "openai-image"} {
		for _, edit := range []bool{false, true} {
			t.Run(adapter+map[bool]string{false: "/generate", true: "/edit"}[edit], func(t *testing.T) {
				unsetTestEnv(t, "IMAGE_MODEL_DEFINITIONS")
				// A name recognized by another built-in adapter must still obey configuration.
				const alias = "nano-banana-pro"
				definition := model.ImageModelDefinition{
					Protocol: adapter, AspectRatios: []string{"1:1", "4:1"}, Resolutions: []string{"4k"},
					QualityValues: []string{}, MaxReferenceImages: 2, MaxOutputCount: 3,
				}
				imageData := httpTestPNGBytes(t)
				encoded := base64.StdEncoding.EncodeToString(imageData)
				var calls atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					expectedPath := "/v1/images/generations"
					if edit {
						expectedPath = "/v1/images/edits"
					}
					if adapter == "google-gemini-image" {
						expectedPath = "/v1/chat/completions"
					}
					if r.Method != http.MethodPost || r.URL.Path != expectedPath {
						t.Errorf("upstream = %s %s, want POST %s", r.Method, r.URL.Path, expectedPath)
					}
					body := map[string]any{}
					if adapter == "openai-image" && edit {
						if err := r.ParseMultipartForm(1 << 20); err != nil {
							t.Error(err)
							return
						}
						defer r.MultipartForm.RemoveAll()
						for key, values := range r.MultipartForm.Value {
							body[key] = values[0]
						}
						if len(r.MultipartForm.File) == 0 {
							t.Error("missing multipart reference image")
						}
					} else if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					if body["model"] != alias {
						t.Errorf("model renamed: %#v", body["model"])
					}
					if body[imageModelDefinitionPayloadKey] != nil {
						t.Error("internal model definition leaked upstream")
					}
					if adapter == "google-gemini-image" {
						config := util.StringMap(util.StringMap(util.StringMap(body["extra_body"])["google"])["image_config"])
						if config["aspect_ratio"] != "4:1" || config["image_size"] != "4K" {
							t.Errorf("Gemini config = %#v", config)
						}
						messages := util.AsMapSlice(body["messages"])
						if edit && (len(messages) != 1 || len(protocol.ExtractImagesFromMessageContent(messages[0]["content"])) != 1) {
							t.Error("Gemini reference image missing")
						}
						util.WriteJSON(w, http.StatusOK, map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": "![image](data:image/png;base64," + encoded + ")"}}}})
						return
					}
					if adapter == "xai-image" {
						if body["aspect_ratio"] != "4:1" || body["resolution"] != "4k" {
							t.Errorf("Grok config = %#v", body)
						}
						if edit && len(util.AsMapSlice(body["images"])) != 1 {
							t.Error("Grok JSON reference image missing")
						}
					}
					util.WriteJSON(w, http.StatusOK, map[string]any{"data": []map[string]any{{"b64_json": encoded}}})
				}))
				defer upstream.Close()
				app := newTestApp(t)
				defer app.Close()
				if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL, "image_model_definitions": map[string]model.ImageModelDefinition{alias: definition}}); err != nil {
					t.Fatal(err)
				}
				var images []protocol.UploadedImage
				if edit {
					images = []protocol.UploadedImage{{Data: imageData, ContentType: "image/png", Filename: "reference.png"}}
				}
				payload := map[string]any{"api_key": "sk-test", "model": alias, "prompt": "draw", "n": 1, "size": "4:1", "image_resolution": "4k", "images": images}
				payload["api_mode"] = "responses"
				result, err := app.runLoggedImageTask(context.Background(), service.Identity{ID: "owner", Role: service.AuthRoleUser}, payload, map[bool]string{false: "/api/creation-tasks/image-generations", true: "/api/creation-tasks/image-edits"}[edit], "文生图", func(ctx context.Context, p map[string]any) (map[string]any, error) {
					return app.relayImageCreationTask(ctx, p, images, edit)
				})
				if err != nil {
					t.Fatal(err)
				}
				items := util.AsMapSlice(result["data"])
				if calls.Load() != 1 || len(items) != 1 || !app.isLocalImageURL(util.Clean(items[0]["url"])) {
					t.Fatalf("calls=%d result=%#v", calls.Load(), result)
				}
			})
		}
	}
}

func TestConfiguredImageDefinitionAuthorityAndLimits(t *testing.T) {
	unsetTestEnv(t, "IMAGE_MODEL_DEFINITIONS")
	app := newTestApp(t)
	defer app.Close()
	d := model.ImageModelDefinition{Protocol: "google-gemini-image", AspectRatios: []string{"1:1"}, Resolutions: []string{"2k"}, MaxReferenceImages: 1, MaxOutputCount: 2}
	if _, err := app.config.Update(map[string]any{"image_model_definitions": map[string]model.ImageModelDefinition{"alias": d}}); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"model": "alias", imageModelDefinitionPayloadKey: map[string]any{"protocol": "xai-image"}}
	app.applyDefaultImageModel(payload)
	if imagePayloadRoute(payload) != util.ImageModelRouteGoogleGemini {
		t.Fatal("client overrode server protocol")
	}
	if published := app.modelConfig()["image_model_definitions"].(map[string]model.ImageModelDefinition); published["alias"].Protocol != d.Protocol {
		t.Fatal("definitions not published")
	}
	for key, value := range map[string]any{"n": 3, "image_resolution": "4k", "quality": "high", "size": "16:9", "input_image_mask": "mask"} {
		candidate := util.CopyMap(payload)
		candidate[key] = value
		if err := validateConfiguredImageRequest(candidate, nil); err == nil {
			t.Errorf("accepted unsupported %s", key)
		}
	}
	if err := validateConfiguredImageRequest(payload, make([]protocol.UploadedImage, 2)); err == nil {
		t.Error("accepted too many references")
	}
	if _, err := app.config.Update(map[string]any{"image_model_definitions": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	app.attachImageModelDefinition(payload)
	if _, ok := configuredImageDefinition(payload); ok {
		t.Fatal("removed definition retained")
	}
}

func TestConfiguredGrokQualityUsesDeclaredValue(t *testing.T) {
	d := model.ImageModelDefinition{Protocol: "xai-image", MaxOutputCount: 1, QualityValues: []string{"low", "medium"}}
	for _, quality := range []string{"", "auto", "low", "MEDIUM"} {
		payload := map[string]any{"model": "custom-alias", "quality": quality, imageModelDefinitionPayloadKey: d}
		body := relayPayloadForPath("/v1/images/generations", payload)
		if quality == "" || quality == "auto" {
			if _, present := body["quality"]; present {
				t.Fatalf("automatic quality was sent: %#v", body)
			}
		} else if body["quality"] != strings.ToLower(quality) {
			t.Fatalf("quality changed: %#v", body)
		}
		if _, present := body["resolution"]; present {
			t.Fatalf("quality invented a resolution: %#v", body)
		}
	}
}
