package httpapi

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func sanitizeRelayImagePayload(payload map[string]any) {
	delete(payload, "messages")
	if sanitizeConfiguredImagePayload(payload) {
		return
	}
	model := util.Clean(payload["model"])
	isAPIMartImage := isAPIMartImagePayload(payload)
	isKIEImage := isKnownKIEImageModel(model)
	if _, configured := configuredImageDefinition(payload); configured {
		isKIEImage = false
	}
	route := imagePayloadRoute(payload)
	if isKIEImage || isAPIMartImage {
		// Provider-specific schemas are strict. Their normalizers have already
		// selected the accepted fields, so skip generic OpenAI cleanup.
		delete(payload, "stream")
		delete(payload, "partial_images")
		delete(payload, "response_format")
		delete(payload, "input_image_mask")
		delete(payload, "background")
		delete(payload, "moderation")
		delete(payload, "output_compression")
		return
	}
	if route == util.ImageModelRouteGoogleGemini {
		delete(payload, "image_resolution")
		delete(payload, "stream")
		delete(payload, "partial_images")
		delete(payload, "output_format")
		delete(payload, "output_compression")
		delete(payload, "response_format")
		return
	}
	if route == util.ImageModelRouteZhipu {
		delete(payload, "image_resolution")
		// GLM-Image/CogView use the OpenAI image envelope for size and
		// quality, but their adapters do not accept streaming, output-format,
		// mask, or response-format controls.
		if _, ok := payload["size"]; ok {
			if normalizedSize, ok := normalizeRelayImageSize(util.Clean(payload["size"])); ok && normalizedSize != "" {
				payload["size"] = normalizedSize
			} else {
				delete(payload, "size")
			}
		}
		if quality := util.NormalizeZhipuImageQuality(util.Clean(payload["model"]), util.Clean(payload["quality"])); quality != "" && quality != "auto" {
			payload["quality"] = quality
		} else {
			delete(payload, "quality")
		}
		for _, key := range []string{"stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"} {
			delete(payload, key)
		}
		return
	}
	if route == util.ImageModelRouteAgnes {
		delete(payload, "image_resolution")
		ratioSource := firstNonEmpty(util.Clean(payload["ratio"]), util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
		if strings.EqualFold(strings.ReplaceAll(strings.ReplaceAll(util.Clean(payload["model"]), "_", "-"), " ", "-"), "agnes-image-2.1-flash") {
			payload["size"] = agnesImageSize(util.Clean(payload["size"]), util.Clean(payload["image_resolution"]), util.Clean(payload["quality"]))
			if ratioSource != "" {
				if normalizedRatio := normalizeAgnesImageRatio(ratioSource); normalizedRatio != "" {
					payload["ratio"] = normalizedRatio
				}
			}
		}
		delete(payload, "quality")
		delete(payload, "stream")
		delete(payload, "partial_images")
		delete(payload, "output_format")
		delete(payload, "output_compression")
		delete(payload, "response_format")
		delete(payload, "input_image_mask")
		return
	}
	if route == util.ImageModelRouteXAI {
		delete(payload, "image_resolution")
		normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
		aspectRatioSource := firstNonEmpty(util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
		if aspectRatio, ok := util.NormalizeXAIImageAspectRatio(aspectRatioSource); ok && aspectRatio != "" && aspectRatio != "auto" {
			payload["aspect_ratio"] = aspectRatio
		} else {
			delete(payload, "aspect_ratio")
		}
		resolutionSource := firstNonEmpty(referenceGrokImageResolution(model, util.Clean(payload["quality"])), util.Clean(payload["resolution"]))
		if resolution, ok := util.NormalizeXAIImageResolution(resolutionSource); ok && resolution != "" && resolution != "auto" {
			payload["resolution"] = resolution
		} else {
			delete(payload, "resolution")
		}
		delete(payload, "quality")
		if util.ToBool(payload["stream"]) {
			payload["stream"] = true
			if partialImages, ok := normalizeRelayImagePartialImages(payload["partial_images"]); ok {
				payload["partial_images"] = partialImages
			} else {
				payload["partial_images"] = 1
			}
		} else {
			delete(payload, "stream")
			delete(payload, "partial_images")
		}
		allowed := map[string]struct{}{
			"model":           {},
			"prompt":          {},
			"n":               {},
			"response_format": {},
			"aspect_ratio":    {},
			"resolution":      {},
			"stream":          {},
			"partial_images":  {},
			"images":          {},
		}
		for key := range payload {
			if _, ok := allowed[key]; !ok {
				delete(payload, key)
			}
		}
		return
	}
	delete(payload, "image_resolution")
	if util.ToBool(payload["stream"]) {
		payload["stream"] = true
		if partialImages, ok := normalizeRelayImagePartialImages(payload["partial_images"]); ok {
			payload["partial_images"] = partialImages
		} else {
			delete(payload, "partial_images")
		}
	} else {
		delete(payload, "stream")
		delete(payload, "partial_images")
	}

	if _, ok := payload["size"]; ok {
		if normalizedSize, ok := normalizeRelayImageSize(util.Clean(payload["size"])); ok && normalizedSize != "" {
			payload["size"] = normalizedSize
		} else {
			delete(payload, "size")
		}
	}
	normalizeRelayImageEnum(payload, "quality", map[string]string{"auto": "auto", "low": "low", "medium": "medium", "high": "high"})
	normalizeRelayImageEnum(payload, "background", map[string]string{"auto": "auto", "opaque": "opaque"})
	normalizeRelayImageEnum(payload, "moderation", map[string]string{"auto": "auto", "low": "low"})
	normalizeRelayImageEnum(payload, "response_format", map[string]string{"b64_json": "b64_json"})

	outputFormat := ""
	if _, ok := payload["output_format"]; ok {
		if format, ok := normalizeRelayImageOutputFormat(util.Clean(payload["output_format"])); ok {
			payload["output_format"] = format
			outputFormat = format
		} else {
			delete(payload, "output_format")
		}
	}
	if compression, ok := normalizeRelayImageOutputCompression(payload["output_compression"]); ok && relayImageOutputFormatSupportsCompression(outputFormat) {
		payload["output_compression"] = compression
	} else {
		delete(payload, "output_compression")
	}
}

func isKnownKIEImageModel(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	if !strings.Contains(value, "/") {
		return value == "z-image" ||
			strings.Contains(value, "nano-banana") ||
			strings.HasPrefix(value, "gpt-image-2-") ||
			strings.HasPrefix(value, "imagen4")
	}
	for _, prefix := range []string{
		"bytedance/seedream", "bytedance/seedance-4", "flux-2/",
		"google/imagen4", "google/nano-banana", "gpt-image/1.5",
		"grok-imagine/", "grok-imagine-image-2-0/", "ideogram/",
		"qwen/", "qwen2/", "recraft/", "seedream/", "topaz/",
		"wan/2-7-image",
	} {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

// normalizeImagePayloadForModel keeps only fields supported by the selected
// provider API and maps application size metadata to provider-native fields.
func normalizeImagePayloadForModel(payload map[string]any) {
	if payload == nil {
		return
	}
	if normalizeConfiguredImagePayload(payload) {
		return
	}
	if normalizeAPIMartImagePayload(payload) {
		return
	}
	if normalizeKIEImagePayload(payload) {
		return
	}
	switch util.ImageModelRouteFor(util.Clean(payload["model"])) {
	case util.ImageModelRouteGoogleGemini:
		for _, key := range []string{
			"quality", "background", "moderation", "stream", "partial_images",
			"output_format", "output_compression", "response_format", "input_image_mask",
		} {
			delete(payload, key)
		}
	case util.ImageModelRouteXAI:
		if !util.IsOfficialXAIImageModel(util.Clean(payload["model"])) {
			for _, key := range []string{
				"size", "requested_size", "image_resolution", "quality", "background",
				"moderation", "stream", "partial_images", "output_format",
				"output_compression", "input_image_mask", "aspect_ratio", "resolution",
				"image_format", "storage_options", "user",
			} {
				delete(payload, key)
			}
			normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
			return
		}
		aspectRatioSource := firstNonEmpty(util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
		if aspectRatio, ok := util.NormalizeXAIImageAspectRatio(aspectRatioSource); ok && aspectRatio != "" && aspectRatio != "auto" {
			payload["aspect_ratio"] = aspectRatio
			payload["size"] = aspectRatio
		} else {
			delete(payload, "aspect_ratio")
		}
		resolutionSource := firstNonEmpty(referenceGrokImageResolution(util.Clean(payload["model"]), util.Clean(payload["quality"])), util.Clean(payload["resolution"]), util.Clean(payload["image_resolution"]))
		if resolution, ok := util.NormalizeXAIImageResolution(resolutionSource); ok && resolution != "" && resolution != "auto" {
			payload["resolution"] = resolution
			payload["image_resolution"] = resolution
		} else {
			delete(payload, "resolution")
		}
		delete(payload, "quality")
		for _, key := range []string{
			"background", "moderation", "output_format",
			"output_compression", "input_image_mask",
			"image_format", "storage_options", "user",
		} {
			delete(payload, key)
		}
		if util.ToBool(payload["stream"]) {
			payload["stream"] = true
			if partialImages, ok := normalizeRelayImagePartialImages(payload["partial_images"]); ok {
				payload["partial_images"] = partialImages
			} else {
				payload["partial_images"] = 1
			}
		} else {
			delete(payload, "stream")
			delete(payload, "partial_images")
		}
		normalizeRelayImageEnum(payload, "response_format", map[string]string{"url": "url", "b64_json": "b64_json"})
	case util.ImageModelRouteZhipu:
		if quality := util.NormalizeZhipuImageQuality(util.Clean(payload["model"]), util.Clean(payload["quality"])); quality != "" && quality != "auto" {
			payload["quality"] = quality
		} else {
			delete(payload, "quality")
		}
		for _, key := range []string{"stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"} {
			delete(payload, key)
		}
	case util.ImageModelRouteAgnes:
		if ratio := firstNonEmpty(util.Clean(payload["ratio"]), util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"])); ratio != "" {
			if normalizedRatio := normalizeAgnesImageRatio(ratio); normalizedRatio != "" {
				payload["ratio"] = normalizedRatio
			}
		}
		if strings.EqualFold(strings.ReplaceAll(strings.ReplaceAll(util.Clean(payload["model"]), "_", "-"), " ", "-"), "agnes-image-2.1-flash") {
			payload["size"] = agnesImageSize(util.Clean(payload["size"]), util.Clean(payload["image_resolution"]), util.Clean(payload["quality"]))
		}
		delete(payload, "quality")
		for _, key := range []string{"stream", "partial_images", "output_format", "output_compression", "response_format", "input_image_mask"} {
			delete(payload, key)
		}
	}
}

// normalizeKIEImagePayload mirrors the reference project's model-specific
// image input contract. Only known KIE model IDs are handled here; unknown
// slash-qualified custom models retain the generic OpenAI-compatible payload.
func normalizeKIEImagePayload(payload map[string]any) bool {
	name := strings.ToLower(strings.TrimSpace(util.Clean(payload["model"])))
	if !isKnownKIEImageModel(name) {
		return false
	}
	originalPayload := util.CopyMap(payload)
	imageSize := firstNonEmpty(util.Clean(payload["image_size"]), util.Clean(payload["size"]))
	resolution := firstNonEmpty(util.Clean(payload["image_resolution"]), util.Clean(payload["resolution"]))
	count := firstNonNilRelayValue(payload["n"], payload["num_images"], payload["max_images"], payload["actual_image_count"])
	delete(payload, "resolution")
	delete(payload, "image_resolution")
	delete(payload, "n")
	delete(payload, "num_images")
	delete(payload, "max_images")
	delete(payload, "actual_image_count")
	mapAspectRatio := func() {
		if imageSize == "" {
			return
		}
		if ratio := normalizeKIEAspectRatio(imageSize); ratio != "" {
			payload["aspect_ratio"] = ratio
		}
		delete(payload, "size")
	}
	mapImageSize := func() {
		if imageSize != "" {
			payload["image_size"] = normalizeKIEImageSizeName(imageSize)
		}
		delete(payload, "size")
	}
	mapResolution := func(field string) {
		if resolution != "" {
			payload[field] = normalizeKIEImageResolutionValue(resolution)
		}
		if field != "resolution" {
			delete(payload, "resolution")
		}
		if field != "image_resolution" {
			delete(payload, "image_resolution")
		}
	}
	mapImageResolutionFromSize := func(field string, maxResolution string) {
		if resolution != "" || imageSize == "" {
			return
		}
		derived := normalizeKIEImageResolutionFromSize(imageSize)
		if derived == "" {
			return
		}
		if maxResolution == "2K" && derived == "4K" {
			derived = "2K"
		}
		payload[field] = derived
	}
	mapQuality := func(allowed bool, modelPrefix string) {
		quality := strings.ToLower(strings.TrimSpace(util.Clean(payload["quality"])))
		if quality == "" {
			return
		}
		if !allowed {
			resolutionValue := normalizeKIEQualityResolutionValue(quality)
			if resolutionValue != "" && resolution == "" {
				payload["resolution"] = resolutionValue
			}
			delete(payload, "quality")
			return
		}
		switch modelPrefix {
		case "gpt-image/1.5":
			if quality != "high" {
				quality = "medium"
			}
		case "seedream/4.5", "seedream/5-lite":
			if quality == "high" || quality == "4k" {
				quality = "high"
			} else {
				quality = "basic"
			}
		case "seedream/5-pro":
			if quality == "high" || quality == "2k" {
				quality = "high"
			} else {
				quality = "basic"
			}
		}
		payload["quality"] = quality
	}
	mapCount := func(field string, asString bool) {
		if count == nil {
			return
		}
		if asString {
			payload[field] = util.Clean(count)
		} else {
			payload[field] = count
		}
		if field != "n" {
			delete(payload, "n")
		}
	}
	mapReferenceFrom := func(field string, sources []string) {
		if len(normalizeKIEReferenceArrayValue(payload[field])) > 0 {
			return
		}
		for _, source := range sources {
			if value, ok := payload[source]; ok {
				values := normalizeKIEReferenceArrayValue(value)
				if len(values) == 0 {
					continue
				}
				if isKIEImageReferenceArrayFieldName(field) {
					payload[field] = values
				} else {
					payload[field] = values[0]
				}
				if source != field {
					delete(payload, source)
				}
				return
			}
		}
	}
	mapReference := func(field string) {
		mapReferenceFrom(field, []string{"input_urls", "image_urls", "input_url", "image_url", "images"})
	}

	switch {
	case name == "seedream/5-pro-layer-decomposition":
		// This endpoint is intentionally different from the other Seedream
		// variants in the reference project: it accepts one image_url, a
		// dedicated size enum, and always returns PNG layers.
		mapReference("image_url")
		layerSize := firstNonEmpty(imageSize, resolution)
		switch strings.ToLower(strings.TrimSpace(layerSize)) {
		case "1k", "1.5k", "2k":
			payload["size"] = strings.ToUpper(layerSize)
		case "auto":
			payload["size"] = "auto"
		default:
			switch strings.ToLower(strings.TrimSpace(util.Clean(payload["quality"]))) {
			case "low":
				payload["size"] = "1K"
			case "medium":
				payload["size"] = "1.5K"
			case "high":
				payload["size"] = "2K"
			default:
				payload["size"] = "auto"
			}
		}
		payload["output_format"] = "png"
		for _, key := range []string{"quality", "ratio", "aspect_ratio", "image_size", "resolution", "image_resolution", "n", "num_images", "max_images", "actual_image_count", "requested_size"} {
			delete(payload, key)
		}
	case strings.Contains(name, "seedream/4.5"), strings.Contains(name, "gpt-image/1.5"):
		mapAspectRatio()
		// These endpoints expose quality, not a separate resolution field.
		// The reference project sends only aspect_ratio and quality here.
		delete(payload, "resolution")
		if strings.Contains(name, "seedream/4.5") && strings.Contains(name, "edit") {
			mapReference("image_urls")
		}
		if strings.Contains(name, "gpt-image/1.5") && strings.Contains(name, "image-to-image") {
			mapReference("input_urls")
		}
		if strings.Contains(name, "seedream/4.5") {
			mapQuality(true, "seedream/4.5")
		} else {
			mapQuality(true, "gpt-image/1.5")
		}
	case strings.Contains(name, "seedream"), strings.Contains(name, "seedance-4"):
		if name == "bytedance/seedream" {
			// The legacy Seedream endpoint accepts only the named image_size
			// enum; unlike v4 it has no image_resolution field.
			mapImageSize()
			delete(payload, "image_resolution")
		} else if strings.Contains(name, "seedream-v4") {
			mapImageSize()
			mapResolution("image_resolution")
			mapImageResolutionFromSize("image_resolution", "")
		} else if strings.Contains(name, "seedream/4") {
			mapAspectRatio()
		} else if strings.Contains(name, "seedream/5") {
			mapAspectRatio()
		}
		if strings.Contains(name, "layer-decomposition") {
			mapReference("image_url")
		} else if strings.Contains(name, "edit") || strings.Contains(name, "image-to-image") {
			mapReference("image_urls")
		}
		if strings.Contains(name, "v4") {
			mapCount("max_images", false)
		}
		if strings.Contains(name, "seedream/5-lite") {
			mapQuality(true, "seedream/5-lite")
		} else if strings.Contains(name, "seedream/5-pro") {
			mapQuality(true, "seedream/5-pro")
		} else if name == "bytedance/seedream" {
			// Legacy Seedream has neither quality nor resolution controls.
			delete(payload, "quality")
		} else {
			mapQuality(false, "")
		}
		if name == "bytedance/seedream" || strings.Contains(name, "seedream-v4") {
			delete(payload, "aspect_ratio")
		}
	case strings.Contains(name, "flux-2"), strings.Contains(name, "gpt-image-2"):
		mapAspectRatio()
		mapResolution("resolution")
		if strings.Contains(name, "flux-2") {
			mapImageResolutionFromSize("resolution", "2K")
			if value := normalizeKIEImageResolutionValue(util.Clean(payload["resolution"])); value == "4K" {
				payload["resolution"] = "2K"
			}
		} else {
			mapImageResolutionFromSize("resolution", "")
		}
		if strings.Contains(name, "image-to-image") {
			mapReference("input_urls")
		}
	case strings.Contains(name, "nano-banana"):
		mapAspectRatio()
		if (strings.Contains(name, "nano-banana-2") && !strings.Contains(name, "nano-banana-2-lite")) || strings.Contains(name, "nano-banana-pro") {
			mapResolution("resolution")
			mapImageResolutionFromSize("resolution", "")
		} else {
			delete(payload, "resolution")
		}
		if strings.Contains(name, "nano-banana-2-lite") {
			mapReference("image_urls")
		} else if strings.Contains(name, "nano-banana-2") || strings.Contains(name, "nano-banana-pro") {
			mapReference("image_input")
		} else if strings.Contains(name, "edit") {
			mapReference("image_urls")
		}
		delete(payload, "size")
	case strings.Contains(name, "wan/2-7-image"):
		mapAspectRatio()
		mapResolution("resolution")
		mapImageResolutionFromSize("resolution", "")
		mapCount("n", false)
		mapReference("input_urls")
	case strings.Contains(name, "ideogram/"):
		if !strings.Contains(name, "character-edit") && !strings.Contains(name, "v3-edit") {
			mapImageSize()
		} else {
			delete(payload, "size")
		}
		if strings.Contains(name, "character") || strings.Contains(name, "v3-remix") {
			mapCount("num_images", true)
		}
		if strings.Contains(name, "v3-remix") {
			// Ideogram v3 Remix uses one source image under image_url. The
			// character-remix endpoint is the separate variant that accepts
			// reference_image_urls.
			mapReferenceFrom("image_url", []string{"input_urls", "image_urls", "input_url", "image_url", "images", "reference_image_urls"})
		} else if strings.Contains(name, "character-remix") {
			// Character Remix has two independent image inputs: the base
			// image_url and one or more character reference images. Do not
			// consume reference_image_urls as the base image when image_url is
			// absent; the provider validates both fields separately.
			mapReferenceFrom("image_url", []string{"input_urls", "image_urls", "input_url", "image_url", "images"})
			if values := normalizeKIEReferenceArrayValue(payload["reference_image_urls"]); len(values) > 0 {
				payload["reference_image_urls"] = values
			}
		} else if strings.Contains(name, "edit") {
			mapReference("image_url")
			mapReferenceFrom("mask_url", []string{"mask_urls", "mask_url", "mask"})
			// Character Edit has a second, independent reference_image_urls
			// input. Preserve it instead of consuming it as the base image.
			if strings.Contains(name, "character-edit") {
				if values := normalizeKIEReferenceArrayValue(payload["reference_image_urls"]); len(values) > 0 {
					payload["reference_image_urls"] = values
				}
			}
		} else if strings.Contains(name, "character") || strings.Contains(name, "remix") {
			mapReference("reference_image_urls")
		}
	case strings.Contains(name, "qwen"):
		if !strings.Contains(name, "image-to-image") {
			mapImageSize()
		} else {
			delete(payload, "size")
		}
		if strings.Contains(name, "image-to-image") || strings.Contains(name, "edit") {
			mapReferenceFrom("image_url", []string{"input_urls", "image_urls", "input_url", "image_url", "images", "reference_image_urls"})
		}
		if name == "qwen/image-edit" {
			mapCount("num_images", true)
		}
		// Qwen's image_size is an aspect-ratio enum. A generic resolution
		// value must not be coerced into that field.
		delete(payload, "resolution")
	case strings.Contains(name, "imagen4"), strings.Contains(name, "grok-imagine"):
		if strings.Contains(name, "imagen4") || strings.Contains(name, "text-to-image") {
			mapAspectRatio()
		} else {
			delete(payload, "size")
			delete(payload, "aspect_ratio")
		}
		if strings.Contains(name, "grok-imagine") {
			switch {
			case strings.Contains(name, "extend"):
				mapReference("image_url")
			case strings.Contains(name, "image-to-image"):
				mapReference("image_urls")
			}
		}
		delete(payload, "size")
	case strings.Contains(name, "recraft/"):
		mapReference("image")
		delete(payload, "size")
		delete(payload, "aspect_ratio")
	case strings.Contains(name, "topaz/"):
		if strings.Contains(name, "video-upscale") {
			mapReferenceFrom("video_url", []string{"video_urls", "video_url", "input_video_urls", "reference_video_urls"})
		} else {
			mapReference("image_url")
		}
		delete(payload, "size")
		delete(payload, "aspect_ratio")
	case name == "z-image":
		mapAspectRatio()
		delete(payload, "size")
	default:
		clear(payload)
		for key, value := range originalPayload {
			payload[key] = value
		}
		return false
	}
	clearKIEImageReferenceAliases(payload, name)
	if !supportsKIEImageOutputFormat(name) {
		delete(payload, "output_format")
	} else if format := strings.TrimSpace(util.Clean(payload["output_format"])); format != "" {
		payload["output_format"] = normalizeKIEOutputFormatValue(format)
	}
	if !supportsKIEImageQuality(name) {
		delete(payload, "quality")
	}
	delete(payload, "requested_size")
	return true
}

// KIE accepts one provider-native reference field per image model. Remove
// stale compatibility aliases after mapping so a caller that reuses a payload
// cannot accidentally send unrelated image/video/audio fields to a strict
// endpoint. This mirrors the reference handler's clearKIEReferenceAliases.
func clearKIEImageReferenceAliases(payload map[string]any, model string) {
	keep := map[string]bool{}
	name := strings.ToLower(strings.TrimSpace(model))
	keepField := func(fields ...string) {
		for _, field := range fields {
			keep[field] = true
		}
	}
	switch {
	case strings.Contains(name, "topaz/") && strings.Contains(name, "video-upscale"):
		keepField("video_url")
	case strings.Contains(name, "recraft/"):
		keepField("image")
	case strings.HasPrefix(name, "ideogram/"):
		switch {
		case strings.Contains(name, "v3-edit"):
			keepField("image_url", "mask_url")
		case strings.Contains(name, "character-edit"):
			keepField("image_url", "reference_image_urls", "mask_url")
		case strings.Contains(name, "character-remix"):
			keepField("image_url", "reference_image_urls")
		case strings.HasSuffix(name, "/character"):
			keepField("reference_image_urls")
		case strings.Contains(name, "v3-remix"):
			keepField("image_url")
		}
	case strings.Contains(name, "qwen"):
		if strings.Contains(name, "image-to-image") || strings.Contains(name, "edit") {
			keepField("image_url")
		}
	case strings.Contains(name, "nano-banana") || strings.Contains(name, "google/nano-banana"):
		if (strings.Contains(name, "nano-banana-2") && !strings.Contains(name, "nano-banana-2-lite")) || strings.Contains(name, "nano-banana-pro") {
			keepField("image_input")
		} else if strings.Contains(name, "nano-banana-2-lite") || strings.Contains(name, "edit") {
			keepField("image_urls")
		}
	case strings.Contains(name, "grok-imagine"):
		if strings.Contains(name, "extend") {
			keepField("image_url")
		} else if strings.Contains(name, "image-to-image") {
			keepField("image_urls")
		}
	case strings.Contains(name, "gpt-image/1.5"):
		if strings.Contains(name, "image-to-image") {
			keepField("input_urls")
		}
	case strings.Contains(name, "flux-2"), strings.Contains(name, "gpt-image-2"):
		if strings.Contains(name, "image-to-image") {
			keepField("input_urls")
		}
	case strings.Contains(name, "seedream/4.5"):
		if strings.Contains(name, "edit") {
			keepField("image_urls")
		}
	case strings.Contains(name, "seedream"):
		if strings.Contains(name, "layer-decomposition") {
			keepField("image_url")
		} else if strings.Contains(name, "edit") || strings.Contains(name, "image-to-image") {
			keepField("image_urls")
		}
	case strings.Contains(name, "wan/2-7-image"):
		keepField("input_urls")
	case strings.Contains(name, "topaz/"):
		keepField("image_url")
	}
	for _, key := range []string{
		"image", "images", "image_url", "image_urls", "input_url", "input_urls", "input_reference", "input_reference[]", "image_input",
		"reference_image", "reference_images", "reference_image_url", "reference_image_urls", "first_frame_url", "last_frame_url", "end_image_url", "tail_image_url",
		"video", "videos", "video_url", "video_urls", "input_video_url", "input_video_urls", "video_reference", "video_reference[]", "first_clip_url", "reference_video", "reference_videos", "reference_video_url", "reference_video_urls",
		"audio", "audios", "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "reference_audio", "reference_audios", "reference_audio_url", "reference_audio_urls", "audio_reference", "audio_reference[]", "driving_audio_url", "reference_voice", "audio_ids",
		"mask", "mask_url", "mask_urls",
	} {
		if !keep[key] {
			delete(payload, key)
		}
	}
}

func normalizeKIEImageSizeName(value string) string {
	ratio := normalizeKIEAspectRatio(value)
	switch ratio {
	case "", "auto":
		return ratio
	case "1:1":
		return "square_hd"
	case "16:9":
		return "landscape_16_9"
	case "9:16":
		return "portrait_16_9"
	case "4:3":
		return "landscape_4_3"
	case "3:4":
		return "portrait_4_3"
	default:
		return ratio
	}
}

func normalizeKIEAspectRatio(value string) string {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
	switch normalized {
	case "", "auto", "adaptive":
		return normalized
	case "landscape", "landscape_16_9", "1280x720", "1920x1080", "1024x576", "720x405":
		return "16:9"
	case "portrait", "portrait_16_9", "720x1280", "1080x1920", "576x1024", "405x720":
		return "9:16"
	case "square", "square_hd", "1024x1024", "1080x1080", "960x960":
		return "1:1"
	case "landscape_4_3":
		return "4:3"
	case "portrait_4_3":
		return "3:4"
	}
	separator := ":"
	if strings.Contains(normalized, "x") {
		separator = "x"
	} else if strings.Contains(normalized, "*") {
		separator = "*"
	}
	parts := strings.Split(normalized, separator)
	if len(parts) != 2 {
		return normalized
	}
	width, widthErr := strconv.ParseFloat(parts[0], 64)
	height, heightErr := strconv.ParseFloat(parts[1], 64)
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return normalized
	}
	options := []struct {
		name  string
		value float64
	}{
		{name: "1:1", value: 1},
		{name: "16:9", value: 16.0 / 9},
		{name: "9:16", value: 9.0 / 16},
		{name: "4:3", value: 4.0 / 3},
		{name: "3:4", value: 3.0 / 4},
		{name: "21:9", value: 21.0 / 9},
	}
	target := width / height
	best := options[0]
	bestDiff := math.Abs(target-best.value) / best.value
	for _, option := range options[1:] {
		diff := math.Abs(target-option.value) / option.value
		if diff < bestDiff {
			best, bestDiff = option, diff
		}
	}
	if bestDiff <= 0.04 {
		return best.name
	}
	return strconv.FormatFloat(width, 'f', -1, 64) + ":" + strconv.FormatFloat(height, 'f', -1, 64)
}

func firstNonNilRelayValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func normalizeKIEImageResolutionValue(value string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), " ", "")
	switch strings.ToLower(normalized) {
	case "":
		return ""
	case "auto":
		return "auto"
	case "1", "1k", "1024", "1024p":
		return "1K"
	case "2", "2k", "2048", "2048p":
		return "2K"
	case "4", "4k", "4096", "4096p":
		return "4K"
	default:
		if strings.HasSuffix(strings.ToLower(normalized), "k") {
			return strings.ToUpper(normalized)
		}
		return normalized
	}
}

// Reference image models derive their resolution tier from a pixel size when
// the caller did not provide an explicit quality/resolution value. This is
// the same longest-edge bucketing used by the reference project's KIE
// handler: at least 900px is 1K, 1700px is 2K, and 3500px is 4K.
func normalizeKIEImageResolutionFromSize(value string) string {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
	separator := "x"
	if strings.Contains(normalized, "*") {
		separator = "*"
	}
	parts := strings.Split(normalized, separator)
	if len(parts) != 2 {
		return ""
	}
	width, errWidth := strconv.Atoi(parts[0])
	height, errHeight := strconv.Atoi(parts[1])
	if errWidth != nil || errHeight != nil || width <= 0 || height <= 0 {
		return ""
	}
	longSide := width
	if height > longSide {
		longSide = height
	}
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

func normalizeKIEQualityResolutionValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "standard", "1k":
		return "1K"
	case "medium", "hd", "2k":
		return "2K"
	case "high", "4k":
		return "4K"
	default:
		return ""
	}
}

func supportsKIEImageOutputFormat(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	return (strings.Contains(value, "nano-banana-2") && !strings.Contains(value, "nano-banana-2-lite")) || strings.Contains(value, "nano-banana-pro") ||
		value == "google/nano-banana" || value == "google/nano-banana-edit" ||
		value == "seedream/5-pro-layer-decomposition" ||
		strings.HasPrefix(value, "qwen/") || strings.HasPrefix(value, "qwen2/")
}

func supportsKIEImageQuality(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(value, "gpt-image/1.5") || strings.HasPrefix(value, "seedream/4.5") || strings.HasPrefix(value, "seedream/5-lite") || strings.HasPrefix(value, "seedream/5-pro")
}

func normalizeKIEOutputFormatValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "jpg", "jpeg":
		return "jpg"
	case "png":
		return "png"
	case "webp":
		return "png"
	default:
		return value
	}
}

