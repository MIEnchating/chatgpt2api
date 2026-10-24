package httpapi

import (
	"chatgpt2api/internal/protocol"
	"encoding/json"
	"strings"
	"testing"
)

func TestReviewGeneratedProviderRequiresDocumentEvidence(t *testing.T) {
	c := dramayaVideoContract(t)
	c.Models = []string{"grok-imagine-video"}
	c.ModelProfiles = nil
	c.Provider = &protocol.VideoContractProvider{BaseURL: "https://api.example.com", AuthMode: "header", AuthHeader: "X-Api-Key"}
	const source = "grok-imagine-video; POST /videos; duration 8; status completed; GET /videos/{id}/content; API Base URL https://api.example.com; Authentication X-Api-Key"
	e := map[string]any{"model": c.Models[0], "endpoints_quote": "POST /videos", "parameters_quote": "duration 8", "polling_quote": "status completed", "download_quote": "GET /videos/{id}/content", "review_issues": []string{}, "provider_base_url_quote": "API Base URL https://api.example.com", "provider_auth_quote": "Authentication X-Api-Key"}
	output := func() string {
		b, err := json.Marshal(map[string]any{"contracts": []protocol.VideoModelContract{c}, "evidence": []any{e}})
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	result, err := reviewGeneratedVideoContracts(output(), source)
	if err != nil || result.Contracts[0].Provider.AuthHeader != "X-Api-Key" {
		t.Fatalf("provider extraction failed: %v", err)
	}
	e["provider_base_url_quote"] = ""
	if _, err := reviewGeneratedVideoContracts(output(), source); err == nil {
		t.Fatal("accepted address without evidence")
	}
	e["provider_base_url_quote"] = "POST /videos"
	if _, err := reviewGeneratedVideoContracts(output(), source); err == nil {
		t.Fatal("accepted unrelated URL evidence")
	}
	e["provider_base_url_quote"] = "API Base URL https://api.example.com"
	c.Provider.AuthMode = "bearer"
	c.Provider.AuthHeader = ""
	if _, err := reviewGeneratedVideoContracts(output(), source); err == nil {
		t.Fatal("accepted bearer inferred from API key header")
	}
	c.Provider = &protocol.VideoContractProvider{}
	e["provider_base_url_quote"] = ""
	e["provider_auth_quote"] = ""
	result, err = reviewGeneratedVideoContracts(output(), source)
	if err != nil || result.Contracts[0].Provider != nil || !result.DryRun[0].ReviewPassed || len(result.DryRun[0].ReviewIssues) != 0 {
		t.Fatal("missing provider must remain empty without blocking the contract")
	}
}

func TestReviewGeneratedVideoContractsEvidence(t *testing.T) {
	contract := dramayaVideoContract(t)
	contract.Models = []string{"grok-imagine-video"}
	contract.Name = "Review video contract"
	contract.ModelProfiles = nil
	contracts, err := json.Marshal([]any{contract})
	if err != nil {
		t.Fatal(err)
	}
	const source = "grok-imagine-video creates with POST /videos. duration is 8 seconds. status is completed. Download with GET /videos/{id}/content."

	makeOutput := func(quotes [4]string, issues ...string) string {
		t.Helper()
		evidence, err := json.Marshal(map[string]any{"model": "grok-imagine-video", "endpoints_quote": quotes[0], "parameters_quote": quotes[1], "polling_quote": quotes[2], "download_quote": quotes[3], "review_issues": append([]string{}, issues...)})
		if err != nil {
			t.Fatal(err)
		}
		return `{"contracts":` + string(contracts) + `,"evidence":[` + string(evidence) + `]}`
	}

	t.Run("valid continuous quotes", func(t *testing.T) {
		result, err := reviewGeneratedVideoContracts(makeOutput([4]string{
			"POST /videos", "duration is 8 seconds", "status is completed", "GET /videos/{id}/content",
		}), source)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.DryRun) != 1 || !result.DryRun[0].EvidenceComplete || !result.DryRun[0].Passed || !result.DryRun[0].ReviewPassed {
			t.Fatalf("unexpected reviewed result: %#v", result.DryRun)
		}
	})

	t.Run("missing quotes are pending review", func(t *testing.T) {
		result, err := reviewGeneratedVideoContracts(makeOutput([4]string{"POST /videos", "", "status is completed", "GET /videos/{id}/content"}), source)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.DryRun) != 1 || result.DryRun[0].EvidenceComplete || len(result.DryRun[0].MissingEvidence) != 1 || result.DryRun[0].ReviewPassed {
			t.Fatalf("missing evidence was not marked pending: %#v", result.DryRun)
		}
	})

	t.Run("unmapped requirements cannot pass preliminary review", func(t *testing.T) {
		result, err := reviewGeneratedVideoContracts(makeOutput([4]string{
			"POST /videos", "duration is 8 seconds", "status is completed", "GET /videos/{id}/content",
		}, "Required prompt_expansion_mode has no supported request mapping"), source)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Contracts) != 1 || len(result.DryRun) != 1 {
			t.Fatal("pending draft was discarded")
		}
		review := result.DryRun[0]
		if !review.Passed || !review.EvidenceComplete || review.ReviewPassed || len(review.ReviewIssues) != 1 || !strings.Contains(review.ReviewIssues[0], "prompt_expansion_mode") {
			t.Fatalf("unmapped requirement was treated as executable: %#v", review)
		}
	})

	t.Run("review issues are required and bounded", func(t *testing.T) {
		output := makeOutput([4]string{"POST /videos", "duration is 8 seconds", "status is completed", "GET /videos/{id}/content"})
		for _, replacement := range []string{"null", `[""]`, `["   "]`, `["` + strings.Repeat("x", 501) + `"]`} {
			invalid := strings.Replace(output, `"review_issues":[]`, `"review_issues":`+replacement, 1)
			if _, err := reviewGeneratedVideoContracts(invalid, source); err == nil || !strings.Contains(err.Error(), "review_issues") {
				t.Fatalf("invalid review issues accepted: %s, %v", replacement, err)
			}
		}
		without := strings.Replace(output, `,"review_issues":[]`, "", 1)
		if _, err := reviewGeneratedVideoContracts(without, source); err == nil {
			t.Fatal("missing review issues accepted")
		}
	})

	t.Run("fabricated quotes are rejected", func(t *testing.T) {
		_, err := reviewGeneratedVideoContracts(makeOutput([4]string{
			"POST /videos", "duration is always 8 seconds", "status is completed", "GET /videos/{id}/content",
		}), source)
		if err == nil || !strings.Contains(err.Error(), "引文不在原始文档中") {
			t.Fatalf("fabricated quote error = %v", err)
		}
	})
}
