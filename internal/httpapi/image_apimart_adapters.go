package httpapi

import (
	"fmt"
	"strconv"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

type apimartImageContract struct {
	aspectField    string
	hasResolution  bool
	resolutionCase string
	maxResolution  string
	minResolution  string
	hasCount       bool
	hasQuality     bool
	hasOutput      bool
	imageRefField  string
	maxImageRefs   int
}

func isAPIMartImagePayload(payload map[string]any) bool {
	if payload == nil {
		return false
	}
	for _, key := range []string{"provider", "image_provider", "channel_protocol", "protocol"} {
		value := strings.ToLower(strings.TrimSpace(util.Clean(payload[key])))
		if strings.Contains(value, "apimart") {
			return true
		}
		if value == "kie" {
			return false
		}
	}
	for _, key := range []string{"channel_base_url", "provider_base_url"} {
		if strings.Contains(strings.ToLower(strings.TrimSpace(util.Clean(payload[key]))), "apimart") {
			return true
		}
	}
	return isKnownAPIMartImageModel(util.Clean(payload["model"]))
}

func isKnownAPIMartImageModel(model string) bool {
	name := normalizeAPIMartImageModelName(model)
	if name == "" || strings.Contains(strings.TrimSpace(model), "/") {
		return false
	}
	// These bare IDs belong to KIE in the reference project. Callers can still
	// select APIMart explicitly with a provider or protocol hint.
	if name == "z-image" || name == "nano-banana" || name == "nano-banana-pro" || strings.HasPrefix(name, "nano-banana-2") || strings.HasPrefix(name, "gpt-image-2-text-to-image") || strings.HasPrefix(name, "gpt-image-2-image-to-image") {
		return false
	}
	if strings.HasSuffix(name, "-apimart") {
		return true
	}
	for _, prefix := range []string{
		"gemini-31", "nano-banana2", "seedream", "seedance-4", "qwen", "wan2-7", "flux-2",
	} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return name == "gpt-image-2-official" || name == "gpt-image-2-apimart"
}

func normalizeAPIMartImagePayload(payload map[string]any) bool {
	if !isAPIMartImagePayload(payload) {
		return false
	}
	model := util.Clean(payload["model"])
	contract := apimartImageContractForModel(model)
	normalizeAPIMartImageResolution(payload, contract)
	normalizeAPIMartImageAspect(payload, contract)
	normalizeAPIMartImageCount(payload, contract)
	normalizeAPIMartImageQuality(payload, contract)
	if apimartImageReferenceExcluded(model) {
		clearAPIMartImageReferenceFields(payload)
	} else {
		normalizeAPIMartImageReferences(payload, contract)
	}
	clearAPIMartImageCompatibilityFields(payload)
	return true
}

func relayImageEditPath(payload map[string]any) string {
	const editsPath = "/v1/images/edits"
	if !isAPIMartImagePayload(payload) {
		return editsPath
	}
	model := normalizeAPIMartImageModelName(util.Clean(payload["model"]))
	if strings.Contains(model, "grok-imagine") && strings.Contains(model, "edit") {
		return editsPath
	}
	return "/v1/images/generations"
}

func apimartImageContractForModel(modelName string) apimartImageContract {
	model := normalizeAPIMartImageModelName(modelName)
	contract := apimartImageContract{
		aspectField:    "size",
		hasResolution:  true,
		resolutionCase: "upper",
		hasCount:       true,
		imageRefField:  "image_urls",
	}
	switch {
	case strings.Contains(model, "gpt-image-2") && strings.Contains(model, "official"):
		contract.resolutionCase = "lower"
		contract.hasQuality = true
		contract.hasOutput = true
	case strings.Contains(model, "gpt-image-2"):
		contract.resolutionCase = "lower"
		contract.hasQuality = true
	case strings.Contains(model, "gpt-4o-image"):
		contract.hasResolution = false
	case strings.Contains(model, "gpt-image-1"):
		contract.hasResolution = false
		contract.hasQuality = true
		contract.hasOutput = true
	case strings.Contains(model, "gemini-3-1-flash-lite"):
		contract.maxResolution = "1K"
	case strings.Contains(model, "gemini-3-1"), strings.Contains(model, "gemini-31"), strings.Contains(model, "nano-banana2"):
		contract.hasCount = false
	case strings.Contains(model, "gemini-3-pro"), strings.Contains(model, "nano-banana-pro"):
		contract.hasCount = false
	case strings.Contains(model, "gemini-2-5"), strings.Contains(model, "nano-banana"):
		contract.maxResolution = "1K"
		contract.hasCount = false
	case strings.Contains(model, "imagen"):
		contract.hasResolution = false
		contract.hasCount = false
		contract.imageRefField = ""
	case strings.Contains(model, "seedream-5-0-pro"):
		contract.maxResolution = "2K"
		contract.hasCount = false
		contract.maxImageRefs = 10
	case strings.Contains(model, "seedream-5"):
		contract.minResolution = "2K"
		contract.hasOutput = true
	case strings.Contains(model, "seedream-4-5"), strings.Contains(model, "seedance-4-5"):
		contract.minResolution = "2K"
	case strings.Contains(model, "seedream"), strings.Contains(model, "seedance-4"):
	case strings.Contains(model, "qwen"):
		contract.maxResolution = "2K"
	case strings.Contains(model, "z-image"):
		contract.maxResolution = "2K"
		contract.hasCount = false
		contract.imageRefField = ""
	case strings.Contains(model, "grok-imagine"):
		contract.hasResolution = false
	case strings.Contains(model, "wan2-7"):
	case strings.Contains(model, "flux-2"):
		contract.hasCount = false
	}
	return contract
}

func normalizeAPIMartImageResolution(payload map[string]any, contract apimartImageContract) {
	if !contract.hasResolution {
		if !contract.hasQuality {
			delete(payload, "resolution")
			delete(payload, "resolution_name")
		}
		delete(payload, "image_resolution")
		return
	}
	value := firstNonEmpty(
		util.Clean(payload["resolution"]),
		util.Clean(payload["resolution_name"]),
		util.Clean(payload["image_resolution"]),
		apimartImageSizeResolution(util.Clean(payload["size"])),
		apimartImageQualityResolution(util.Clean(payload["quality"])),
	)
	if value != "" {
		payload["resolution"] = normalizeAPIMartImageResolutionValue(clampAPIMartImageResolution(value, contract), contract.resolutionCase)
	}
	delete(payload, "image_resolution")
	delete(payload, "resolution_name")
}

func normalizeAPIMartImageAspect(payload map[string]any, contract apimartImageContract) {
	value := firstNonEmpty(
		util.Clean(payload[contract.aspectField]),
		util.Clean(payload["size"]),
		util.Clean(payload["aspect_ratio"]),
		util.Clean(payload["ratio"]),
		util.Clean(payload["image_size"]),
	)
	if value != "" {
		payload[contract.aspectField] = normalizeAPIMartImageRatio(value)
	}
	if contract.aspectField != "size" {
		delete(payload, "size")
	}
	if contract.aspectField != "aspect_ratio" {
		delete(payload, "aspect_ratio")
	}
	delete(payload, "ratio")
	delete(payload, "image_size")
}

func normalizeAPIMartImageCount(payload map[string]any, contract apimartImageContract) {
	if !contract.hasCount {
		for _, key := range []string{"n", "num_images", "max_images", "actual_image_count"} {
			delete(payload, key)
		}
		return
	}
	value := firstNonNilRelayValue(payload["n"], payload["num_images"], payload["max_images"], payload["actual_image_count"])
	if value != nil && strings.TrimSpace(util.Clean(value)) != "" {
		payload["n"] = normalizeAPIMartImageInt(value)
	}
	for _, key := range []string{"num_images", "max_images", "actual_image_count"} {
		delete(payload, key)
	}
}

func normalizeAPIMartImageQuality(payload map[string]any, contract apimartImageContract) {
	if contract.hasQuality {
		if quality := strings.TrimSpace(util.Clean(payload["quality"])); quality != "" {
			payload["quality"] = strings.ToLower(quality)
		}
	} else {
		delete(payload, "quality")
	}
	if contract.hasOutput {
		if format := firstNonEmpty(util.Clean(payload["output_format"]), util.Clean(payload["format"])); format != "" {
			payload["output_format"] = normalizeAPIMartImageOutputFormat(format)
		}
	} else {
		delete(payload, "output_format")
	}
	delete(payload, "format")
}

func normalizeAPIMartImageReferences(payload map[string]any, contract apimartImageContract) {
	if contract.imageRefField == "" {
		clearAPIMartImageReferenceFields(payload)
		return
	}
	values := make([]string, 0)
	for _, key := range apimartImageReferenceAliasKeys() {
		values = append(values, collectAPIMartImageReferenceStrings(payload[key], 0)...)
	}
	values = dedupeAPIMartImageReferences(values)
	if contract.maxImageRefs > 0 && len(values) > contract.maxImageRefs {
		values = values[:contract.maxImageRefs]
	}
	clearAPIMartImageReferenceFields(payload)
	for _, key := range apimartMediaReferenceAliasKeys() {
		delete(payload, key)
	}
	if len(values) > 0 {
		payload[contract.imageRefField] = values
	}
}

func collectAPIMartImageReferenceStrings(value any, depth int) []string {
	if depth > 6 || value == nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		if value := strings.TrimSpace(typed); value != "" {
			return []string{value}
		}
	case []string:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			result = append(result, collectAPIMartImageReferenceStrings(item, depth+1)...)
		}
		return result
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			result = append(result, collectAPIMartImageReferenceStrings(item, depth+1)...)
		}
		return result
	case map[string]any:
		for _, key := range []string{"url", "image_url", "imageUrl", "download_url", "downloadUrl"} {
			if value := strings.TrimSpace(util.Clean(typed[key])); value != "" {
				return []string{value}
			}
		}
		result := make([]string, 0)
		for _, item := range typed {
			result = append(result, collectAPIMartImageReferenceStrings(item, depth+1)...)
		}
		return result
	}
	return nil
}

