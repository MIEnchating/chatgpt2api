package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
)

func TestVideoContractAgentToolsValidateBeforeFinish(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	contract.Models = []string{"agent-video-v1"}
	contract.Driver = protocol.VideoContractDriverCustom
	contract.Transport.CreatePath, contract.Transport.QueryPath = "/v1/videos", "/v1/videos/{task_id}"
	output, _ := json.Marshal(map[string]any{"contracts": []protocol.VideoModelContract{contract}, "evidence": []map[string]any{{"model": "agent-video-v1", "endpoints_quote": "", "parameters_quote": "", "polling_quote": "", "download_quote": "", "review_issues": []string{}}}})
	state := &videoContractAgentState{content: "agent-video-v1", report: func(videoContractImportProgressEvent) {}}
	ctx := context.Background()
	if _, _, err := state.execute(ctx, "run_shell", `{"command":"pwd"}`); err == nil {
		t.Fatal("unknown tool accepted")
	}
	if _, _, err := state.executeTool(ctx, "finish", `{}`); err == nil {
		t.Fatal("finished without inspecting protocols")
	}
	if _, _, err := state.executeTool(ctx, "inspect_protocols", `{"anything":true}`); err == nil {
		t.Fatal("unexpected arguments accepted")
	}
	if _, _, err := state.executeTool(ctx, "inspect_protocols", `{}`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := state.executeTool(ctx, "finish", `{}`); err == nil {
		t.Fatal("finished before validation")
	}
	result, done, err := state.executeTool(ctx, "validate_contracts", string(output))
	if err != nil || done || !strings.Contains(result, `"requests"`) {
		t.Fatalf("validation: %v %s", err, result)
	}
	if state.result.Contracts[0].Driver != protocol.VideoContractDriverOpenAI || state.result.DryRun[0].ReviewPassed {
		t.Fatal("matching or missing-evidence status was lost")
	}
	if _, done, err := state.executeTool(ctx, "finish", `{}`); err != nil || !done {
		t.Fatalf("finish: %v", err)
	}
	if _, _, err := state.executeTool(ctx, "validate_contracts", `{}`); err == nil {
		t.Fatal("invalid contract accepted")
	}
	if _, _, err := state.executeTool(ctx, "finish", `{}`); err == nil {
		t.Fatal("failed validation reused stale result")
	}
	state.validations = videoContractGenerationAttempts
	if _, _, err := state.executeTool(ctx, "validate_contracts", string(output)); err == nil {
		t.Fatal("validation limit bypassed")
	}
}

func TestVideoContractAgentReadsOnlyCandidateDocuments(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "text/markdown")
		fmt.Fprint(w, "# Query endpoint\nGET /v1/videos/{task_id}")
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	page, _ := url.Parse(server.URL + "/query.md")
	state := &videoContractAgentState{content: "Original model documentation", read: map[int]string{}, client: server.Client(), result: &videoContractGenerationResult{}, source: videoContractImportSource{Site: &videoContractDocumentSite{baseURL: base, remainingBytes: 4096, links: []videoContractDocumentLink{{index: 1, name: "Query", url: page}}}}}
	for _, ids := range [][]int{nil, {0}, {2}, {1, 1}} {
		if _, err := state.readDocuments(context.Background(), ids, nil); err == nil {
			t.Fatalf("invalid ids accepted: %v", ids)
		}
	}
	for n := 0; n < 2; n++ {
		if _, err := state.readDocuments(context.Background(), []int{1}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if requests != 1 || strings.Count(state.content, "# Query endpoint") != 1 || state.result != nil {
		t.Fatal("cache, evidence accumulation or validation invalidation failed")
	}
	state.read = map[int]string{}
	state.source.Site.remainingBytes = 1
	output, err := state.readDocuments(context.Background(), []int{1}, nil)
	var batch videoContractDocumentBatch
	if err != nil || json.Unmarshal([]byte(output), &batch) != nil || len(batch.Documents) != 0 || len(batch.Errors) != 1 || len(state.read) != 0 {
		t.Fatalf("byte budget failure must be returned per page: output=%s err=%v", output, err)
	}
}

func TestVideoContractAgentPartialDocumentReads(t *testing.T) {
	var successRequests, failedRequests atomic.Int32
	var healthy atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/query.md" {
			failedRequests.Add(1)
			if !healthy.Load() {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
		} else {
			successRequests.Add(1)
		}
		w.Header().Set("Content-Type", "text/markdown")
		fmt.Fprint(w, "# Endpoint\n"+strings.Repeat("Documentation. ", 800))
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	create, _ := url.Parse(server.URL + "/create.md")
	query, _ := url.Parse(server.URL + "/query.md")
	events := []videoContractImportProgressEvent{}
	state := &videoContractAgentState{inspected: true, content: "Original", read: map[int]string{}, client: server.Client(), result: &videoContractGenerationResult{}, report: func(e videoContractImportProgressEvent) { events = append(events, e) }, source: videoContractImportSource{Site: &videoContractDocumentSite{baseURL: base, remainingBytes: 100000, links: []videoContractDocumentLink{{index: 1, name: "Create", url: create}, {index: 2, name: "Query", url: query}}}}}
	output, _, err := state.execute(context.Background(), "read_documents", `{"ids":[1,2]}`)
	var batch videoContractDocumentBatch
	if err != nil || json.Unmarshal([]byte(output), &batch) != nil || len(batch.Documents) != 1 || len(batch.Errors) != 1 || batch.Documents[0].ID != 1 || batch.Errors[0].ID != 2 {
		t.Fatalf("lost partial document results: output=%s err=%v", output, err)
	}
	if len(events) != 4 || events[0].ValidationCurrent == nil || !*events[0].ValidationCurrent || *events[1].ValidationCurrent || *events[1].DocumentRevision != 1 {
		t.Fatalf("per-page invalidation was not emitted: %#v", events)
	}
	last := events[len(events)-1]
	if last.Detail.Status != "partial" || last.Detail.Summary != "已读取 1 页，1 页读取失败" || !strings.Contains(last.Detail.Error, "页面 2 · Query") || !strings.Contains(last.Detail.Output, "仅展示前 8000 字") {
		t.Fatalf("partial detail lost count or failure after truncation: %#v", last.Detail)
	}
	if state.result != nil || state.documentRevision != 1 {
		t.Fatal("new page did not invalidate validation")
	}
	state.result = &videoContractGenerationResult{}
	output, _, err = state.execute(context.Background(), "read_documents", `{"ids":[1,2]}`)
	if err != nil || json.Unmarshal([]byte(output), &batch) != nil || !batch.Documents[0].Cached || state.result == nil || state.documentRevision != 1 || successRequests.Load() != 1 || failedRequests.Load() != 2 {
		t.Fatalf("cached reads or failed pages invalidated current validation: %s %v", output, err)
	}
	last = events[len(events)-1]
	if !*last.ValidationCurrent {
		t.Fatal("cached page falsely invalidated progress")
	}
	if _, _, err := state.execute(context.Background(), "read_documents", `{"ids":[2]}`); err != nil || state.result == nil || events[len(events)-1].Detail.Status != "failed" {
		t.Fatal("failed-only batch must preserve current validation and report a failed detail")
	}
	healthy.Store(true)
	if _, _, err := state.execute(context.Background(), "read_documents", `{"ids":[2]}`); err != nil || state.result != nil || state.documentRevision != 2 || successRequests.Load() != 1 {
		t.Fatal("failed page could not be retried independently")
	}
	state.result = &videoContractGenerationResult{}
	start := len(events)
	if _, _, err := state.execute(context.Background(), "validate_contracts", `{}`); err == nil || *events[start].ValidationCurrent || *events[len(events)-1].ValidationCurrent {
		t.Fatal("failed validation retained stale completion")
	}
}

func TestVideoContractAgentDocumentCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/cancel.md" {
			cancel()
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "text/markdown")
		fmt.Fprint(w, "# Saved page\nPOST /v1/videos")
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	links := []videoContractDocumentLink{}
	for i, path := range []string{"/saved.md", "/cancel.md", "/never.md"} {
		u, _ := url.Parse(server.URL + path)
		links = append(links, videoContractDocumentLink{index: i + 1, url: u})
	}
	state := &videoContractAgentState{client: server.Client(), source: videoContractImportSource{Site: &videoContractDocumentSite{baseURL: base, remainingBytes: 4096, links: links}}}
	output, err := state.readDocuments(ctx, []int{1, 2, 3}, nil)
	if err != context.Canceled || requests.Load() != 2 || state.documentRevision != 1 || !strings.Contains(output, "Saved page") {
		t.Fatalf("cancellation lost cached evidence or continued fetching: %v %s", err, output)
	}
}

