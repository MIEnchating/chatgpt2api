package httpapi

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/util"
)

func TestProfileModelsUsesSelectedCustomRelayConfig(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()

	var authorization string
	pricingRequests := 0
	pricingFails := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/pricing" {
			pricingRequests++
			if r.Header.Get("Authorization") != "" {
				t.Error("model key sent to public pricing endpoint")
			}
			if pricingFails {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "group_ratio": map[string]float64{"discount": 0.5}, "data": []map[string]any{
				{"model_name": "custom-video-model", "quota_type": 1, "model_price": 0.8, "billing_mode": "per_second", "enable_groups": []string{"discount"}},
				{"model_name": "not-in-key-list", "quota_type": 1, "model_price": 99},
			}})
			return
		}
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
	upstreamAddress := upstream.Listener.Addr().String()
	app.newSafeRelayHTTPClient = func(timeout time.Duration) *http.Client {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, upstreamAddress)
		}
		return &http.Client{Transport: transport, Timeout: timeout}
	}

	token := adminSessionToken(t, app)
	request := httptest.NewRequest(http.MethodPost, "/api/profile/custom-relay-configs", strings.NewReader(`{"kind":"video","name":"视频线路","base_url":"http://relay.example","api_key":"sk-custom-video","pricing_group":"discount"}`))
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
	if pricingRequests != 0 {
		t.Fatal("ordinary model requests must not fetch prices")
	}
	for _, fail := range []bool{false, true} {
		pricingFails = fail
		request = httptest.NewRequest(http.MethodGet, "/api/profile/upstream-models?include_pricing=true&token_name="+created.Item.TokenName, nil)
		setRequestAuthCookie(request, token)
		response = httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("pricing status %d: %s", response.Code, response.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		rows := util.AsMapSlice(body["data"])
		if len(rows) != 1 || rows[0]["id"] != "custom-video-model" {
			t.Fatalf("pricing changed accessible models: %#v", rows)
		}
		if fail {
			if rows[0]["pricing"] != nil || !strings.Contains(util.Clean(body["pricing_notice"]), "无法确认") {
				t.Fatalf("pricing failure not reported: %#v", body)
			}
		} else {
			pricing, _ := rows[0]["pricing"].(map[string]any)
			rates := util.AsMapSlice(pricing["rates"])
			if pricing["mode"] != "per_second" || len(rates) != 1 || rates[0]["amount"] != 0.4 || rates[0]["unit"] != "second" {
				t.Fatalf("invalid price: %#v", pricing)
			}
		}
	}
	if pricingRequests != 2 {
		t.Fatalf("pricing requests: %d", pricingRequests)
	}
}