func dedupeAPIMartImageReferences(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func validateAPIMartImageRequiredInput(model string, payload map[string]any, uploaded int) error {
	if !isAPIMartImagePayload(payload) {
		return nil
	}
	name := normalizeAPIMartImageModelName(model)
	if !strings.Contains(name, "grok-imagine") || !strings.Contains(name, "edit") {
		return nil
	}
	for _, key := range apimartImageReferenceAliasKeys() {
		if len(collectAPIMartImageReferenceStrings(payload[key], 0)) > 0 {
			return nil
		}
	}
	if uploaded > 0 {
		return nil
	}
	return protocol.HTTPError{Status: 400, Message: "APIMart required input missing: image_urls"}
}

func apimartImageReferenceExcluded(modelName string) bool {
	switch normalizeAPIMartImageModelName(modelName) {
	case "grok-imagine-1-5-apimart", "imagen-4-0-apimart":
		return true
	default:
		return false
	}
}

func clearAPIMartImageReferenceFields(payload map[string]any) {
	for _, key := range apimartImageReferenceAliasKeys() {
		delete(payload, key)
	}
}

func apimartImageReferenceAliasKeys() []string {
	return []string{
		"image", "images", "image_url", "image_urls", "input_url", "input_urls", "input_reference", "input_reference[]", "image_input",
		"reference_image", "reference_images", "reference_image_url", "reference_image_urls", "first_frame_url", "first_frame_image", "last_frame_url", "last_frame_image",
	}
}

func apimartMediaReferenceAliasKeys() []string {
	return []string{
		"video", "videos", "video_url", "video_urls", "input_video_url", "input_video_urls", "video_reference", "video_reference[]", "reference_video_url", "reference_video_urls",
		"audio", "audios", "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "audio_reference", "audio_reference[]", "reference_audio_url", "reference_audio_urls",
	}
}

func clearAPIMartImageCompatibilityFields(payload map[string]any) {
	for _, key := range []string{
		"requested_size", "background", "moderation", "stream", "partial_images", "output_compression",
		"response_format", "input_image_mask", "storage_options", "image_format", "user",
	} {
		delete(payload, key)
	}
}

func normalizeAPIMartImageModelName(model string) string {
	return strings.NewReplacer("_", "-", ".", "-", "/", "-").Replace(strings.ToLower(strings.TrimSpace(model)))
}

func normalizeAPIMartImageRatio(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" || value == "auto" {
		return "auto"
	}
	if width, height, ok := parseAPIMartImageSize(value); ok {
		for _, item := range []struct {
			width, height int
			ratio         string
		}{
			{1, 1, "1:1"}, {2, 1, "2:1"}, {1, 2, "1:2"}, {3, 1, "3:1"}, {1, 3, "1:3"},
			{5, 4, "5:4"}, {4, 5, "4:5"}, {16, 9, "16:9"}, {9, 16, "9:16"}, {4, 3, "4:3"},
			{3, 4, "3:4"}, {3, 2, "3:2"}, {2, 3, "2:3"}, {21, 9, "21:9"}, {9, 21, "9:21"},
		} {
			difference := width*item.height - height*item.width
			if difference < 0 {
				difference = -difference
			}
			if difference*100 <= width*item.height*4 {
				return item.ratio
			}
		}
	}
	return value
}

