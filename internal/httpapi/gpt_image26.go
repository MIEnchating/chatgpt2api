package httpapi

import (
	"bytes"
	"image"
	"net/http"
	"slices"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func validateGPTImage26Request(path, model string, payload map[string]any, images []protocol.UploadedImage) error {
	if !util.IsGPTImage26(model) {
		return nil
	}
	fail := func(message string) error { return protocol.HTTPError{Status: http.StatusBadRequest, Message: message} }
	if mode := util.Clean(payload["api_mode"]); mode != "" && mode != "images" {
		return fail("GPT Image 2.6 requires Images API mode")
	}
	if err := validateRelayImageIntegerParameter(payload, "n", 1, 10); err != nil {
		return err
	}
	if len(images) > 16 {
		return fail("GPT Image 2.6 supports at most 16 reference images")
	}
	for key, allowed := range map[string][]string{
		"complexity": {"low", "medium", "high"}, "background": {"auto", "opaque", "transparent"},
		"quality": {"auto", "low", "medium", "high", "xhigh", "max"}, "output_format": {"png", "jpeg", "webp", "gif", "svg"},
	} {
		value := util.Clean(payload[key])
		if value != "" && !slices.Contains(allowed, value) {
			return fail("unsupported " + key + " for GPT Image 2.6")
		}
	}
	format := util.Clean(payload["output_format"])
	if util.Clean(payload["background"]) == "transparent" && format != "" && format != "png" && format != "webp" {
		return fail("transparent background requires PNG or WebP output")
	}
	if format == "svg" || format == "gif" {
		if strings.HasSuffix(path, "edits") {
			return fail("SVG and GIF output require image generation, not editing")
		}
		if util.ToBool(payload["stream"]) || util.ToInt(payload["partial_images"], 0) != 0 || util.Clean(payload["output_compression"]) != "" || hasRelayImageMask(payload["input_image_mask"]) || payload["prompt_rewriter"] != nil {
			return fail("SVG and GIF output do not support streaming, partial images, compression, masks or prompt_rewriter")
		}
		if format == "svg" && util.ToInt(payload["n"], 1) != 1 {
			return fail("SVG output requires n=1")
		}
	}
	for key, bounds := range map[string][2]int{"frame_count": {2, 16}, "frame_duration_ms": {20, 2000}} {
		if util.Clean(payload[key]) == "" {
			continue
		}
		if format != "gif" {
			return fail(key + " requires GIF output")
		}
		// Use the intersection of the guide and API reference until their limits agree.
		if err := validateRelayImageIntegerParameter(payload, key, bounds[0], bounds[1]); err != nil {
			return err
		}
		value, _ := util.StrictInt(payload[key])
		payload[key] = value
	}
	if size := util.Clean(payload["size"]); size != "" && size != "auto" {
		// Ratio presets belong to the workbench contract; upstream expects pixels.
		if strings.Contains(size, ":") {
			var ok bool
			size, ok = normalizeRelayImageSize(size)
			if !ok {
				return fail("invalid image size")
			}
			payload["size"] = size
		}
		width, height, ok := parseRelayImageDimensions(size)
		if !ok || width%16 != 0 || height%16 != 0 || width > 3840 || height > 3840 || int64(width)*int64(height) > 8294400 || width > height*3 || height > width*3 {
			return fail("size must use multiples of 16, at most 3840 per edge and 8294400 pixels, with aspect ratio between 1:3 and 3:1")
		}
		if format == "gif" && int64(width)*int64(height)*int64(util.ToInt(payload["frame_count"], 9))*int64(util.ToInt(payload["n"], 1)) > 8294400 {
			return fail("GIF frame dimensions, frame_count and n exceed the pixel budget")
		}
	}
	if !hasRelayImageMask(payload["markup"]) {
		return nil
	}
	if !strings.HasSuffix(path, "edits") || len(images) == 0 {
		return fail("markup requires an image edit with a first input image")
	}
	if hasRelayImageMask(payload["input_image_mask"]) || hasRelayImageMask(payload["mask"]) || payload["prompt_rewriter"] != nil {
		return fail("markup cannot be combined with mask or prompt_rewriter")
	}
	markup, info, err := relayImageMask(payload["markup"])
	if err != nil {
		return fail("markup must be a transparent PNG supplied as a base64 data URL")
	}
	first, err := util.InspectRasterImage(images[0].Data)
	if err != nil || int64(first.Width)*int64(first.Height) > 16777216 || int64(info.Width)*int64(info.Height) > 16777216 {
		return fail("the first image and markup must each contain at most 16777216 pixels")
	}
	// The upstream compares dimensions after EXIF orientation; DecodeConfig
	// exposes encoded dimensions and would incorrectly reject rotated photos.
	decoded, _, err := image.Decode(bytes.NewReader(markup.Data))
	if err != nil {
		return fail("invalid markup PNG")
	}
	transparent := false
	for y := 0; y < info.Height && !transparent; y++ {
		for x := 0; x < info.Width; x++ {
			_, _, _, alpha := decoded.At(x, y).RGBA()
			if alpha < 65535 {
				transparent = true
				break
			}
		}
	}
	if !transparent {
		return fail("markup PNG must contain transparent pixels")
	}
	payload["markup"] = uploadedImageDataURL(markup)
	return nil
}
