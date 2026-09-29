package model

type WorkflowFieldMapping struct {
	ID                 string `json:"id,omitempty"`
	NodeID             string `json:"nodeId"`
	ClassType          string `json:"classType,omitempty"`
	FieldName          string `json:"fieldName"`
	FieldType          string `json:"fieldType,omitempty"`
	Label              string `json:"label,omitempty"`
	Role               string `json:"role,omitempty"`
	SafeToOverride     *bool  `json:"safeToOverride,omitempty"`
	OptionsSource      string `json:"optionsSource,omitempty"`
	Source             string `json:"source,omitempty"`
	SourceIndex        int    `json:"sourceIndex,omitempty"`
	ImageOrder         int    `json:"imageOrder,omitempty"`
	FieldValue         any    `json:"fieldValue,omitempty"`
	Value              any    `json:"value,omitempty"`
	Default            any    `json:"default,omitempty"`
	DefaultValue       any    `json:"defaultValue,omitempty"`
	Enabled            *bool  `json:"enabled,omitempty"`
	Required           bool   `json:"required,omitempty"`
	RandomEnabled      bool   `json:"randomEnabled,omitempty"`
	BindPrompt         bool   `json:"bindPrompt,omitempty"`
	SourceFromUpstream bool   `json:"sourceFromUpstream,omitempty"`
	SourceAutomatic    *bool  `json:"sourceAutomatic,omitempty"`
	Options            []any  `json:"options,omitempty"`
	Min                any    `json:"min,omitempty"`
	Max                any    `json:"max,omitempty"`
	Step               any    `json:"step,omitempty"`
}

type WorkflowEntry struct {
	Provider      string                 `json:"provider"`
	Kind          string                 `json:"kind"`
	WorkflowID    string                 `json:"workflowId"`
	Title         string                 `json:"title"`
	Capability    string                 `json:"capability"`
	Enabled       bool                   `json:"enabled"`
	Fields        []WorkflowFieldMapping `json:"fields"`
	WorkflowJSON  map[string]any         `json:"workflowJson,omitempty"`
	WorkflowGraph map[string]any         `json:"workflowGraph,omitempty"`
}

type WorkflowRef struct {
	Scope      string `json:"scope"`
	ChannelID  string `json:"channelId"`
	Kind       string `json:"kind"`
	WorkflowID string `json:"workflowId"`
}

type WorkflowRunInput struct {
	Ref                   WorkflowRef    `json:"ref"`
	ExpectedCapability    string         `json:"expectedCapability"`
	Prompt                string         `json:"prompt"`
	SystemPrompt          string         `json:"systemPrompt"`
	FieldValues           map[string]any `json:"fieldValues"`
	ReferenceImages       []string       `json:"referenceImages"`
	ReferenceVideos       []string       `json:"referenceVideos"`
	ReferenceAudios       []string       `json:"referenceAudios"`
	Mask                  string         `json:"mask"`
	Size                  string         `json:"size"`
	Quality               string         `json:"quality"`
	TransparentBackground bool           `json:"transparentBackground"`
	Count                 int            `json:"count"`
	VideoSeconds          string         `json:"videoSeconds"`
	VideoQuality          string         `json:"videoQuality"`
	VideoGenerateAudio    bool           `json:"videoGenerateAudio"`
	VideoWatermark        bool           `json:"videoWatermark"`
	AudioVoice            string         `json:"audioVoice"`
	AudioFormat           string         `json:"audioFormat"`
	AudioSpeed            float64        `json:"audioSpeed"`
	AudioInstructions     string         `json:"audioInstructions"`
	Source                string         `json:"source"`
	SourceID              string         `json:"sourceId"`
	NodeID                string         `json:"nodeId"`
	ClientTaskID          string         `json:"clientTaskId"`
}

type WorkflowOverride struct {
	NodeID    string `json:"nodeId"`
	FieldName string `json:"fieldName"`
	Value     any    `json:"value"`
}

type WorkflowChannel struct {
	BaseURL      string
	APIKey       string
	UploadAPIKey string
}
