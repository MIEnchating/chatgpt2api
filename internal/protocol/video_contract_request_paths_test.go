package protocol

import "testing"

func TestVideoContractRejectsConflictingRequestPaths(t *testing.T) {
	for _, paths := range [][2]string{
		{"duration", "duration"}, {"metadata", "metadata.duration"},
		{"metadata.duration", "metadata"}, {"images[01]", "images[1]"},
		{"images[0]", "images.key"}, {"model", "resolution"}, {"prompt.text", "resolution"},
	} {
		t.Run(paths[0]+"_"+paths[1], func(t *testing.T) {
			contract := DefaultVideoContracts()[0]
			contract.Request.DurationField = paths[0]
			contract.Request.ResolutionField = paths[1]
			if _, err := NormalizeVideoModelContract(contract); err == nil {
				t.Fatal("conflicting request paths were accepted")
			}
		})
	}
}

func TestVideoContractAllowsIndependentPathsAndExclusiveModeMappings(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Request.DurationField = "metadata.duration"
	contract.Request.ResolutionField = "metadata.resolution"
	contract.Request.FirstFrameField = "images[0]"
	contract.Request.LastFrameField = "images[1]"
	contract.Request.ReferenceImagesField = "images"
	if _, err := NormalizeVideoModelContract(contract); err != nil {
		t.Fatalf("independent or mutually exclusive mappings rejected: %v", err)
	}
	contract.Request.LastFrameField = "images[0]"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("overlapping first and last frame mappings accepted")
	}
}

func TestVideoContractMaterialEqualsUsesCounts(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	for _, field := range []string{"first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"} {
		contract.Rules = []VideoModelContractRule{{
			When:        VideoModelContractRuleCondition{Field: field, Operator: "equals", Value: "1"},
			ForceValues: map[string]string{"duration": "8"}, Message: "one material fixes duration",
		}}
		for _, value := range []any{1, "https://example.com/media", []string{"https://example.com/media"}} {
			values := map[string]any{field: value, "duration": 5}
			ApplyVideoContractForcedValues(contract, values)
			if values["duration"] != 8 {
				t.Fatalf("%s=%#v did not match count: %#v", field, value, values)
			}
		}
	}
}

func TestNewAPIDoubaoContractReservesContentAndRequiresURLMaterials(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Driver = VideoContractDriverVolcengine
	contract.Transport.LocalMaterial = "url"
	contract.Request.DurationField = "metadata.content[0].text"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("mapping into driver-owned content was accepted")
	}
	contract.Request.DurationField = "seconds"
	if _, err := NormalizeVideoModelContract(contract); err != nil {
		t.Fatal(err)
	}
	contract.Transport.LocalMaterial = "multipart"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("Doubao file upload was accepted")
	}
}

func TestVideoContractRejectsForcedMaterialValues(t *testing.T) {
	for _, field := range []string{"first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"} {
		contract := DefaultVideoContracts()[0]
		contract.Rules = []VideoModelContractRule{{
			When:        VideoModelContractRuleCondition{Field: "duration", Operator: "present"},
			ForceValues: map[string]string{field: "https://media.example/material"}, Message: "requires actual input",
		}}
		if _, err := NormalizeVideoModelContract(contract); err == nil {
			t.Fatalf("accepted forced material %s, which never enters the actual request", field)
		}
	}
}
