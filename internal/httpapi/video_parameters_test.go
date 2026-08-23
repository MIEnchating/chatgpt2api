package httpapi

import (
	"strings"
	"testing"
)

func TestValidateOfficialVideoParameters(t *testing.T) {
	tests := []struct {
		name           string
		model          string
		size           string
		seconds        int
		resolution     string
		referenceCount int
		wantError      bool
	}{
		{name: "grok 1.5 1080p", model: "grok-imagine-video-1.5", size: "3:2", seconds: 15, resolution: "1080p"},
		{name: "grok legacy rejects 1080p", model: "grok-imagine-video", size: "16:9", seconds: 10, resolution: "1080p", wantError: true},
		{name: "kling 3 range", model: "kling-v3", size: "1:1", seconds: 3, resolution: "720p"},
		{name: "kling 3 supports 4k", model: "kling-v3", size: "16:9", seconds: 15, resolution: "4k"},
		{name: "kling legacy rejects 4k", model: "kling-v2-6", size: "16:9", seconds: 5, resolution: "4k", wantError: true},
		{name: "kling legacy duration", model: "kling-v2-6", size: "16:9", seconds: 7, resolution: "1080p", wantError: true},
		{name: "minimax hailuo omits ratio", model: "MiniMax-Hailuo-2.3", seconds: 10, resolution: "768P"},
		{name: "minimax hailuo rejects ratio", model: "MiniMax-Hailuo-2.3", size: "16:9", seconds: 6, resolution: "768P", wantError: true},
		{name: "minimax h3", model: "MiniMax-H3", size: "21:9", seconds: 15, resolution: "2K"},
		{name: "minimax h3 text rejects adaptive", model: "MiniMax-H3", size: "adaptive", seconds: 5, resolution: "2K", wantError: true},
		{name: "minimax h3 image follows reference ratio", model: "MiniMax-H3", size: "adaptive", seconds: 5, resolution: "768P", referenceCount: 1},
		{name: "minimax h3 rejects multiple first frames", model: "MiniMax-H3", size: "adaptive", seconds: 5, resolution: "768P", referenceCount: 2, wantError: true},
		{name: "minimax h3 requires resolution", model: "MiniMax-H3", size: "16:9", seconds: 5, wantError: true},
		{name: "minimax hailuo rejects 10s 1080p", model: "MiniMax-Hailuo-2.3", seconds: 10, resolution: "1080P", wantError: true},
		{name: "minimax hailuo fast requires image", model: "MiniMax-Hailuo-2.3-Fast", seconds: 6, resolution: "768P", wantError: true},
		{name: "minimax hailuo fast image", model: "MiniMax-Hailuo-2.3-Fast", seconds: 6, resolution: "768P", referenceCount: 1},
		{name: "sora 2 supports 20s", model: "sora-2", size: "1280x720", seconds: 20},
		{name: "sora 2 rejects pro size", model: "sora-2", size: "1920x1080", seconds: 20, wantError: true},
		{name: "sora 2 pro supports 1080p size", model: "sora-2-pro", size: "1920x1080", seconds: 20},
		{name: "sora rejects separate resolution", model: "sora-2", size: "1280x720", seconds: 4, resolution: "720p", wantError: true},
		{name: "seedance 2.5 smart", model: "doubao-seedance-2-5-260628", size: "adaptive", seconds: -1, resolution: "1080p"},
		{name: "seedance 2.0 4k", model: "doubao-seedance-2-0-260128", size: "16:9", seconds: 15, resolution: "4k"},
		{name: "seedance mini rejects 1080p", model: "doubao-seedance-2-0-mini-260128", size: "16:9", seconds: 8, resolution: "1080p", wantError: true},
		{name: "seedance fast supports 720p", model: "doubao-seedance-2-0-fast-260128", size: "adaptive", seconds: -1, resolution: "720p"},
		{name: "unknown seedance uses upstream defaults", model: "doubao-seedance-future", seconds: 4},
		{name: "unknown seedance rejects guessed controls", model: "doubao-seedance-future", size: "1280x720", seconds: 4, resolution: "720p", wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateVideoParameters(tt.model, tt.size, tt.seconds, tt.resolution, tt.referenceCount)
			if (err != nil) != tt.wantError {
				t.Fatalf("validateVideoParameters() error = %v, wantError %v", err, tt.wantError)
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
		{name: "video-to-video alias accepts a public video", model: "MiniMax-H3", mode: "video-to-video", videos: []string{"https://cdn.example.com/a.mp4"}},
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
		{name: "H3 limits images", model: "MiniMax-H3", mode: "reference", images: make([]string, 10), wantError: true},
		{name: "first frame rejects video", model: "MiniMax-H3", mode: "first-frame", videos: []string{"https://cdn.example.com/a.mp4"}, wantError: true},
		{name: "first frame accepts one image data URL", model: "MiniMax-H3", mode: "first-frame", images: []string{"data:image/png;base64,AAAA"}},
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

func TestNormalizeVideoReferenceMode(t *testing.T) {
	tests := map[string]string{
		"":                     "",
		"first-frame":          "first-frame",
		"image-to-video":       "first-frame",
		"reference":            "reference",
		"reference-generation": "reference",
		"reference-to-video":   "reference",
		"video-to-video":       "reference",
	}
	for input, want := range tests {
		if got := normalizeVideoReferenceMode(input); got != want {
			t.Fatalf("normalizeVideoReferenceMode(%q) = %q, want %q", input, got, want)
		}
	}
}
