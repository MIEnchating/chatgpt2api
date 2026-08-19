package httpapi

import "testing"

func TestValidateOfficialVideoParameters(t *testing.T) {
	tests := []struct {
		name       string
		model      string
		size       string
		seconds    int
		resolution string
		wantError  bool
	}{
		{name: "grok 1.5 1080p", model: "grok-imagine-video-1.5", size: "3:2", seconds: 15, resolution: "1080p"},
		{name: "grok legacy rejects 1080p", model: "grok-imagine-video", size: "16:9", seconds: 10, resolution: "1080p", wantError: true},
		{name: "kling 3 range", model: "kling-v3", size: "1:1", seconds: 3, resolution: "720p"},
		{name: "kling legacy duration", model: "kling-v2-6", size: "16:9", seconds: 7, resolution: "1080p", wantError: true},
		{name: "minimax hailuo omits ratio", model: "MiniMax-Hailuo-2.3", seconds: 10, resolution: "768P"},
		{name: "minimax hailuo rejects ratio", model: "MiniMax-Hailuo-2.3", size: "16:9", seconds: 6, resolution: "768P", wantError: true},
		{name: "minimax h3", model: "MiniMax-H3", size: "21:9", seconds: 15, resolution: "2K"},
		{name: "seedance 2.5 smart", model: "doubao-seedance-2-5-260628", size: "adaptive", seconds: -1, resolution: "1080p"},
		{name: "seedance 2.0 4k", model: "doubao-seedance-2-0-260128", size: "16:9", seconds: 15, resolution: "4k"},
		{name: "seedance mini rejects 1080p", model: "doubao-seedance-2-0-mini-260128", size: "16:9", seconds: 8, resolution: "1080p", wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateVideoParameters(tt.model, tt.size, tt.seconds, tt.resolution)
			if (err != nil) != tt.wantError {
				t.Fatalf("validateVideoParameters() error = %v, wantError %v", err, tt.wantError)
			}
		})
	}
}
