package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/util"
)

// Public catalog prices are standard USD prices, without account or group discounts.
func normalizeRelayModelPricing(row map[string]any) model.RelayModelPricing {
	result := model.RelayModelPricing{Currency: "USD", Mode: "unavailable", Rates: []model.RelayModelPriceRate{}}
	number := func(key string) (float64, bool) {
		v, ok := row[key].(float64)
		return v, ok && !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0
	}
	mode := util.Clean(row["billing_mode"])
	if len(util.AsMapSlice(row["billing_plugin_variants"])) > 0 {
		result.Mode = "dynamic"
		return result
	}
	if expr := util.Clean(row["billing_expr"]); expr != "" || mode == "tiered_expr" {
		result.Mode = "dynamic"
		if rates, ok := parseRelayBillingExpression(expr, row["billing_usage_schema"]); mode == "tiered_expr" && ok {
			result.Rates = rates
		}
		return result
	}
	if mode != "" && mode != "ratio" && mode != "per_second" {
		result.Mode = "dynamic"
		return result
	}
	if mode == "per_second" {
		result.Mode = "per_second"
		prices, _ := row["model_second_price"].(map[string]any)
		keys := make([]string, 0, len(prices))
		for key := range prices {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if amount, ok := prices[key].(float64); ok && amount >= 0 && !math.IsNaN(amount) && !math.IsInf(amount, 0) {
				result.Rates = append(result.Rates, model.RelayModelPriceRate{Label: key, Amount: amount, Unit: "second"})
			}
		}
		if len(prices) == 0 {
			if amount, ok := number("model_price"); ok {
				result.Rates = append(result.Rates, model.RelayModelPriceRate{Amount: amount, Unit: "second"})
			}
		}
	} else if quota, ok := number("quota_type"); ok && quota == 1 {
		result.Mode = "per_request"
		if amount, ok := number("model_price"); ok {
			result.Rates = append(result.Rates, model.RelayModelPriceRate{Amount: amount, Unit: "request"})
		}
	} else if quota, ok := number("quota_type"); ok && quota == 0 {
		result.Mode = "per_token"
		if ratio, ok := number("model_ratio"); ok {
			base := ratio * 2
			result.Rates = append(result.Rates, model.RelayModelPriceRate{Label: "输入", Amount: base, Unit: "million_tokens"})
			for _, field := range []struct{ key, label string }{{"completion_ratio", "输出"}, {"cache_ratio", "缓存读取"}, {"create_cache_ratio", "缓存写入"}} {
				if multiplier, ok := number(field.key); ok {
					result.Rates = append(result.Rates, model.RelayModelPriceRate{Label: field.label, Amount: base * multiplier, Unit: "million_tokens"})
				}
			}
		}
	}
	for _, rate := range result.Rates {
		if math.IsInf(rate.Amount, 0) {
			result.Rates = nil
			break
		}
	}
	if len(result.Rates) == 0 {
		result.Mode = "unavailable"
		result.Rates = []model.RelayModelPriceRate{}
	}
	return result
}

func (a *App) relayPublicModelPricing(ctx context.Context, baseURL, group string) (map[string]model.RelayModelPricing, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/api/pricing", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	// Never send a user's model API key to the public pricing endpoint.
	response, err := a.relayHTTPClientForContext(ctx).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("pricing HTTP %d", response.StatusCode)
	}
	const maxSize = 4 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, maxSize+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxSize {
		return nil, fmt.Errorf("pricing response too large")
	}
	var document struct {
		Success    bool               `json:"success"`
		Data       []map[string]any   `json:"data"`
		GroupRatio map[string]float64 `json:"group_ratio"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, err
	}
	if !document.Success || document.Data == nil {
		return nil, fmt.Errorf("invalid pricing response")
	}
	ratio, ok := document.GroupRatio[group]
	grouped := group != "" && group != "auto" && ok && !math.IsNaN(ratio) && !math.IsInf(ratio, 0) && ratio >= 0
	prices := make(map[string]model.RelayModelPricing, len(document.Data))
	for _, row := range document.Data {
		if name := util.Clean(row["model_name"]); name != "" {
			price := normalizeRelayModelPricing(row)
			price.Reference = !grouped
			if grouped {
				price.Group = group
				price.GroupRatio = &ratio
			}
			enabled := util.AsStringSlice(row["enable_groups"])
			supported := false
			for _, value := range enabled {
				if value == group || value == "all" {
					supported = true
				}
			}
			if grouped && !supported {
				continue
			}
			for index := range price.Rates {
				if grouped {
					price.Rates[index].Amount *= ratio
				}
			}
			for _, rate := range price.Rates {
				if math.IsNaN(rate.Amount) || math.IsInf(rate.Amount, 0) {
					price.Mode = "unavailable"
					price.Rates = []model.RelayModelPriceRate{}
					break
				}
			}
			prices[name] = price
		}
	}
	return prices, nil
}

func (a *App) relayListModelsWithPricing(ctx context.Context, baseURL, apiKey, group string) (map[string]any, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type pricingResult struct {
		prices map[string]model.RelayModelPricing
		err    error
	}
	ready := make(chan pricingResult, 1)
	go func() {
		prices, err := a.relayPublicModelPricing(ctx, baseURL, group)
		ready <- pricingResult{prices, err}
	}()
	result, err := a.relayListModelsAt(ctx, baseURL, apiKey)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, fmt.Errorf("upstream model response must be an object")
	}
	pricing := <-ready
	if pricing.err != nil {
		result["pricing_error"] = "价格获取失败，请检查上游价格接口"
		result["pricing_notice"] = "无法确认价格，请检查上游价格接口"
		return result, nil
	}
	if err := a.modelPricingCache.Save(baseURL, group, pricing.prices); err != nil {
		return nil, fmt.Errorf("persist relay model pricing: %w", err)
	}
	for _, row := range util.AsMapSlice(result["data"]) {
		if price, ok := pricing.prices[util.Clean(row["id"])]; ok {
			row["pricing"] = price
		}
	}
	result["pricing_notice"] = "价格已按当前 Key 的分组倍率计算（USD）；动态计费与额外账户优惠以实际结算为准"
	for _, price := range pricing.prices {
		if price.Reference {
			result["pricing_notice"] = "未确认 Key 的计费分组或倍率，显示上游目录参考价；请配置计费分组以查看对应价格"
			break
		}
	}
	return result, nil
}

func (a *App) cachedRelayModelPricing(baseURL, group string) (map[string]any, error) {
	prices, err := a.modelPricingCache.Load(baseURL, group)
	if err != nil {
		return nil, fmt.Errorf("load cached relay model pricing: %w", err)
	}
	rows := make([]map[string]any, 0, len(prices))
	for name, price := range prices {
		rows = append(rows, map[string]any{"id": name, "pricing": price})
	}
	return map[string]any{"data": rows}, nil
}
