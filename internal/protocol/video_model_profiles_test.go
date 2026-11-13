package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestVideoModelProfilesSupportSharedUpstreamModelLimit(t *testing.T) {
	for _, count := range []int{23, 100, 101} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			contract := dramayaTestContract(t)
			profile := contract.ModelProfiles[0]
			contract.Models = nil
			contract.ModelProfiles = nil
			for index := 0; index < count; index++ {
				model := fmt.Sprintf("shared-video-%d", index)
				contract.Models = append(contract.Models, model)
				profile.Model = model
				contract.ModelProfiles = append(contract.ModelProfiles, profile)
			}
			_, err := NormalizeVideoModelContract(contract)
			if count <= 100 && err != nil {
				t.Fatalf("shared upstream with %d models rejected: %v", count, err)
			}
			if count > 100 && err == nil {
				t.Fatal("model limit was not enforced")
			}
			contract.ModelProfiles = nil
			_, err = NormalizeVideoModelContract(contract)
			if (count <= 100) != (err == nil) {
				t.Fatalf("model-only contract with %d models: %v", count, err)
			}
		})
	}
}

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
		{"missing material mapping", func(c *VideoModelContract) {
			for i := range c.ModelProfiles {
				request := *c.ModelProfiles[i].Request
				request.ReferenceImagesField = ""
				c.ModelProfiles[i].Request = &request
			}
		}},
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
