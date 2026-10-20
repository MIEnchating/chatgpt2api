package protocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func dramayaTestContract(t *testing.T) VideoModelContract {
	t.Helper()
	data, err := os.ReadFile("../../docs/examples/dramaya-grok-video-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Contracts []struct {
			Contract VideoModelContract `json:"contract"`
		} `json:"contracts"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Contracts) != 1 {
		t.Fatal("expected one shared contract")
	}
	contract, err := NormalizeVideoModelContract(doc.Contracts[0].Contract)
	if err != nil {
		t.Fatal(err)
	}
	return contract
}

func TestVideoModelProfilesResolveIndependentCapabilities(t *testing.T) {
	previous := ActiveVideoContracts()
	t.Cleanup(func() { _ = ReplaceVideoContracts(previous) })
	contract := dramayaTestContract(t)
	if err := ReplaceVideoContracts([]VideoModelContract{contract}); err != nil {
		t.Fatal(err)
	}
	for _, model := range contract.Models {
		resolved, ok := VideoContractForModel(strings.ToUpper(model))
		if !ok || resolved.Name != contract.Name || len(resolved.ModelProfiles) != 0 {
			t.Fatalf("invalid snapshot for %s", model)
		}
		enhanced := strings.HasSuffix(model, "1.5")
		if stringSliceContains(resolved.Capability.Resolutions, "1080p") != enhanced || resolved.Capability.ReferenceMode != enhanced {
			t.Fatalf("capabilities leaked between models: %#v", resolved.Capability)
		}
		if resolved.Capability.DefaultSeconds != 8 || len(resolved.Capability.Seconds) != 15 || len(resolved.Capability.Sizes) != 7 {
			t.Fatal("incorrect published parameters")
		}
		resolved.Capability.Resolutions[0] = "mutated"
		resolved.Generation.Modes[0].Label = "mutated"
	}
	if ActiveVideoContracts()[0].ModelProfiles[0].Capability.Resolutions[0] != "480p" {
		t.Fatal("registry was mutated through a snapshot")
	}
	exposed := ActiveVideoContracts()
	exposed[0].ModelProfiles[1].Generation.Modes[0].Label = "caller"
	if ActiveVideoContracts()[0].ModelProfiles[1].Generation.Modes[0].Label == "caller" {
		t.Fatal("profile was not deeply cloned")
	}
	if _, ok := VideoContractForModel("grok-unknown"); ok {
		t.Fatal("unexpected model alias")
	}
}

func TestVideoModelProfilesRejectInvalidOverrides(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*VideoModelContract)
	}{
		{"unknown model", func(c *VideoModelContract) { c.ModelProfiles[0].Model = "unpublished-video" }},
		{"wildcard", func(c *VideoModelContract) {
			c.Models = append(c.Models, "grok-*")
			c.ModelProfiles[0].Model = "grok-*"
		}},
		{"duplicate", func(c *VideoModelContract) { c.ModelProfiles[1].Model = strings.ToUpper(c.ModelProfiles[0].Model) }},
		{"invalid default", func(c *VideoModelContract) { c.ModelProfiles[0].Capability.DefaultResolution = "1080p" }},
		{"missing material mapping", func(c *VideoModelContract) { c.Request.ReferenceImagesField = "" }},
		{"invalid material mode", func(c *VideoModelContract) { c.ModelProfiles[1].Generation.Modes[0].Materials.Image.Max = 1 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			contract := dramayaTestContract(t)
			test.mutate(&contract)
			if _, err := NormalizeVideoModelContract(contract); err == nil {
				t.Fatal("invalid profile was accepted")
			}
		})
	}
}
