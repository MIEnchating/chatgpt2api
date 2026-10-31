package httpapi

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func validateRelayImageRequest(pathValue, model string, payload map[string]any, images []protocol.UploadedImage) error {
	if err := validateConfiguredImageRequest(payload, images); err != nil {
		return err
	}
	if err := validateRelayImageIntegerParameter(payload, "partial_images", 0, 3); err != nil {
		return err
	}
	if err := validateRelayImageIntegerParameter(payload, "output_compression", 0, 100); err != nil {
		return err
	}
	if _, configured := configuredImageDefinition(payload); configured {
		return validateRelayImageMask(pathValue, model, payload, images)
	}
	if err := validateKIEImageRequiredInput(model, payload, len(images)); err != nil {
		return err
	}
	if err := validateKIEImageReferenceURLs(model, payload); err != nil {
		return err
	}
	if err := validateAPIMartImageRequiredInput(model, payload, len(images)); err != nil {
		return err
	}
	return validateRelayImageMask(pathValue, model, payload, images)
}

// KIE image endpoints dereference reference fields server-side. Inline data
// URLs, localhost, private-network URLs, and overlong URLs therefore cannot
// work even when the surrounding OpenAI-compatible request accepts them.
func validateKIEImageReferenceURLs(model string, payload map[string]any) error {
	if !isKnownKIEImageModel(model) || payload == nil || isAPIMartImagePayload(payload) {
		return nil
	}
	for _, key := range []string{
		"image_url", "image_urls", "input_url", "input_urls", "images", "image", "image_input",
		"reference_image_url", "reference_image_urls", "mask", "mask_url", "mask_urls",
		"video_url", "video_urls", "input_video_urls", "reference_video_urls",
	} {
		for _, value := range normalizeKIEReferenceArrayValue(payload[key]) {
			if !isPublicReferenceURL(value) {
				return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("模型 %s 的 %s 必须使用公网可访问的 http:// 或 https:// URL", model, key)}
			}
		}
	}
	return nil
}

func validateKIEImageRequiredInput(model string, payload map[string]any, uploaded int) error {
	name := strings.ToLower(strings.TrimSpace(model))
	if !isKnownKIEImageModel(name) || isAPIMartImagePayload(payload) {
		return nil
	}
	has := func(fields ...string) bool {
		for _, field := range fields {
			if len(normalizeKIEReferenceArrayValue(payload[field])) > 0 {
				return true
			}
		}
		return false
	}
	// A multipart upload satisfies the model's primary image input, but it does
	// not satisfy additional provider-native inputs such as a mask or a
	// character reference image. Keep those requirements explicit so strict
	// KIE schemas fail locally with an actionable message instead of returning
	// a generic upstream 422.
	hasBaseImage := uploaded > 0 || has("image_url", "image_urls", "input_urls", "input_url", "images", "image", "image_input", "reference_image")
	if name == "ideogram/v3-remix" || strings.HasPrefix(name, "qwen/") || strings.HasPrefix(name, "qwen2/") {
		hasBaseImage = hasBaseImage || has("reference_image_urls")
	}
	requireBase := func() error {
		if hasBaseImage {
			return nil
		}
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("模型 %s 必须提供参考图片 URL 或上传图片", model)}
	}
	requireField := func(label string, fields ...string) error {
		if has(fields...) {
			return nil
		}
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("模型 %s 必须提供 %s", model, label)}
	}
	switch {
	case name == "ideogram/v3-edit":
		if err := requireBase(); err != nil {
			return err
		}
		// The KIE endpoint requires a public mask_url. OpenAI's
		// input_image_mask multipart field is a different contract and is
		// intentionally not accepted as a substitute here.
		return requireField("mask_url", "mask_url", "mask_urls")
	case name == "ideogram/character-edit":
		if err := requireBase(); err != nil {
			return err
		}
		if err := requireField("mask_url", "mask_url", "mask_urls"); err != nil {
			return err
		}
		return requireField("reference_image_urls", "reference_image_urls")
	case name == "ideogram/character-remix":
		if err := requireBase(); err != nil {
			return err
		}
		return requireField("reference_image_urls", "reference_image_urls")
	case name == "ideogram/character":
		return requireField("reference_image_urls", "reference_image_urls")
	case name == "topaz/video-upscale":
		return requireField("video_url", "video_url", "video_urls", "input_video_urls", "reference_video_urls")
	case strings.Contains(name, "qwen/image-to-image"), strings.Contains(name, "qwen/image-edit"), strings.Contains(name, "qwen2/image-edit"), strings.Contains(name, "ideogram/v3-remix"), strings.Contains(name, "seedream/5-pro-layer-decomposition"), strings.Contains(name, "image-to-image"), strings.Contains(name, "image-edit"), strings.Contains(name, "remix"):
		return requireBase()
	case strings.HasSuffix(name, "/extend"), strings.Contains(name, "upscale"), strings.Contains(name, "remove-background"):
		return requireBase()
	default:
		return nil
	}
}