func parseAPIMartImageSize(value string) (int, int, bool) {
	value = strings.TrimSpace(strings.ToLower(strings.ReplaceAll(value, "×", "x")))
	separator := "x"
	if strings.Contains(value, "*") {
		separator = "*"
	}
	parts := strings.Split(value, separator)
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, widthErr := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, heightErr := strconv.Atoi(strings.TrimSpace(parts[1]))
	return width, height, widthErr == nil && heightErr == nil && width > 0 && height > 0
}

func apimartImageSizeResolution(value string) string {
	width, height, ok := parseAPIMartImageSize(value)
	if !ok {
		return ""
	}
	longSide := max(width, height)
	switch {
	case longSide >= 3500:
		return "4K"
	case longSide >= 1700:
		return "2K"
	case longSide >= 900:
		return "1K"
	default:
		return ""
	}
}

func apimartImageQualityResolution(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "standard":
		return "1K"
	case "medium", "hd":
		return "2K"
	case "high", "uhd":
		return "4K"
	default:
		return ""
	}
}

func clampAPIMartImageResolution(value string, contract apimartImageContract) string {
	level := apimartImageResolutionLevel(value)
	if level == 0 {
		return value
	}
	if maximum := apimartImageResolutionLevel(contract.maxResolution); maximum > 0 && level > maximum {
		level = maximum
	}
	if minimum := apimartImageResolutionLevel(contract.minResolution); minimum > 0 && level < minimum {
		level = minimum
	}
	return fmt.Sprintf("%dK", level)
}

