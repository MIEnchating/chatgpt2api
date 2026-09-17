package httpapi

import (
	"fmt"
	"net/http"
	"slices"
	"strings"

	"chatgpt2api/internal/model"
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

const imageModelDefinitionPayloadKey = "configured_image_model_definition"

func (a *App) attachImageModelDefinition(payload map[string]any) {
	delete(payload, imageModelDefinitionPayloadKey)
	if a == nil || a.config == nil || payload == nil {
		return
	}
	if definition, ok := a.config.ImageModelDefinitions()[util.Clean(payload["model"])]; ok {
		payload[imageModelDefinitionPayloadKey] = definition
	}
}

func configuredImageDefinition(payload map[string]any) (model.ImageModelDefinition, bool) {
	// Only server-attached typed values may select the adapter.
	definition, ok := payload[imageModelDefinitionPayloadKey].(model.ImageModelDefinition)
	return definition, ok
}

func imagePayloadRoute(payload map[string]any) util.ImageModelRoute {
	if definition, ok := configuredImageDefinition(payload); ok {
		return util.ImageModelRoute(definition.Protocol)
	}
	return util.ImageModelRouteFor(util.Clean(payload["model"]))
}

func validateConfiguredImageRequest(payload map[string]any, images []protocol.UploadedImage) error {
	d, ok := configuredImageDefinition(payload)
	if !ok {
		return nil
	}
	fail := func(message string) error {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("模型 %s: %s", util.Clean(payload["model"]), message)}
	}
	if len(images) > d.MaxReferenceImages {
		return fail(fmt.Sprintf("最多支持 %d 张参考图", d.MaxReferenceImages))
	}
	if normalizedProtocolImageCount(payload["n"]) > d.MaxOutputCount {
		return fail(fmt.Sprintf("单次最多生成 %d 张图片", d.MaxOutputCount))
	}
	if hasRelayImageMask(payload["input_image_mask"]) && !d.Mask {
		return fail("不支持遮罩编辑")
	}
	resolution := strings.ToLower(firstNonEmpty(util.Clean(payload["image_resolution"]), util.Clean(payload["resolution"])))
	if resolution != "" && resolution != "auto" && !slices.Contains(d.Resolutions, resolution) {
		return fail("不支持分辨率 " + resolution)
	}
	quality := strings.ToLower(util.Clean(payload["quality"]))
	if quality != "" && quality != "auto" && !slices.Contains(d.QualityValues, quality) {
		return fail("不支持质量档位 " + quality)
	}
	size := firstNonEmpty(util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
	if strings.Contains(size, ":") && !slices.Contains(d.AspectRatios, size) {
		return fail("不支持画幅比例 " + size)
	}
	return nil
}

func configuredImageAspectRatio(payload map[string]any, d model.ImageModelDefinition) string {
	value := firstNonEmpty(util.Clean(payload["aspect_ratio"]), util.Clean(payload["size"]))
	if slices.Contains(d.AspectRatios, value) {
		return value
	}
	if width, height, ok := parseRelayImageDimensions(value); ok {
		return closestImageAspectRatio(float64(width)/float64(height), d.AspectRatios)
	}
	return ""
}

func normalizeConfiguredImagePayload(payload map[string]any) bool {
	d, ok := configuredImageDefinition(payload)
	if !ok {
		return false
	}
	if !d.Streaming {
		delete(payload, "stream")
		delete(payload, "partial_images")
	}
	if !d.OutputControls {
		delete(payload, "output_format")
		delete(payload, "output_compression")
	}
	if !d.Mask {
		delete(payload, "input_image_mask")
	}
	quality := strings.ToLower(util.Clean(payload["quality"]))
	if len(d.QualityValues) == 0 || quality == "" || quality == "auto" {
		delete(payload, "quality")
	} else {
		payload["quality"] = quality
	}
	if d.Protocol == "xai-image" {
		if ratio := configuredImageAspectRatio(payload, d); ratio != "" {
			payload["aspect_ratio"] = ratio
		}
		resolution := strings.ToLower(firstNonEmpty(util.Clean(payload["image_resolution"]), util.Clean(payload["resolution"])))
		if resolution != "" && resolution != "auto" {
			payload["resolution"] = resolution
		} else {
			delete(payload, "resolution")
		}
		delete(payload, "background")
		delete(payload, "moderation")
	}
	return true
}

func sanitizeConfiguredImagePayload(payload map[string]any) bool {
	d, ok := configuredImageDefinition(payload)
	if !ok {
		return false
	}
	normalizeConfiguredImagePayload(payload)
	if d.Protocol == "openai-image" {
		return false
	}
	if d.Protocol == "xai-image" {
		delete(payload, "size")
		delete(payload, "image_resolution")
		allowed := map[string]bool{"model": true, "prompt": true, "n": true, "images": true, "response_format": true, "aspect_ratio": true, "resolution": true, "quality": true, "stream": true, "partial_images": true}
		for key := range payload {
			if !allowed[key] {
				delete(payload, key)
			}
		}
	}
	return true
}
