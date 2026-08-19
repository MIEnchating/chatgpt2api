package util

import "testing"

func TestImageModelRouteForProviderModels(t *testing.T) {
	tests := []struct {
		model string
		want  ImageModelRoute
	}{
		{model: "gemini-3.1-flash-lite-image", want: ImageModelRouteGoogleGemini},
		{model: "gemini-3.1-flash-image", want: ImageModelRouteGoogleGemini},
		{model: "gemini-3-pro-image", want: ImageModelRouteGoogleGemini},
		{model: "gemini-2.5-flash-image", want: ImageModelRouteGoogleGemini},
		{model: "grok-2-image-1212", want: ImageModelRouteXAI},
		{model: "grok-imagine-image", want: ImageModelRouteXAI},
		{model: "grok-imagine-image-2026-03-02", want: ImageModelRouteXAI},
		{model: "grok-imagine-image-quality", want: ImageModelRouteXAI},
		{model: "grok-imagine-image-quality-20260403", want: ImageModelRouteXAI},
		{model: "grok-imagine-image-quality-latest", want: ImageModelRouteXAI},
		{model: "grok-imagine-image-pro", want: ImageModelRouteXAI},
		{model: "grok-imagine-image-2.0", want: ImageModelRouteXAI},
		{model: "gpt-image-2", want: ImageModelRouteOpenAI},
		{model: "nano-banana-pro-preview", want: ImageModelRouteOpenAI},
		{model: "gemini-2.0-flash-exp", want: ImageModelRouteOpenAI},
		{model: "custom-image-channel", want: ImageModelRouteOpenAI},
	}
	for _, test := range tests {
		if got := ImageModelRouteFor(test.model); got != test.want {
			t.Errorf("ImageModelRouteFor(%q) = %q, want %q", test.model, got, test.want)
		}
	}
}

func TestMaxImageReferenceImagesMatchesCurrentUpstreamCapabilities(t *testing.T) {
	tests := []struct {
		model string
		want  int
	}{
		{model: "gemini-3.1-flash-lite-image", want: 14},
		{model: "gemini-3.1-flash-image", want: 14},
		{model: "gemini-3-pro-image", want: 14},
		{model: "gemini-2.5-flash-image", want: 3},
		{model: "grok-2-image-1212", want: 0},
		{model: "grok-imagine-image", want: 0},
		{model: "grok-imagine-image-2026-03-02", want: 0},
		{model: "grok-imagine-image-quality", want: 0},
		{model: "grok-imagine-image-quality-20260403", want: 0},
		{model: "grok-imagine-image-quality-latest", want: 0},
		{model: "grok-imagine-image-pro", want: 0},
		{model: "grok-imagine-image-2.0", want: 0},
		{model: "gpt-image-2", want: 10},
		{model: "gpt-image-1.5", want: 10},
		{model: "chatgpt-image-latest", want: 10},
		{model: "codex-gpt-image-2", want: 4},
	}
	for _, test := range tests {
		if got := MaxImageReferenceImages(test.model); got != test.want {
			t.Errorf("MaxImageReferenceImages(%q) = %d, want %d", test.model, got, test.want)
		}
	}
}

func TestMaxImageOutputCountUsesProviderLimits(t *testing.T) {
	tests := []struct {
		model string
		want  int
	}{
		{model: "gpt-image-2", want: 10},
		{model: "gpt-image-1.5", want: 10},
		{model: "chatgpt-image-latest", want: 10},
		{model: "gemini-3.1-flash-image", want: 4},
		{model: "grok-imagine-image-2.0", want: 4},
		{model: "codex-gpt-image-2", want: 4},
		{model: "custom-image-channel", want: 4},
	}
	for _, test := range tests {
		if got := MaxImageOutputCount(test.model); got != test.want {
			t.Errorf("MaxImageOutputCount(%q) = %d, want %d", test.model, got, test.want)
		}
	}
}

func TestGeminiImageCapabilitiesUseOfficialModelIDs(t *testing.T) {
	if !IsGoogleGemini31FlashImageModel("gemini-3.1-flash-image") {
		t.Fatal("Gemini 3.1 Flash Image was not recognized")
	}
	if IsGoogleGemini31FlashImageModel("gemini-3.1-flash-lite-image") {
		t.Fatal("Gemini 3.1 Flash Lite Image was recognized as the full model")
	}
	if !IsGoogleGeminiFlashLiteImageModel("gemini-3.1-flash-lite-image") {
		t.Fatal("Gemini 3.1 Flash Lite Image was not recognized")
	}
	if IsGoogleGeminiImageModel("nano-banana-2") {
		t.Fatal("legacy Nano Banana alias was recognized as an official model ID")
	}
}

func TestXAIImageGenerationParametersFollowOfficialValues(t *testing.T) {
	if !IsOfficialXAIImageModel("grok-imagine-image") || IsOfficialXAIImageModel("grok-2-image-1212") {
		t.Fatal("official xAI image model classification is incorrect")
	}
	for _, ratio := range []string{"auto", "1:1", "16:9", "2:1", "19.5:9", "9:20"} {
		if got, ok := NormalizeXAIImageAspectRatio(ratio); !ok || got != ratio {
			t.Errorf("NormalizeXAIImageAspectRatio(%q) = %q, %v", ratio, got, ok)
		}
	}
	if _, ok := NormalizeXAIImageAspectRatio("21:9"); ok {
		t.Fatal("unsupported xAI aspect ratio was accepted")
	}
	for _, resolution := range []string{"auto", "1k", "2k"} {
		if got, ok := NormalizeXAIImageResolution(resolution); !ok || got != resolution {
			t.Errorf("NormalizeXAIImageResolution(%q) = %q, %v", resolution, got, ok)
		}
	}
	if _, ok := NormalizeXAIImageResolution("4k"); ok {
		t.Fatal("unsupported xAI resolution was accepted")
	}
	if !SupportsXAIImageQuality("grok-imagine-image-2.0") {
		t.Fatal("Grok image 2.0 quality support was not recognized")
	}
	if SupportsXAIImageQuality("grok-imagine-image-quality") {
		t.Fatal("quality model incorrectly accepted the quality request field")
	}
}