func apimartImageResolutionLevel(value string) int {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "0.5", "0.5k", "512", "512p", "1", "1k", "1024", "1024p", "low", "standard":
		return 1
	case "2", "2k", "2048", "2048p", "medium", "hd":
		return 2
	case "3", "3k", "3072":
		return 3
	case "4", "4k", "4096", "4096p", "high", "uhd":
		return 4
	default:
		return 0
	}
}

func normalizeAPIMartImageResolutionValue(value, mode string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(strings.ToLower(value), "px")))
	switch normalized {
	case "0.5", "0.5k", "512", "512p":
		normalized = "0.5k"
	case "1", "1k", "1024", "1024p", "low", "standard":
		normalized = "1k"
	case "2", "2k", "2048", "2048p", "medium", "hd":
		normalized = "2k"
	case "3", "3k", "3072":
		normalized = "3k"
	case "4", "4k", "4096", "4096p", "high", "uhd":
		normalized = "4k"
	}
	if mode == "lower" {
		return normalized
	}
	return strings.ToUpper(normalized)
}

func normalizeAPIMartImageInt(value any) int {
	if number, ok := util.StrictInt(value); ok {
		return number
	}
	return util.ToInt(value, 0)
}

func normalizeAPIMartImageOutputFormat(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "jpg" {
		return "jpeg"
	}
	return value
}
