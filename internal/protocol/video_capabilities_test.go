package protocol

import (
	"encoding/json"
	"testing"
)

func TestCanonicalVideoModel(t *testing.T) {
	tests := map[string]string{
		"kling/text-to-video":                "kling-2.6/text-to-video",
		"kling/v25-turbo-image-to-video-pro": "kling/v2-5-turbo-image-to-video-pro",
		"bytedance/seedance-1-5-pro":         "bytedance/seedance-1.5-pro",
		"grok-imagine-1.5-video":             "grok-imagine-video-1-5-preview",
	}
	for input, want := range tests {
		if got := CanonicalVideoModel(input); got != want {
			t.Fatalf("CanonicalVideoModel(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestReferenceProjectKIEVideoModelProfiles(t *testing.T) {
	tests := map[string]string{
		"kling/v2-1-pro":                       "kling-kie-legacy",
		"kling/ai-avatar-pro":                  "kling-avatar",
		"grok-imagine/image-to-video":          "grok-i2v",
		"grok-imagine/text-to-video":           "grok-kie",
		"wan/2-2-a14b-speech-to-video-turbo":   "wan-speech",
		"wan/2-2-animate-replace":              "wan-animate",
		"bytedance/v1-pro-fast-image-to-video": "bytedance-v1-i2v",
		"bytedance/seedance-2":                 "seedance-20",
		"doubao-seedance-future":               "seedance-20",
		"doubao-seedance-future-fast":          "seedance-20-fast",
		"kling/v3-turbo-text-to-video":         "kling-kie-v3",
		"kling-2.6/image-to-video":             "kling-kie-26",
		"wan/2-7-text-to-video":                "wan-kie-t2v",
	}
	for model, want := range tests {
		if got := VideoModelProfile(model); got != want {
			t.Errorf("VideoModelProfile(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestSharedVideoCapabilityContract(t *testing.T) {
	checks := []struct {
		model, size, resolution string
		seconds                 int
		image, video, audio     int
	}{
		{"sora-2", "1280x720", "", 8, 1, 0, 0},
		{"kling-v3", "16:9", "4k", 15, 0, 0, 0},
		{"kling/v3-turbo-text-to-video", "16:9", "720p", 17, 0, 0, 0},
		{"MiniMax-H3", "adaptive", "2K", 8, 9, 3, 3},
		{"seedance-2.0-fast", "adaptive", "720p", 10, 9, 3, 3},
		{"CogVideoX-3", "1920x1080", "4k", 10, 0, 0, 0},
		{"veo-3.1-generate-preview", "16:9", "4k", 8, 3, 0, 0},
		{"wan2.7-i2v-plus", "", "1080p", 10, 2, 3, 1},
		{"wan/2-7-image-to-video", "", "1080p", 10, 2, 1, 1},
		{"wan/2-7-r2v", "16:9", "1080p", 10, 9, 3, 1},
		{"wan/2-7-videoedit", "16:9", "720p", 5, 1, 1, 0},
		{"wan/2-6-video-to-video", "", "720p", 10, 0, 1, 0},
		{"wan2.6-t2v", "1280x720", "", 5, 0, 0, 0},
		{"viduq3", "16:9", "1080p", 10, 0, 0, 0},
		{"viduq1", "", "1080p", 12, 0, 0, 0},
		{"jimeng_v30", "9:16", "", 10, 0, 0, 0},
		{"agnes-video-2.5", "16:9", "720P", 8, 9, 3, 3},
		{"agnes-video", "1280x720", "", 6, 0, 0, 0},
		{"kling-3.0-omni/reference-to-video", "16:9", "1080p", 8, 9, 1, 0},
		{"kling-2.6/motion-control", "", "", 5, 1, 1, 0},
		{"gemini-omni-video", "16:9", "720p", 6, 9, 3, 0},
		{"skyreels-v4", "16:9", "720p", 5, 9, 3, 1},
		{"flux-3-video", "16:9", "1080p", 20, 10, 1, 0},
	}
	for _, check := range checks {
		profile := VideoCapability(check.model)
		if !VideoCapabilitySupports(profile, check.size, check.seconds, check.resolution) {
			t.Fatalf("shared capability rejected supported request for %s", check.model)
		}
		if profile.References.Image != check.image || profile.References.Video != check.video || profile.References.Audio != check.audio {
			t.Fatalf("references for %s = %+v, want image=%d video=%d audio=%d", check.model, profile.References, check.image, check.video, check.audio)
		}
		if profile.DefaultSeconds == 0 {
			t.Fatalf("default seconds missing for %s", check.model)
		}
	}
	for _, model := range []string{"viduq1", "viduq3"} {
		profile := VideoCapability(model)
		if profile.FirstFrameImageLimit != 2 || profile.ReferenceMode {
			t.Fatalf("Vidu capability for %s = %+v, want two-frame first/last handling without multimodal reference mode", model, profile)
		}
	}
}

func TestModelSpecificKIEVideoCapabilities(t *testing.T) {
	textHailuo := VideoCapability("hailuo/02-text-to-video-standard")
	if len(textHailuo.Resolutions) != 0 || textHailuo.DefaultSeconds != 5 || !VideoCapabilitySupports(textHailuo, "", 5, "") {
		t.Fatalf("unexpected Hailuo text capability: %+v", textHailuo)
	}
	imageHailuo := VideoCapability("hailuo/02-image-to-video-standard")
	if imageHailuo.FirstFrameImageLimit != 2 || !VideoCapabilitySupports(imageHailuo, "", 10, "768P") {
		t.Fatalf("unexpected Hailuo image capability: %+v", imageHailuo)
	}
	turbo := VideoCapability("kling/v3-turbo-image-to-video")
	if turbo.FirstFrameImageLimit != 2 || !VideoCapabilitySupports(turbo, "", 30, "4k") {
		t.Fatalf("unexpected Kling turbo capability: %+v", turbo)
	}
	kie26 := VideoCapability("kling-2.6/image-to-video")
	if kie26.FirstFrameImageLimit != 2 || kie26.AudioControl != "toggle" || !VideoCapabilitySupports(kie26, "", 5, "") {
		t.Fatalf("unexpected Kling 2.6 KIE capability: %+v", kie26)
	}
	for _, model := range []string{"kling/v3-turbo-text-to-video", "grok-imagine/text-to-video", "minimax-h3/text-to-video", "happyhorse/text-to-video"} {
		capability := VideoCapability(model)
		if capability.FirstFrameImageLimit != 0 || capability.ReferenceMode {
			t.Fatalf("text-only model %s exposes references: %+v", model, capability)
		}
	}
	happyHorseImage := VideoCapability("happyhorse/image-to-video")
	if happyHorseImage.FirstFrameImageLimit != 9 || happyHorseImage.ReferenceMode {
		t.Fatalf("unexpected HappyHorse image capability: %+v", happyHorseImage)
	}
	happyHorse11Image := VideoCapability("happyhorse-1-1/image-to-video")
	if happyHorse11Image.FirstFrameImageLimit != 1 || happyHorse11Image.ReferenceMode {
		t.Fatalf("unexpected HappyHorse 1.1 image capability: %+v", happyHorse11Image)
	}
	happyHorseReference := VideoCapability("happyhorse/reference-to-video")
	if !happyHorseReference.ReferenceMode || happyHorseReference.References.Image != 9 || happyHorseReference.References.Video != 0 {
		t.Fatalf("unexpected HappyHorse reference capability: %+v", happyHorseReference)
	}
	wan27Image := VideoCapability("wan/2-7-image-to-video")
	if wan27Image.FirstFrameImageLimit != 2 {
		t.Fatalf("Wan 2.7 KIE image limit = %d, want 2", wan27Image.FirstFrameImageLimit)
	}
	if capability := VideoCapability("bytedance/seedance-1.5-pro"); capability.FirstFrameImageLimit != 9 {
		t.Fatalf("Seedance 1.5 KIE image limit = %d", capability.FirstFrameImageLimit)
	}
	for _, model := range []string{"wan/2-2-a14b-image-to-video-turbo", "wan/2-2-a14b-text-to-video-turbo", "wan/2-5-image-to-video", "wan/2-6-image-to-video"} {
		capability := VideoCapability(model)
		if capability.Watermark || capability.References.Audio != 0 {
			t.Fatalf("KIE model %s inherited unsupported controls: %+v", model, capability)
		}
	}
	grokImage := VideoCapability("grok-imagine/image-to-video")
	if grokImage.FirstFrameImageLimit != 9 || grokImage.References.Image != 9 || grokImage.ReferenceMode {
		t.Fatalf("unexpected Grok image capability: %+v", grokImage)
	}
}

func TestExactKIEEndpointCapabilitiesDoNotInheritUnsupportedControls(t *testing.T) {
	for _, model := range []string{"kling-2.6/image-to-video", "kling/v3-turbo-image-to-video", "kling/v2-1-pro", "minimax-h3/image-to-video", "happyhorse/image-to-video", "happyhorse/video-edit", "wan/2-6-text-to-video"} {
		capability := VideoCapability(model)
		if len(capability.Sizes) != 0 {
			t.Fatalf("%s retained unsupported size controls: %+v", model, capability)
		}
	}
	for _, model := range []string{"kling-2.6/image-to-video", "kling/v2-1-pro"} {
		if capability := VideoCapability(model); len(capability.Resolutions) != 0 {
			t.Fatalf("%s retained unsupported resolution controls: %+v", model, capability)
		}
	}
	if capability := VideoCapability("minimax-h3/image-to-video"); len(capability.Resolutions) == 0 {
		t.Fatalf("MiniMax H3 image endpoint lost its official resolution controls: %+v", capability)
	}
	if capability := VideoCapability("minimax-h3/image-to-video"); capability.FirstFrameImageLimit != 2 {
		t.Fatalf("MiniMax H3 image endpoint image limit = %d, want 2", capability.FirstFrameImageLimit)
	}
	if capability := VideoCapability("gemini-omni-video"); capability.References.Audio != 0 {
		t.Fatalf("Gemini Omni must not expose URL audio references = %+v", capability.References)
	}
	if capability := VideoCapability("grok-imagine-video-1-5-preview"); capability.AudioControl != "none" {
		t.Fatalf("Grok 1.5 audio control = %q", capability.AudioControl)
	}
	if capability := VideoCapability("kling-3.0/video"); len(capability.Resolutions) != 0 || capability.Watermark || capability.FirstFrameImageLimit != 2 {
		t.Fatalf("Kling 3.0 universal retained transport-only controls: %+v", capability)
	}
}

func TestReferenceWorkbenchVideoAudioControls(t *testing.T) {
	tests := map[string]string{
		"kling-text-to-video":           "toggle",
		"kling-image-to-video":          "toggle",
		"kling-3-0-turbo":               "none",
		"kling-3.0-omni/transformation": "toggle",
		"viduq3-pro":                    "toggle",
		"viduq3-turbo":                  "toggle",
		"pixverse-v6":                   "toggle",
		"pixverse-v5":                   "none",
		"veo-3.1-generate-preview":      "none",
		"veo3.1-official":               "toggle",
		"wan2.7-i2v-plus":               "none",
		"wan2-6-image-to-video":         "none",
		"wan2-6-video-to-video":         "none",
		"wan2-6-flash-image-to-video":   "none",
		"wan2-6-flash-video-to-video":   "none",
		"wan2-6-i2v-flash":              "toggle",
		"wan/2-6-flash-video-to-video":  "toggle",
	}
	for model, want := range tests {
		if got := VideoCapability(model).AudioControl; got != want {
			t.Errorf("VideoCapability(%q).AudioControl = %q, want %q", model, got, want)
		}
	}
	turbo := VideoCapability("kling-3-0-turbo")
	if turbo.FirstFrameImageLimit != 1 || turbo.ReferenceMode || !VideoCapabilitySupports(turbo, "", 17, "") {
		t.Fatalf("unexpected Kling 3.0 Turbo workbench capability: %+v", turbo)
	}
	if hailuo := VideoCapability("MiniMax-Hailuo-2.3"); hailuo.FirstFrameImageLimit != 1 {
		t.Fatalf("MiniMax Hailuo 2.3 image limit = %d, want 1", hailuo.FirstFrameImageLimit)
	}
}

func TestSharedVideoContractIncludesRequestEnvelope(t *testing.T) {
	var document videoCapabilityDocument
	if err := json.Unmarshal(videoCapabilitiesJSON, &document); err != nil {
		t.Fatal(err)
	}
	if document.Version != 1 || len(document.Profiles) < 10 || len(document.Request) < 10 {
		t.Fatalf("unexpected shared video contract: version=%d request=%d profiles=%d", document.Version, len(document.Request), len(document.Profiles))
	}
}
