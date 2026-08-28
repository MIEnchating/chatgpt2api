package httpapi

import (
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/util"
)

func TestValidateOfficialVideoParameters(t *testing.T) {
	tests := []struct {
		name                     string
		model                    string
		size                     string
		seconds                  int
		resolution               string
		referenceCount           int
		multimodalReferenceCount int
		wantError                bool
	}{
		{name: "grok 1.5 1080p", model: "grok-imagine-video-1.5", size: "3:2", seconds: 15, resolution: "1080p"},
		{name: "APIMart Grok uses ratio controls", model: "grok-imagine", size: "16:9", seconds: 6, resolution: "720p"},
		{name: "APIMart Grok accepts manual 1080p", model: "grok-imagine-video", size: "16:9", seconds: 10, resolution: "1080p"},
		{name: "kling 3 range", model: "kling-v3", size: "1:1", seconds: 3, resolution: "720p"},
		{name: "kling 3 supports 4k", model: "kling-v3", size: "16:9", seconds: 15, resolution: "4k"},
		{name: "kling legacy rejects 4k", model: "kling-v2-6", size: "16:9", seconds: 5, resolution: "4k", wantError: true},
		{name: "kling legacy duration", model: "kling-v2-6", size: "16:9", seconds: 7, resolution: "1080p", wantError: true},
		{name: "APIMart Kling motion maps manual quality to mode", model: "kling-v2-6-motion-control", seconds: 5, resolution: "1080p"},
		{name: "APIMart Kling motion accepts manual quality for adapter mapping", model: "kling-v2-6-motion-control", seconds: 5, resolution: "1440p"},
		{name: "KIE Kling motion has no quality", model: "kling-2.6/motion-control", seconds: 5, resolution: ""},
		{name: "minimax hailuo omits ratio", model: "MiniMax-Hailuo-2.3", seconds: 10, resolution: "768P"},
		{name: "KIE Hailuo 02 text uses 5 seconds without resolution", model: "hailuo/02-text-to-video-standard", seconds: 5},
		{name: "KIE Hailuo generic panel keeps manual duration", model: "hailuo/02-text-to-video-standard", seconds: 7},
		{name: "KIE Hailuo generic panel accepts manual clarity before provider cleanup", model: "hailuo/02-text-to-video-standard", seconds: 5, resolution: "768P"},
		{name: "KIE Kling turbo accepts ratio and manual clarity", model: "kling/v3-turbo-text-to-video", size: "16:9", seconds: 17, resolution: "1440p"},
		{name: "KIE Kling turbo normalizes workbench pixel size", model: "kling/v3-turbo-text-to-video", size: "1536x864", seconds: 17, resolution: "1440p"},
		{name: "KIE Kling image endpoint accepts generic workbench size", model: "kling/v3-turbo-image-to-video", size: "1280x720", seconds: 5, resolution: "720p", referenceCount: 1},
		{name: "KIE Kling 2.6 follows official controls", model: "kling-2.6/text-to-video", size: "16:9", seconds: 5},
		{name: "KIE Kling 2.6 generic panel keeps manual duration", model: "kling-2.6/text-to-video", size: "16:9", seconds: 7},
		{name: "KIE Kling legacy generic panel keeps manual duration", model: "kling/v2-1-pro", seconds: 7},
		{name: "minimax hailuo rejects ratio", model: "MiniMax-Hailuo-2.3", size: "16:9", seconds: 6, resolution: "768P", wantError: true},
		{name: "minimax h3", model: "MiniMax-H3", size: "21:9", seconds: 15, resolution: "2K"},
		{name: "minimax h3 maps manual clarity at provider boundary", model: "MiniMax-H3", size: "16:9", seconds: 5, resolution: "1440p"},
		{name: "minimax h3 text rejects adaptive", model: "MiniMax-H3", size: "adaptive", seconds: 5, resolution: "2K", wantError: true},
		{name: "minimax h3 image follows reference ratio", model: "MiniMax-H3", size: "adaptive", seconds: 5, resolution: "768P", referenceCount: 1},
		{name: "minimax h3 supports first and last frames", model: "MiniMax-H3", size: "adaptive", seconds: 5, resolution: "768P", referenceCount: 2},
		{name: "minimax h3 requires resolution", model: "MiniMax-H3", size: "16:9", seconds: 5, wantError: true},
		{name: "minimax hailuo rejects 10s 1080p", model: "MiniMax-Hailuo-2.3", seconds: 10, resolution: "1080P", wantError: true},
		{name: "minimax hailuo fast requires image", model: "MiniMax-Hailuo-2.3-Fast", seconds: 6, resolution: "768P", wantError: true},
		{name: "minimax hailuo fast image", model: "MiniMax-Hailuo-2.3-Fast", seconds: 6, resolution: "768P", referenceCount: 1},
		{name: "sora 2 supports 20s", model: "sora-2", size: "1280x720", seconds: 20},
		{name: "sora 2 accepts generic workbench pixel size", model: "sora-2", size: "1920x1080", seconds: 20},
		{name: "sora 2 pro supports 1080p size", model: "sora-2-pro", size: "1920x1080", seconds: 20},
		{name: "sora accepts manual quality", model: "sora-2", size: "1280x720", seconds: 4, resolution: "720p"},
		{name: "seedance 2.5 smart submission", model: "doubao-seedance-2-5-260628", size: "adaptive", seconds: 1, resolution: "1080p"},
		{name: "seedance 2.0 maximum creator duration", model: "doubao-seedance-2-0-260128", size: "16:9", seconds: 15, resolution: "1080p"},
		{name: "seedance 1.0 smart submission", model: "doubao-seedance-1-0-260128", size: "adaptive", seconds: 1, resolution: "720p"},
		{name: "seedance 1.5 follows shared creator duration", model: "doubao-seedance-1-5-260128", size: "16:9", seconds: 15, resolution: "720p"},
		{name: "seedance mini rejects 1080p", model: "doubao-seedance-2-0-mini-260128", size: "16:9", seconds: 8, resolution: "1080p", wantError: true},
		{name: "seedance fast supports smart submission at 720p", model: "doubao-seedance-2-0-fast-260128", size: "adaptive", seconds: 1, resolution: "720p"},
		{name: "unknown seedance uses reference workbench controls", model: "doubao-seedance-future", size: "16:9", seconds: 4, resolution: "720p"},
		{name: "unknown seedance fast rejects 1080p", model: "doubao-seedance-future-fast", size: "16:9", seconds: 4, resolution: "1080p", wantError: true},
		{name: "generic custom controls", model: "custom-video-provider", size: "1536x864", seconds: 17, resolution: "1440p"},
		{name: "grok accepts manual quality", model: "grok-imagine-video", size: "16:9", seconds: 5, resolution: "1440p"},
		{name: "hailuo accepts manual quality", model: "MiniMax-Hailuo-2.3", seconds: 6, resolution: "1440p"},
		{name: "vidu accepts manual quality", model: "viduq1", seconds: 5, resolution: "1440p"},
		{name: "pixverse accepts manual quality", model: "pixverse-v6", size: "16:9", seconds: 5, resolution: "1440p"},
		{name: "skyreels accepts manual quality", model: "skyreels-v4", size: "16:9", seconds: 5, resolution: "1440p"},
		{name: "happyhorse accepts manual quality", model: "happyhorse/text-to-video", size: "16:9", seconds: 5, resolution: "1440p"},
		{name: "wan accepts manual quality", model: "wan2.7-i2v-plus", seconds: 5, resolution: "1440p", referenceCount: 1},
		{name: "agnes 2.5 accepts manual quality", model: "agnes-video-2.5", size: "16:9", seconds: 5, resolution: "1440p"},
		{name: "flux accepts manual quality", model: "flux-3-video", size: "16:9", seconds: 5, resolution: "1440p"},
		{name: "cogvideox accepts manual quality", model: "CogVideoX-3", size: "1280x720", seconds: 5, resolution: "1440p"},
		{name: "cogvideox 3", model: "CogVideoX-3", size: "1920x1080", seconds: 10, resolution: "4k"},
		{name: "veo 3.1 720p allows 6s", model: "veo-3.1-generate-preview", size: "16:9", seconds: 6, resolution: "720p"},
		{name: "veo 3.1 4k requires 8s", model: "veo-3.1-generate-preview", size: "16:9", seconds: 8, resolution: "4k"},
		{name: "veo 3.1 rejects short 4k", model: "veo-3.1-generate-preview", size: "16:9", seconds: 6, resolution: "4k", wantError: true},
		{name: "veo 3.1 asset references require 8s", model: "veo-3.1-generate-preview", size: "16:9", seconds: 6, resolution: "720p", multimodalReferenceCount: 1, wantError: true},
		{name: "veo 3.1 asset references at 8s", model: "veo-3.1-generate-preview", size: "16:9", seconds: 8, resolution: "720p", multimodalReferenceCount: 3},
		{name: "wan 2.7 image parameters", model: "wan2.7-i2v-plus", seconds: 10, resolution: "1080p", referenceCount: 2},
		{name: "wan KIE image parameters", model: "wan/2-7-image-to-video", seconds: 10, resolution: "1080p", multimodalReferenceCount: 3},
		{name: "wan r2v parameters", model: "wan/2-7-r2v", size: "16:9", seconds: 10, resolution: "1080p", multimodalReferenceCount: 3},
		{name: "wan videoedit parameters", model: "wan/2-7-videoedit", size: "16:9", seconds: 5, resolution: "720p", multimodalReferenceCount: 2},
		{name: "wan video to video parameters", model: "wan/2-6-video-to-video", seconds: 10, resolution: "720p", multimodalReferenceCount: 1},
		{name: "wan 2.2 image ignores unsupported duration", model: "wan/2-2-a14b-image-to-video-turbo", seconds: 30, resolution: "720p", referenceCount: 1},
		{name: "wan 2.2 text ignores unsupported duration", model: "wan/2-2-a14b-text-to-video-turbo", size: "16:9", seconds: 30, resolution: "720p"},
		{name: "gemini omni flash accepts configured duration", model: "gemini-omni-flash-preview", size: "16:9", seconds: 30, resolution: "720p"},
		{name: "wan text dimensions", model: "wan2.6-t2v", size: "1280x720", seconds: 5},
		{name: "vidu parameters", model: "viduq1", seconds: 12, resolution: "1080p", referenceCount: 2},
		{name: "vidu text supports aspect ratio", model: "viduq1", size: "16:9", seconds: 5, resolution: "1080p"},
		{name: "vidu q3 parameters", model: "viduq3", size: "16:9", seconds: 10, resolution: "1080p", referenceCount: 1},
		{name: "jimeng parameters", model: "jimeng_v30", size: "9:16", seconds: 10},
		{name: "generic rejects malformed size", model: "custom-video-provider", size: "16:9", seconds: 17, resolution: "1440p", wantError: true},
		{name: "generic rejects duration above range", model: "custom-video-provider", size: "1536x864", seconds: 31, resolution: "1440p", wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateVideoParameters(tt.model, tt.size, tt.seconds, tt.resolution, tt.referenceCount, tt.multimodalReferenceCount)
			if (err != nil) != tt.wantError {
				t.Fatalf("validateVideoParameters() error = %v, wantError %v", err, tt.wantError)
			}
		})
	}
}

