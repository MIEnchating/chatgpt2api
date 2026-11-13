package httpapi

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
)

func (a *App) canvasAgentVideoModels() []service.CanvasAgentVideoModel {
	models := a.configuredVideoModels()
	catalog := make([]service.CanvasAgentVideoModel, 0, len(models))
	for _, model := range models {
		entry := service.CanvasAgentVideoModel{Model: model, Capabilities: canvasAgentVideoCapabilities(model)}
		if contract, ok := protocol.VideoContractForModel(model); ok {
			entry.Defaults = map[string]any{"videoSize": contract.Capability.DefaultSize, "videoQuality": contract.Capability.DefaultResolution, "videoSeconds": contract.Capability.DefaultSeconds}
			if contract.Capability.AudioControl != "toggle" {
				entry.Defaults["videoGenerateAudio"] = contract.Capability.AudioControl == "always"
			}
		}
		catalog = append(catalog, entry)
	}
	return catalog
}

func canvasAgentVideoCapabilities(model string) map[string]any {
	contract, configured := protocol.VideoContractForModel(model)
	if !configured {
		return map[string]any{"contractConfigured": false, "audioControl": "unknown"}
	}
	capability := contract.Capability
	values := capability.Seconds
	labels := make([]string, 0, len(values))
	for _, seconds := range values {
		labels = append(labels, strconv.Itoa(seconds))
	}
	duration := "可选 " + strings.Join(labels, "、") + " 秒"
	if len(values) == 1 {
		duration = "仅 " + labels[0] + " 秒"
	}
	if r := capability.SecondsRange; r != nil {
		values = []int{capability.DefaultSeconds}
		duration = fmt.Sprintf("%d 秒起，无固定上限，步长 %d 秒", r.Min, r.Step)
		if r.Max != nil {
			duration = fmt.Sprintf("%d 秒起，最多 %d 秒，步长 %d 秒", r.Min, *r.Max, r.Step)
		}
	}
	durationSpec := map[string]any{"values": values, "range": duration}
	if r := capability.SecondsRange; r != nil {
		secondsRange := map[string]any{"min": r.Min, "step": r.Step}
		if r.Max != nil {
			secondsRange["max"] = *r.Max
		}
		durationSpec["secondsRange"] = secondsRange
	}
	transports := contract.Transport.MaterialTransports
	if len(transports) == 0 {
		transports = []string{contract.Transport.LocalMaterial}
	}
	defaultMode := "text"
	for _, mode := range contract.Generation.Modes {
		if mode.ID == contract.Generation.DefaultMode {
			defaultMode = mode.Kind
			break
		}
	}
	return map[string]any{
		"contractConfigured": true,
		"sizes":              capability.Sizes, "resolutions": capability.Resolutions,
		"parameters":   capability.Parameters,
		"defaultMode":  defaultMode,
		"duration":     durationSpec,
		"audioControl": capability.AudioControl,
		"referenceMaterials": map[string]any{
			"transport": transports[0], "transports": transports,
			"multipartRepeatable": contract.Transport.MultipartRepeatable,
			"multipartMixedURLs":  contract.Transport.MultipartMixedURLs,
			"base64":              slices.Contains(transports, "base64"),
			"dataURL":             slices.Contains(transports, "base64") && contract.Transport.Base64Format != "raw",
			"modes":               contract.Generation.Modes,
		},
	}
}