func TestVideoContractRetryBackoff(t *testing.T) {
	if videoContractRetryDelay(1) != time.Second || videoContractRetryDelay(2) != 2*time.Second || videoContractRetryDelay(100) != 2*time.Second {
		t.Fatal("retry delay must be bounded exponential backoff")
	}
	start := time.Now()
	if err := waitVideoContractRetry(context.Background(), 15*time.Millisecond); err != nil || time.Since(start) < 15*time.Millisecond {
		t.Fatal("retry did not wait")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitVideoContractRetry(ctx, time.Hour); err != context.Canceled {
		t.Fatalf("error=%v", err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	start = time.Now()
	if err := waitVideoContractRetry(ctx, time.Hour); err != context.DeadlineExceeded || time.Since(start) > time.Second {
		t.Fatalf("backoff was not cancellable: %v", err)
	}
	for _, err := range []error{context.Canceled, context.DeadlineExceeded, protocol.HTTPError{Status: 400}} {
		if retryableVideoContractRelayError(err) {
			t.Fatalf("unexpected retry: %v", err)
		}
	}
}

func TestVideoContractAgentDetailRedactsAndBounds(t *testing.T) {
	for _, input := range []string{
		`{"api_key":"PRIVATE_KEY","url":"https://user:PRIVATE_PASSWORD@example.test/video?signature=PRIVATE_SIGNATURE"}`,
		"Authorization: Bearer PRIVATE_TOKEN\nCookie: PRIVATE_COOKIE\napi_key=PRIVATE_KEY\nhttps://example.test/?token=PRIVATE_QUERY",
	} {
		if got := videoContractAgentDetailText(input); strings.Contains(got, "PRIVATE_") {
			t.Fatalf("secret exposed: %s", got)
		}
	}
	if got := videoContractAgentDetailText(strings.Repeat("文", 20000)); len([]rune(got)) > 8100 || !strings.Contains(got, "仅展示") {
		t.Fatal("detail bound failed")
	}
}

func TestVideoContractAgentSchemaAndActualRequests(t *testing.T) {
	tools := videoContractAgentTools(false)
	if len(tools) != 4 {
		t.Fatal("unexpected tool surface")
	}
	for _, tool := range tools {
		function := tool["function"].(map[string]any)
		if function["name"] == "read_documents" {
			encoded, _ := json.Marshal(function["parameters"])
			for _, requirement := range []string{`"additionalProperties":false`, `"maxItems":24`, `"uniqueItems":true`} {
				if !strings.Contains(string(encoded), requirement) {
					t.Fatalf("missing bound: %s", requirement)
				}
			}
		}
	}
	for _, driver := range []string{protocol.VideoContractDriverOpenAI, protocol.VideoContractDriverVolcengine, protocol.VideoContractDriverArk} {
		t.Run(driver, func(t *testing.T) {
			contract := protocol.DefaultVideoContracts()[0]
			contract.Models = []string{"sample-video"}
			contract.Driver = driver
			contract.Transport.LocalMaterial = "url"
			contract.Capability.Prompt = &protocol.VideoPromptConstraint{Required: true, MinLength: 25, MaxLength: 25}
			result := videoContractGenerationResult{Contracts: []protocol.VideoModelContract{contract}, DryRun: []videoContractImportDryRun{{}}}
			requests, err := previewVideoContractAgentRequests(context.Background(), &result)
			if err != nil || len(requests) != len(contract.Generation.Modes) {
				t.Fatalf("requests=%d error=%v", len(requests), err)
			}
			for _, request := range requests {
				if request["create_path"] == "" || request["body"] == nil {
					t.Fatal("missing executable request preview")
				}
			}
		})
	}
}