func TestNormalizeVideoWorkbenchSizeForModel(t *testing.T) {
	tests := []struct {
		model, size, want string
	}{
		{model: "kling/v3-turbo-text-to-video", size: "1536x864", want: "16:9"},
		{model: "kling-2.6/text-to-video", size: "1536x864", want: "16:9"},
		{model: "MiniMax-Hailuo-2.3", size: "1536x864", want: ""},
		{model: "sora-2", size: "1920x1080", want: "1920x1080"},
	}
	for _, test := range tests {
		t.Run(test.model, func(t *testing.T) {
			if got := normalizeVideoWorkbenchSizeForModel(test.model, test.size); got != test.want {
				t.Fatalf("normalizeVideoWorkbenchSizeForModel(%q, %q) = %q, want %q", test.model, test.size, got, test.want)
			}
		})
	}
}

func TestValidateOfficialVideoPromptLimits(t *testing.T) {
	if err := validateVideoPrompt("kling-v3", string(make([]rune, 3072))); err != nil {
		t.Fatalf("Kling 3.0 prompt at limit: %v", err)
	}
	if err := validateVideoPrompt("kling-v3", string(make([]rune, 3073))); err == nil {
		t.Fatal("Kling 3.0 accepted a prompt longer than 3072 characters")
	}
	if err := validateVideoPrompt("MiniMax-H3", string(make([]rune, 7001))); err == nil {
		t.Fatal("MiniMax H3 accepted a prompt longer than 7000 characters")
	}
}

