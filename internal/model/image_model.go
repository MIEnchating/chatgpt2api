package model

// ImageModelDefinition describes an administrator-configured image adapter.
type ImageModelDefinition struct {
	Protocol           string   `json:"protocol"`
	AspectRatios       []string `json:"aspect_ratios"`
	Resolutions        []string `json:"resolutions"`
	QualityValues      []string `json:"quality_values"`
	MaxReferenceImages int      `json:"max_reference_images"`
	MaxOutputCount     int      `json:"max_output_count"`
	Streaming          bool     `json:"streaming"`
	Mask               bool     `json:"mask"`
	OutputControls     bool     `json:"output_controls"`
	ExactDimensions    bool     `json:"exact_dimensions"`
}