func validateRelayImageIntegerParameter(payload map[string]any, key string, minimum, maximum int) error {
	if payload == nil || payload[key] == nil || strings.TrimSpace(util.Clean(payload[key])) == "" {
		return nil
	}
	value, ok := util.StrictInt(payload[key])
	if !ok || value < minimum || value > maximum {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("%s must be an integer between %d and %d", key, minimum, maximum)}
	}
	return nil
}

func validateRelayImageMask(pathValue, model string, payload map[string]any, images []protocol.UploadedImage) error {
	if payload == nil || !hasRelayImageMask(payload["input_image_mask"]) {
		return nil
	}
	if pathValue != "/v1/images/edits" && pathValue != "/api/creation-tasks/image-edits" {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask is only supported by the image edits endpoint"}
	}
	route := util.ImageModelRouteFor(model)
	if definition, configured := configuredImageDefinition(payload); configured {
		route = util.ImageModelRoute(definition.Protocol)
	}
	if route != util.ImageModelRouteOpenAI {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s does not support mask editing through NewAPI", model)}
	}
	if len(images) == 0 {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask requires an input image"}
	}
	mask, maskInfo, err := relayImageMask(payload["input_image_mask"])
	if err != nil {
		return err
	}
	firstInfo, err := util.InspectRasterImage(images[0].Data, "image/png")
	if err != nil {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "the first input image must be a PNG when a mask is provided"}
	}
	if firstInfo.Width != maskInfo.Width || firstInfo.Height != maskInfo.Height {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask and first input image must have the same dimensions"}
	}
	payload["input_image_mask"] = uploadedImageDataURL(mask)
	return nil
}

func hasRelayImageMask(value any) bool {
	if value == nil {
		return false
	}
	if item := util.StringMap(value); len(item) > 0 {
		return strings.TrimSpace(util.Clean(item["image_url"])) != "" || strings.TrimSpace(util.Clean(item["file_id"])) != ""
	}
	return strings.TrimSpace(util.Clean(value)) != ""
}

func relayImageMask(value any) (protocol.UploadedImage, util.RasterImageInfo, error) {
	raw := strings.TrimSpace(util.Clean(value))
	if item := util.StringMap(value); len(item) > 0 {
		raw = strings.TrimSpace(util.Clean(item["image_url"]))
	}
	if raw == "" {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask data is required"}
	}

	var (
		data        []byte
		contentType string
		err         error
	)
	if strings.HasPrefix(strings.ToLower(raw), "data:") {
		data, contentType, err = imageDataURLBytes(raw)
	} else {
		if len(raw) > base64.StdEncoding.EncodedLen(maxRelayImageBytes)+4 {
			return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusRequestEntityTooLarge, Message: "mask file is too large"}
		}
		data, err = base64.StdEncoding.DecodeString(raw)
		contentType = "image/png"
	}
	if err != nil {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask must be a valid base64-encoded PNG"}
	}
	if len(data) > maxRelayImageBytes {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusRequestEntityTooLarge, Message: "mask file is too large"}
	}
	info, err := util.InspectRasterImage(data, "image/png")
	if err != nil || !strings.EqualFold(contentType, "image/png") {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask must be a PNG image"}
	}
	if !pngHasAlphaChannel(data) {
		return protocol.UploadedImage{}, util.RasterImageInfo{}, protocol.HTTPError{Status: http.StatusBadRequest, Message: "mask PNG must contain an alpha channel"}
	}
	return protocol.UploadedImage{Data: data, Filename: "mask.png", ContentType: "image/png"}, info, nil
}

func pngHasAlphaChannel(data []byte) bool {
	return len(data) > 25 &&
		bytes.Equal(data[:8], []byte{'\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n'}) &&
		string(data[12:16]) == "IHDR" &&
		(data[25] == 4 || data[25] == 6)
}

func validateRelayImageReferenceCount(model string, count int, payloads ...map[string]any) error {
	if len(payloads) > 0 {
		if d, ok := configuredImageDefinition(payloads[0]); ok {
			if count > d.MaxReferenceImages {
				return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s supports at most %d reference images", model, d.MaxReferenceImages)}
			}
			return nil
		}
	}
	if count <= 0 {
		return nil
	}
	if len(payloads) > 0 && isAPIMartImagePayload(payloads[0]) {
		contract := apimartImageContractForModel(model)
		if contract.imageRefField != "" && (contract.maxImageRefs == 0 || count <= contract.maxImageRefs) {
			return nil
		}
		if contract.imageRefField == "" {
			return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s does not support APIMart reference images", model)}
		}
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s supports at most %d APIMart reference images", model, contract.maxImageRefs)}
	}
	limit := util.MaxImageReferenceImages(model)
	if count <= limit {
		return nil
	}
	if limit == 0 {
		return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s does not support reference image editing through NewAPI", model)}
	}
	return protocol.HTTPError{Status: http.StatusBadRequest, Message: fmt.Sprintf("model %s supports at most %d reference images through NewAPI", model, limit)}
}
