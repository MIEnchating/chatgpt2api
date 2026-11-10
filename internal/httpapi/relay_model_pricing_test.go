package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"chatgpt2api/internal/model"
)

func TestNormalizeRelayModelPricing(t *testing.T) {
	for _, test := range []struct {
		name, input, mode string
		rates             []model.RelayModelPriceRate
	}{
		{"seconds", `{"quota_type":1,"model_price":0.8,"billing_mode":"per_second"}`, "per_second", []model.RelayModelPriceRate{{Amount: 0.8, Unit: "second"}}},
		{"request despite seconds usage schema", `{"quota_type":1,"model_price":6,"billing_usage_schema":{"seconds":{"unit":"second"}}}`, "per_request", []model.RelayModelPriceRate{{Amount: 6, Unit: "request"}}},
		{"resolution tiers", `{"billing_mode":"per_second","model_price":9,"model_second_price":{"720p":0.2,"480p":0.1}}`, "per_second", []model.RelayModelPriceRate{{Label: "480p", Amount: 0.1, Unit: "second"}, {Label: "720p", Amount: 0.2, Unit: "second"}}},
		{"tokens", `{"quota_type":0,"model_ratio":2.5,"completion_ratio":6,"cache_ratio":0.1}`, "per_token", []model.RelayModelPriceRate{{Label: "输入", Amount: 5, Unit: "million_tokens"}, {Label: "输出", Amount: 30, Unit: "million_tokens"}, {Label: "缓存读取", Amount: 0.5, Unit: "million_tokens"}}},
		{"zero price", `{"quota_type":1,"model_price":0}`, "per_request", []model.RelayModelPriceRate{{Amount: 0, Unit: "request"}}},
		{"missing price", `{"quota_type":1}`, "unavailable", []model.RelayModelPriceRate{}},
		{"invalid price", `{"quota_type":1,"model_price":-1}`, "unavailable", []model.RelayModelPriceRate{}},
		{"malformed price", `{"quota_type":1,"model_price":"6"}`, "unavailable", []model.RelayModelPriceRate{}},
		{"missing quota", `{"model_ratio":2.5}`, "unavailable", []model.RelayModelPriceRate{}},
		{"invalid resolution prices", `{"billing_mode":"per_second","model_price":9,"model_second_price":{"480p":-1}}`, "unavailable", []model.RelayModelPriceRate{}},
		{"dynamic expression", `{"quota_type":0,"model_ratio":2.5,"billing_mode":"tiered_expr","billing_expr":"len > 100 ? 2 : 1"}`, "dynamic", []model.RelayModelPriceRate{}},
		{"dynamic tokens", `{"billing_mode":"tiered_expr","billing_expr":"tier(\"base\", p * 2 + c * 8)"}`, "dynamic", []model.RelayModelPriceRate{{Label: "base · 输入", Amount: 2, Unit: "million_tokens"}, {Label: "base · 输出", Amount: 8, Unit: "million_tokens"}}},
		{"dynamic fixed zero", `{"billing_mode":"tiered_expr","billing_expr":"v1:tier(\"free\", fixed(0))"}`, "dynamic", []model.RelayModelPriceRate{{Label: "free", Amount: 0, Unit: "request"}}},
		{"dynamic task seconds", `{"billing_mode":"tiered_expr","billing_expr":"tier(\"base\", u(\"seconds\") * 0.4)","billing_usage_schema":{"seconds":{"type":"number","unit":"second"}}}`, "dynamic", []model.RelayModelPriceRate{{Label: "base · seconds", Amount: 0.4, Unit: "second"}}},
		{"dynamic task tiers", `{"billing_mode":"tiered_expr","billing_expr":"u(\"resolution\") == \"720p\" ? tier(\"high\", 0.2) : tier(\"low\", 0.1)","billing_usage_schema":{"resolution":{"enum":["720p","480p"]}}}`, "dynamic", []model.RelayModelPriceRate{{Label: "resolution = 720p", Amount: 0.2, Unit: "request"}, {Label: "非(resolution = 720p)", Amount: 0.1, Unit: "request"}}},
		{"unknown task unit", `{"billing_mode":"tiered_expr","billing_expr":"tier(\"base\", u(\"seconds\") * 0.4)"}`, "dynamic", []model.RelayModelPriceRate{}},
		{"unqualified constant", `{"billing_mode":"tiered_expr","billing_expr":"tier(\"base\", 0.4)"}`, "dynamic", []model.RelayModelPriceRate{}},
		{"external multiplier", `{"billing_mode":"tiered_expr","billing_expr":"tier(\"base\", p * 2) * 3"}`, "dynamic", []model.RelayModelPriceRate{}},
		{"unknown expression version", `{"billing_mode":"tiered_expr","billing_expr":"v2:tier(\"base\", p * 2)"}`, "dynamic", []model.RelayModelPriceRate{}},
		{"mixed fixed tokens", `{"billing_mode":"tiered_expr","billing_expr":"tier(\"base\", fixed(1) + p * 2)"}`, "dynamic", []model.RelayModelPriceRate{}},
		{"plugin variants", `{"quota_type":1,"model_price":9,"billing_plugin_variants":[{"plugin_key":"different-prices"}]}`, "dynamic", []model.RelayModelPriceRate{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var row map[string]any
			if err := json.Unmarshal([]byte(test.input), &row); err != nil {
				t.Fatal(err)
			}
			got := normalizeRelayModelPricing(row)
			if got.Currency != "USD" || got.Mode != test.mode || !reflect.DeepEqual(got.Rates, test.rates) {
				t.Fatalf("pricing = %#v; expected %s %#v", got, test.mode, test.rates)
			}
		})
	}
}

