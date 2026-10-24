package protocol

import (
	"strings"
	"testing"
)

func TestDryRunVideoModelContractsCoversDefaultModelModes(t *testing.T) {
	contract := dramayaTestContract(t)
	results, err := DryRunVideoModelContracts([]VideoModelContract{contract})
	if err != nil {
		t.Fatal(err)
	}
	wantModes := 0
	for _, model := range contract.Models {
		profile, ok := ResolveVideoModelContract(contract, model)
		if !ok {
			t.Fatalf("model %q did not resolve", model)
		}
		wantModes += len(profile.Generation.Modes)
	}
	if len(results) != 1 || !results[0].Passed || results[0].ModelsTested != len(contract.Models) || results[0].ModesTested != wantModes {
		t.Fatalf("unexpected dry-run result: %#v", results)
	}
	if len(results[0].Checks) == 0 {
		t.Fatal("dry-run did not report its checks")
	}
}

func TestDryRunVideoModelContractsRejectsInvalidForcedDefaults(t *testing.T) {
	contract := dramayaTestContract(t)
	rule := VideoModelContractRule{
		When:        VideoModelContractRuleCondition{Field: "duration", Operator: "present"},
		ForceValues: map[string]string{"duration": "999"},
		Message:     "forced duration is unsupported",
	}
	contract.Rules = append(contract.Rules, rule)
	for index := range contract.ModelProfiles {
		contract.ModelProfiles[index].Rules = append(contract.ModelProfiles[index].Rules, rule)
	}
	_, err := DryRunVideoModelContracts([]VideoModelContract{contract})
	if err == nil || !strings.Contains(err.Error(), "规则强制值不在可选参数范围内") {
		t.Fatalf("DryRunVideoModelContracts() error = %v, want unsupported forced-default error", err)
	}
}
