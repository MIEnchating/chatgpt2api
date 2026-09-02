package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestFreshStoreModelConfigDefaultsStayWithinPublishedModels(t *testing.T) {
	for _, key := range []string{"IMAGE_MODELS", "VIDEO_MODELS", "TEXT_MODELS", "AUDIO_MODELS", "CHAT_MODELS"} {
		unsetTestEnv(t, key)
	}
	app := newTestApp(t)
	defer app.Close()

	config := app.modelConfig()
	assertPublishedModelDefault(t, config, "image_models", "default_image_model")
	assertPublishedModelDefault(t, config, "text_models", "default_text_model")
	assertPublishedModelDefault(t, config, "audio_models", "default_audio_model")

	videoModels := config["video_models"].([]string)
	defaultVideo := config["default_video_model"].(string)
	contracts := config["video_model_contracts"].([]protocol.VideoModelContract)
	if defaultVideo == "" || !containsModel(videoModels, defaultVideo) {
		t.Fatalf("default video model = %q, configured models = %#v", defaultVideo, videoModels)
	}
	matched := false
	for _, contract := range contracts {
		if protocol.VideoContractMatchesModel(contract, defaultVideo) {
			matched = true
			break
		}
	}
	if !matched {
		t.Fatalf("default video model %q does not match an active contract: %#v", defaultVideo, contracts)
	}
}

func TestExplicitEmptyModelConfigurationSurvivesFreshStoreAndHTTP(t *testing.T) {
	for _, key := range []string{"IMAGE_MODELS", "VIDEO_MODELS", "TEXT_MODELS", "AUDIO_MODELS", "CHAT_MODELS"} {
		t.Setenv(key, "")
	}
	app := newTestApp(t)
	defer app.Close()

	if len(app.config.ChatModels()) != 0 || app.config.DefaultChatModel() != "" {
		t.Fatalf("chat model configuration = %#v, default %q; want explicit empty", app.config.ChatModels(), app.config.DefaultChatModel())
	}
	config := app.modelConfig()
	for _, key := range []string{"image_models", "video_models", "text_models", "audio_models"} {
		if models, ok := config[key].([]string); !ok || len(models) != 0 {
			t.Errorf("modelConfig()[%q] = %#v, want empty []string", key, config[key])
		}
	}
	for _, key := range []string{"default_image_model", "default_video_model", "default_text_model", "default_audio_model"} {
		if config[key] != "" {
			t.Errorf("modelConfig()[%q] = %#v, want empty", key, config[key])
		}
	}
	if contracts, ok := config["video_model_contracts"].([]protocol.VideoModelContract); !ok || len(contracts) == 0 {
		t.Fatalf("fresh store active contracts = %#v, want seeded contracts", config["video_model_contracts"])
	}

	_, token := createPasswordUserSession(t, app, "empty-models", "Password123", "Empty Models")
	req := httptest.NewRequest(http.MethodGet, "/api/model-config", nil)
	setRequestAuthCookie(req, "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("model config status = %d body = %s", res.Code, res.Body.String())
	}
	var payload struct {
		Config struct {
			ImageModels       []string `json:"image_models"`
			VideoModels       []string `json:"video_models"`
			TextModels        []string `json:"text_models"`
			AudioModels       []string `json:"audio_models"`
			DefaultImageModel string   `json:"default_image_model"`
			DefaultVideoModel string   `json:"default_video_model"`
			DefaultTextModel  string   `json:"default_text_model"`
			DefaultAudioModel string   `json:"default_audio_model"`
		} `json:"config"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode model config: %v", err)
	}
	if len(payload.Config.ImageModels)+len(payload.Config.VideoModels)+len(payload.Config.TextModels)+len(payload.Config.AudioModels) != 0 {
		t.Fatalf("HTTP model lists restored a fallback: %#v", payload.Config)
	}
	if payload.Config.DefaultImageModel != "" || payload.Config.DefaultVideoModel != "" || payload.Config.DefaultTextModel != "" || payload.Config.DefaultAudioModel != "" {
		t.Fatalf("HTTP model defaults restored a fallback: %#v", payload.Config)
	}

	localModels, err := app.relayListModelsAt(context.Background(), app.relayBaseURL(), "")
	if err != nil {
		t.Fatalf("load local upstream models: %v", err)
	}
	if data, ok := localModels["data"].([]map[string]any); !ok || len(data) != 0 {
		t.Fatalf("local upstream models = %#v, want empty", localModels)
	}
}

func TestImageCreationRoutesRejectModelsDisabledByAdministrator(t *testing.T) {
	unsetTestEnv(t, "IMAGE_MODELS")
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"image_models": []string{"image-enabled"}}); err != nil {
		t.Fatalf("configure image models: %v", err)
	}
	_, token := createPasswordUserSession(t, app, "image-policy", "Password123", "Image Policy")

	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-generations", strings.NewReader(`{"prompt":"draw","model":"image-disabled"}`))
	setRequestAuthCookie(req, "Bearer "+token)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "图片模型不可用") {
		t.Fatalf("disabled generation model status = %d body = %s", res.Code, res.Body.String())
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("prompt", "edit"); err != nil {
		t.Fatalf("write edit prompt: %v", err)
	}
	if err := writer.WriteField("model", "image-disabled"); err != nil {
		t.Fatalf("write edit model: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close edit request: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/creation-tasks/image-edits", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	setRequestAuthCookie(req, "Bearer "+token)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "图片模型不可用") {
		t.Fatalf("disabled edit model status = %d body = %s", res.Code, res.Body.String())
	}
}

func assertPublishedModelDefault(t *testing.T, config map[string]any, modelsKey, defaultKey string) {
	t.Helper()
	models := config[modelsKey].([]string)
	model := config[defaultKey].(string)
	if model == "" || !containsModel(models, model) {
		t.Fatalf("%s = %q, %s = %#v", defaultKey, model, modelsKey, models)
	}
}

func containsModel(models []string, want string) bool {
	for _, model := range models {
		if model == want {
			return true
		}
	}
	return false
}
