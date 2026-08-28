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
		{model: "glm-image", want: ImageModelRouteZhipu},
		{model: "cogview-4", want: ImageModelRouteZhipu},
		{model: "agnes-image-2.1-flash", want: ImageModelRouteAgnes},
		{model: "agens-image-1", want: ImageModelRouteAgnes},
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

func TestNormalizeZhipuImageQualityMatchesReference(t *testing.T) {
	if got := NormalizeZhipuImageQuality("glm-image", "auto"); got != "hd" {
		t.Fatalf("GLM auto quality = %q, want hd", got)
	}
	if got := NormalizeZhipuImageQuality("cogview-4", "auto"); got != "auto" {
		t.Fatalf("CogView auto quality = %q, want auto", got)
	}
	if got := NormalizeZhipuImageQuality("cogview-4", "medium"); got != "standard" {
		t.Fatalf("CogView medium quality = %q, want standard", got)
	}
}

func TestMaxImageReferenceImagesLeavesGenericLimitsToProviderAdapters(t *testing.T) {
	tests := []struct {
		model string
		want  int
	}{
		{model: "gemini-3.1-flash-lite-image", want: maxImageReferenceImages},
		{model: "gemini-3.1-flash-image", want: maxImageReferenceImages},
		{model: "gemini-3-pro-image", want: maxImageReferenceImages},
		{model: "gemini-2.5-flash-image", want: maxImageReferenceImages},
		{model: "grok-2-image-1212", want: maxImageReferenceImages},
		{model: "grok-imagine-image", want: maxImageReferenceImages},
		{model: "grok-imagine-image-2026-03-02", want: maxImageReferenceImages},
		{model: "grok-imagine-image-quality", want: maxImageReferenceImages},
		{model: "grok-imagine-image-quality-20260403", want: maxImageReferenceImages},
		{model: "grok-imagine-image-quality-latest", want: maxImageReferenceImages},
		{model: "grok-imagine-image-pro", want: maxImageReferenceImages},
		{model: "grok-imagine-image-2.0", want: maxImageReferenceImages},
		{model: "gpt-image-2", want: maxImageReferenceImages},
		{model: "gpt-image-1.5", want: maxImageReferenceImages},
		{model: "chatgpt-image-latest", want: maxImageReferenceImages},
		{model: "codex-gpt-image-2", want: maxImageReferenceImages},
		{model: "glm-image", want: 0},
		{model: "cogview-4", want: 0},
	}
	for _, test := range tests {
		if got := MaxImageReferenceImages(test.model); got != test.want {
			t.Errorf("MaxImageReferenceImages(%q) = %d, want %d", test.model, got, test.want)
		}
	}
}

func TestMaxImageOutputCountUsesReferenceWorkbenchAPILimit(t *testing.T) {
	tests := []struct {
		model string
		want  int
	}{
		{model: "gpt-image-2", want: 15},
		{model: "gpt-image-1.5", want: 15},
		{model: "chatgpt-image-latest", want: 15},
		{model: "gemini-3.1-flash-image", want: 15},
		{model: "grok-imagine-image-2.0", want: 15},
		{model: "codex-gpt-image-2", want: 15},
		{model: "custom-image-channel", want: 15},
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
	for input, want := range map[string]string{
		"2048x1152": "16:9",
		"1152x2048": "9:16",
		"3136x1344": "20:9",
	} {
		if got, ok := NormalizeXAIImageAspectRatio(input); !ok || got != want {
			t.Errorf("NormalizeXAIImageAspectRatio(%q) = %q, %v; want %q, true", input, got, ok, want)
		}
	}
	for _, resolution := range []string{"auto", "1k", "2k"} {
		if got, ok := NormalizeXAIImageResolution(resolution); !ok || got != resolution {
			t.Errorf("NormalizeXAIImageResolution(%q) = %q, %v", resolution, got, ok)
		}
	}
	if _, ok := NormalizeXAIImageResolution("4k"); ok {
		t.Fatal("unsupported xAI resolution was accepted")
	}
}
