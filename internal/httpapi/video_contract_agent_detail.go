package httpapi

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"chatgpt2api/internal/service"
)

type videoContractAgentDetail struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Name           string `json:"name"`
	Status         string `json:"status"`
	Input          string `json:"input,omitempty"`
	Output         string `json:"output,omitempty"`
	Summary        string `json:"summary,omitempty"`
	Error          string `json:"error,omitempty"`
	Round          int    `json:"round,omitempty"`
	RequestAttempt int    `json:"request_attempt,omitempty"`
}

var videoAgentCredentialPattern = regexp.MustCompile(`(?i)(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)(["'\s]*[:=]["'\s]*)([^\r\n,}"']+)`)
var videoAgentBearerPattern = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+`)
var videoAgentURLPattern = regexp.MustCompile(`https?://[^\s"'<>]+`)

func videoContractAgentDetailText(value string) string {
	var parsed any
	if json.Unmarshal([]byte(value), &parsed) == nil {
		data, _ := json.MarshalIndent(service.SanitizeLogValue(parsed), "", "  ")
		value = string(data)
	}
	value = videoAgentURLPattern.ReplaceAllStringFunc(value, service.SanitizeLogURL)
	value = videoAgentCredentialPattern.ReplaceAllString(value, "$1$2[已隐藏]")
	value = videoAgentBearerPattern.ReplaceAllString(value, "Bearer [已隐藏]")
	runes := []rune(value)
	if len(runes) > 8000 {
		value = string(runes[:8000]) + "\n…（详情过长，仅展示前 8000 字）"
	}
	return strings.TrimSpace(value)
}

func newVideoContractAgentDetail(id, kind, name, status, input, output string) *videoContractAgentDetail {
	return &videoContractAgentDetail{ID: id, Kind: kind, Name: name, Status: status, Input: videoContractAgentDetailText(input), Output: videoContractAgentDetailText(output)}
}

func newVideoContractModelDetail(round, attempt int, status, output string, err error) *videoContractAgentDetail {
	detail := newVideoContractAgentDetail(fmt.Sprintf("model-%d-attempt-%d", round, attempt), "model", "模型回复", status, "", output)
	detail.Round, detail.RequestAttempt = round, attempt
	if err != nil {
		detail.Error = videoContractAgentDetailText(err.Error())
	}
	return detail
}