func TestValidateVideoRequiredInputs(t *testing.T) {
	image := []string{"https://cdn.example.com/frame.png"}
	if err := validateVideoRequiredInputs("kling-3-0-turbo", "", nil, nil, nil); err == nil {
		t.Fatal("Kling 3 Turbo accepted a request without prompt or image")
	}
	if err := validateVideoRequiredInputs("kling-3-0-turbo", "", image, nil, nil); err != nil {
		t.Fatalf("Kling 3 Turbo rejected its image-only mode: %v", err)
	}
	if err := validateVideoRequiredInputs("bytedance/seedance-2-mini", "", image, nil, nil); err == nil {
		t.Fatal("Seedance 2 Mini accepted an empty required prompt")
	}
}

func TestValidateVideoReferences(t *testing.T) {
	tests := []struct {
		name      string
		model     string
		mode      string
		images    []string
		videos    []string
		audios    []string
		wantError bool
	}{
		{name: "H3 accepts mixed public references", model: "MiniMax-H3", mode: "reference", images: []string{"https://cdn.example.com/a.png"}, videos: []string{"https://cdn.example.com/a.mp4"}, audios: []string{"https://cdn.example.com/a.mp3"}},
		{name: "removed video-to-video mode is rejected", model: "MiniMax-H3", mode: "video-to-video", videos: []string{"https://cdn.example.com/a.mp4"}, wantError: true},
		{name: "reference mode requires input", model: "MiniMax-H3", mode: "reference", wantError: true},
		{name: "reference mode rejects data URLs", model: "MiniMax-H3", mode: "reference", images: []string{"data:image/png;base64,AAAA"}, wantError: true},
		{name: "reference mode rejects relative URLs", model: "MiniMax-H3", mode: "reference", videos: []string{"/video.mp4"}, wantError: true},
		{name: "video to video accepts public video URL", model: "MiniMax-H3", mode: "reference", videos: []string{"https://media.example.com/source.mp4"}},
		{name: "reference mode rejects localhost", model: "MiniMax-H3", mode: "reference", videos: []string{"http://localhost/source.mp4"}, wantError: true},
		{name: "reference mode rejects loopback", model: "MiniMax-H3", mode: "reference", audios: []string{"http://127.0.0.1/audio.mp3"}, wantError: true},
		{name: "reference mode rejects private IP", model: "MiniMax-H3", mode: "reference", images: []string{"https://192.168.1.5/image.png"}, wantError: true},
		{name: "reference mode rejects URL credentials", model: "MiniMax-H3", mode: "reference", images: []string{"https://user:pass@cdn.example.com/image.png"}, wantError: true},
		{name: "reference mode rejects oversized URL", model: "MiniMax-H3", mode: "reference", images: []string{"https://cdn.example.com/" + strings.Repeat("a", 2084)}, wantError: true},
		{name: "only H3 exposes multimodal references", model: "kling-v3", mode: "reference", videos: []string{"https://cdn.example.com/a.mp4"}, wantError: true},
		{name: "generic workbench accepts shared material envelope", model: "sora-2", mode: "reference", images: []string{"https://cdn.example.com/a.png"}, videos: []string{"https://cdn.example.com/a.mp4"}, audios: []string{"https://cdn.example.com/a.mp3"}},
		{name: "generic workbench limits videos to three", model: "sora-2", mode: "reference", videos: []string{"https://cdn.example.com/1.mp4", "https://cdn.example.com/2.mp4", "https://cdn.example.com/3.mp4", "https://cdn.example.com/4.mp4"}, wantError: true},
		{name: "H3 limits images", model: "MiniMax-H3", mode: "reference", images: make([]string, 10), wantError: true},
		{name: "first frame rejects video", model: "MiniMax-H3", mode: "first-frame", videos: []string{"https://cdn.example.com/a.mp4"}, wantError: true},
		{name: "first frame rejects image data URL", model: "MiniMax-H3", mode: "first-frame", images: []string{"data:image/png;base64,AAAA"}, wantError: true},
		{name: "first frame accepts one public image URL", model: "MiniMax-H3", mode: "first-frame", images: []string{"https://cdn.example.com/frame.png"}},
		{name: "H3 rejects audio-only reference", model: "MiniMax-H3", mode: "reference", audios: []string{"https://cdn.example.com/a.mp3"}, wantError: true},
		{name: "Kling accepts first and last frame", model: "kling-v3", mode: "first-frame", images: []string{"https://cdn.example.com/first.png", "https://cdn.example.com/last.png"}},
		{name: "KIE Kling image endpoint requires image", model: "kling/v3-turbo-image-to-video", mode: "first-frame", wantError: true},
		{name: "KIE Kling image endpoint accepts image", model: "kling/v3-turbo-image-to-video", mode: "first-frame", images: []string{"https://cdn.example.com/frame.png"}},
		{name: "KIE Kling image endpoint limits frames to two", model: "kling/v3-turbo-image-to-video", mode: "first-frame", images: []string{"https://cdn.example.com/one.png", "https://cdn.example.com/two.png", "https://cdn.example.com/three.png"}, wantError: true},
		{name: "KIE Kling legacy pro requires image", model: "kling/v2-1-pro", mode: "first-frame", wantError: true},
		{name: "KIE Kling legacy pro accepts image", model: "kling/v2-1-pro", mode: "first-frame", images: []string{"https://cdn.example.com/frame.png"}},
		{name: "Wan image model requires image", model: "wan2.7-i2v-plus", mode: "first-frame", wantError: true},
		{name: "Wan image model accepts public image", model: "wan2.7-i2v-plus", mode: "first-frame", images: []string{"https://cdn.example.com/first.png"}},
		{name: "Wan native 2.7 accepts video-only generation", model: "wan2.7-i2v-plus", mode: "reference", videos: []string{"https://cdn.example.com/source.mp4"}},
		{name: "Wan native 2.7 accepts reference video", model: "wan2.7-i2v-plus", mode: "reference", images: []string{"https://cdn.example.com/first.png"}, videos: []string{"https://cdn.example.com/source.mp4"}},
		{name: "KIE Wan 2.7 accepts video-only generation", model: "wan/2-7-image-to-video", mode: "reference", videos: []string{"https://cdn.example.com/source.mp4"}},
		{name: "KIE Wan 2.7 keeps first and last frames with clip", model: "wan/2-7-image-to-video", mode: "reference", images: []string{"https://cdn.example.com/first.png", "https://cdn.example.com/last.png"}, videos: []string{"https://cdn.example.com/source.mp4"}},
		{name: "Wan native 2.7 rejects video with audio", model: "wan2.7-i2v-plus", mode: "reference", images: []string{"https://cdn.example.com/first.png"}, videos: []string{"https://cdn.example.com/source.mp4"}, audios: []string{"https://cdn.example.com/voice.mp3"}, wantError: true},
		{name: "Wan videoedit requires video", model: "wan/2-7-videoedit", mode: "reference", images: []string{"https://cdn.example.com/style.png"}, wantError: true},
		{name: "Wan videoedit accepts video", model: "wan/2-7-videoedit", mode: "reference", videos: []string{"https://cdn.example.com/source.mp4"}},
		{name: "Wan video to video requires video", model: "wan/2-6-video-to-video", mode: "reference", wantError: true},
		{name: "KIE Wan R2V accepts an image without a video", model: "wan/2-7-r2v", mode: "reference", images: []string{"https://cdn.example.com/character.png"}},
		{name: "KIE Wan R2V accepts a video without an image", model: "wan/2-7-r2v", mode: "reference", videos: []string{"https://cdn.example.com/motion.mp4"}},
		{name: "Wan R2V accepts image and video", model: "wan/2-7-r2v", mode: "reference", images: []string{"https://cdn.example.com/character.png"}, videos: []string{"https://cdn.example.com/motion.mp4"}},
		{name: "Wan R2V accepts audio with a video role", model: "wan/2-7-r2v", mode: "reference", videos: []string{"https://cdn.example.com/motion.mp4"}, audios: []string{"https://cdn.example.com/voice.mp3"}},
		{name: "Wan R2V rejects audio without a visual role", model: "wan/2-7-r2v", mode: "reference", audios: []string{"https://cdn.example.com/voice.mp3"}, wantError: true},
		{name: "SkyReels rejects audio without reference image", model: "skyreels-v4", mode: "reference", audios: []string{"https://cdn.example.com/voice.mp3"}, wantError: true},
		{name: "SkyReels accepts image with audio", model: "skyreels-v4", mode: "reference", images: []string{"https://cdn.example.com/character.png"}, audios: []string{"https://cdn.example.com/voice.mp3"}},
		{name: "Vidu Q3 requires image", model: "viduq3", mode: "first-frame", wantError: true},
		{name: "Vidu Q3 accepts image", model: "viduq3", mode: "first-frame", images: []string{"https://cdn.example.com/input.png"}},
		{name: "Kling motion requires both inputs", model: "kling-2.6/motion-control", mode: "reference", images: []string{"https://cdn.example.com/input.png"}, wantError: true},
		{name: "Kling motion accepts image and video", model: "kling-2.6/motion-control", mode: "reference", images: []string{"https://cdn.example.com/input.png"}, videos: []string{"https://cdn.example.com/input.mp4"}},
		{name: "Kling omni transformation requires video", model: "kling-3.0-omni/transformation", mode: "reference", images: []string{"https://cdn.example.com/style.png"}, wantError: true},
		{name: "Kling omni transformation accepts video", model: "kling-3.0-omni/transformation", mode: "reference", videos: []string{"https://cdn.example.com/input.mp4"}},
		{name: "Infinitalk requires image and audio", model: "infinitalk/from-audio", mode: "reference", images: []string{"https://cdn.example.com/input.png"}, wantError: true},
		{name: "Infinitalk accepts image and audio", model: "infinitalk/from-audio", mode: "reference", images: []string{"https://cdn.example.com/input.png"}, audios: []string{"https://cdn.example.com/input.mp3"}},
		{name: "Topaz video requires video", model: "topaz/video-upscale", mode: "reference", wantError: true},
		{name: "Topaz video accepts video", model: "topaz/video-upscale", mode: "reference", videos: []string{"https://cdn.example.com/input.mp4"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateVideoReferences(tt.model, tt.mode, tt.images, tt.videos, tt.audios)
			if (err != nil) != tt.wantError {
				t.Fatalf("validateVideoReferences() error = %v, wantError %v", err, tt.wantError)
			}
		})
	}
}