func TestRelayPublicModelPricingUsesSelectedGroup(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"group_ratio":{"discount":0.5,"free":0},"data":[{"model_name":"video","quota_type":1,"model_price":6,"enable_groups":["discount","free"]},{"model_name":"dynamic","billing_mode":"tiered_expr","billing_expr":"tier(\"base\", u(\"seconds\") * 6)","billing_usage_schema":{"seconds":{"type":"number","unit":"second"}},"enable_groups":["discount","free"]},{"model_name":"other","quota_type":1,"model_price":9,"enable_groups":["other"]}]}`))
	}))
	defer upstream.Close()
	for _, tc := range []struct {
		group string
		want  float64
		valid bool
	}{{"discount", 3, true}, {"free", 0, true}, {"", 6, false}, {"unknown", 6, false}, {"auto", 6, false}} {
		t.Run(tc.group, func(t *testing.T) {
			prices, err := app.relayPublicModelPricing(context.Background(), upstream.URL, tc.group)
			if err != nil {
				t.Fatal(err)
			}
			p := prices["video"]
			if len(p.Rates) != 1 || p.Rates[0].Amount != tc.want || p.Reference == tc.valid || (tc.valid && (p.Group != tc.group || p.GroupRatio == nil)) || (!tc.valid && (p.Group != "" || p.GroupRatio != nil)) {
				t.Fatalf("wrong grouped price: %#v", p)
			}
			if _, ok := prices["other"]; tc.valid && ok {
				t.Fatal("included a model from another group")
			}
			dynamic := prices["dynamic"]
			if len(dynamic.Rates) != 1 || dynamic.Rates[0].Amount != tc.want {
				t.Fatalf("wrong grouped dynamic price: %#v", dynamic)
			}
		})
	}
}

func TestCachedRelayModelPricingIsScopedAndUpdated(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	requests := 0
	price := "6"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/pricing" {
			requests++
			_, _ = w.Write([]byte(`{"success":true,"group_ratio":{"discount":0.5},"data":[{"model_name":"video","quota_type":1,"model_price":` + price + `,"enable_groups":["discount"]}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"video"}]}`))
	}))
	defer upstream.Close()
	if _, err := app.relayListModelsWithPricing(context.Background(), upstream.URL, "key", "discount"); err != nil {
		t.Fatal(err)
	}
	rows := cachedModelPriceRows(t, app, upstream.URL, "discount")
	if len(rows) != 1 || rows[0]["pricing"].(model.RelayModelPricing).Rates[0].Amount != 3 {
		t.Fatalf("cached prices: %#v", rows)
	}
	if len(cachedModelPriceRows(t, app, upstream.URL, "other")) != 0 || requests != 1 {
		t.Fatal("cache scope or upstream requests incorrect")
	}
	price = "8"
	if _, err := app.relayListModelsWithPricing(context.Background(), upstream.URL, "key", "discount"); err != nil {
		t.Fatal(err)
	}
	rows = cachedModelPriceRows(t, app, upstream.URL, "discount")
	if rows[0]["pricing"].(model.RelayModelPricing).Rates[0].Amount != 4 || requests != 2 {
		t.Fatalf("updated prices: %#v", rows)
	}
}

func TestCachedRelayModelPricingSurvivesRestartAndFailedRefresh(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	requests := 0
	failPricing := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/pricing" {
			requests++
			if failPricing {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
			_, _ = w.Write([]byte(`{"success":true,"group_ratio":{"discount":0.5},"data":[{"model_name":"video","quota_type":1,"model_price":6,"enable_groups":["discount"]}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"video"}]}`))
	}))
	defer upstream.Close()
	if _, err := app.relayListModelsWithPricing(context.Background(), upstream.URL, "key", "discount"); err != nil {
		t.Fatal(err)
	}
	app.Close()
	restarted, err := NewApp()
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	checkCached := func() {
		t.Helper()
		rows := cachedModelPriceRows(t, restarted, upstream.URL, "discount")
		if len(rows) != 1 || rows[0]["pricing"].(model.RelayModelPricing).Rates[0].Amount != 3 {
			t.Fatalf("cached prices after restart: %#v", rows)
		}
		for _, scope := range [][2]string{{upstream.URL, "other"}, {upstream.URL + "/other", "discount"}} {
			if len(cachedModelPriceRows(t, restarted, scope[0], scope[1])) != 0 {
				t.Fatalf("prices leaked to another scope: %v", scope)
			}
		}
	}
	checkCached()
	if requests != 1 {
		t.Fatalf("reading cache made upstream requests: %d", requests)
	}
	failPricing = true
	result, err := restarted.relayListModelsWithPricing(context.Background(), upstream.URL, "key", "discount")
	if err != nil || result["pricing_error"] == nil {
		t.Fatalf("failed pricing refresh = %#v, %v", result, err)
	}
	checkCached()
	if requests != 2 {
		t.Fatalf("unexpected upstream pricing requests: %d", requests)
	}
}

func cachedModelPriceRows(t *testing.T, app *App, baseURL, group string) []map[string]any {
	t.Helper()
	result, err := app.cachedRelayModelPricing(baseURL, group)
	if err != nil {
		t.Fatal(err)
	}
	return result["data"].([]map[string]any)
}
