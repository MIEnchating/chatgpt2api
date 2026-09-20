package protocol

import (
	"net/url"
	"strings"
)

// IsArkAgentPlanURL identifies the explicit subscription endpoint, not /models errors.
func IsArkAgentPlanURL(baseURL string) bool {
	u, err := url.Parse(baseURL)
	return err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") && strings.TrimRight(u.Path, "/") == "/api/plan/v3"
}

// ArkAgentPlanModelCandidates is a selection aid, not account entitlement discovery.
func ArkAgentPlanModelCandidates(videoOnly bool) []map[string]any {
	groups := []struct {
		kind string
		ids  []string
	}{
		{"text", []string{
			"doubao-seed-2.0-mini", "doubao-seed-2.0-lite", "deepseek-v4-flash", "glm-5.3-flash",
			"doubao-seed-2.1-turbo", "doubao-seed-evolving", "minimax-m3", "glm-5.3",
			"kimi-k2.7-code", "deepseek-v4-pro", "kimi-k3", "deepseek-v4.1-flash",
		}},
		{"video", []string{
			"doubao-seedance-2.5", "doubao-seedance-2.0", "doubao-seedance-2.0-fast",
			"doubao-seedance-2.0-mini", "doubao-seedance-1.5-pro",
		}},
	}
	models := make([]map[string]any, 0, 17)
	for _, group := range groups {
		if videoOnly && group.kind != "video" {
			continue
		}
		for _, id := range group.ids {
			models = append(models, map[string]any{"id": id, "object": "model", "kind": group.kind})
		}
	}
	return models
}