func isKIEImageReferenceArrayFieldName(field string) bool {
	switch field {
	case "image_urls", "input_urls", "image_input", "reference_image_urls":
		return true
	default:
		return false
	}
}

func normalizeKIEReferenceArrayValue(value any) []string {
	values := make([]string, 0)
	appendValue := func(item any) {
		if text := strings.TrimSpace(util.Clean(item)); text != "" {
			values = append(values, text)
		}
	}
	switch typed := value.(type) {
	case []string:
		for _, item := range typed {
			appendValue(item)
		}
	case []any:
		for _, item := range typed {
			appendValue(item)
		}
	default:
		appendValue(value)
	}
	return values
}

func agnesImageSize(currentSize, resolution, quality string) string {
	for _, value := range []string{currentSize, resolution} {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "1k", "2k", "3k", "4k":
			return strings.ToUpper(strings.TrimSpace(value))
		}
	}
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "low":
		return "2K"
	case "medium":
		return "3K"
	case "high":
		return "4K"
	default:
		return "1K"
	}
}

func normalizeAgnesImageRatio(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "×", "x")))
	if normalized == "auto" || normalized == "" {
		return "1:1"
	}
	if width, height, ok := parseRelayImageRatio(normalized); ok {
		return closestImageAspectRatio(width/height, []string{"1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"})
	}
	if width, height, ok := parseRelayImageDimensions(normalized); ok {
		return closestImageAspectRatio(float64(width)/float64(height), []string{"1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"})
	}
	return ""
}