func TestPublicReferenceURLLengthBoundary(t *testing.T) {
	prefix := "https://cdn.example.com/"
	if value := prefix + strings.Repeat("a", 2083-len(prefix)); !isPublicReferenceURL(value) {
		t.Fatal("public reference URL at the upstream length limit was rejected")
	}
	if value := prefix + strings.Repeat("a", 2084-len(prefix)); isPublicReferenceURL(value) {
		t.Fatal("public reference URL above the upstream length limit was accepted")
	}
}

func TestValidateMiniMaxH3MultimodalReferenceAllowsAdaptiveRatio(t *testing.T) {
	if err := validateVideoParameters("MiniMax-H3", "adaptive", 8, "2K", 0, 1); err != nil {
		t.Fatalf("H3 multimodal reference rejected adaptive ratio: %v", err)
	}
}

func TestValidateVideoPromptRequiresTextForEveryModel(t *testing.T) {
	for _, model := range []string{"sora-2", "topaz/video-upscale", "infinitalk/from-audio", "kling-3-0-turbo"} {
		if err := validateVideoPrompt(model, ""); err == nil || err.Error() != "请输入视频提示词" {
			t.Fatalf("validateVideoPrompt(%q) error = %v, want 请输入视频提示词", model, err)
		}
	}
}

