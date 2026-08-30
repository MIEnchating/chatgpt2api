package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func TestProfileModelsUsesSelectedCustomRelayConfig(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	var authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("upstream path = %q", r.URL.Path)
		}
		authorization = r.Header.Get("Authorization")
		util.WriteJSON(w, http.StatusOK, map[string]any{
			"object": "list",
			"data":   []map[string]any{{"id": "custom-video-model", "object": "model"}},
		})
	}))
	defer upstream.Close()

	token := adminSessionToken(t, app)
	request := httptest.NewRequest(http.MethodPost, "/api/profile/custom-relay-configs", strings.NewReader(`{"kind":"video","name":"视频线路","base_url":"`+upstream.URL+`","api_key":"sk-custom-video"}`))
	request.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(request, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("save custom relay status = %d body = %s", response.Code, response.Body.String())
	}
	var created struct {
		Item struct {
			TokenName string `json:"token_name"`
		} `json:"item"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil || created.Item.TokenName == "" {
		t.Fatalf("decode custom relay response = %#v, %v", created, err)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/profile/upstream-models?token_name="+created.Item.TokenName, nil)
	setRequestAuthCookie(request, token)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"custom-video-model"`) {
		t.Fatalf("custom relay models status = %d body = %s", response.Code, response.Body.String())
	}
	if authorization != "Bearer sk-custom-video" {
		t.Fatalf("upstream Authorization = %q", authorization)
	}
}
