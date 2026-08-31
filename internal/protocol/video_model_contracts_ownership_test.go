package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

func TestNormalizeVideoModelContractDoesNotMutateInput(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Generation.Modes[0].Label = "  Text to video  "
	contract.Rules[0].When.Field = " LAST_FRAME "
	contract.Rules[0].Require = []string{" FIRST_FRAME ", "first_frame"}
	contract.Rules[0].Limits = map[string]int{" FIRST_FRAME ": 1}
	contract.Rules[0].ForceValues = map[string]string{" DURATION ": " 5 "}
	contract.Rules[0].UI.Show = []string{" WATERMARK "}
	contract.Rules[0].Message = "  First frame is required  "

	before, err := json.Marshal(contract)
	if err != nil {
		t.Fatalf("marshal input before normalization: %v", err)
	}
	normalized, err := NormalizeVideoModelContract(contract)
	if err != nil {
		t.Fatalf("NormalizeVideoModelContract() error = %v", err)
	}
	after, err := json.Marshal(contract)
	if err != nil {
		t.Fatalf("marshal input after normalization: %v", err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("NormalizeVideoModelContract() mutated its input\nbefore: %s\nafter:  %s", before, after)
	}
	if normalized.Generation.Modes[0].Label != "Text to video" ||
		normalized.Rules[0].When.Field != "last_frame" ||
		len(normalized.Rules[0].Require) != 1 || normalized.Rules[0].Require[0] != "first_frame" ||
		normalized.Rules[0].Limits["first_frame"] != 1 ||
		normalized.Rules[0].ForceValues["duration"] != "5" ||
		len(normalized.Rules[0].UI.Show) != 1 || normalized.Rules[0].UI.Show[0] != "watermark" {
		t.Fatalf("normalized nested state = %#v", normalized)
	}
}

func TestIndexVideoModelContractsOwnsInput(t *testing.T) {
	contract := videoContractOwnershipFixture(t)
	input := []VideoModelContract{contract}
	registry := indexVideoModelContracts(input)
	mutateVideoContractNestedState(&input[0], "caller")

	if len(registry.contracts) != 1 {
		t.Fatalf("indexed contracts = %#v", registry.contracts)
	}
	assertVideoContractOwnershipFixture(t, registry.contracts[0])
	exact, ok := registry.exact["ownership-exact"]
	if !ok {
		t.Fatal("exact ownership index entry was not created")
	}
	assertVideoContractOwnershipFixture(t, exact)
	if len(registry.wildcards) != 1 {
		t.Fatalf("wildcard ownership index entries = %#v", registry.wildcards)
	}
	assertVideoContractOwnershipFixture(t, registry.wildcards[0].contract)
}

func TestVideoContractRegistryOwnsInputAndReturnsClones(t *testing.T) {
	t.Cleanup(func() {
		if err := ReplaceVideoContracts(DefaultVideoContracts()); err != nil {
			t.Fatalf("reset video contracts: %v", err)
		}
	})

	contract := videoContractOwnershipFixture(t)
	if err := ReplaceVideoContracts([]VideoModelContract{contract}); err != nil {
		t.Fatalf("ReplaceVideoContracts() error = %v", err)
	}
	mutateVideoContractNestedState(&contract, "caller")

	exact, ok := VideoContractForModel("ownership-exact")
	if !ok {
		t.Fatal("exact ownership contract was not found")
	}
	assertVideoContractOwnershipFixture(t, exact)
	mutateVideoContractNestedState(&exact, "returned")

	exactAgain, ok := VideoContractForModel("ownership-exact")
	if !ok {
		t.Fatal("exact ownership contract disappeared after mutating a result")
	}
	assertVideoContractOwnershipFixture(t, exactAgain)
	wildcard, ok := VideoContractForModel("ownership-wildcard")
	if !ok {
		t.Fatal("wildcard ownership contract was not found")
	}
	assertVideoContractOwnershipFixture(t, wildcard)

	active := ActiveVideoContracts()
	if len(active) != 1 {
		t.Fatalf("ActiveVideoContracts() = %#v", active)
	}
	assertVideoContractOwnershipFixture(t, active[0])
}

func TestVideoContractRegistryConcurrentOwnershipIsolation(t *testing.T) {
	t.Cleanup(func() {
		if err := ReplaceVideoContracts(DefaultVideoContracts()); err != nil {
			t.Fatalf("reset video contracts: %v", err)
		}
	})

	contract := videoContractOwnershipFixture(t)
	if err := ReplaceVideoContracts([]VideoModelContract{contract}); err != nil {
		t.Fatalf("ReplaceVideoContracts() error = %v", err)
	}

	const (
		readers    = 8
		iterations = 250
	)
	start := make(chan struct{})
	issues := make(chan string, readers)
	var wait sync.WaitGroup
	wait.Add(readers + 1)
	go func() {
		defer wait.Done()
		<-start
		for index := 0; index < iterations; index++ {
			if index%2 == 0 {
				contract.Generation.Modes[0].Label = "caller mutation a"
			} else {
				contract.Generation.Modes[0].Label = "caller mutation b"
			}
		}
	}()
	for reader := 0; reader < readers; reader++ {
		reader := reader
		go func() {
			defer wait.Done()
			<-start
			model := "ownership-exact"
			if reader%2 != 0 {
				model = "ownership-wildcard"
			}
			issue := ""
			for index := 0; index < iterations; index++ {
				value, ok := VideoContractForModel(model)
				if !ok {
					issue = fmt.Sprintf("VideoContractForModel(%q) did not match", model)
					break
				}
				if value.Generation.Modes[0].Label != "Text to video" || value.Polling.ResultFields[0] != "video_url" {
					issue = fmt.Sprintf("VideoContractForModel(%q) exposed mutated state: %#v", model, value)
					break
				}
				value.Generation.Modes[0].Label = "returned mutation"
				value.Polling.ResultFields[0] = "returned.result"
			}
			if issue != "" {
				issues <- issue
			}
		}()
	}
	close(start)
	wait.Wait()
	close(issues)
	for issue := range issues {
		t.Error(issue)
	}

	stored, ok := VideoContractForModel("ownership-exact")
	if !ok {
		t.Fatal("ownership contract disappeared after concurrent access")
	}
	assertVideoContractOwnershipFixture(t, stored)
}

func videoContractOwnershipFixture(t *testing.T) VideoModelContract {
	t.Helper()
	contract := DefaultVideoContracts()[0]
	contract.Name = "Ownership contract"
	contract.Models = []string{"ownership-exact", "ownership-*"}
	contract.Artifact.AllowedHosts = []string{"media.example.com"}
	contract.Generation.Modes[0].Label = "Text to video"
	contract.Rules = []VideoModelContractRule{{
		When:        VideoModelContractRuleCondition{Field: "watermark", Operator: "equals", Value: "true"},
		Require:     []string{"size"},
		RequireAny:  []string{"reference_image"},
		Forbid:      []string{"reference_audio"},
		Limits:      map[string]int{"reference_image": 1},
		ForceValues: map[string]string{"duration": "5"},
		UI: VideoModelContractRuleUI{
			Show:    []string{"watermark"},
			Hide:    []string{"reference_audio"},
			Disable: []string{"duration"},
		},
		Message: "Invalid material combination",
	}}
	normalized, err := NormalizeVideoModelContract(contract)
	if err != nil {
		t.Fatalf("normalize ownership fixture: %v", err)
	}
	return normalized
}

func mutateVideoContractNestedState(contract *VideoModelContract, prefix string) {
	contract.Models[0] = prefix + "-model"
	contract.Artifact.AllowedHosts[0] = prefix + ".example.com"
	contract.Capability.Sizes[0] = prefix + "-size"
	contract.Capability.Seconds[0] = 999
	contract.Capability.Resolutions[0] = prefix + "-resolution"
	contract.Generation.Modes[0].Label = prefix + " mode"
	contract.Rules[0].When.Field = "duration"
	contract.Rules[0].Require[0] = "duration"
	contract.Rules[0].RequireAny[0] = "video"
	contract.Rules[0].Forbid[0] = "watermark"
	contract.Rules[0].Limits["reference_image"] = 999
	contract.Rules[0].ForceValues["duration"] = "999"
	contract.Rules[0].UI.Show[0] = "duration"
	contract.Rules[0].UI.Hide[0] = "watermark"
	contract.Rules[0].UI.Disable[0] = "size"
	contract.Polling.TaskIDFields[0] = prefix + ".task_id"
	contract.Polling.StatusFields[0] = prefix + ".status"
	contract.Polling.ProgressFields[0] = prefix + ".progress"
	contract.Polling.ErrorFields[0] = prefix + ".error"
	contract.Polling.QueuedStatuses[0] = prefix + "-queued"
	contract.Polling.RunningStatuses[0] = prefix + "-running"
	contract.Polling.SuccessStatuses[0] = prefix + "-success"
	contract.Polling.FailureStatuses[0] = prefix + "-failure"
	contract.Polling.ResultFields[0] = prefix + ".result"
}

func assertVideoContractOwnershipFixture(t *testing.T, contract VideoModelContract) {
	t.Helper()
	rule := contract.Rules[0]
	if contract.Name != "Ownership contract" ||
		len(contract.Models) != 2 || contract.Models[0] != "ownership-exact" ||
		len(contract.Artifact.AllowedHosts) != 1 || contract.Artifact.AllowedHosts[0] != "media.example.com" ||
		contract.Capability.Sizes[0] != "auto" || contract.Capability.Seconds[0] != 4 || contract.Capability.Resolutions[0] != "768p" ||
		contract.Generation.Modes[0].Label != "Text to video" ||
		rule.When.Field != "watermark" || rule.Require[0] != "size" || rule.RequireAny[0] != "reference_image" || rule.Forbid[0] != "reference_audio" ||
		rule.Limits["reference_image"] != 1 || rule.ForceValues["duration"] != "5" ||
		rule.UI.Show[0] != "watermark" || rule.UI.Hide[0] != "reference_audio" || rule.UI.Disable[0] != "duration" ||
		contract.Polling.TaskIDFields[0] != "id" || contract.Polling.StatusFields[0] != "status" || contract.Polling.ProgressFields[0] != "progress" ||
		contract.Polling.ErrorFields[0] != "error.message" || contract.Polling.QueuedStatuses[0] != "queued" ||
		contract.Polling.RunningStatuses[0] != "in_progress" || contract.Polling.SuccessStatuses[0] != "completed" ||
		contract.Polling.FailureStatuses[0] != "failed" || contract.Polling.ResultFields[0] != "video_url" {
		t.Fatalf("video contract nested state was not isolated: %#v", contract)
	}
}