func TestVideoFrameAliasesRemainSeparateFromOrdinaryReferences(t *testing.T) {
	body := map[string]any{
		"first_frame_url":      "https://cdn.example.com/first.png",
		"last_frame_url":       "https://cdn.example.com/last.png",
		"reference_image_urls": []string{"https://cdn.example.com/first.png", "https://cdn.example.com/reference.png"},
	}
	frames := videoFrameAliases(body)
	refs := removeVideoFrameAliases(util.AsStringSlice(body["reference_image_urls"]), frames)
	if !reflect.DeepEqual(frames, []string{"https://cdn.example.com/first.png", "https://cdn.example.com/last.png"}) {
		t.Fatalf("frame aliases = %#v", frames)
	}
	if !reflect.DeepEqual(refs, []string{"https://cdn.example.com/reference.png"}) {
		t.Fatalf("ordinary references = %#v", refs)
	}
}

func TestValidateProviderVideoReferenceCombinations(t *testing.T) {
	tests := []struct {
		name, model, firstFrame, lastFrame string
		images, videos, audios             []string
		want                               string
	}{
		{
			name: "Veo tail requires first frame", model: "veo-3.1-generate-preview",
			lastFrame: "https://cdn.example.com/last.png", want: "请先添加首帧图片",
		},
		{
			name: "Veo frames reject ordinary images", model: "veo-3.1-generate-preview",
			firstFrame: "https://cdn.example.com/first.png", images: []string{"https://cdn.example.com/reference.png"}, want: "首尾帧模式不能与普通参考图同时使用",
		},
		{
			name: "Veo rejects ordinary video", model: "veo-3.1-generate-preview",
			videos: []string{"https://cdn.example.com/reference.mp4"}, want: "Gemini Veo 不支持普通参考视频，请移除后重试",
		},
		{
			name: "Veo rejects audio", model: "veo-3.1-generate-preview",
			audios: []string{"https://cdn.example.com/reference.mp3"}, want: "Gemini Veo 不支持参考音频，请移除后重试",
		},
		{
			name: "older Veo rejects tail frame", model: "veo-3-generate-preview",
			firstFrame: "https://cdn.example.com/first.png", lastFrame: "https://cdn.example.com/last.png", want: "当前 Veo 模型不支持尾帧或普通参考图",
		},
		{
			name: "Veo 3.1 limits asset references", model: "veo-3.1-generate-preview",
			images: []string{"https://cdn.example.com/1.png", "https://cdn.example.com/2.png", "https://cdn.example.com/3.png", "https://cdn.example.com/4.png"}, want: "Veo 3.1 参考图最多 3 张",
		},
		{
			name: "Agnes frames reject ordinary media", model: "Agnes-Video-2.5",
			firstFrame: "https://cdn.example.com/first.png", videos: []string{"https://cdn.example.com/reference.mp4"}, want: "Agnes Video 2.5 的首尾帧不能和普通参考素材同时使用",
		},
		{
			name: "H3 frames reject ordinary media", model: "MiniMax-H3",
			firstFrame: "https://cdn.example.com/first.png", audios: []string{"https://cdn.example.com/reference.mp3"}, want: "MiniMax H3 首尾帧不能与参考图片、视频或音频同时使用",
		},
		{
			name: "CogVideoX rejects video", model: "CogVideoX-3",
			videos: []string{"https://cdn.example.com/reference.mp4"}, want: "CogVideoX-3 不支持参考视频或参考音频",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateVideoReferenceCombination(tt.model, tt.firstFrame != "", tt.lastFrame != "", tt.images, tt.videos, tt.audios)
			if err == nil || err.Error() != tt.want {
				t.Fatalf("combination error = %v, want %q", err, tt.want)
			}
		})
	}

	if err := validateVideoReferenceCombination(
		"veo-3.1-generate-preview",
		false,
		false,
		[]string{"https://cdn.example.com/1.png", "https://cdn.example.com/2.png", "https://cdn.example.com/3.png"},
		nil,
		nil,
	); err != nil {
		t.Fatalf("Veo 3.1 rejected three asset references: %v", err)
	}
}

