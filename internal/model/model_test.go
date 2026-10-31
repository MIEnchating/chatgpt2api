package model

import (
	"encoding/json"
	"testing"
)

func TestStorageSettingJSONContract(t *testing.T) {
	data, err := json.Marshal(StorageSetting{
		Mode:                    "local",
		Providers:               []StorageProvider{{ID: "p1", Type: StorageProviderTypeWebDAV, PathPrefix: "assets"}},
		LocalCapacityLimitBytes: 10,
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	for _, key := range []string{"mode", "allowUserProvider", "allowUserGlobalProvider", "providers", "capacityCheck", "capacityLimitBytes", "localCapacityLimitBytes"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("StorageSetting JSON is missing key %q", key)
		}
	}
	provider := decoded["providers"].([]any)[0].(map[string]any)
	for _, key := range []string{"id", "type", "pathPrefix", "accessKeyId", "secretAccessKey", "publicBaseUrl", "ownerUserId", "capacityExceeded"} {
		if _, ok := provider[key]; !ok {
			t.Errorf("StorageProvider JSON is missing key %q", key)
		}
	}
}

func TestStorageProviderTypeConstants(t *testing.T) {
	if StorageProviderTypeLocal != "local" || StorageProviderTypeS3 != "s3" || StorageProviderTypeWebDAV != "webdav" {
		t.Fatal("storage provider type constants changed")
	}
}

func TestWorkflowFieldMappingOmitsEmptyOptionalFields(t *testing.T) {
	data, err := json.Marshal(WorkflowFieldMapping{NodeID: "1", FieldName: "text"})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(decoded) != 2 || decoded["nodeId"] != "1" || decoded["fieldName"] != "text" {
		t.Fatalf("unexpected JSON = %s", data)
	}
}

func TestAutoDLWorkflowInputRulesRoundTrip(t *testing.T) {
	min := 1.0
	input := AutoDLWorkflow{UUID: "u", Name: "n", Kind: "image", InputRules: map[string]AutoDLInputRule{"steps": {Type: "number", Required: true, Min: &min, Options: []AutoDLOption{{Label: "a"}}}}}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var output AutoDLWorkflow
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	rule := output.InputRules["steps"]
	if output.UUID != "u" || !rule.Required || rule.Min == nil || *rule.Min != 1 || rule.Max != nil || len(rule.Options) != 1 {
		t.Fatalf("round trip lost data: %#v", output)
	}
}

func TestImageModelDefinitionJSONKeys(t *testing.T) {
	data, err := json.Marshal(ImageModelDefinition{Protocol: "openai", MaxOutputCount: 4})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	for _, key := range []string{"protocol", "aspect_ratios", "resolutions", "quality_values", "max_reference_images", "max_output_count", "streaming", "mask", "output_controls", "exact_dimensions"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("ImageModelDefinition JSON is missing key %q", key)
		}
	}
}
