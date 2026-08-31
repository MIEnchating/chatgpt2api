package util

import (
	"math"
	"strconv"
	"strings"
)

// ImageModelRoute identifies the upstream protocol needed by an image model.
type ImageModelRoute string

const (
	ImageModelRouteOpenAI       ImageModelRoute = "openai-image"
	ImageModelRouteGoogleGemini ImageModelRoute = "google-gemini-image"
	ImageModelRouteXAI          ImageModelRoute = "xai-image"
	ImageModelRouteZhipu        ImageModelRoute = "zhipu-image"
	ImageModelRouteAgnes        ImageModelRoute = "agnes-image"
)

const (
	maxImageOutputCount     = 15
	maxImageReferenceImages = int(^uint(0) >> 1)
)

// ImageModelRouteFor returns the protocol family for a configured image model.
// Unknown models keep the existing OpenAI-compatible image behavior so custom
// NewAPI image channels continue to work without a hard-coded model registry.
func ImageModelRouteFor(model string) ImageModelRoute {
	value := strings.ToLower(strings.TrimSpace(model))
	if isXAIImageModelName(value) {
		return ImageModelRouteXAI
	}
	if isGoogleGeminiImageModelName(value) {
		return ImageModelRouteGoogleGemini
	}
	if isZhipuImageModelName(value) {
		return ImageModelRouteZhipu
	}
	if isAgnesImageModelName(value) {
		return ImageModelRouteAgnes
	}
	return ImageModelRouteOpenAI
}

func isGoogleGeminiImageModelName(value string) bool {
	switch value {
	case "gemini-3.1-flash-lite-image",
		"gemini-3.1-flash-image",
		"gemini-3-pro-image",
		"gemini-2.5-flash-image":
		return true
	default:
		return false
	}
}

func isXAIImageModelName(value string) bool {
	switch value {
	case "grok-2-image-1212",
		"grok-imagine-image",
		"grok-imagine-image-2026-03-02",
		"grok-imagine-image-quality",
		"grok-imagine-image-quality-20260403",
		"grok-imagine-image-quality-latest",
		"grok-imagine-image-pro",
		"grok-imagine-image-2.0":
		return true
	default:
		return false
	}
}

func isZhipuImageModelName(value string) bool {
	return value == "glm-image" || strings.HasPrefix(value, "cogview-")
}

func isAgnesImageModelName(value string) bool {
	value = strings.NewReplacer("_", "-", " ", "-").Replace(value)
	return strings.HasPrefix(value, "agnes-image") || strings.HasPrefix(value, "agens-image")
}

func IsGoogleGeminiImageModel(model string) bool {
	return ImageModelRouteFor(model) == ImageModelRouteGoogleGemini
}

// IsGoogleGemini31FlashImageModel identifies Gemini 3.1 Flash Image.
func IsGoogleGemini31FlashImageModel(model string) bool {
	return strings.EqualFold(strings.TrimSpace(model), "gemini-3.1-flash-image")
}

func IsXAIImageModel(model string) bool {
	return ImageModelRouteFor(model) == ImageModelRouteXAI
}

func IsAgnesImageModel(model string) bool {
	return ImageModelRouteFor(model) == ImageModelRouteAgnes
}

// NormalizeZhipuImageQuality maps the application's quality vocabulary to
// the values accepted by GLM-Image and CogView adapters.
func NormalizeZhipuImageQuality(model, quality string) string {
	quality = strings.ToLower(strings.TrimSpace(quality))
	if strings.EqualFold(strings.TrimSpace(model), "glm-image") {
		return "hd"
	}
	if quality == "" || quality == "auto" {
		return quality
	}
	if quality == "high" || quality == "hd" {
		return "hd"
	}
	if quality == "low" || quality == "medium" || quality == "standard" {
		return "standard"
	}
	return ""
}

// IsOfficialXAIImageModel identifies the image model IDs and aliases listed
// by the current xAI API. The legacy grok-2 ID is intentionally excluded.
func IsOfficialXAIImageModel(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	return isXAIImageModelName(value) && value != "grok-2-image-1212"
}

// NormalizeXAIImageAspectRatio returns an aspect ratio accepted by the
// current xAI image generation API.
func NormalizeXAIImageAspectRatio(value string) (string, bool) {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
	normalized = strings.ReplaceAll(normalized, "×", "x")
	if parts := strings.Split(normalized, "x"); len(parts) == 2 {
		width, widthErr := strconv.ParseFloat(parts[0], 64)
		height, heightErr := strconv.ParseFloat(parts[1], 64)
		if widthErr == nil && heightErr == nil && width > 0 && height > 0 {
			normalized = closestXAIImageAspectRatio(width / height)
		}
	}
	switch normalized {
	case "", "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
		"2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20":
		return normalized, true
	default:
		return "", false
	}
}

func closestXAIImageAspectRatio(target float64) string {
	best := "1:1"
	bestDistance := math.Inf(1)
	for _, candidate := range []string{"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"} {
		parts := strings.Split(candidate, ":")
		width, _ := strconv.ParseFloat(parts[0], 64)
		height, _ := strconv.ParseFloat(parts[1], 64)
		if distance := math.Abs(width/height - target); distance < bestDistance {
			best, bestDistance = candidate, distance
		}
	}
	return best
}

// NormalizeXAIImageResolution returns a resolution accepted by the current
// xAI image generation API.
func NormalizeXAIImageResolution(value string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "", "auto", "1k", "2k":
		return normalized, true
	default:
		return "", false
	}
}

// MaxImageOutputCount returns the maximum number of images accepted for one
// request by this application for the selected model.
func MaxImageOutputCount(_ string) int {
	return maxImageOutputCount
}

// MaxImageReferenceImages follows the reference workbench: generic image
// requests do not guess provider limits before the provider adapter runs.
func MaxImageReferenceImages(model string) int {
	if ImageModelRouteFor(model) == ImageModelRouteZhipu {
		return 0
	}
	return maxImageReferenceImages
}