func TestNormalizeVideoReferenceMode(t *testing.T) {
	tests := map[string]string{
		"":              "",
		"first-frame":   "first-frame",
		" FIRST-FRAME ": "first-frame",
		"reference":     "reference",
	}
	for input, want := range tests {
		if got := normalizeVideoReferenceMode(input); got != want {
			t.Fatalf("normalizeVideoReferenceMode(%q) = %q, want %q", input, got, want)
		}
	}
	for _, removed := range []string{"image-to-video", "reference-generation", "reference-to-video", "video-to-video", "multimodal"} {
		if err := validateVideoReferences("minimax-h3", removed, nil, nil, nil); err == nil {
			t.Fatalf("removed reference mode %q was accepted", removed)
		}
		if err := validateVideoReferencesWithFrameSlots("minimax-h3", removed, "https://cdn.example.com/frame.png", "", nil, nil, nil, false); err == nil {
			t.Fatalf("removed reference mode %q was accepted with a frame slot", removed)
		}
	}
}

func TestNormalizeAndValidateAdvancedVideoControls(t *testing.T) {
	kling := map[string]any{
		"negative_prompt":       "blur",
		"multi_shot":            true,
		"shot_type":             "customize",
		"multi_prompt":          []any{map[string]any{"prompt": "shot", "duration": 3}},
		"element_list":          []any{map[string]any{"name": "hero"}},
		"character_orientation": "image",
	}
	normalizeVideoControlParameters(kling, "kling-3.0/video")
	if err := validateVideoAdvancedParameters(kling, "kling-3.0/video"); err != nil {
		t.Fatalf("Kling advanced controls rejected: %v", err)
	}
	if _, ok := kling["character_orientation"]; ok {
		t.Fatal("non-motion Kling request retained character_orientation")
	}
	if _, ok := kling["negative_prompt"]; ok {
		t.Fatal("KIE Kling 3.0 retained unsupported negative_prompt")
	}
	if _, ok := kling["shot_type"]; ok {
		t.Fatal("KIE Kling 3.0 retained unsupported shot_type")
	}
	if kling["video_mode"] != "std" {
		t.Fatalf("KIE Kling 3.0 mode = %#v, want std", kling["video_mode"])
	}

	apimart := map[string]any{"negative_prompt": "blur", "multi_shot": true, "shot_type": "intelligence"}
	normalizeVideoControlParameters(apimart, "kling-v3")
	if apimart["negative_prompt"] != "blur" || apimart["shot_type"] != "intelligence" {
		t.Fatalf("APIMart Kling V3 controls were removed: %#v", apimart)
	}

	generic := map[string]any{"negative_prompt": "blur", "multi_shot": true, "element_list": []any{map[string]any{"name": "hero"}}}
	normalizeVideoControlParameters(generic, "custom-video-provider")
	for _, key := range []string{"negative_prompt", "multi_shot", "element_list"} {
		if _, ok := generic[key]; ok {
			t.Fatalf("generic request retained unsupported %s", key)
		}
	}

	invalid := map[string]any{"multi_shot": true}
	if err := validateVideoAdvancedParameters(invalid, "kling-3.0/video"); err == nil {
		t.Fatal("custom multi-shot accepted without multi_prompt")
	}
}