func normalizeRelayImagePartialImages(value any) (int, bool) {
	partialImages, ok := util.StrictInt(value)
	if !ok || partialImages < 0 || partialImages > 3 {
		return 0, false
	}
	return partialImages, true
}

func referenceGrokImageResolution(model, quality string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	if !strings.HasPrefix(model, "grok-imagine-image") {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "low":
		return "1k"
	case "medium", "high":
		if strings.Contains(model, "edit") {
			return "1k"
		}
		return "2k"
	default:
		return ""
	}
}

func normalizeRelayImageEnum(payload map[string]any, key string, allowed map[string]string) {
	if _, ok := payload[key]; !ok {
		return
	}
	normalized := strings.ToLower(strings.TrimSpace(util.Clean(payload[key])))
	if value, ok := allowed[normalized]; ok {
		payload[key] = value
		return
	}
	delete(payload, key)
}

func normalizeRelayImageOutputFormat(format string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "png":
		return "png", true
	case "jpg", "jpeg":
		return "jpeg", true
	case "webp":
		return "webp", true
	default:
		return "", false
	}
}

func relayImageOutputFormatSupportsCompression(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpeg", "webp":
		return true
	default:
		return false
	}
}

func normalizeRelayImageOutputCompression(value any) (int, bool) {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return 0, false
	}
	compression, ok := util.StrictInt(value)
	if !ok || compression < 0 {
		return 0, false
	}
	if compression > 100 {
		compression = 100
	}
	return compression, true
}

