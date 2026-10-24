package protocol

import (
	"testing"
)

func TestVideoParametersValidateAndPreserveExplicitValues(t *testing.T) {
	cap := VideoModelContractCapability{Parameters: []VideoModelParameter{
		{Name: "seed", Label: "Seed", Field: "seed", Type: "integer"},
		{Name: "prompt_enhance", Label: "Enhance", Field: "prompt_enhance", Type: "boolean", Default: true},
		{Name: "callback_url", Label: "Callback", Field: "callback_url", Type: "string", Format: "uri"},
		{Name: "prompt_expansion_mode", Label: "Expansion", Field: "prompt_expansion_mode", Type: "string", Required: true, Enum: []string{"balanced", "quality"}},
	}}
	input := map[string]any{"seed": 0, "prompt_enhance": false, "prompt_expansion_mode": "quality"}
	got, err := NormalizeVideoParameters(cap, "text", input)
	if err != nil || got["seed"] != 0 || got["prompt_enhance"] != false || len(got) != 3 {
		t.Fatalf("got %#v: %v", got, err)
	}
	for _, bad := range []map[string]any{
		{}, {"seed": 1.5, "prompt_expansion_mode": "quality"}, {"prompt_expansion_mode": "fast"},
		{"prompt_expansion_mode": "quality", "callback_url": "javascript:alert(1)"},
		{"prompt_expansion_mode": "quality", "unknown": true}, {"prompt_expansion_mode": "quality", "seed": nil},
	} {
		if _, err := NormalizeVideoParameters(cap, "text", bad); err == nil {
			t.Fatalf("accepted %#v", bad)
		}
	}
}

func TestVideoExtendedContractValidation(t *testing.T) {
	c := DefaultVideoContracts()[0]
	c.ModelProfiles = nil
	c.Capability.Seconds = nil
	c.Capability.SecondsRange = &VideoDurationRange{Min: 1, Step: 1}
	c.Polling.IntervalSeconds, c.Polling.TimeoutSeconds = 0, 0
	c.Capability.Parameters = []VideoModelParameter{{Name: "seed", Label: "Seed", Field: "settings.seed", Type: "integer"}}
	normalized, err := NormalizeVideoModelContract(c)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Polling.IntervalSeconds != 5 || normalized.Polling.TimeoutSeconds != 900 || !VideoDurationSupported(normalized.Capability, 5000) {
		t.Fatal("defaults or open range lost")
	}
	c.Capability.Parameters[0].Field = c.Request.DurationField
	if _, err := NormalizeVideoModelContract(c); err == nil {
		t.Fatal("overlapping field accepted")
	}
	c.Capability.Parameters[0].Field = "settings.constructor"
	if _, err := NormalizeVideoModelContract(c); err == nil {
		t.Fatal("prototype field accepted")
	}
	c.Capability.Parameters[0].Field = "settings.seed"
	c.Capability.SecondsRange.Step = 0
	if _, err := NormalizeVideoModelContract(c); err == nil {
		t.Fatal("zero step accepted")
	}
}

func TestVideoParameterProfilesAndOwnership(t *testing.T) {
	c := DefaultVideoContracts()[0]
	c.ModelProfiles = nil
	c.Models = []string{"video-a", "video-b"}
	minimum := 0.0
	c.Capability.Parameters = []VideoModelParameter{{Name: "seed", Label: "Seed", Field: "seed", Type: "integer", Minimum: &minimum}}
	profile := videoModelProfileFromContract("video-b", c)
	profile.Capability.Parameters = nil
	c.ModelProfiles = []VideoModelContractProfile{profile}
	n, err := NormalizeVideoModelContract(c)
	if err != nil {
		t.Fatal(err)
	}
	*c.Capability.Parameters[0].Minimum = 99
	if *n.Capability.Parameters[0].Minimum != 0 {
		t.Fatal("shared parameter pointer")
	}
	b, _ := ResolveVideoModelContract(n, "video-b")
	if len(b.Capability.Parameters) != 0 {
		t.Fatal("parameters leaked between models")
	}
}

func TestSharedScalarMaterialRequiresConsistentMultipartRoute(t *testing.T) {
	c := VideoModelContract{
		Request: VideoModelContractRequest{ReferenceValueType: "scalar", ReferenceImagesField: "input_reference", ReferenceVideosField: "input_reference"},
		Transport: VideoModelContractTransport{LocalMaterial: "multipart", MultipartFields: map[string]string{
			"reference_image": "image", "reference_video": "video",
		}},
		Generation: VideoModelContractGeneration{Modes: []VideoModelGenerationMode{{
			Kind: "reference", Materials: VideoModelModeMaterials{
				Image: VideoModelMaterialRange{Max: 1}, Video: VideoModelMaterialRange{Max: 1}, Total: VideoModelMaterialRange{Max: 1},
			},
		}}},
	}
	if err := validateVideoContractMultipartFields(c); err == nil {
		t.Fatal("accepted ambiguous upload routes for a shared scalar path")
	}
	c.Transport.MultipartFields["reference_image"] = "input_reference"
	c.Transport.MultipartFields["reference_video"] = "input_reference"
	if err := validateVideoContractMultipartFields(c); err != nil {
		t.Fatal(err)
	}
}

func TestVideoContractProviderHintsValidationAndOwnership(t *testing.T) {
	c := DefaultVideoContracts()[0]
	c.Provider = &VideoContractProvider{BaseURL: "https://API.example.com/", AuthMode: "header", AuthHeader: "X-Api-Key"}
	n, err := NormalizeVideoModelContract(c)
	if err != nil {
		t.Fatal(err)
	}
	if n.Provider.BaseURL != "https://api.example.com" || n.Provider.AuthHeader != "X-Api-Key" {
		t.Fatalf("unexpected provider: %#v", n.Provider)
	}
	c.Provider.BaseURL = "https://other.example.com"
	if n.Provider.BaseURL != "https://api.example.com" {
		t.Fatal("provider metadata is aliased")
	}
	for _, p := range []VideoContractProvider{
		{BaseURL: "https://secret@api.example.com"}, {BaseURL: "https://api.example.com?key=secret"},
		{AuthMode: "header", AuthHeader: "Authorization"}, {AuthMode: "header", AuthHeader: "X-Key\r\nOther"},
		{AuthMode: "bearer", AuthHeader: "Bearer secret"}, {AuthMode: "guessed"},
	} {
		c.Provider = &p
		if _, err := NormalizeVideoModelContract(c); err == nil {
			t.Fatalf("accepted invalid provider: %#v", p)
		}
	}
	c.Provider = &VideoContractProvider{}
	n, err = NormalizeVideoModelContract(c)
	if err != nil || n.Provider != nil {
		t.Fatal("unknown provider must remain unset")
	}
}