func TestValidateKlingElementList(t *testing.T) {
	valid := []any{map[string]any{
		"name": "hero", "description": "lead character",
		"references": []any{
			map[string]any{"kind": "image", "url": "https://cdn.example.com/hero.png"},
			map[string]any{"kind": "video", "url": "https://cdn.example.com/hero.mp4"},
		},
	}}
	if err := validateKlingElementList(valid); err != nil {
		t.Fatalf("valid Kling elements rejected: %v", err)
	}
	if !hasKlingElementReferences(valid) {
		t.Fatal("valid Kling elements were not recognized as reference input")
	}
	if err := validateVideoReferences("kling-3.0-omni/reference-to-video", "reference", nil, nil, nil, true); err != nil {
		t.Fatalf("Kling Omni element-only reference request rejected: %v", err)
	}
	tests := []struct {
		name  string
		value []any
	}{
		{name: "too many elements", value: []any{map[string]any{}, map[string]any{}, map[string]any{}, map[string]any{}}},
		{name: "missing description", value: []any{map[string]any{"name": "hero", "references": valid[0].(map[string]any)["references"]}}},
		{name: "one resource", value: []any{map[string]any{"name": "hero", "description": "lead", "references": []any{map[string]any{"kind": "image", "url": "https://cdn.example.com/hero.png"}}}}},
		{name: "invalid kind", value: []any{map[string]any{"name": "hero", "description": "lead", "references": []any{map[string]any{"kind": "file", "url": "https://cdn.example.com/a.bin"}, map[string]any{"kind": "image", "url": "https://cdn.example.com/b.png"}}}}},
		{name: "inline URL", value: []any{map[string]any{"name": "hero", "description": "lead", "references": []any{map[string]any{"kind": "image", "url": "data:image/png;base64,abc"}, map[string]any{"kind": "image", "url": "https://cdn.example.com/b.png"}}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateKlingElementList(test.value); err == nil {
				t.Fatal("invalid Kling elements accepted")
			}
		})
	}
}

func TestValidateKlingV26AudioGeneration(t *testing.T) {
	if err := validateVideoAudioGeneration("kling-v2-6", true, "std", 1); err == nil || err.Error() != "Kling v2.6 音频生成需要 pro 模式" {
		t.Fatalf("unexpected non-pro validation error: %v", err)
	}
	if err := validateVideoAudioGeneration("kling-v2-6", true, "pro", 2); err == nil || err.Error() != "Kling v2.6 开启音频时最多 1 张参考图" {
		t.Fatalf("unexpected image-limit validation error: %v", err)
	}
	if err := validateVideoAudioGeneration("kling-v2-6", true, "pro", 1); err != nil {
		t.Fatalf("valid Kling v2.6 audio request rejected: %v", err)
	}
}
