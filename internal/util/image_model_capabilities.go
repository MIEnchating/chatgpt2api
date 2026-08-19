package util

import "strings"

// ImageModelRoute identifies the upstream protocol needed by an image model.
type ImageModelRoute string

const (
	ImageModelRouteOpenAI       ImageModelRoute = "openai-image"
	ImageModelRouteGoogleGemini ImageModelRoute = "google-gemini-image"
	ImageModelRouteXAI          ImageModelRoute = "xai-image"
)

const (
	// Gemini 3 image models support up to 14 reference images according to the
	// current Google API documentation. GPT Image models support up to 10 input
	// images. Unknown OpenAI-compatible models keep the conservative four-image
	// application limit.
	maxGemini3ReferenceImages  = 14
	maxGemini25ReferenceImages = 3
	maxGPTImageReferenceImages = 10
	maxGPTImageOutputCount     = 10
	maxDefaultReferenceImages  = 4
	maxDefaultImageOutputCount = 4
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

func IsGoogleGeminiImageModel(model string) bool {
	return ImageModelRouteFor(model) == ImageModelRouteGoogleGemini
}

// IsGoogleGemini3ImageModel identifies current official Gemini 3 image IDs.
func IsGoogleGemini3ImageModel(model string) bool {
	value := strings.ToLower(strings.TrimSpace(model))
	switch value {
	case "gemini-3.1-flash-lite-image", "gemini-3.1-flash-image", "gemini-3-pro-image":
		return true
	default:
		return false
	}
}

// IsGoogleGemini31FlashImageModel identifies Gemini 3.1 Flash Image.
func IsGoogleGemini31FlashImageModel(model string) bool {
	return strings.EqualFold(strings.TrimSpace(model), "gemini-3.1-flash-image")
}

// IsGoogleGeminiFlashLiteImageModel identifies Gemini 3.1 Flash Lite Image.
func IsGoogleGeminiFlashLiteImageModel(model string) bool {
	return strings.EqualFold(strings.TrimSpace(model), "gemini-3.1-flash-lite-image")
}

func IsXAIImageModel(model string) bool {
	return ImageModelRouteFor(model) == ImageModelRouteXAI
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
	switch normalized {
	case "", "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
		"2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20":
		return normalized, true
	default:
		return "", false
	}
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

// SupportsXAIImageQuality reports whether the model accepts xAI's quality
// request field. The official API currently limits it to image 2.0.
func SupportsXAIImageQuality(model string) bool {
	return strings.EqualFold(strings.TrimSpace(model), "grok-imagine-image-2.0")
}

func isOfficialGPTImageModelName(value string) bool {
	return strings.HasPrefix(value, "gpt-image-") || value == "chatgpt-image-latest"
}

// MaxImageOutputCount returns the maximum number of images accepted for one
// request by this application for the selected model.
func MaxImageOutputCount(model string) int {
	value := strings.ToLower(strings.TrimSpace(model))
	if isOfficialGPTImageModelName(value) {
		return maxGPTImageOutputCount
	}
	return maxDefaultImageOutputCount
}

// MaxImageReferenceImages returns the number of reference images that this
// application can safely send for a model through the configured upstream
// route. This deliberately describes the NewAPI-backed capability, rather
// than exposing provider features that NewAPI currently drops.
func MaxImageReferenceImages(model string) int {
	value := strings.ToLower(strings.TrimSpace(model))
	switch ImageModelRouteFor(value) {
	case ImageModelRouteGoogleGemini:
		if IsGoogleGemini3ImageModel(value) {
			return maxGemini3ReferenceImages
		}
		if value == "gemini-2.5-flash-image" {
			return maxGemini25ReferenceImages
		}
		return maxDefaultReferenceImages
	case ImageModelRouteXAI:
		// The current NewAPI xAI adaptor only forwards generation fields and
		// does not forward image edit requests or reference images.
		return 0
	default:
		if isOfficialGPTImageModelName(value) {
			return maxGPTImageReferenceImages
		}
		return maxDefaultReferenceImages
	}
}