func normalizeRelayImageSize(size string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(size))
	normalized = strings.ReplaceAll(normalized, " ", "")
	normalized = strings.ReplaceAll(normalized, "×", "x")
	if normalized == "" || normalized == "auto" {
		return "", true
	}
	switch normalized {
	case "1080p":
		return normalizeRelayImageDimensions(1080, 1080), true
	case "2k":
		return normalizeRelayImageDimensions(2048, 2048), true
	case "4k":
		return normalizeRelayImageDimensions(3840, 3840), true
	case "2048x2048", "2048x1152", "1152x2048", "3136x1344",
		"3840x2160", "2160x3840", "6272x2688":
		// Preserve the exact high-resolution presets used by the reference
		// project. Generic dimensions still pass through the safety normalizer.
		return normalized, true
	}
	if width, height, ok := parseRelayImageDimensions(normalized); ok {
		if width < 128 && height < 128 {
			return relayImageSizeFromRatio(float64(width), float64(height)), true
		}
		return normalizeRelayImageDimensions(width, height), true
	}
	if ratioWidth, ratioHeight, ok := parseRelayImageRatio(normalized); ok {
		return relayImageSizeFromRatio(ratioWidth, ratioHeight), true
	}
	return "", false
}

func parseRelayImageDimensions(value string) (int, int, bool) {
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, err := strconv.Atoi(parts[0])
	if err != nil || width <= 0 {
		return 0, 0, false
	}
	height, err := strconv.Atoi(parts[1])
	if err != nil || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func parseRelayImageRatio(value string) (float64, float64, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || width <= 0 || math.IsNaN(width) || math.IsInf(width, 0) {
		return 0, 0, false
	}
	height, err := strconv.ParseFloat(parts[1], 64)
	if err != nil || height <= 0 || math.IsNaN(height) || math.IsInf(height, 0) {
		return 0, 0, false
	}
	if ratio := width / height; ratio <= 0 || math.IsInf(ratio, 0) {
		return 0, 0, false
	}
	return width, height, true
}

func relayImageSizeFromRatio(ratioWidth, ratioHeight float64) string {
	if ratioWidth <= 0 || ratioHeight <= 0 {
		return ""
	}
	if ratioWidth == ratioHeight {
		return normalizeRelayImageDimensions(1024, 1024)
	}
	if ratioWidth > ratioHeight {
		return normalizeRelayImageDimensions(1536, int(ratioHeight/ratioWidth*1536+0.5))
	}
	return normalizeRelayImageDimensions(int(ratioWidth/ratioHeight*1536+0.5), 1536)
}

func normalizeRelayImageDimensions(width, height int) string {
	const (
		maxEdge   = 3840
		maxRatio  = 3
		minPixels = 655360
		maxPixels = 8294400
	)
	normalizedWidth := roundToRelayImageMultiple(width)
	normalizedHeight := roundToRelayImageMultiple(height)

	scaleToFit := func(scale float64) {
		normalizedWidth = floorToRelayImageMultiple(float64(normalizedWidth) * scale)
		normalizedHeight = floorToRelayImageMultiple(float64(normalizedHeight) * scale)
	}
	scaleToFill := func(scale float64) {
		normalizedWidth = ceilToRelayImageMultiple(float64(normalizedWidth) * scale)
		normalizedHeight = ceilToRelayImageMultiple(float64(normalizedHeight) * scale)
	}

	for range 4 {
		if max(normalizedWidth, normalizedHeight) > maxEdge {
			scaleToFit(float64(maxEdge) / float64(max(normalizedWidth, normalizedHeight)))
		}
		if normalizedWidth > normalizedHeight*maxRatio {
			normalizedWidth = floorToRelayImageMultiple(float64(normalizedHeight * maxRatio))
		} else if normalizedHeight > normalizedWidth*maxRatio {
			normalizedHeight = floorToRelayImageMultiple(float64(normalizedWidth * maxRatio))
		}
		pixels := normalizedWidth * normalizedHeight
		if pixels > maxPixels {
			scaleToFit(math.Sqrt(float64(maxPixels) / float64(pixels)))
		} else if pixels < minPixels {
			scaleToFill(math.Sqrt(float64(minPixels) / float64(pixels)))
		}
	}
	return fmt.Sprintf("%dx%d", normalizedWidth, normalizedHeight)
}

func roundToRelayImageMultiple(value int) int {
	remainder := value % relayImageDimensionMultiple
	rounded := value - remainder
	if remainder >= relayImageDimensionMultiple/2 && rounded <= math.MaxInt-relayImageDimensionMultiple {
		rounded += relayImageDimensionMultiple
	}
	return max(relayImageDimensionMultiple, rounded)
}

func floorToRelayImageMultiple(value float64) int {
	return max(relayImageDimensionMultiple, int(value/float64(relayImageDimensionMultiple))*relayImageDimensionMultiple)
}

func ceilToRelayImageMultiple(value float64) int {
	return max(relayImageDimensionMultiple, int(math.Ceil(value/float64(relayImageDimensionMultiple)))*relayImageDimensionMultiple)
}

func shouldDropRelayPayloadKey(key string) bool {
	switch key {
	case "api_key", "relay_api_key", "relayai_api_key", "upstream_api_key",
		relayTranslationSourceKey, relayTaskCredentialKey, "relay_base_url", "relay_protocol", "workflow_inputs", relayCustomEndpointPayloadKey,
		"token_group", "newapi_token_group", "relay_token_group",
		"token_name", "newapi_token_name", "relay_token_name",
		"owner_id", "owner_name", "base_url", "visibility", "client_task_id",
		"requested_size", "images", "api_mode",
		"share_prompt_parameters", "share_reference_images",
		relayImageTaskSlotManagedPayloadKey,
		service.ImageOutputCompletionReleasePayloadKey,
		protocol.ImageOutputSlotAcquirerPayloadKey,
		"image_output_callback", "text_output_callback", service.VideoTaskProgressCallbackPayloadKey,
		service.MediaTaskProgressCallbackPayloadKey:
		return true
	default:
		return false
	}
}
