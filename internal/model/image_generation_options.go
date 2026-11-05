package model

// ImageGenerationOptions contains the optional GPT Image planning and output controls.
type ImageGenerationOptions struct {
	Complexity      string `json:"complexity,omitempty"`
	Background      string `json:"background,omitempty"`
	FrameCount      *int   `json:"frame_count,omitempty"`
	FrameDurationMS *int   `json:"frame_duration_ms,omitempty"`
	Markup          string `json:"markup,omitempty"`
}
