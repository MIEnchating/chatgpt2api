package model

type AutoDLInputRule struct {
	Type      string         `json:"type"`
	Required  bool           `json:"required"`
	Default   any            `json:"default,omitempty"`
	Min       *float64       `json:"min,omitempty"`
	Max       *float64       `json:"max,omitempty"`
	MinLength *int           `json:"min_length,omitempty"`
	MaxLength *int           `json:"max_length,omitempty"`
	Options   []AutoDLOption `json:"options,omitempty"`
}

type AutoDLOption struct {
	Label string `json:"label"`
}

type AutoDLWorkflow struct {
	UUID       string                     `json:"uuid"`
	Name       string                     `json:"name"`
	Kind       string                     `json:"kind"`
	InputRules map[string]AutoDLInputRule `json:"input_rules,omitempty"`
}
