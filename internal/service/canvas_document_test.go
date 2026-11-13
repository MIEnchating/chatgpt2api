package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/storage"
)

func loadCanvas(service *CanvasDocumentService, ownerID string) (CanvasDocument, error) {
	workspace, err := service.Workspace(ownerID)
	return workspace.Document, err
}

func saveCanvas(service *CanvasDocumentService, ownerID string, input CanvasDocument) (CanvasDocument, error) {
	return service.save(ownerID, input, nil)
}

func clearCanvas(service *CanvasDocumentService, ownerID, projectID string) (CanvasDocument, error) {
	return service.clear(ownerID, projectID, nil)
}

func newCanvasLongHistoryBenchmark(b *testing.B) (*CanvasDocumentService, CanvasDocument, CanvasDocument) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(b.TempDir(), "history.db")))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = backend.Close() })
	svc := NewCanvasDocumentService(backend)
	document, err := loadCanvas(svc, "benchmark-owner")
	if err != nil {
		b.Fatal(err)
	}
	var messages, protocol []map[string]any
	for i := 0; i < 1000; i++ {
		id := fmt.Sprintf("request-%d", i)
		messages = append(messages, map[string]any{"id": id, "role": "user", "text": "Retained request"}, map[string]any{"id": fmt.Sprintf("reply-%d", i), "role": "assistant", "text": "Retained reply"})
		protocol = append(protocol, map[string]any{"role": "user", "messageID": id, "content": "Retained request"}, map[string]any{"role": "assistant", "toolCalls": []map[string]any{{"id": id, "name": "get_canvas_summary", "arguments": map[string]any{}}}}, map[string]any{"role": "tool", "toolCallId": id, "content": strings.Repeat("Retained history. ", 480)}, map[string]any{"role": "assistant", "content": "Retained reply"})
	}
	document.AgentSessions, err = json.Marshal([]map[string]any{{"id": "long-session", "messages": messages, "protocolMessages": protocol}})
	if err != nil {
		b.Fatal(err)
	}
	document.ActiveAgentSessionID = "long-session"
	document, err = svc.SaveAtRevision("benchmark-owner", document)
	if err != nil {
		b.Fatal(err)
	}
	view, err := CanvasAgentHistoryView(document, nil)
	if err != nil {
		b.Fatal(err)
	}
	view.AgentSessions = json.RawMessage("[]")
	return svc, document, view
}

func BenchmarkCanvasDocumentLongHistoryGeometrySave(b *testing.B) {
	svc, document, view := newCanvasLongHistoryBenchmark(b)
	var err error
	b.ReportAllocs()
	b.SetBytes(int64(len(document.AgentSessions)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		view.Title = fmt.Sprintf("Geometry edit %d", i)
		view, err = svc.SaveAtRevision("benchmark-owner", view)
		if err != nil {
			b.Fatal(err)
		}
		if string(view.AgentSessions) != "[]" {
			b.Fatal("geometry save retransmitted unchanged history")
		}
	}
	b.StopTimer()
	stored, err := svc.Project("benchmark-owner", document.ID)
	if err != nil || string(stored.AgentSessions) != string(document.AgentSessions) {
		b.Fatal("geometry save changed history", err)
	}
}

func BenchmarkCanvasDocumentLongHistoryMetadataSave(b *testing.B) {
	svc, document, view := newCanvasLongHistoryBenchmark(b)
	var err error
	b.ReportAllocs()
	b.SetBytes(int64(len(document.AgentSessions)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		engine := "native"
		if i%2 == 1 {
			engine = "codex"
		}
		raw, _ := json.Marshal(engine)
		view.AgentSessionUpdates = []CanvasAgentSessionUpdate{{ID: "long-session", Changes: map[string]json.RawMessage{"engine": raw}}}
		view, err = svc.SaveAtRevision("benchmark-owner", view)
		if err != nil {
			b.Fatal(err)
		}
		if string(view.AgentSessions) != "[]" || len(view.AgentSessionUpdates) != 1 {
			b.Fatal("metadata save did not acknowledge the update without retransmitting history")
		}
	}
	b.StopTimer()
	stored, err := svc.Project("benchmark-owner", document.ID)
	if err != nil {
		b.Fatal(err)
	}
	var original, actual []map[string]json.RawMessage
	_ = json.Unmarshal(document.AgentSessions, &original)
	_ = json.Unmarshal(stored.AgentSessions, &actual)
	if len(actual) != 1 || len(actual[0]["engine"]) == 0 {
		b.Fatal("metadata save did not persist the chosen engine")
	}
	delete(actual[0], "engine")
	if !reflect.DeepEqual(actual, original) {
		b.Fatal("metadata save changed retained session fields")
	}
}

func BenchmarkCanvasDocumentLongHistoryEditorRead(b *testing.B) {
	svc, document, _ := newCanvasLongHistoryBenchmark(b)
	b.ReportAllocs()
	b.SetBytes(int64(len(document.AgentSessions)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		workspace, err := svc.EditorWorkspace("benchmark-owner", document.ID, nil)
		if err != nil {
			b.Fatal(err)
		}
		if !workspace.Document.AgentHistoryPartial || string(workspace.Document.AgentSessions) != string(document.AgentSessions) {
			b.Fatal("editor read changed the active conversation")
		}
	}
}

func BenchmarkCanvasAgentSettledLongHistoryEditorRead(b *testing.B) {
	canvas, document, _ := newCanvasLongHistoryBenchmark(b)
	identity := Identity{ID: "benchmark-owner"}
	document.AgentPanel.Open = true
	document.AgentRun = &CanvasAgentRun{ID: "settled", SessionID: document.ActiveAgentSessionID, AssistantID: "reply-999", Status: "success"}
	document, err := canvas.saveAgent(identity.ID, document)
	if err != nil {
		b.Fatal(err)
	}
	agent := NewCanvasAgentService(context.Background(), nil, canvas, nil, nil, nil)
	b.Cleanup(agent.Close)
	b.ReportAllocs()
	b.SetBytes(int64(len(document.AgentSessions)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		result, err := agent.Workspace(identity, document.ID, nil, CanvasHistoryEditor)
		if err != nil || result.Document.Revision != document.Revision || string(result.Document.AgentSessions) != string(document.AgentSessions) {
			b.Fatal("opening settled history changed the saved conversation", err)
		}
	}
}

func BenchmarkCanvasAgentHistoryChunkDecode(b *testing.B) {
	data := []byte(strings.Repeat("Verified history. ", canvasAgentHistoryChunkBytes/18))
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	raw := map[string]any{"data": base64.StdEncoding.EncodeToString(data)}
	b.ReportAllocs()
	b.SetBytes(int64(len(data)))
	for b.Loop() {
		decoded, err := decodeCanvasAgentHistoryChunk(raw, hash)
		if err != nil || !reflect.DeepEqual(decoded, data) {
			b.Fatal("history chunk was not preserved", err)
		}
	}
}

func TestCanvasAgentHistoryChunkDecodingPreservesIntegrity(t *testing.T) {
	data := []byte(strings.Repeat("完整历史😀", 100))
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	decoded, err := decodeCanvasAgentHistoryChunk(map[string]any{"data": base64.StdEncoding.EncodeToString(data), "unused": "retained storage metadata"}, hash)
	if err != nil || !reflect.DeepEqual(decoded, data) {
		t.Fatal("valid history chunk was changed", err)
	}
	for _, raw := range []any{
		nil, "invalid", map[string]any{}, map[string]any{"data": nil}, map[string]any{"data": false},
		map[string]any{"data": ""}, map[string]any{"data": "invalid!"},
		map[string]any{"data": base64.StdEncoding.EncodeToString([]byte("corrupt history"))},
		map[string]any{"data": base64.StdEncoding.EncodeToString(make([]byte, canvasAgentHistoryChunkBytes+1))},
	} {
		if _, err := decodeCanvasAgentHistoryChunk(raw, hash); err == nil {
			t.Fatalf("invalid history chunk accepted: %T", raw)
		}
	}
}

func TestCanvasAgentHistoryBlockAssemblyPreservesExactBytesAndRejectsInvalidLengths(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	svc := NewCanvasDocumentService(backend)
	owner, project := "assembly-owner", "assembly-project"
	payload := []byte(strings.Repeat("完整历史😀\n", 12000))
	reference, err := svc.saveAgentHistoryBlockLocked(owner, project, payload)
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("canvas_agent_history/%x/", sha256.Sum256([]byte(owner)))
	loaded, err := loadCanvasAgentHistoryBlock(backend, prefix, project, reference)
	if err != nil || !reflect.DeepEqual(loaded, payload) {
		t.Fatal("multi-chunk history was not reconstructed exactly", err)
	}
	loaded[0] ^= 1
	loaded, err = loadCanvasAgentHistoryBlock(backend, prefix, project, reference)
	if err != nil || !reflect.DeepEqual(loaded, payload) {
		t.Fatal("mutating a read changed persisted chunks", err)
	}
	for _, size := range []int{reference.Bytes - 1, reference.Bytes + 1, 0, -1} {
		invalid := reference
		invalid.Bytes = size
		if data, err := loadCanvasAgentHistoryBlock(backend, prefix, project, invalid); err == nil || data != nil {
			t.Fatalf("invalid declared length %d returned partial history: err=%v", size, err)
		}
	}
	invalid := reference
	invalid.Chunks = append([]string(nil), reference.Chunks...)
	invalid.Chunks[len(invalid.Chunks)-1] = strings.Repeat("0", sha256.Size*2)
	if data, err := loadCanvasAgentHistoryBlock(backend, prefix, project, invalid); !errors.Is(err, errCanvasAgentHistoryChunkMissing) || data != nil {
		t.Fatal("missing chunk returned partial history", err)
	}
	name := canvasAgentHistoryChunkName(owner, project, reference.Chunks[len(reference.Chunks)-1])
	if err := backend.SaveJSONDocument(name, canvasAgentHistoryChunk{Data: []byte("corrupt")}); err != nil {
		t.Fatal(err)
	}
	if data, err := loadCanvasAgentHistoryBlock(backend, prefix, project, reference); err == nil || data != nil {
		t.Fatal("corrupt chunk returned partial history", err)
	}
}

func TestCanvasGeometrySaveReusesVerifiedHistoryWithoutRereadingChunks(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	svc := NewCanvasDocumentService(backend)
	doc := DefaultCanvasDocument()
	doc.AgentSessions, _ = json.Marshal([]map[string]any{{"id": "s", "messages": []map[string]any{{"role": "user", "text": "Keep request"}}, "protocolMessages": []map[string]any{{"role": "assistant", "content": strings.Repeat("Complete retained protocol. ", 5000)}}}})
	doc.ActiveAgentSessionID = "s"
	doc.AgentMessages = []CanvasAgentMessage{{ID: "legacy", Role: "user", Content: "Keep legacy request"}}
	workspace, err := svc.Import("verified-history-owner", doc)
	if err != nil {
		t.Fatal(err)
	}
	doc = workspace.Document
	raw, err := backend.documents.LoadJSONDocument(canvasWorkspaceName("verified-history-owner"))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(raw)
	var manifest canvasWorkspace
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(canvasAgentHistoryHashes(manifest.AgentHistories[doc.ID])) < 3 {
		t.Fatal("fixture did not persist the expected independent history chunks")
	}
	loads := make(map[string]int)
	backend.beforeLoad = func(name string) { loads[name]++ }
	partial, err := CanvasAgentHistoryView(workspace.Document, nil)
	if err != nil {
		t.Fatal(err)
	}
	partial.AgentSessions = json.RawMessage("[]")
	partial.Title = "Geometry changed"
	receipt, err := svc.SaveAtRevision("verified-history-owner", partial)
	if err != nil {
		t.Fatal(err)
	}
	for _, hash := range canvasAgentHistoryHashes(manifest.AgentHistories[doc.ID]) {
		name := canvasAgentHistoryChunkName("verified-history-owner", doc.ID, hash)
		if loads[name] != 1 {
			t.Fatalf("geometry save read the same verified immutable chunk %d times", loads[name])
		}
	}
	if string(receipt.AgentSessions) != "[]" {
		t.Fatal("geometry receipt returned the unchanged transcript")
	}
	reopened := NewCanvasDocumentService(backend)
	stored, err := reopened.Project("verified-history-owner", doc.ID)
	if err != nil || string(stored.AgentSessions) != string(workspace.Document.AgentSessions) || !reflect.DeepEqual(stored.AgentMessages, workspace.Document.AgentMessages) {
		t.Fatal("reused history reference changed persisted messages", err)
	}
	stored.AgentMessages[0].Content = "Changed legacy request"
	stored.AgentSessions = json.RawMessage(strings.Replace(string(stored.AgentSessions), "Keep request", "Changed request", 1))
	changed, err := svc.SaveAtRevision("verified-history-owner", stored)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := reopened.Project("verified-history-owner", doc.ID)
	if err != nil || string(loaded.AgentSessions) != string(changed.AgentSessions) || loaded.AgentMessages[0].Content != "Changed legacy request" || !strings.Contains(string(loaded.AgentSessions), "Changed request") {
		t.Fatal("changed history reused an obsolete reference", err)
	}
}

func TestCanvasPartialHistoryReadOnlyPreservesStoredBytes(t *testing.T) {
	current := json.RawMessage("[\n  {\"id\": \"retained\", \"messages\": [{\"id\": \"reply\", \"role\": \"assistant\", \"text\": \"Original history\"}], \"protocolMessages\": []}\n]")
	for _, incoming := range []json.RawMessage{nil, json.RawMessage("[]"), json.RawMessage("null")} {
		merged, err := mergeCanvasPartialHistory(current, incoming, nil, nil, nil)
		if err != nil || string(merged) != string(current) {
			t.Fatalf("a read-only partial save rewrote unchanged history: %s, %v", merged, err)
		}
	}
}

func TestCanvasHistoryReceiptReusesOnlyMatchingVerifiedSummaries(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	svc := NewCanvasDocumentService(backend)
	doc := DefaultCanvasDocument()
	doc.AgentSessions = json.RawMessage(`[{"id":"first","title":"First","messages":[{"role":"user","text":"Original request"}],"protocolMessages":[{"role":"tool","content":"Complete original result"}]},{"id":"second","title":"Second","messages":[]},{"id":"third","title":"Third","messages":[{"role":"assistant","text":"Other conversation"}]}]`)
	doc.ActiveAgentSessionID = "first"
	created, err := svc.Import("verified-receipt-owner", doc)
	if err != nil {
		t.Fatal(err)
	}
	workspace, found, err := svc.readWorkspaceLocked("verified-receipt-owner")
	if err != nil || !found {
		t.Fatal("cannot read verified fixture", err)
	}
	doc = workspace.Projects[canvasProjectIndex(workspace, created.Document.ID)]
	verified, ok := workspace.verifiedAgentHistories[doc.ID]
	if !ok || len(verified.reference.Sessions) != 3 || sha256.Sum256(doc.AgentSessions) != verified.sessionsHash {
		t.Fatal("fixture did not produce verified current-format summaries")
	}
	acknowledged := make(map[string]string)
	for _, session := range verified.reference.Sessions {
		acknowledged[session.ID] = session.ContentHash
	}
	for _, scenario := range []struct {
		name         string
		active, run  string
		keep         []string
		wantIDs      []string
		acknowledged map[string]string
		updates      []CanvasAgentSessionUpdate
	}{
		{name: "active without acknowledgement", active: "first", wantIDs: []string{"first"}},
		{name: "acknowledged bodies omitted", active: "first", acknowledged: acknowledged},
		{name: "explicit body still returned", active: "first", keep: []string{"second"}, wantIDs: []string{"second"}, acknowledged: acknowledged},
		{name: "unacknowledged running conversation", active: "first", run: "third", wantIDs: []string{"third"}, acknowledged: map[string]string{"first": acknowledged["first"]}},
		{name: "stale acknowledgement", active: "first", wantIDs: []string{"first"}, acknowledged: map[string]string{"first": "stale"}},
		{name: "metadata acknowledgement", active: "first", updates: []CanvasAgentSessionUpdate{{ID: "first", Changes: map[string]json.RawMessage{"title": json.RawMessage(`"First"`)}}}},
		{name: "default active conversation", wantIDs: []string{"first"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := doc
			input.ActiveAgentSessionID = scenario.active
			if scenario.run != "" {
				input.AgentRun = &CanvasAgentRun{SessionID: scenario.run}
			}
			want, err := canvasAgentHistoryView(input, scenario.keep, scenario.acknowledged, scenario.updates, canvasVerifiedAgentHistory{})
			if err != nil {
				t.Fatal(err)
			}
			got, err := canvasAgentHistoryView(input, scenario.keep, scenario.acknowledged, scenario.updates, verified)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatal("verified summary reuse changed receipt selection or content", err)
			}
			var bodies []struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(got.AgentSessions, &bodies); err != nil {
				t.Fatal(err)
			}
			var ids []string
			for _, body := range bodies {
				ids = append(ids, body.ID)
			}
			if !reflect.DeepEqual(ids, scenario.wantIDs) || len(got.AgentSessionSummaries) != 3 || got.AgentSessionSummaries[0].ContentHash != acknowledged["first"] {
				t.Fatal("receipt omitted required bodies or changed the complete directory")
			}
			got.AgentSessionSummaries[0].Title = "Caller changed returned summary"
			if verified.reference.Sessions[0].Title != "First" {
				t.Fatal("returned summary changed private verification evidence")
			}
		})
	}
	for _, body := range []json.RawMessage{
		json.RawMessage(strings.Replace(string(doc.AgentSessions), "Original request", "New request", 1)),
		json.RawMessage(`[{"id":"replacement","title":"Replaced","messages":[]}]`),
		json.RawMessage(`[]`),
		nil,
	} {
		input := doc
		input.AgentSessions = body
		want, err := CanvasAgentHistoryView(input, nil)
		if err != nil {
			t.Fatal(err)
		}
		got, err := canvasAgentHistoryView(input, nil, nil, nil, verified)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatal("changed history reused obsolete summaries", err)
		}
	}
	for _, body := range []json.RawMessage{json.RawMessage(`[{"id":"bad","messages":{}}]`), json.RawMessage(`[{"id":"bad"}`)} {
		input := doc
		input.AgentSessions = body
		if _, err := canvasAgentHistoryView(input, nil, nil, nil, verified); err == nil {
			t.Fatal("corrupt changed history bypassed validation")
		}
	}
}

func TestCanvasPartialHistoryMetadataPreservesValidationAndVersionChecks(t *testing.T) {
	for _, body := range []json.RawMessage{
		json.RawMessage(`{"id":"retained","messages":{}}`),
		json.RawMessage(`{"id":42,"messages":[]}`),
		json.RawMessage(`{"id":"retained","title":false,"messages":[]}`),
		json.RawMessage(`{"id":"retained","createdAt":42,"messages":[]}`),
		json.RawMessage(`{"id":"retained","messages":[]`),
	} {
		current := append(append(json.RawMessage("["), body...), ']')
		if _, err := mergeCanvasPartialHistory(current, json.RawMessage("[]"), nil, nil, nil); err == nil {
			t.Fatalf("read-only merge accepted malformed stored metadata: %s", body)
		}
	}
	stored := json.RawMessage(`{"id":"retained","messages":[{"id":"reply","text":"Original"}],"protocolMessages":[{"role":"assistant","content":"Private original"}]}`)
	summary, err := canvasAgentSessionSummary(stored)
	if err != nil {
		t.Fatal(err)
	}
	current := append(append(json.RawMessage("["), stored...), ']')
	changed := json.RawMessage(`[{"id":"retained","messages":[{"id":"reply","text":"Edited"}]}]`)
	for _, deletion := range []bool{false, true} {
		incoming, deleted := changed, []string(nil)
		if deletion {
			incoming, deleted = json.RawMessage("[]"), []string{"retained"}
		}
		if _, err := mergeCanvasPartialHistory(current, incoming, deleted, nil, nil); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("write without a baseline hash was accepted: %v", err)
		}
		if _, err := mergeCanvasPartialHistory(current, incoming, deleted, nil, []CanvasAgentSessionSummary{{ID: summary.ID, ContentHash: "stale"}}); !errors.Is(err, ErrCanvasRevisionConflict) {
			t.Fatalf("write over another client's version was accepted: %v", err)
		}
		if _, err := mergeCanvasPartialHistory(current, incoming, deleted, nil, []CanvasAgentSessionSummary{summary}); err != nil {
			t.Fatalf("write with the original verified hash was rejected: %v", err)
		}
	}
}

func TestCanvasPartialHistoryMixedWritesValidateEveryOriginalVersion(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	svc := NewCanvasDocumentService(backend)
	doc := DefaultCanvasDocument()
	doc.AgentSessions = json.RawMessage(`[{"id":"edit","messages":[]},{"id":"metadata","title":"Original","messages":[]},{"id":"delete","messages":[]},{"id":"retained","messages":[{"role":"assistant","text":"Keep history"}]}]`)
	created, err := svc.Import("mixed-versions-owner", doc)
	if err != nil {
		t.Fatal(err)
	}
	partial, err := CanvasAgentHistoryView(created.Document, nil)
	if err != nil {
		t.Fatal(err)
	}
	partial.AgentSessions = json.RawMessage(`[{"id":"new","messages":[]},{"id":"edit","messages":[{"role":"user","text":"New request"}]}]`)
	partial.DeletedAgentSessionIDs = []string{"delete"}
	partial.AgentSessionUpdates = []CanvasAgentSessionUpdate{{ID: "metadata", Changes: map[string]json.RawMessage{"title": json.RawMessage(`"Renamed"`)}}}
	for _, id := range []string{"edit", "metadata", "delete"} {
		for _, missing := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/missing=%t", id, missing), func(t *testing.T) {
				input := partial
				input.AgentSessionSummaries = nil
				for _, summary := range partial.AgentSessionSummaries {
					if summary.ID == id {
						if missing {
							continue
						}
						summary.ContentHash = "stale"
					}
					input.AgentSessionSummaries = append(input.AgentSessionSummaries, summary)
				}
				want := ErrCanvasRevisionConflict
				if missing {
					want = ErrInvalidCanvasDocument
				}
				if _, err := svc.SaveAtRevision("mixed-versions-owner", input); !errors.Is(err, want) {
					t.Fatalf("mixed write bypassed original version for %s: %v", id, err)
				}
			})
		}
	}
	stored, err := svc.Project("mixed-versions-owner", created.Document.ID)
	if err != nil || !reflect.DeepEqual(stored, created.Document) {
		t.Fatal("rejected mixed writes changed the stored project", err)
	}
	for index := range partial.AgentSessionSummaries {
		if partial.AgentSessionSummaries[index].ID == "retained" {
			partial.AgentSessionSummaries[index].ContentHash = "not-written"
		}
	}
	if _, err := svc.SaveAtRevision("mixed-versions-owner", partial); err != nil {
		t.Fatal("valid mixed write rejected an untouched session's stale acknowledgement", err)
	}
	stored, err = NewCanvasDocumentService(backend).Project("mixed-versions-owner", created.Document.ID)
	if err != nil {
		t.Fatal(err)
	}
	var bodies []map[string]json.RawMessage
	if err := json.Unmarshal(stored.AgentSessions, &bodies); err != nil || len(bodies) != 4 {
		t.Fatal("mixed save lost a retained or newly created session", err)
	}
	for index, id := range []string{`"new"`, `"edit"`, `"metadata"`, `"retained"`} {
		if string(bodies[index]["id"]) != id {
			t.Fatal("mixed save changed session ordering or retained the deleted session")
		}
	}
	if string(bodies[1]["messages"]) != `[{"role":"user","text":"New request"}]` || string(bodies[2]["title"]) != `"Renamed"` || string(bodies[3]["messages"]) != `[{"role":"assistant","text":"Keep history"}]` {
		t.Fatal("mixed save changed accepted edits or untouched history")
	}
}

func TestCanvasSessionMetadataUpdatesPreserveHistoryAndRequireOriginalVersion(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "metadata.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	svc := NewCanvasDocumentService(backend)
	doc := DefaultCanvasDocument()
	doc.AgentSessions = json.RawMessage(`[{"id":"s","title":"Original","createdAt":"now","updatedAt":"now","messages":[{"id":"u","role":"user","text":"Keep full request"}],"protocolMessages":[{"role":"assistant","content":"Private complete protocol"}],"toolReceipts":[{"id":"server-receipt"}],"contextUsage":{"totalTokens":7},"futureField":{"retained":true}},{"id":"inactive","title":"Other conversation","messages":[]}]`)
	doc.ActiveAgentSessionID = "s"
	workspace, err := svc.Import("metadata-owner", doc)
	if err != nil {
		t.Fatal(err)
	}
	partial, err := CanvasAgentHistoryView(workspace.Document, nil)
	if err != nil {
		t.Fatal(err)
	}
	partial.AgentSessions = json.RawMessage("[]")
	partial.AgentSessionUpdates = []CanvasAgentSessionUpdate{{ID: "s", Changes: map[string]json.RawMessage{"engine": json.RawMessage(`"codex"`), "title": json.RawMessage(`"Renamed"`), "updatedAt": json.RawMessage(`"later"`)}}}
	receipt, err := svc.SaveAtRevision("metadata-owner", partial)
	if err != nil {
		t.Fatal(err)
	}
	if string(receipt.AgentSessions) != "[]" || !reflect.DeepEqual(receipt.AgentSessionUpdates, partial.AgentSessionUpdates) || len(receipt.AgentSessionSummaries) != 2 || receipt.AgentSessionSummaries[0].ContentHash == partial.AgentSessionSummaries[0].ContentHash {
		t.Fatalf("metadata receipt did not acknowledge the changed body without retransmitting it: %#v", receipt)
	}
	stored, err := svc.Project("metadata-owner", partial.ID)
	if err != nil {
		t.Fatal(err)
	}
	var expected, actual []map[string]any
	_ = json.Unmarshal(workspace.Document.AgentSessions, &expected)
	_ = json.Unmarshal(stored.AgentSessions, &actual)
	expected[0]["engine"], expected[0]["title"], expected[0]["updatedAt"] = "codex", "Renamed", "later"
	if !reflect.DeepEqual(actual, expected) || len(stored.AgentSessionUpdates) != 0 {
		t.Fatal("metadata update changed messages, protocol, server-owned fields, unknown fields or session order")
	}
	stale := partial
	stale.Revision = receipt.Revision
	if _, err := svc.SaveAtRevision("metadata-owner", stale); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("fresh canvas revision bypassed the original conversation hash: %v", err)
	}
	stale.AgentSessionSummaries = nil
	if _, err := svc.SaveAtRevision("metadata-owner", stale); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("metadata update without original hash was accepted: %v", err)
	}
	partial.AgentHistoryPartial = false
	if _, err := svc.SaveAtRevision("metadata-owner", partial); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("complete document accepted a metadata-only update: %v", err)
	}
	unchanged, err := svc.Project("metadata-owner", partial.ID)
	if err != nil || !reflect.DeepEqual(unchanged, stored) {
		t.Fatal("rejected metadata update changed the saved document", err)
	}
	stored.AgentRun = &CanvasAgentRun{ID: "active-run", SessionID: "s", Status: "running", Engine: "codex"}
	running, err := svc.saveWithAgent("metadata-owner", stored, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	busy, err := CanvasAgentHistoryView(running, nil)
	if err != nil {
		t.Fatal(err)
	}
	busy.AgentSessions = json.RawMessage("[]")
	busy.AgentSessionUpdates = []CanvasAgentSessionUpdate{{ID: "s", Changes: map[string]json.RawMessage{"engine": json.RawMessage(`"native"`)}}}
	if _, err := svc.SaveAtRevision("metadata-owner", busy); !errors.Is(err, ErrCanvasAgentBusy) {
		t.Fatalf("running Agent accepted a session metadata update: %v", err)
	}
	unchanged, err = svc.Project("metadata-owner", partial.ID)
	if err != nil || !reflect.DeepEqual(unchanged, running) {
		t.Fatal("rejected busy update changed the running document", err)
	}
}

func TestCanvasSessionMetadataAndBodyWritesPreserveExactValuesAndServerFields(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	svc := NewCanvasDocumentService(backend)
	doc := DefaultCanvasDocument()
	doc.AgentSessions = json.RawMessage(`[{"id":"metadata","title":"Original","messages":[],"protocolMessages":[{"role":"tool","content":"Retain original protocol","result":{"integer":9007199254740993}}],"futureField":{"integer":9007199254740993,"decimal":1.234567890123456789}},{"id":"body","messages":[],"toolReceipts":[{"integer":9007199254740993}],"contextUsage":{"integer":9007199254740993,"decimal":1.234567890123456789}}]`)
	doc.ActiveAgentSessionID = "metadata"
	created, err := svc.Import("exact-session-owner", doc)
	if err != nil {
		t.Fatal(err)
	}
	partial, err := CanvasAgentHistoryView(created.Document, nil)
	if err != nil {
		t.Fatal(err)
	}
	partial.AgentSessions = json.RawMessage(`[{"id":"body","messages":[{"role":"user","text":"New browser request"}],"toolReceipts":[{"forged":true}],"contextUsage":{"integer":0},"futureField":{"integer":9007199254740995,"decimal":9.876543210987654321}}]`)
	partial.AgentSessionUpdates = []CanvasAgentSessionUpdate{{ID: "metadata", Changes: map[string]json.RawMessage{"engine": json.RawMessage(`"codex"`)}}}
	receipt, err := svc.SaveAtRevision("exact-session-owner", partial)
	if err != nil {
		t.Fatal(err)
	}
	if len(receipt.AgentSessionUpdates) != 1 || !reflect.DeepEqual(receipt.AgentSessionUpdates, partial.AgentSessionUpdates) {
		t.Fatal("mixed save did not acknowledge the accepted metadata update")
	}
	stored, err := NewCanvasDocumentService(backend).Project("exact-session-owner", created.Document.ID)
	if err != nil {
		t.Fatal(err)
	}
	var original, actual, submitted []map[string]json.RawMessage
	_ = json.Unmarshal(created.Document.AgentSessions, &original)
	_ = json.Unmarshal(stored.AgentSessions, &actual)
	_ = json.Unmarshal(partial.AgentSessions, &submitted)
	if len(actual) != 2 || string(actual[0]["engine"]) != `"codex"` {
		t.Fatal("mixed save lost a session or its engine update")
	}
	for key, value := range original[0] {
		if string(actual[0][key]) != string(value) {
			t.Fatalf("metadata update altered untouched field %q", key)
		}
	}
	for _, key := range []string{"toolReceipts", "contextUsage"} {
		if string(actual[1][key]) != string(original[1][key]) {
			t.Fatalf("browser write altered server-owned field %q", key)
		}
	}
	for _, key := range []string{"messages", "futureField"} {
		if string(actual[1][key]) != string(submitted[0][key]) {
			t.Fatalf("browser write altered accepted field %q", key)
		}
	}
}

func TestCanvasSessionMetadataUpdatesRejectInvalidAndOverlappingWrites(t *testing.T) {
	stored := json.RawMessage(`[{"id":"s","title":"Original","messages":[],"protocolMessages":[]}]`)
	valid := CanvasAgentSessionUpdate{ID: "s", Changes: map[string]json.RawMessage{"engine": json.RawMessage(`"native"`)}}
	for _, update := range []CanvasAgentSessionUpdate{
		{ID: "missing", Changes: valid.Changes},
		{ID: "", Changes: valid.Changes},
		{ID: "s"},
		{ID: "s", Changes: map[string]json.RawMessage{"messages": json.RawMessage(`[]`)}},
		{ID: "s", Changes: map[string]json.RawMessage{"toolReceipts": json.RawMessage(`[]`)}},
		{ID: "s", Changes: map[string]json.RawMessage{"contextUsage": json.RawMessage(`{}`)}},
		{ID: "s", Changes: map[string]json.RawMessage{"engine": json.RawMessage(`"unknown"`)}},
		{ID: "s", Changes: map[string]json.RawMessage{"engine": json.RawMessage(`false`)}},
		{ID: "s", Changes: map[string]json.RawMessage{"title": json.RawMessage(`null`)}},
	} {
		if _, err := mergeCanvasPartialHistory(stored, json.RawMessage("[]"), nil, []CanvasAgentSessionUpdate{update}, nil); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("invalid metadata update accepted: %#v, %v", update, err)
		}
	}
	for _, item := range []struct {
		incoming json.RawMessage
		deleted  []string
		updates  []CanvasAgentSessionUpdate
	}{{json.RawMessage("[]"), nil, []CanvasAgentSessionUpdate{valid, valid}}, {stored, nil, []CanvasAgentSessionUpdate{valid}}, {json.RawMessage("[]"), []string{"s"}, []CanvasAgentSessionUpdate{valid}}} {
		if _, err := mergeCanvasPartialHistory(stored, item.incoming, item.deleted, item.updates, nil); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("overlapping metadata write accepted: %v", err)
		}
	}
}

func TestCanvasDocumentLongAgentHistorySurvivesIndependentStorage(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var databaseURL string
			if dialect == "sqlite" {
				databaseURL = "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "history.db"))
			} else {
				databaseURL = os.Getenv("TEST_CANVAS_" + strings.ToUpper(dialect) + "_DATABASE_URL")
				if databaseURL == "" {
					t.Skip("isolated canvas database not configured")
				}
			}
			backend, err := storage.NewDatabaseBackend(databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = backend.Close() })
			exerciseCanvasAgentHistoryStorage(t, backend, databaseURL)
		})
	}
}

func exerciseCanvasAgentHistoryStorage(t *testing.T, backend storage.Backend, databaseURL string) {
	t.Helper()
	svc := NewCanvasDocumentService(backend)
	doc, err := loadCanvas(svc, "history-owner")
	if err != nil {
		t.Fatal(err)
	}
	var sessions []map[string]any
	for i := 0; i < 30; i++ {
		sessions = append(sessions, map[string]any{"id": fmt.Sprintf("session-%d", i), "messages": []map[string]any{{"id": "reply", "role": "assistant", "text": strings.Repeat("Long history retained. ", 5000)}}})
	}
	doc.AgentSessions, err = json.Marshal(sessions)
	if err != nil {
		t.Fatal(err)
	}
	doc.ActiveAgentSessionID = "session-29"
	saved, err := svc.SaveAtRevision("history-owner", doc)
	if err != nil {
		t.Fatalf("long history cannot be saved: %v", err)
	}
	reopened := NewCanvasDocumentService(backend)
	loaded, err := reopened.Project("history-owner", saved.ID)
	if err != nil || string(loaded.AgentSessions) != string(saved.AgentSessions) || loaded.ActiveAgentSessionID != "session-29" {
		t.Fatal("long history changed after reopening", err)
	}
	projectWorkspace, err := reopened.ProjectWorkspace("history-owner", saved.ID)
	if err != nil || !reflect.DeepEqual(projectWorkspace.Document, loaded) || projectWorkspace.ActiveProjectID != saved.ID {
		t.Fatal("project workspace did not preserve the complete document", err)
	}
	raw, err := backend.(storage.JSONDocumentBackend).LoadJSONDocument(canvasWorkspaceName("history-owner"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(raw)
	if err != nil || strings.Contains(string(data), "Long history retained.") || len(data) >= canvasDocumentMaxBytes {
		t.Fatal("workspace still embeds the full transcript", err)
	}
	t.Run("history_pages_do_not_load_unrelated_message_bodies", func(t *testing.T) {
		var chunksRead []string
		wrapper := &countingCanvasDocumentBackend{Backend: backend, documents: backend.(storage.JSONDocumentBackend), saves: make(map[string]int), beforeLoad: func(name string) {
			if strings.HasPrefix(name, "canvas_agent_history/") {
				chunksRead = append(chunksRead, name)
			}
		}}
		reader := NewCanvasDocumentService(wrapper)
		cursor := ""
		var ids []string
		for {
			page, err := reader.AgentHistoryPage("history-owner", saved.ID, cursor, 7)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Sessions) > 7 || page.Revision != saved.Revision {
				t.Fatal("invalid history page", page)
			}
			for _, item := range page.Sessions {
				if item.MessageCount != 1 {
					t.Fatal("incorrect message count", item)
				}
				ids = append(ids, item.ID)
			}
			cursor = page.NextCursor
			if cursor == "" {
				break
			}
		}
		if len(ids) != 30 || len(chunksRead) != 0 {
			t.Fatalf("index pagination loaded transcripts: sessions=%d chunks=%d", len(ids), len(chunksRead))
		}
		for index, id := range ids {
			if id != fmt.Sprintf("session-%d", index) {
				t.Fatal("session page skipped or repeated records", ids)
			}
		}
		body, err := reader.AgentHistorySession("history-owner", saved.ID, "session-29", saved.Revision)
		if err != nil {
			t.Fatal(err)
		}
		var original []json.RawMessage
		if err := json.Unmarshal(saved.AgentSessions, &original); err != nil {
			t.Fatal(err)
		}
		if string(body) != string(original[29]) || len(chunksRead) != 2 {
			t.Fatalf("single session read loaded wrong data or all history: chunks=%d err=%v", len(chunksRead), err)
		}
		chunksRead = nil
		editor, err := reader.EditorWorkspace("history-owner", saved.ID, nil)
		if err != nil {
			t.Fatal(err)
		}
		var selected []json.RawMessage
		_ = json.Unmarshal(editor.Document.AgentSessions, &selected)
		if !editor.Document.AgentHistoryPartial || len(editor.Document.AgentSessionSummaries) != 30 || len(selected) != 1 || len(chunksRead) != 2 || string(selected[0]) != string(original[29]) {
			t.Fatalf("editor loaded inactive transcripts: selected=%d summaries=%d chunks=%d", len(selected), len(editor.Document.AgentSessionSummaries), len(chunksRead))
		}
		if _, err := reader.AgentHistorySession("history-owner", saved.ID, "session-29", saved.Revision-1); !errors.Is(err, ErrCanvasRevisionConflict) {
			t.Fatal("stale session revision accepted", err)
		}
		if _, err := reader.AgentHistoryPage("other-owner", saved.ID, "", 7); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatal("other owner read the session index", err)
		}
		if _, err := reader.AgentHistorySession("history-owner", saved.ID, "missing", saved.Revision); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatal("unknown session returned data", err)
		}
		for _, limit := range []int{0, 51} {
			if _, err := reader.AgentHistoryPage("history-owner", saved.ID, "", limit); !errors.Is(err, ErrInvalidCanvasDocument) {
				t.Fatal("invalid page size accepted", err)
			}
		}
		if _, err := reader.AgentHistoryPage("history-owner", saved.ID, "not-a-cursor", 7); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatal("invalid cursor accepted", err)
		}
		page, err := reader.AgentHistoryPage("history-owner", saved.ID, "", 7)
		if err != nil {
			t.Fatal(err)
		}
		otherCursor := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"project_id":"other-project","revision":%d,"offset":7}`, saved.Revision)))
		if _, err := reader.AgentHistoryPage("history-owner", saved.ID, otherCursor, 7); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatal("cursor from another project accepted", err)
		}
		staleCursor := canvasAgentHistoryCursor{}
		cursorBytes, _ := base64.RawURLEncoding.DecodeString(page.NextCursor)
		_ = json.Unmarshal(cursorBytes, &staleCursor)
		staleCursor.Revision--
		cursorBytes, _ = json.Marshal(staleCursor)
		if _, err := reader.AgentHistoryPage("history-owner", saved.ID, base64.RawURLEncoding.EncodeToString(cursorBytes), 7); !errors.Is(err, ErrCanvasRevisionConflict) {
			t.Fatal("stale cursor accepted", err)
		}
	})
	t.Run("partial_save_preserves_unloaded_sessions_and_requires_explicit_deletion", func(t *testing.T) {
		workspace, err := svc.Import("partial-history-owner", saved)
		if err != nil {
			t.Fatal(err)
		}
		partial := workspace.Document
		partial, err = CanvasAgentHistoryView(partial, nil)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(partial)
		var wire map[string]any
		_ = json.Unmarshal(encoded, &wire)
		wire["agent_history_partial"] = true
		encoded, _ = json.Marshal(wire)
		_ = json.Unmarshal(encoded, &partial)
		updated, err := svc.SaveAtRevision("partial-history-owner", partial)
		if err != nil {
			t.Fatal(err)
		}
		full, err := svc.Project("partial-history-owner", partial.ID)
		if err != nil {
			t.Fatal(err)
		}
		var retained []json.RawMessage
		_ = json.Unmarshal(full.AgentSessions, &retained)
		if len(retained) != 30 {
			t.Fatalf("partial save removed unloaded history: got %d sessions", len(retained))
		}
		if !updated.AgentHistoryPartial || len(updated.AgentSessionSummaries) != 30 {
			t.Fatal("partial save returned the wrong history view")
		}
		encoded, _ = json.Marshal(updated)
		_ = json.Unmarshal(encoded, &wire)
		wire["deleted_agent_session_ids"] = []string{"session-0"}
		encoded, _ = json.Marshal(wire)
		_ = json.Unmarshal(encoded, &partial)
		if _, err := svc.SaveAtRevision("partial-history-owner", partial); err != nil {
			t.Fatal(err)
		}
		full, err = svc.Project("partial-history-owner", partial.ID)
		if err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(full.AgentSessions, &retained)
		if len(retained) != 29 {
			t.Fatalf("explicit deletion removed wrong history: got %d sessions", len(retained))
		}
		for _, body := range retained {
			var session map[string]any
			_ = json.Unmarshal(body, &session)
			if session["id"] == "session-0" {
				t.Fatal("deleted session remained")
			}
		}
		stale, err := CanvasAgentHistoryView(full, nil)
		if err != nil {
			t.Fatal(err)
		}
		var concurrent []map[string]any
		_ = json.Unmarshal(full.AgentSessions, &concurrent)
		concurrent[len(concurrent)-1]["title"] = "Changed in another window"
		full.AgentSessions, _ = json.Marshal(concurrent)
		changed, err := svc.SaveAtRevision("partial-history-owner", full)
		if err != nil {
			t.Fatal(err)
		}
		stale.Revision = changed.Revision
		if _, err := svc.SaveAtRevision("partial-history-owner", stale); !errors.Is(err, ErrCanvasRevisionConflict) {
			t.Fatal("stale body overwrote history at a fresh canvas revision", err)
		}
		stale.AgentSessionSummaries = nil
		if _, err := svc.SaveAtRevision("partial-history-owner", stale); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatal("partial body accepted without a version", err)
		}
		if _, err := svc.Import("partial-import-owner", stale); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatal("partial history imported as complete", err)
		}
	})
	t.Run("save_receipts_omit_unchanged_bodies_and_return_reconciled_history", func(t *testing.T) {
		const owner = "history-receipt-owner"
		workspace, err := svc.Import(owner, saved)
		if err != nil {
			t.Fatal(err)
		}
		partial, err := CanvasAgentHistoryView(workspace.Document, nil)
		if err != nil {
			t.Fatal(err)
		}
		partial.AgentSessions = json.RawMessage(`[]`)
		partial.Title = "Geometry-only save"
		receipt, err := svc.SaveAtRevision(owner, partial)
		if err != nil {
			t.Fatal(err)
		}
		var bodies []json.RawMessage
		if err := json.Unmarshal(receipt.AgentSessions, &bodies); err != nil || len(bodies) != 0 || len(receipt.AgentSessionSummaries) != 30 || !receipt.AgentHistoryPartial || receipt.ActiveAgentSessionID != "session-29" {
			t.Fatalf("unchanged history was retransmitted: bodies=%d summaries=%d active=%s error=%v", len(bodies), len(receipt.AgentSessionSummaries), receipt.ActiveAgentSessionID, err)
		}
		full, err := svc.Project(owner, receipt.ID)
		if err != nil || string(full.AgentSessions) != string(saved.AgentSessions) {
			t.Fatal("omitting receipt bodies changed stored history", err)
		}
		var sessions []map[string]any
		_ = json.Unmarshal(full.AgentSessions, &sessions)
		sessions[29]["title"] = "Remote title"
		full.AgentSessions, _ = json.Marshal(sessions)
		remote, err := svc.SaveAtRevision(owner, full)
		if err != nil {
			t.Fatal(err)
		}
		// Geometry-only saves may carry an older directory hash at a fresh
		// canvas revision. Return the changed active body to refresh its cache.
		receipt.Revision = remote.Revision
		reconciled, err := svc.SaveAtRevision(owner, receipt)
		if err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(reconciled.AgentSessions, &bodies)
		if len(bodies) != 1 || !strings.Contains(string(bodies[0]), "Remote title") {
			t.Fatal("changed active history was hidden by receipt filtering")
		}
		// Editing an inactive body must return that accepted body without
		// retransmitting the unchanged active conversation.
		current, err := svc.Project(owner, receipt.ID)
		if err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(current.AgentSessions, &sessions)
		sessions[0]["title"] = "Inactive edit"
		encoded, _ := json.Marshal(sessions[:1])
		reconciled.AgentSessions = encoded
		edited, err := svc.SaveAtRevision(owner, reconciled)
		if err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(edited.AgentSessions, &bodies)
		if len(bodies) != 1 || !strings.Contains(string(bodies[0]), "Inactive edit") || strings.Contains(string(bodies[0]), "session-29") {
			t.Fatalf("receipt did not isolate the submitted body: count=%d", len(bodies))
		}
		reopened, err := NewCanvasDocumentService(backend).Project(owner, edited.ID)
		if err != nil {
			t.Fatal(err)
		}
		var retained []json.RawMessage
		_ = json.Unmarshal(reopened.AgentSessions, &retained)
		if len(retained) != 30 || !strings.Contains(string(reopened.AgentSessions), "Remote title") || !strings.Contains(string(reopened.AgentSessions), "Inactive edit") {
			t.Fatal("receipt filtering lost persisted history on reload")
		}
	})
	t.Run("partial_geometry_and_inactive_edits_preserve_cached_body_hashes", func(t *testing.T) {
		const owner = "history-original-hash-owner"
		source := saved
		source.AgentSessions = json.RawMessage(`[{"id":"one","title":"Active","messages":[{"role":"assistant","id":"first","text":"Retained"}],"contextUsage":{"totalTokens":7}},{"id":"two","title":"Inactive","messages":[{"role":"assistant","id":"second","text":"Also retained"}]}]`)
		source.ActiveAgentSessionID = "one"
		workspace, err := svc.Import(owner, source)
		if err != nil {
			t.Fatal(err)
		}
		partial, err := CanvasAgentHistoryView(workspace.Document, nil)
		if err != nil {
			t.Fatal(err)
		}
		originalSummaries := append([]CanvasAgentSessionSummary(nil), partial.AgentSessionSummaries...)
		partial.AgentSessions = json.RawMessage(`[]`)
		partial.Title = "Geometry edit"
		receipt, err := svc.SaveAtRevision(owner, partial)
		if err != nil {
			t.Fatal(err)
		}
		if string(receipt.AgentSessions) != "[]" || !reflect.DeepEqual(receipt.AgentSessionSummaries, originalSummaries) {
			t.Fatal("geometry-only save changed a cached body's representation or content hash")
		}
		receipt.AgentSessions = json.RawMessage(`[{"id":"two","title":"Renamed inactive","messages":[{"role":"assistant","id":"second","text":"Also retained"}],"toolReceipts":[{"forged":true}],"contextUsage":{"totalTokens":999}}]`)
		edited, err := svc.SaveAtRevision(owner, receipt)
		if err != nil {
			t.Fatal(err)
		}
		var bodies []map[string]any
		if err := json.Unmarshal(edited.AgentSessions, &bodies); err != nil || len(bodies) != 1 || bodies[0]["id"] != "two" {
			t.Fatal("inactive edit retransmitted an unchanged body", err)
		}
		if _, ok := bodies[0]["contextUsage"]; ok {
			t.Fatal("browser forged server usage")
		}
		if _, ok := bodies[0]["toolReceipts"]; ok {
			t.Fatal("browser forged tool receipts")
		}
		if edited.AgentSessionSummaries[0].ContentHash != originalSummaries[0].ContentHash {
			t.Fatal("inactive edit changed the active body's hash")
		}
		full, err := NewCanvasDocumentService(backend).Project(owner, edited.ID)
		if err != nil {
			t.Fatal(err)
		}
		var original, retained []json.RawMessage
		_ = json.Unmarshal(source.AgentSessions, &original)
		_ = json.Unmarshal(full.AgentSessions, &retained)
		if len(retained) != 2 || string(retained[0]) != string(original[0]) {
			t.Fatal("saving changed an untouched transcript")
		}
	})
	t.Run("failed_publish_preserves_committed_history", func(t *testing.T) {
		documents := backend.(storage.JSONDocumentBackend)
		wrapper := &countingCanvasDocumentBackend{Backend: backend, documents: documents, saves: make(map[string]int)}
		writer := NewCanvasDocumentService(wrapper)
		for _, failure := range []string{"chunk", "workspace"} {
			t.Run(failure, func(t *testing.T) {
				injected := errors.New("injected storage failure")
				writes := 0
				wrapper.failSave = func(name string) error {
					if strings.HasPrefix(name, "canvas_agent_history/") {
						writes++
						if failure == "chunk" && writes == 2 {
							return injected
						}
					}
					if failure == "workspace" && name == canvasWorkspaceName("history-owner") {
						return injected
					}
					return nil
				}
				candidate := saved
				candidate.AgentSessions = json.RawMessage(fmt.Sprintf(`[{"id":"new","messages":[{"text":%q}]}]`, strings.Repeat(failure+" modified history. ", 10000)))
				if _, err := writer.SaveAtRevision("history-owner", candidate); !errors.Is(err, injected) {
					t.Fatalf("save did not report storage failure: %v", err)
				}
				wrapper.failSave = nil
				current, err := reopened.Project("history-owner", saved.ID)
				if err != nil || current.Revision != saved.Revision || string(current.AgentSessions) != string(saved.AgentSessions) {
					t.Fatal("failed save changed committed history", err)
				}
			})
		}
	})
	t.Run("missing_corrupt_and_other_owner_fail_closed", func(t *testing.T) {
		documents := backend.(storage.JSONDocumentBackend)
		var workspace canvasWorkspace
		if err := json.Unmarshal(data, &workspace); err != nil {
			t.Fatal(err)
		}
		name := canvasAgentHistoryChunkName("history-owner", saved.ID, canvasAgentHistoryHashes(workspace.AgentHistories[saved.ID])[0])
		chunk, err := documents.LoadJSONDocument(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, corrupt := range []bool{false, true} {
			if corrupt {
				err = documents.SaveJSONDocument(name, canvasAgentHistoryChunk{Data: []byte("corrupt")})
			} else {
				err = documents.DeleteJSONDocument(name)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := reopened.Project("history-owner", saved.ID); err == nil {
				t.Fatal("incomplete history returned as a successful read")
			}
			if _, err := reopened.ProjectWorkspace("history-owner", saved.ID); err == nil {
				t.Fatal("project workspace silently accepted incomplete history")
			}
			if _, err := reopened.SaveAtRevision("history-owner", saved); err == nil {
				t.Fatal("incomplete history accepted a replacement save")
			}
			if err := documents.SaveJSONDocument(name, chunk); err != nil {
				t.Fatal(err)
			}
		}
		if err := documents.SaveJSONDocument(canvasWorkspaceName("other-history-owner"), workspace); err != nil {
			t.Fatal(err)
		}
		if _, err := reopened.Project("other-history-owner", saved.ID); err == nil {
			t.Fatal("another owner could read the source owner's chunks")
		}
	})
	t.Run("inline_upgrade_and_reopen", func(t *testing.T) {
		documents := backend.(storage.JSONDocumentBackend)
		legacy := DefaultCanvasDocument()
		legacy.AgentSessions = json.RawMessage(`[{"id":"old-session","messages":[{"text":"old conversation"}]}]`)
		legacy.ActiveAgentSessionID = "old-session"
		other := DefaultCanvasDocument()
		workspace := canvasWorkspace{Version: 1, Generation: 1, ActiveProjectID: other.ID, Projects: []CanvasDocument{legacy, other}}
		if err := documents.SaveJSONDocument(canvasWorkspaceName("legacy-history-owner"), workspace); err != nil {
			t.Fatal(err)
		}
		if err := documents.SaveJSONDocument(canvasActiveProjectName("legacy-history-owner"), canvasActiveProject{Version: 1, WorkspaceGeneration: 1, ProjectID: legacy.ID}); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			service := NewCanvasDocumentService(backend)
			selected, err := service.ProjectWorkspace("legacy-history-owner", legacy.ID)
			if err != nil || selected.Document.ID != legacy.ID || string(selected.Document.AgentSessions) != string(legacy.AgentSessions) {
				t.Fatal("project workspace did not preserve legacy history", err)
			}
			loaded, err := service.Workspace("legacy-history-owner")
			if err != nil || loaded.Document.ID != legacy.ID || string(loaded.Document.AgentSessions) != string(legacy.AgentSessions) {
				t.Fatal("legacy history or active pointer changed", err)
			}
			if _, err := service.SaveAtRevision("legacy-history-owner", loaded.Document); err != nil {
				t.Fatal(err)
			}
		}
		raw, err := documents.LoadJSONDocument(canvasWorkspaceName("legacy-history-owner"))
		encoded, marshalErr := json.Marshal(raw)
		if err != nil || marshalErr != nil || !strings.Contains(string(encoded), `"agent_histories"`) || strings.Contains(string(encoded), "old conversation") {
			t.Fatal("inline history was not migrated", err, marshalErr)
		}
	})
	t.Run("concurrent_project_saves_preserve_both_histories", func(t *testing.T) {
		secondBackend, err := storage.NewDatabaseBackend(databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		defer secondBackend.Close()
		second, err := svc.Import("history-owner", CanvasDocument{Title: "Second history", Viewport: CanvasViewport{Zoom: 1}})
		if err != nil {
			t.Fatal(err)
		}
		barrier := newCanvasSaveBarrier(2)
		wrap := func(store storage.Backend) *CanvasDocumentService {
			return NewCanvasDocumentService(&barrierCanvasDocumentBackend{Backend: store, documents: store.(storage.JSONDocumentBackend), barrier: barrier})
		}
		firstService, secondService := wrap(backend), wrap(secondBackend)
		firstCandidate, secondCandidate := saved, second.Document
		firstCandidate.AgentSessions = json.RawMessage(`[{"id":"first","messages":[{"text":"first concurrent transcript"}]}]`)
		secondCandidate.AgentSessions = json.RawMessage(`[{"id":"second","messages":[{"text":"second concurrent transcript"}]}]`)
		results := make(chan error, 2)
		go func() { _, err := firstService.SaveAtRevision("history-owner", firstCandidate); results <- err }()
		go func() { _, err := secondService.SaveAtRevision("history-owner", secondCandidate); results <- err }()
		for range 2 {
			if err := <-results; err != nil {
				t.Fatal(err)
			}
		}
		reader := NewCanvasDocumentService(secondBackend)
		for _, candidate := range []CanvasDocument{firstCandidate, secondCandidate} {
			actual, err := reader.Project("history-owner", candidate.ID)
			if err != nil || string(actual.AgentSessions) != string(candidate.AgentSessions) {
				t.Fatal("concurrent project history was lost", err)
			}
		}
		// Keep the next assertion based on the new committed revision.
		saved, err = reader.Project("history-owner", saved.ID)
		if err != nil {
			t.Fatal(err)
		}
	})
	t.Run("geometry_save_reloads_reclaimed_sibling_history", func(t *testing.T) {
		const owner = "verified-cas-owner"
		secondBackend, err := storage.NewDatabaseBackend(databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		defer secondBackend.Close()
		firstDoc := DefaultCanvasDocument()
		firstDoc.AgentSessions = json.RawMessage(`[{"id":"first","messages":[{"text":"Retain first history"}]}]`)
		first, err := svc.Import(owner, firstDoc)
		if err != nil {
			t.Fatal(err)
		}
		secondDoc := DefaultCanvasDocument()
		secondDoc.AgentSessions = json.RawMessage(`[{"id":"sibling","messages":[{"text":"Old sibling history"}]}]`)
		second, err := svc.Import(owner, secondDoc)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := backend.(storage.JSONDocumentBackend).LoadJSONDocument(canvasWorkspaceName(owner))
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(raw)
		var original canvasWorkspace
		if err := json.Unmarshal(data, &original); err != nil {
			t.Fatal(err)
		}
		oldHashes := canvasAgentHistoryHashes(original.AgentHistories[second.Document.ID])
		if len(oldHashes) != 1 {
			t.Fatal("sibling fixture did not create one history chunk")
		}
		writer := NewCanvasDocumentService(secondBackend)
		wrapper := &countingCanvasDocumentBackend{Backend: backend, documents: backend.(storage.JSONDocumentBackend), saves: make(map[string]int)}
		injected := false
		wrapper.failSave = func(name string) error {
			if name != canvasWorkspaceName(owner) || injected {
				return nil
			}
			injected = true
			candidate := second.Document
			candidate.AgentSessions = json.RawMessage(`[{"id":"sibling","messages":[{"text":"New committed sibling history"}]}]`)
			_, err := writer.SaveAtRevision(owner, candidate)
			return err
		}
		partial, err := CanvasAgentHistoryView(first.Document, nil)
		if err != nil {
			t.Fatal(err)
		}
		partial.AgentSessions = json.RawMessage("[]")
		partial.Title = "Committed geometry"
		if _, err := NewCanvasDocumentService(wrapper).SaveAtRevision(owner, partial); err != nil {
			t.Fatal("geometry save did not rebuild verified references after a root conflict", err)
		}
		if !injected || wrapper.saves[canvasWorkspaceName(owner)] != 2 {
			t.Fatal("test did not force a retry after concurrent history pruning")
		}
		current, err := writer.Project(owner, first.Document.ID)
		if err != nil || current.Title != partial.Title || string(current.AgentSessions) != string(first.Document.AgentSessions) {
			t.Fatal("geometry retry changed the target conversation", err)
		}
		sibling, err := writer.Project(owner, second.Document.ID)
		if err != nil || !strings.Contains(string(sibling.AgentSessions), "New committed sibling history") {
			t.Fatal("geometry retry lost the concurrently committed sibling", err)
		}
		if raw, err := backend.(storage.JSONDocumentBackend).LoadJSONDocument(canvasAgentHistoryChunkName(owner, second.Document.ID, oldHashes[0])); err != nil || raw != nil {
			t.Fatal("geometry retry resurrected a reclaimed sibling chunk", err)
		}
	})
	t.Run("reader_reloads_manifest_replaced_during_pruning", func(t *testing.T) {
		for _, read := range []string{"project", "file references", "history session"} {
			t.Run(read, func(t *testing.T) {
				var once sync.Once
				wrapper := &countingCanvasDocumentBackend{Backend: backend, documents: backend.(storage.JSONDocumentBackend), saves: make(map[string]int)}
				wrapper.beforeLoad = func(name string) {
					if !strings.HasPrefix(name, "canvas_agent_history/") {
						return
					}
					once.Do(func() {
						candidate := saved
						candidate.AgentSessions = json.RawMessage(fmt.Sprintf(`[{"id":"read-race","messages":[{"text":%q,"references":[{"storageKey":"server:read-object"}]}]}]`, read))
						var err error
						saved, err = reopened.SaveAtRevision("history-owner", candidate)
						if err != nil {
							t.Fatal(err)
						}
					})
				}
				reader := NewCanvasDocumentService(wrapper)
				if read == "history session" {
					var previous []map[string]any
					_ = json.Unmarshal(saved.AgentSessions, &previous)
					if _, err := reader.AgentHistorySession("history-owner", saved.ID, previous[0]["id"].(string), saved.Revision); !errors.Is(err, ErrCanvasRevisionConflict) {
						t.Fatal("pruning during session read did not return a revision conflict", err)
					}
					return
				}
				if read == "project" {
					actual, err := reader.Project("history-owner", saved.ID)
					if err != nil || string(actual.AgentSessions) != string(saved.AgentSessions) {
						t.Fatal("reader did not recover the new committed history", err)
					}
				} else if referenced, err := reader.ReferencesStorageObject("history-owner", "server:read-object"); err != nil || !referenced {
					t.Fatal("pruning race hid a live file reference", err)
				}
			})
		}
	})
	t.Run("clearing_history_drops_manifest", func(t *testing.T) {
		candidate := saved
		candidate.AgentSessions, candidate.AgentMessages = nil, nil
		candidate.ActiveAgentSessionID = ""
		cleared, err := reopened.SaveAtRevision("history-owner", candidate)
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := reopened.Project("history-owner", cleared.ID)
		if err != nil || len(loaded.AgentSessions) != 0 {
			t.Fatal("cleared history was resurrected", err)
		}
		raw, err := backend.(storage.JSONDocumentBackend).LoadJSONDocument(canvasWorkspaceName("history-owner"))
		encoded, marshalErr := json.Marshal(raw)
		var workspace canvasWorkspace
		decodeErr := json.Unmarshal(encoded, &workspace)
		_, stillReferenced := workspace.AgentHistories[cleared.ID]
		if err != nil || marshalErr != nil || decodeErr != nil || stillReferenced {
			t.Fatal("cleared history still has a manifest", err, marshalErr)
		}
		chunks, err := backend.(storage.JSONDocumentPrefixBackend).ListJSONDocuments(fmt.Sprintf("canvas_agent_history/%x/%x/", sha256.Sum256([]byte("history-owner")), sha256.Sum256([]byte(cleared.ID))))
		if err != nil || len(chunks) != 0 {
			t.Fatalf("cleared history still occupies storage: chunks=%d err=%v", len(chunks), err)
		}
	})
	t.Run("version_three_index_gets_content_versions_on_successful_save", func(t *testing.T) {
		owner := "version-three-history-owner"
		workspace, err := svc.Import(owner, CanvasDocument{Title: "Version three", AgentSessions: json.RawMessage(`[{"id":"old-index-session","messages":[{"text":"retained"}]}]`)})
		if err != nil {
			t.Fatal(err)
		}
		documents := backend.(storage.JSONDocumentBackend)
		raw, err := documents.LoadJSONDocument(canvasWorkspaceName(owner))
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(raw)
		var stored canvasWorkspace
		_ = json.Unmarshal(encoded, &stored)
		stored.Version = 3
		ref := stored.AgentHistories[workspace.Document.ID]
		ref.Sessions[0].ContentHash = ""
		stored.AgentHistories[workspace.Document.ID] = ref
		if err := documents.SaveJSONDocument(canvasWorkspaceName(owner), stored); err != nil {
			t.Fatal(err)
		}
		view, err := reopened.EditorWorkspace(owner, workspace.Document.ID, nil)
		if err != nil || len(view.Document.AgentSessionSummaries) != 1 || view.Document.AgentSessionSummaries[0].ContentHash == "" {
			t.Fatal("old session index has no usable version", err)
		}
		if _, err := reopened.SaveAtRevision(owner, view.Document); err != nil {
			t.Fatal("partial save did not migrate the index", err)
		}
		actual, err := reopened.Project(owner, workspace.Document.ID)
		if err != nil || !strings.Contains(string(actual.AgentSessions), "retained") {
			t.Fatal("version-three migration lost history", err)
		}
		raw, _ = documents.LoadJSONDocument(canvasWorkspaceName(owner))
		encoded, _ = json.Marshal(raw)
		_ = json.Unmarshal(encoded, &stored)
		if stored.Version != canvasWorkspaceVersion || stored.AgentHistories[workspace.Document.ID].Sessions[0].ContentHash == "" {
			t.Fatal("history index migration was not persisted")
		}
	})
	t.Run("version_two_envelope_migrates_after_successful_save", func(t *testing.T) {
		owner := "version-two-history-owner"
		document := DefaultCanvasDocument()
		document.AgentSessions = json.RawMessage(`[{"id":"old-envelope-session","title":"Original","messages":[{"id":"old-message","role":"assistant","text":"old envelope transcript"}]}]`)
		payload, _ := json.Marshal(canvasAgentHistory{Sessions: document.AgentSessions})
		block, err := svc.saveAgentHistoryBlockLocked(owner, document.ID, payload)
		if err != nil {
			t.Fatal(err)
		}
		stored := document
		stored.AgentSessions = nil
		workspace := canvasWorkspace{Version: 2, Generation: 1, ActiveProjectID: document.ID, Projects: []CanvasDocument{stored}, AgentHistories: map[string]canvasAgentHistoryReference{document.ID: {Chunks: block.Chunks, Bytes: block.Bytes}}}
		documents := backend.(storage.JSONDocumentBackend)
		if err := documents.SaveJSONDocument(canvasWorkspaceName(owner), workspace); err != nil {
			t.Fatal(err)
		}
		page, err := reopened.AgentHistoryPage(owner, document.ID, "", 20)
		if err != nil || len(page.Sessions) != 1 || page.Sessions[0].ID != "old-envelope-session" {
			t.Fatal("old envelope index could not be read", err)
		}
		session, err := reopened.AgentHistorySession(owner, document.ID, page.Sessions[0].ID, page.Revision)
		if err != nil || !strings.Contains(string(session), "old envelope transcript") {
			t.Fatal("old envelope session could not be read", err)
		}
		before, err := documents.LoadJSONDocument(canvasWorkspaceName(owner))
		encoded, _ := json.Marshal(before)
		if err != nil || !strings.Contains(string(encoded), `"version":2`) {
			t.Fatal("history GET rewrote legacy data", err)
		}
		loaded, err := reopened.Project(owner, document.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := reopened.SaveAtRevision(owner, loaded); err != nil {
			t.Fatal(err)
		}
		if _, err := reopened.Project(owner, document.ID); err != nil {
			t.Fatal("migrated history cannot be reopened", err)
		}
		oldChunk, err := documents.LoadJSONDocument(canvasAgentHistoryChunkName(owner, document.ID, block.Chunks[0]))
		if err != nil || oldChunk != nil {
			t.Fatal("old envelope was not reclaimed after migration", err)
		}
	})
}

func TestCanvasDocumentMediaReplacementClearsInheritedMeasurements(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatal(err)
	}
	audio := true
	document.Nodes = []CanvasNode{{ID: "video", Type: "video", Width: 240, Height: 360, ScaleX: 1, ScaleY: 1, URL: "/old.mp4", GenerationVideoModel: "test", GenerationVideoSeconds: 15, GenerationVideoSize: "9:16", MediaMetadata: &CanvasMediaMetadata{Width: 768, Height: 1376, DurationMS: 15020, HasAudio: &audio}, MediaSilentClips: 1, MediaProbeError: "Old probe failure"}}
	saved, err := service.SaveAtRevision("owner", document)
	if err != nil {
		t.Fatal(err)
	}
	saved.Nodes[0].X = 100
	moved, err := service.SaveAtRevision("owner", saved)
	if err != nil || !reflect.DeepEqual(moved.Nodes[0].MediaMetadata, saved.Nodes[0].MediaMetadata) {
		t.Fatal("layout discarded actual measurements", err)
	}
	moved.Nodes[0].URL = "/replacement.mp4"
	replaced, err := service.SaveAtRevision("owner", moved)
	if err != nil {
		t.Fatal(err)
	}
	if replaced.Nodes[0].MediaMetadata != nil || replaced.Nodes[0].MediaSilentClips != 0 || replaced.Nodes[0].MediaProbeError != "" {
		t.Fatal("replacement inherited another file's measurements")
	}
}

func TestCanvasDocumentServiceDoesNotRenewExpiredHistory(t *testing.T) {
	for _, publicOnly := range []bool{false, true} {
		service := NewCanvasDocumentService(newTestStorageBackend(t))
		document, err := loadCanvas(service, "owner")
		if err != nil {
			t.Fatal(err)
		}
		if publicOnly {
			document.RetainedStorageObjectURLs = []string{"https://cdn.example.test/expired.png"}
		} else {
			document.RetainedStorageObjectIDs = []string{"expired-object"}
		}
		document.RetainedStorageObjectsUntil = time.Now().Add(-time.Second).Format(time.RFC3339Nano)
		saved, err := service.SaveAtRevision("owner", document)
		if err != nil {
			t.Fatal(err)
		}
		if len(saved.RetainedStorageObjectIDs) != 0 || len(saved.RetainedStorageObjectURLs) != 0 || saved.RetainedStorageObjectsUntil != "" {
			t.Fatalf("expired history renewed: %+v", saved)
		}
		saved.RetainedStorageObjectIDs = []string{"active-object"}
		saved.RetainedStorageObjectsUntil = time.Now().Add(time.Minute).Format(time.RFC3339Nano)
		renewed, err := service.SaveAtRevision("owner", saved)
		if err != nil {
			t.Fatal(err)
		}
		until, err := time.Parse(time.RFC3339Nano, renewed.RetainedStorageObjectsUntil)
		if err != nil || !until.After(time.Now().Add(23*time.Hour)) || !reflect.DeepEqual(renewed.RetainedStorageObjectIDs, []string{"active-object"}) {
			t.Fatalf("live history lease not renewed: %+v, %v", renewed, err)
		}
	}
}

func TestCanvasDocumentServiceTreatsHistoryTextMatchesAsCandidates(t *testing.T) {
	f := newFileLifecycleFixture(t)
	object := f.upload(t)
	document, err := loadCanvas(f.canvas, "alice")
	if err != nil {
		t.Fatal(err)
	}
	document.Nodes = []CanvasNode{{ID: "text", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "说明 https://other.example/api/files/demo/content server:8080 https://other.example/%xx"}}
	document.RetainedStorageObjectIDs = []string{object.ID, "demo", "8080", "invalid/guess"}
	document.RetainedStorageObjectURLs = []string{"https://other.example/%xx"}
	saved, err := f.canvas.SaveAtRevision("alice", document)
	if err != nil {
		t.Fatalf("text-only canvas with guessed references must save: %v", err)
	}
	if !reflect.DeepEqual(saved.RetainedStorageObjectIDs, []string{object.ID}) || len(saved.RetainedStorageObjectURLs) != 0 || saved.Nodes[0].Prompt != document.Nodes[0].Prompt {
		t.Fatalf("unexpected retained candidates or text: %+v", saved)
	}
	saved.Nodes = append(saved.Nodes, CanvasNode{ID: "image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, URL: "/api/files/missing/content"})
	if _, err := f.canvas.SaveAtRevision("alice", saved); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("actual missing media must still fail: %v", err)
	}
}

func TestCanvasDocumentServiceHistoryValidationPreservesStorageFailure(t *testing.T) {
	storageFailure := errors.New("database unavailable")
	service := NewCanvasDocumentService(newTestStorageBackend(t), func(ownerID, objectID string) error { return storageFailure })
	document, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatal(err)
	}
	document.RetainedStorageObjectIDs = []string{"object"}
	if _, err := service.SaveAtRevision("owner", document); !errors.Is(err, storageFailure) {
		t.Fatalf("storage failure was suppressed: %v", err)
	}
}

func TestCanvasDocumentServiceStoresAgentSessions(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.AgentSessions = json.RawMessage(`[{"id":"session-1","title":"广告创作","messages":[],"agentState":{"phase":"script","approvedNodeIds":[],"referenceNodeIds":[],"pendingTaskIds":[],"completedTaskIds":[]},"protocolMessages":[],"createdAt":"2026-08-26T00:00:00Z","updatedAt":"2026-08-26T00:00:00Z"}]`)
	document.ActiveAgentSessionID = "session-1"
	document.AgentConfig = json.RawMessage(`{"imageQuality":"high","videoSize":"16:9"}`)
	document.AgentPanel = &CanvasAgentPanel{Open: true, Width: 520}

	saved, err := service.SaveAtRevision("agent-owner", document)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}
	if saved.ActiveAgentSessionID != "session-1" || !strings.Contains(string(saved.AgentSessions), `"session-1"`) || !strings.Contains(string(saved.AgentConfig), `"high"`) || saved.AgentPanel == nil || !saved.AgentPanel.Open || saved.AgentPanel.Width != 520 {
		t.Fatalf("saved agent data = %#v", saved)
	}
	reloaded, err := loadCanvas(service, "agent-owner")
	if err != nil {
		t.Fatalf("Load(reloaded) error = %v", err)
	}
	if reloaded.ActiveAgentSessionID != saved.ActiveAgentSessionID || !strings.Contains(string(reloaded.AgentSessions), `"session-1"`) || !strings.Contains(string(reloaded.AgentConfig), `"high"`) || reloaded.AgentPanel == nil || !reloaded.AgentPanel.Open || reloaded.AgentPanel.Width != 520 {
		t.Fatalf("reloaded agent data = %#v", reloaded)
	}
}

func TestCanvasDocumentServicePersistsAgentAutoTitleState(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "agent-title-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !document.AgentAutoTitlePending {
		t.Fatal("new canvas must allow the first primary script to set its title")
	}
	document.AgentAutoTitlePending = false
	saved, err := service.SaveAtRevision("agent-title-owner", document)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}
	cleared, err := service.ClearAtRevision("agent-title-owner", saved.ID, saved.Revision)
	if err != nil {
		t.Fatalf("ClearAtRevision() error = %v", err)
	}
	if cleared.AgentAutoTitlePending {
		t.Fatal("clearing an established canvas must not re-enable Agent auto title")
	}
	renamed, err := service.UpdateProjectAtRevision("agent-title-owner", "rename", cleared.ID, "手动标题", cleared.Revision)
	if err != nil {
		t.Fatalf("UpdateProjectAtRevision(rename) error = %v", err)
	}
	if renamed.Document.AgentAutoTitlePending {
		t.Fatal("manual rename must disable Agent auto title")
	}
}

func TestCanvasDocumentServiceRejectsInvalidAgentSessions(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "invalid-agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.AgentSessions = json.RawMessage(`{"not":"an array"}`)
	if _, err := service.SaveAtRevision("invalid-agent-owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceAgentPanelModes(t *testing.T) {
	for _, mode := range []string{"", "floating", "docked", "invalid"} {
		t.Run(mode, func(t *testing.T) {
			service := NewCanvasDocumentService(newTestStorageBackend(t))
			document, err := loadCanvas(service, "panel-mode-owner")
			if err != nil {
				t.Fatal(err)
			}
			if document.AgentPanel == nil || document.AgentPanel.Mode != "floating" {
				t.Fatalf("default panel = %#v", document.AgentPanel)
			}
			document.AgentPanel = &CanvasAgentPanel{Open: true, Width: 480, Mode: mode}
			saved, err := service.SaveAtRevision("panel-mode-owner", document)
			if mode == "invalid" {
				if !errors.Is(err, ErrInvalidCanvasDocument) {
					t.Fatalf("SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := mode
			if want == "" {
				want = "floating"
			}
			if saved.AgentPanel.Mode != want {
				t.Fatalf("saved mode = %q, want %q", saved.AgentPanel.Mode, want)
			}
			reloaded, err := loadCanvas(service, "panel-mode-owner")
			if err != nil {
				t.Fatal(err)
			}
			if reloaded.AgentPanel.Mode != want || reloaded.AgentPanel.Width != 480 || !reloaded.AgentPanel.Open {
				t.Fatalf("reloaded panel = %#v", reloaded.AgentPanel)
			}
		})
	}
}

func TestCanvasDocumentServiceRejectsInvalidAgentPanelWidth(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "invalid-agent-panel-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.AgentPanel = &CanvasAgentPanel{Open: true, Width: 761}
	if _, err := service.SaveAtRevision("invalid-agent-panel-owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServicePersistsPendingAgentRequest(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "pending-agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.PendingAgentRequest = json.RawMessage(`{"prompt":"制作产品广告","assets":[{"nodeId":"image-1","payload":{"kind":"image"},"reference":{"id":"image-1"}}]}`)
	saved, err := service.SaveAtRevision("pending-agent-owner", document)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}
	if !strings.Contains(string(saved.PendingAgentRequest), `"制作产品广告"`) {
		t.Fatalf("saved pending Agent request = %s", saved.PendingAgentRequest)
	}
	reloaded, err := loadCanvas(service, "pending-agent-owner")
	if err != nil {
		t.Fatalf("Load(reloaded) error = %v", err)
	}
	var savedRequest, reloadedRequest map[string]any
	if err := json.Unmarshal(saved.PendingAgentRequest, &savedRequest); err != nil {
		t.Fatalf("decode saved pending Agent request: %v", err)
	}
	if err := json.Unmarshal(reloaded.PendingAgentRequest, &reloadedRequest); err != nil {
		t.Fatalf("decode reloaded pending Agent request: %v", err)
	}
	if !reflect.DeepEqual(reloadedRequest, savedRequest) {
		t.Fatalf("reloaded pending Agent request = %v, want %v", reloadedRequest, savedRequest)
	}
	reloaded.PendingAgentRequest = nil
	cleared, err := service.SaveAtRevision("pending-agent-owner", reloaded)
	if err != nil {
		t.Fatalf("SaveAtRevision(clear pending request) error = %v", err)
	}
	if len(cleared.PendingAgentRequest) != 0 {
		t.Fatalf("cleared pending Agent request = %s", cleared.PendingAgentRequest)
	}
}

func TestCanvasDocumentServiceRejectsInvalidPendingAgentRequest(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "invalid-pending-agent-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	document.PendingAgentRequest = json.RawMessage(`{"prompt":"","assets":[]}`)
	if _, err := service.SaveAtRevision("invalid-pending-agent-owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

type countingCanvasDocumentBackend struct {
	storage.Backend
	documents  storage.JSONDocumentBackend
	saves      map[string]int
	failSave   func(string) error
	beforeLoad func(string)
}

type canvasSaveBarrier struct {
	mu        sync.Mutex
	remaining int
	release   chan struct{}
}

func newCanvasSaveBarrier(participants int) *canvasSaveBarrier {
	return &canvasSaveBarrier{remaining: participants, release: make(chan struct{})}
}

func (b *canvasSaveBarrier) wait() {
	b.mu.Lock()
	b.remaining--
	if b.remaining == 0 {
		close(b.release)
	}
	b.mu.Unlock()
	<-b.release
}

type barrierCanvasDocumentBackend struct {
	storage.Backend
	documents storage.JSONDocumentBackend
	barrier   *canvasSaveBarrier
	once      sync.Once
}

type blockingCanvasDocumentBackend struct {
	storage.Backend
	documents storage.JSONDocumentBackend
	started   chan struct{}
	release   <-chan struct{}
	once      sync.Once
}

func (b *barrierCanvasDocumentBackend) LoadJSONDocument(name string) (any, error) {
	return b.documents.LoadJSONDocument(name)
}

func (b *barrierCanvasDocumentBackend) SaveJSONDocument(name string, value any) error {
	if b.barrier != nil && strings.HasPrefix(name, canvasWorkspaceDir+"/") {
		b.once.Do(b.barrier.wait)
	}
	return b.documents.SaveJSONDocument(name, value)
}

func (b *barrierCanvasDocumentBackend) SaveJSONDocumentAndPrune(ctx context.Context, name string, value any, prefix string, retained []string) error {
	if b.barrier != nil {
		b.once.Do(b.barrier.wait)
	}
	return b.documents.(storage.JSONDocumentPruningBackend).SaveJSONDocumentAndPrune(ctx, name, value, prefix, retained)
}

func (b *barrierCanvasDocumentBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}

func (b *blockingCanvasDocumentBackend) LoadJSONDocument(name string) (any, error) {
	return b.documents.LoadJSONDocument(name)
}

func (b *blockingCanvasDocumentBackend) SaveJSONDocument(name string, value any) error {
	if strings.HasPrefix(name, canvasWorkspaceDir+"/") {
		b.once.Do(func() {
			close(b.started)
			<-b.release
		})
	}
	return b.documents.SaveJSONDocument(name, value)
}

func (b *blockingCanvasDocumentBackend) SaveJSONDocumentAndPrune(ctx context.Context, name string, value any, prefix string, retained []string) error {
	b.once.Do(func() {
		close(b.started)
		<-b.release
	})
	return b.documents.(storage.JSONDocumentPruningBackend).SaveJSONDocumentAndPrune(ctx, name, value, prefix, retained)
}

func (b *blockingCanvasDocumentBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}

func newCountingCanvasDocumentBackend(t *testing.T) *countingCanvasDocumentBackend {
	t.Helper()
	backend := newTestStorageBackend(t)
	documents, ok := backend.(storage.JSONDocumentBackend)
	if !ok {
		t.Fatal("test backend does not support JSON documents")
	}
	return &countingCanvasDocumentBackend{Backend: backend, documents: documents, saves: make(map[string]int)}
}

func (b *countingCanvasDocumentBackend) LoadJSONDocument(name string) (any, error) {
	if b.beforeLoad != nil {
		b.beforeLoad(name)
	}
	return b.documents.LoadJSONDocument(name)
}

func (b *countingCanvasDocumentBackend) SaveJSONDocument(name string, value any) error {
	b.saves[name]++
	if b.failSave != nil {
		if err := b.failSave(name); err != nil {
			return err
		}
	}
	return b.documents.SaveJSONDocument(name, value)
}

func (b *countingCanvasDocumentBackend) SaveJSONDocumentAndPrune(ctx context.Context, name string, value any, prefix string, retained []string) error {
	b.saves[name]++
	if b.failSave != nil {
		if err := b.failSave(name); err != nil {
			return err
		}
	}
	return b.documents.(storage.JSONDocumentPruningBackend).SaveJSONDocumentAndPrune(ctx, name, value, prefix, retained)
}

func (b *countingCanvasDocumentBackend) DeleteJSONDocument(name string) error {
	return b.documents.DeleteJSONDocument(name)
}

func TestCanvasDocumentServiceSavesAndIsolatesOwners(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner-a", CanvasDocument{
		Title:    "Campaign board",
		Viewport: CanvasViewport{Zoom: 1.25, X: 120, Y: -30},
		Nodes: []CanvasNode{{
			ID: "image-1", Type: "image", X: 40, Y: 50, Width: 512, Height: 512,
			ScaleX: 1, ScaleY: 1, URL: "/images/a.png", Prompt: "draw a city",
		}},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if document.Revision != 1 || document.UpdatedAt == "" || len(document.Nodes) != 1 {
		t.Fatalf("Save() document = %#v", document)
	}

	loaded, err := loadCanvas(service, "owner-a")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Title != "Campaign board" || loaded.Nodes[0].URL != "/images/a.png" {
		t.Fatalf("Load() document = %#v", loaded)
	}
	other, err := loadCanvas(service, "owner-b")
	if err != nil {
		t.Fatalf("Load(other) error = %v", err)
	}
	if other.Revision != 0 || len(other.Nodes) != 0 {
		t.Fatalf("other owner saw canvas = %#v", other)
	}
}

func TestCanvasDocumentServiceNormalizesWithoutMutatingInput(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	workspace, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	input := workspace.Document
	input.Nodes = []CanvasNode{
		{
			ID: " root ", Type: " IMAGE ", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1,
			URL: " /images/root.png ", StorageKey: " server:root ",
			GenerationReferenceURLs:        []string{" /images/reference.png "},
			GenerationVideoReferenceURLs:   []string{" /videos/reference.mp4 "},
			GenerationVideoReferenceImages: []string{" /images/video-reference.png "},
			GenerationVideoReferenceAudio:  []string{" /audio/reference.mp3 "},
			BatchChildIDs:                  []string{" child "},
			BatchPrimaryID:                 " child ",
			CameraControl:                  &CanvasCameraControl{Camera: " dolly ", Lens: " wide "},
		},
		{ID: " child ", Type: " text ", Width: 320, Height: 180, ScaleX: 1, ScaleY: 1, BatchRootID: " root "},
	}
	input.Connections = []CanvasConnection{{ID: " connection ", FromNodeID: " root ", ToNodeID: " child "}}
	input.AgentMessages = []CanvasAgentMessage{{ID: " message ", Role: " USER ", Content: " hello ", CreatedAt: " now "}}
	before, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("json.Marshal(input) error = %v", err)
	}

	stored, err := service.SaveAtRevision("owner", input)
	if err != nil {
		t.Fatalf("SaveAtRevision() error = %v", err)
	}
	after, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("json.Marshal(input after save) error = %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("SaveAtRevision() mutated input\nbefore: %s\nafter:  %s", before, after)
	}
	root := stored.Nodes[0]
	if root.StorageKey != "server:root" || root.GenerationReferenceURLs[0] != "/images/reference.png" || root.GenerationVideoReferenceURLs[0] != "/videos/reference.mp4" || root.GenerationVideoReferenceImages[0] != "/images/video-reference.png" || root.GenerationVideoReferenceAudio[0] != "/audio/reference.mp3" || root.BatchChildIDs[0] != "child" || root.CameraControl.Camera != "dolly" || root.CameraControl.Lens != "wide" {
		t.Fatalf("stored root node was not normalized: %#v", root)
	}
	if stored.Connections[0].ID != "connection" || stored.AgentMessages[0].Role != "user" || stored.AgentMessages[0].Content != "hello" {
		t.Fatalf("stored document was not normalized: %#v", stored)
	}
}

func TestCanvasDocumentServiceRejectedImportDoesNotMutateInput(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	input := CanvasDocument{
		Nodes: []CanvasNode{
			{
				ID: " first ", Type: " image ", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1,
				GenerationReferenceURLs: []string{" /images/reference.png "},
				CameraControl:           &CanvasCameraControl{Camera: " dolly ", Lens: " wide "},
			},
			{ID: " second ", Type: " text ", Width: 320, Height: 180, ScaleX: 1, ScaleY: 1},
		},
		Connections: []CanvasConnection{
			{ID: " valid ", FromNodeID: " first ", ToNodeID: " second "},
			{ID: " invalid ", FromNodeID: " missing ", ToNodeID: " second "},
		},
		AgentMessages: []CanvasAgentMessage{{ID: " message ", Role: " USER ", Content: " hello ", CreatedAt: " now "}},
	}
	before, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("json.Marshal(input) error = %v", err)
	}

	_, err = service.Import("owner", input)
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Import() error = %v, want ErrInvalidCanvasDocument", err)
	}
	after, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("json.Marshal(input after import) error = %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("Import() mutated rejected input\nbefore: %s\nafter:  %s", before, after)
	}
}

func TestCanvasDocumentServiceRejectsNegativeNodeBytes(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := service.Import("owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, Bytes: -1,
	}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Import() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceFindsStorageObjectReferences(t *testing.T) {
	canvas := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(canvas, "owner-a", CanvasDocument{
		Title: "Stored media",
		Nodes: []CanvasNode{
			{ID: "image", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1, URL: "/api/files/image-a/content", StorageKey: "server:image-a"},
			{ID: "text", Type: "text", Width: 320, Height: 180, ScaleX: 1, ScaleY: 1, GenerationVideoLastFrameURL: "/api/files/tail/content"},
		},
		AgentSessions: json.RawMessage(`[{"references":[{"storageKey":"server:session-image"}]}]`),
	})
	if err != nil {
		t.Fatalf("saveCanvas() error = %v", err)
	}
	for _, storageKey := range []string{"server:image-a", "server:session-image", "server:tail"} {
		referenced, err := canvas.ReferencesStorageObject("owner-a", storageKey)
		if err != nil || !referenced {
			t.Fatalf("ReferencesStorageObject(%q) = (%v, %v)", storageKey, referenced, err)
		}
	}
	referenced, err := canvas.ReferencesStorageObject("owner-a", "server:unused")
	if err != nil || referenced {
		t.Fatalf("ReferencesStorageObject(unused) = (%v, %v)", referenced, err)
	}
	referenced, err = canvas.ReferencesStorageObject("owner-b", "server:image-a")
	if err != nil || referenced {
		t.Fatalf("ReferencesStorageObject(other owner) = (%v, %v)", referenced, err)
	}
}

func TestCanvasStorageReferenceSaveAndDeletionFenceAreAtomicAcrossInstances(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-canvas-deletion.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	seed := NewCanvasDocumentService(backendA)
	initial, err := seed.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(initial) error = %v", err)
	}
	candidate := initial.Document
	candidate.Nodes = []CanvasNode{{
		ID: "stored-image", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1,
		URL: "/api/files/object-a/content", StorageKey: "server:object-a",
	}}

	barrier := newCanvasSaveBarrier(2)
	wrap := func(backend storage.Backend) *barrierCanvasDocumentBackend {
		documents := backend.(storage.JSONDocumentBackend)
		return &barrierCanvasDocumentBackend{Backend: backend, documents: documents, barrier: barrier}
	}
	deleteService := NewCanvasDocumentService(wrap(backendA))
	saveService := NewCanvasDocumentService(wrap(backendB))
	type result struct {
		operation string
		err       error
	}
	results := make(chan result, 2)
	go func() {
		results <- result{operation: "delete", err: deleteService.ReserveStorageObjectDeletion("owner", "object-a")}
	}()
	go func() {
		_, saveErr := saveService.SaveAtRevision("owner", candidate)
		results <- result{operation: "save", err: saveErr}
	}()

	completed := map[string]error{}
	for range 2 {
		item := <-results
		completed[item.operation] = item.err
	}
	deleteErr := completed["delete"]
	saveErr := completed["save"]
	switch {
	case deleteErr == nil:
		if !errors.Is(saveErr, ErrInvalidCanvasDocument) {
			t.Fatalf("deletion fence won but SaveAtRevision() error = %v", saveErr)
		}
		if err := deleteService.CompleteStorageObjectDeletion("owner", "object-a"); err != nil {
			t.Fatalf("CompleteStorageObjectDeletion() error = %v", err)
		}
	case saveErr == nil:
		if !errors.Is(deleteErr, ErrStorageObjectInUse) {
			t.Fatalf("reference save won but ReserveStorageObjectDeletion() error = %v", deleteErr)
		}
	default:
		t.Fatalf("concurrent operations both failed: delete=%v save=%v", deleteErr, saveErr)
	}
}

func TestCanvasDeletionFenceAndMissingObjectValidatorRejectReferences(t *testing.T) {
	available := true
	service := NewCanvasDocumentService(newTestStorageBackend(t), func(ownerID, objectID string) error {
		if ownerID != "owner" || objectID != "object-a" || !available {
			return storage.ErrStorageObjectNotFound
		}
		return nil
	})
	workspace, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	candidate := workspace.Document
	candidate.Nodes = []CanvasNode{{
		ID: "stored-image", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1,
		URL: "/api/files/object-a/content", StorageKey: "server:object-a",
	}}

	if err := service.ReserveStorageObjectDeletion("owner", "object-a"); err != nil {
		t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
	}
	if _, err := service.SaveAtRevision("owner", candidate); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision(fenced) error = %v, want ErrInvalidCanvasDocument", err)
	}
	if _, err := service.Import("owner", candidate); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Import(fenced) error = %v, want ErrInvalidCanvasDocument", err)
	}

	available = false
	if err := service.CompleteStorageObjectDeletion("owner", "object-a"); err != nil {
		t.Fatalf("CompleteStorageObjectDeletion() error = %v", err)
	}
	if _, err := service.SaveAtRevision("owner", candidate); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("SaveAtRevision(missing object) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasWorkspaceGenerationPreventsDeletionFenceABA(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "canvas-deletion-aba.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	seed := NewCanvasDocumentService(backendA)
	workspace, err := seed.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	candidate := workspace.Document
	candidate.Nodes = []CanvasNode{{
		ID: "stored-image", Type: "image", Width: 512, Height: 512, ScaleX: 1, ScaleY: 1,
		URL: "/api/files/object-a/content", StorageKey: "server:object-a",
	}}

	var available atomic.Bool
	available.Store(true)
	validator := func(_, objectID string) error {
		if objectID != "object-a" || !available.Load() {
			return storage.ErrStorageObjectNotFound
		}
		return nil
	}
	started := make(chan struct{})
	release := make(chan struct{})
	blockingBackend := &blockingCanvasDocumentBackend{
		Backend: backendB, documents: backendB, started: started, release: release,
	}
	staleService := NewCanvasDocumentService(blockingBackend, validator)
	deletionService := NewCanvasDocumentService(backendA, validator)
	saveResult := make(chan error, 1)
	go func() {
		_, saveErr := staleService.SaveAtRevision("owner", candidate)
		saveResult <- saveErr
	}()
	<-started

	if err := deletionService.ReserveStorageObjectDeletion("owner", "object-a"); err != nil {
		t.Fatalf("ReserveStorageObjectDeletion() error = %v", err)
	}
	available.Store(false)
	if err := deletionService.CompleteStorageObjectDeletion("owner", "object-a"); err != nil {
		t.Fatalf("CompleteStorageObjectDeletion() error = %v", err)
	}
	close(release)
	if saveErr := <-saveResult; !errors.Is(saveErr, ErrInvalidCanvasDocument) {
		t.Fatalf("stale SaveAtRevision() error = %v, want ErrInvalidCanvasDocument", saveErr)
	}

	deletionService.mu.Lock()
	finalWorkspace, err := deletionService.loadWorkspaceLocked("owner")
	deletionService.mu.Unlock()
	if err != nil {
		t.Fatalf("loadWorkspaceLocked() error = %v", err)
	}
	if finalWorkspace.Generation < 3 || len(finalWorkspace.Projects[0].Nodes) != 0 {
		t.Fatalf("final workspace generation/nodes = %d/%#v", finalWorkspace.Generation, finalWorkspace.Projects[0].Nodes)
	}
}

func TestCanvasDocumentServicePreservesCreativeTextWhitespace(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	composer := "  保留配置空白\n"
	document, err := saveCanvas(service, "creative-whitespace-owner", CanvasDocument{
		Title: "Creative whitespace",
		Nodes: []CanvasNode{
			{ID: "text-1", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "  第一行\n第二行  ", GenerationStatus: "loading", GenerationStartedAt: 12345, GenerationProgress: 42},
			{ID: "config-1", Type: "config", Width: 440, Height: 240, ScaleX: 1, ScaleY: 1, ComposerContent: &composer},
		},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if document.Nodes[0].Prompt != "  第一行\n第二行  " || document.Nodes[0].GenerationStartedAt != 12345 || document.Nodes[0].GenerationProgress != 42 || document.Nodes[1].ComposerContent == nil || *document.Nodes[1].ComposerContent != composer {
		t.Fatalf("Save() changed creative text: %#v", document.Nodes)
	}

	loaded, err := loadCanvas(service, "creative-whitespace-owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Nodes[0].Prompt != "  第一行\n第二行  " || loaded.Nodes[0].GenerationStartedAt != 12345 || loaded.Nodes[0].GenerationProgress != 42 || loaded.Nodes[1].ComposerContent == nil || *loaded.Nodes[1].ComposerContent != composer {
		t.Fatalf("Load() changed creative text: %#v", loaded.Nodes)
	}
}

func TestCanvasDocumentServiceRejectsStaleRevision(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(initial) error = %v", err)
	}
	first := initial
	first.Title = "第一台设备"
	first.Nodes = []CanvasNode{{ID: "first", Type: "text", Width: 320, Height: 160, ScaleX: 1, ScaleY: 1}}
	saved, err := service.SaveAtRevision("owner", first)
	if err != nil {
		t.Fatalf("SaveAtRevision(first) error = %v", err)
	}

	stale := initial
	stale.Title = "第二台设备"
	if _, err := service.SaveAtRevision("owner", stale); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("SaveAtRevision(stale) error = %v, want ErrCanvasRevisionConflict", err)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(after conflict) error = %v", err)
	}
	if loaded.Title != saved.Title || loaded.Revision != saved.Revision || len(loaded.Nodes) != 1 {
		t.Fatalf("stale save changed document: loaded=%#v saved=%#v", loaded, saved)
	}

	loaded.Title = "基于最新版本"
	updated, err := service.SaveAtRevision("owner", loaded)
	if err != nil {
		t.Fatalf("SaveAtRevision(current) error = %v", err)
	}
	if updated.Revision != saved.Revision+1 || updated.Title != "基于最新版本" {
		t.Fatalf("updated document = %#v", updated)
	}
}

func TestCanvasDocumentServiceRenameAdvancesRevision(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(initial) error = %v", err)
	}

	renamed, err := service.UpdateProjectAtRevision("owner", "rename", initial.ID, "新名称", initial.Revision)
	if err != nil {
		t.Fatalf("UpdateProjectAtRevision(rename) error = %v", err)
	}
	if renamed.Document.Title != "新名称" || renamed.Document.Revision != initial.Revision+1 {
		t.Fatalf("renamed document = %#v", renamed.Document)
	}
	if _, err := service.SaveAtRevision("owner", initial); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("stale SaveAtRevision() error = %v, want ErrCanvasRevisionConflict", err)
	}
	if _, err := service.UpdateProjectAtRevision("owner", "delete", initial.ID, "", initial.Revision); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("stale delete error = %v, want ErrCanvasRevisionConflict", err)
	}
}

func TestCanvasDocumentServiceMergesConcurrentSavesToDifferentProjects(t *testing.T) {
	databaseURL := "sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "shared-canvas.db"))
	backendA, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(A) error = %v", err)
	}
	t.Cleanup(func() { _ = backendA.Close() })
	backendB, err := storage.NewDatabaseBackend(databaseURL)
	if err != nil {
		t.Fatalf("NewDatabaseBackend(B) error = %v", err)
	}
	t.Cleanup(func() { _ = backendB.Close() })

	seed := NewCanvasDocumentService(backendA)
	first, err := seed.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(initial) error = %v", err)
	}
	second, err := seed.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("UpdateProject(create) error = %v", err)
	}

	barrier := newCanvasSaveBarrier(2)
	wrap := func(backend storage.Backend) *barrierCanvasDocumentBackend {
		documents, ok := backend.(storage.JSONDocumentBackend)
		if !ok {
			t.Fatal("database backend does not support JSON documents")
		}
		return &barrierCanvasDocumentBackend{Backend: backend, documents: documents, barrier: barrier}
	}
	serviceA := NewCanvasDocumentService(wrap(backendA))
	serviceB := NewCanvasDocumentService(wrap(backendB))
	firstDocument := first.Document
	firstDocument.Nodes = []CanvasNode{{ID: "first-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}}
	secondDocument := second.Document
	secondDocument.Nodes = []CanvasNode{{ID: "second-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}}

	errorsCh := make(chan error, 2)
	go func() {
		_, saveErr := serviceA.SaveAtRevision("owner", firstDocument)
		errorsCh <- saveErr
	}()
	go func() {
		_, saveErr := serviceB.SaveAtRevision("owner", secondDocument)
		errorsCh <- saveErr
	}()
	for range 2 {
		if saveErr := <-errorsCh; saveErr != nil {
			t.Fatalf("concurrent SaveAtRevision() error = %v", saveErr)
		}
	}

	firstResult, err := serviceA.UpdateProject("owner", "activate", firstDocument.ID, "")
	if err != nil {
		t.Fatalf("activate first error = %v", err)
	}
	secondResult, err := serviceA.UpdateProject("owner", "activate", secondDocument.ID, "")
	if err != nil {
		t.Fatalf("activate second error = %v", err)
	}
	if len(firstResult.Document.Nodes) != 1 || firstResult.Document.Nodes[0].ID != "first-node" {
		t.Fatalf("first project lost concurrent update: %#v", firstResult.Document)
	}
	if len(secondResult.Document.Nodes) != 1 || secondResult.Document.Nodes[0].ID != "second-node" {
		t.Fatalf("second project lost concurrent update: %#v", secondResult.Document)
	}
}

func TestCanvasDocumentServiceValidatesAndClears(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{ID: "bad", Type: "image", Width: 0, Height: 100}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save() error = %v, want ErrInvalidCanvasDocument", err)
	}

	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-1", Type: "text", Width: 320, Height: 160, FontSize: 18, ScaleX: 1, ScaleY: 1, Prompt: "idea",
	}}}); err != nil {
		t.Fatalf("Save(valid) error = %v", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-invalid-font", Type: "text", Width: 320, Height: 160, FontSize: 40, ScaleX: 1, ScaleY: 1,
	}}}); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(invalid font size) error = %v, want ErrInvalidCanvasDocument", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image-empty", Type: "image", Width: 360, Height: 360, ScaleX: 1, ScaleY: 1,
	}}}); err != nil {
		t.Fatalf("Save(blank image) error = %v", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "text-empty", Type: "text", Width: 340, Height: 220, ScaleX: 1, ScaleY: 1,
	}}}); err != nil {
		t.Fatalf("Save(blank text) error = %v", err)
	}
	saved, err := saveCanvas(service, "owner", CanvasDocument{
		Title: "保留的画布", Background: "grid", Viewport: CanvasViewport{Zoom: 1.5, X: 240, Y: -80},
		Nodes: []CanvasNode{{ID: "config-empty", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}},
	})
	if err != nil {
		t.Fatalf("Save(config) error = %v", err)
	}
	cleared, err := clearCanvas(service, "owner", saved.ID)
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if cleared.Title != "保留的画布" || cleared.Background != "grid" || cleared.Viewport != (CanvasViewport{Zoom: 1.5, X: 240, Y: -80}) || len(cleared.Nodes) != 0 || len(cleared.Connections) != 0 {
		t.Fatalf("Clear() document = %#v", cleared)
	}
}

func TestCanvasDocumentServiceStoresAndValidatesGroups(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{
		{ID: "group-1", Type: "group", X: 10, Y: 20, Width: 760, Height: 480, ScaleX: 1, ScaleY: 1},
		{ID: "image-1", Type: "image", X: 34, Y: 44, Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, GroupID: " group-1 "},
	}})
	if err != nil {
		t.Fatalf("Save(group) error = %v", err)
	}
	if document.Nodes[1].GroupID != "group-1" {
		t.Fatalf("group id = %q", document.Nodes[1].GroupID)
	}

	for _, nodes := range [][]CanvasNode{
		{{ID: "image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, GroupID: "missing"}},
		{{ID: "group", Type: "group", Width: 760, Height: 480, ScaleX: 1, ScaleY: 1, GroupID: "group"}},
		{{ID: "text", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1}, {ID: "image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, GroupID: "text"}},
	} {
		if _, saveErr := saveCanvas(service, "owner", CanvasDocument{Nodes: nodes}); !errors.Is(saveErr, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(invalid group) error = %v, want ErrInvalidCanvasDocument", saveErr)
		}
	}
}

func TestCanvasDocumentServiceValidatesGroupAndDirectorConnections(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	base := []CanvasNode{
		{ID: "group", Type: "group", Width: 760, Height: 480, ScaleX: 1, ScaleY: 1},
		{ID: "director", Type: "director", Width: 360, Height: 320, ScaleX: 1, ScaleY: 1},
		{ID: "image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
		{ID: "panorama", Type: "panorama", Width: 340, Height: 170, ScaleX: 1, ScaleY: 1, PanoramaProjection: "equirectangular"},
		{ID: "text", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: base, Connections: []CanvasConnection{{ID: "image-director", FromNodeID: "image", ToNodeID: "director"}}}); err != nil {
		t.Fatalf("Save(image director connection) error = %v", err)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: base, Connections: []CanvasConnection{{ID: "panorama-director", FromNodeID: "panorama", ToNodeID: "director"}}}); err != nil {
		t.Fatalf("Save(panorama director connection) error = %v", err)
	}
	for _, connection := range []CanvasConnection{
		{ID: "group-image", FromNodeID: "group", ToNodeID: "image"},
		{ID: "text-director", FromNodeID: "text", ToNodeID: "director"},
	} {
		if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: base, Connections: []CanvasConnection{connection}}); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(invalid connection %#v) error = %v", connection, err)
		}
	}
}

func TestCanvasDocumentServiceStoresPanoramaGenerationMetadata(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "panorama-owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "panorama-1", Type: "panorama", Width: 340, Height: 170, ScaleX: 1, ScaleY: 1,
		GenerationModel: " gpt-image-1 ", GenerationSize: " 2:1 ", GenerationType: " EDIT ",
		GenerationReferenceURLs: []string{" https://cdn.example.com/reference.png "},
		GenerationStatus:        " SUCCESS ", GenerationStartedAt: 12345, GenerationProgress: 100,
		DurationMS: 3200, PanoramaSourcePrompt: " 环形大厅 ", PanoramaFinalPrompt: " 完整全景提示词 ",
		PanoramaProjection: " EQUIRECTANGULAR ",
	}}})
	if err != nil {
		t.Fatalf("Save(panorama) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationModel != "gpt-image-1" || node.GenerationSize != "2:1" || node.GenerationType != "edit" || len(node.GenerationReferenceURLs) != 1 || node.GenerationReferenceURLs[0] != "https://cdn.example.com/reference.png" || node.GenerationStatus != "success" || node.GenerationStartedAt != 12345 || node.GenerationProgress != 100 || node.DurationMS != 3200 || node.PanoramaSourcePrompt != "环形大厅" || node.PanoramaFinalPrompt != "完整全景提示词" || node.PanoramaProjection != "equirectangular" {
		t.Fatalf("panorama generation metadata = %#v", node)
	}
	reloaded, err := loadCanvas(service, "panorama-owner")
	if err != nil {
		t.Fatalf("Load(panorama) error = %v", err)
	}
	if reloaded.Nodes[0].PanoramaProjection != "equirectangular" || reloaded.Nodes[0].DurationMS != 3200 || reloaded.Nodes[0].GenerationProgress != 100 {
		t.Fatalf("panorama metadata was not persisted: %#v", reloaded.Nodes[0])
	}
}

func TestCanvasDocumentServiceStoresAndValidatesDirectorProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	project := json.RawMessage(`{"version":1,"objects":[{"id":"actor-1","type":"character"}],"timeline":{"duration":8}}`)
	document, err := saveCanvas(service, "director-owner", CanvasDocument{Nodes: []CanvasNode{{
		ID:              "director-1",
		Type:            "director",
		Width:           360,
		Height:          320,
		ScaleX:          1,
		ScaleY:          1,
		DirectorProject: project,
	}}})
	if err != nil {
		t.Fatalf("Save(director project) error = %v", err)
	}
	var wantProject, savedProject map[string]any
	if err := json.Unmarshal(project, &wantProject); err != nil {
		t.Fatalf("Unmarshal(want director project) error = %v", err)
	}
	if err := json.Unmarshal(document.Nodes[0].DirectorProject, &savedProject); err != nil {
		t.Fatalf("Unmarshal(saved director project) error = %v", err)
	}
	if !reflect.DeepEqual(savedProject, wantProject) {
		t.Fatalf("saved director project = %#v, want %#v", savedProject, wantProject)
	}
	reloaded, err := loadCanvas(service, "director-owner")
	if err != nil {
		t.Fatalf("Load(director project) error = %v", err)
	}
	var reloadedProject map[string]any
	if err := json.Unmarshal(reloaded.Nodes[0].DirectorProject, &reloadedProject); err != nil {
		t.Fatalf("Unmarshal(reloaded director project) error = %v", err)
	}
	if !reflect.DeepEqual(reloadedProject, wantProject) {
		t.Fatalf("reloaded director project = %#v, want %#v", reloadedProject, wantProject)
	}

	for name, raw := range map[string]json.RawMessage{
		"invalid JSON": json.RawMessage(`{"objects":`),
		"too large":    json.RawMessage(`{"data":"` + strings.Repeat("x", (512<<10)+1) + `"}`),
	} {
		t.Run(name, func(t *testing.T) {
			_, saveErr := saveCanvas(service, "invalid-director-"+name, CanvasDocument{Nodes: []CanvasNode{{
				ID:              "director-1",
				Type:            "director",
				Width:           360,
				Height:          320,
				ScaleX:          1,
				ScaleY:          1,
				DirectorProject: raw,
			}}})
			if !errors.Is(saveErr, ErrInvalidCanvasDocument) {
				t.Fatalf("Save(%s director project) error = %v, want ErrInvalidCanvasDocument", name, saveErr)
			}
		})
	}
}

func TestCanvasDocumentServiceClearsExplicitProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	first, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "first-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "first",
	}}})
	if err != nil {
		t.Fatalf("Save(first) error = %v", err)
	}
	secondWorkspace, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}
	second, err := saveCanvas(service, "owner", CanvasDocument{ID: secondWorkspace.Document.ID, Nodes: []CanvasNode{{
		ID: "second-node", Type: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1, Prompt: "second",
	}}})
	if err != nil {
		t.Fatalf("Save(second) error = %v", err)
	}

	cleared, err := clearCanvas(service, "owner", first.ID)
	if err != nil {
		t.Fatalf("Clear(first) error = %v", err)
	}
	if cleared.ID != first.ID || len(cleared.Nodes) != 0 {
		t.Fatalf("cleared document = %#v", cleared)
	}
	workspace, err := service.UpdateProject("owner", "activate", second.ID, "")
	if err != nil {
		t.Fatalf("Activate(second) error = %v", err)
	}
	if workspace.Document.ID != second.ID || len(workspace.Document.Nodes) != 1 || workspace.Document.Nodes[0].ID != "second-node" {
		t.Fatalf("second project changed while clearing first: %#v", workspace.Document)
	}
}

func TestCanvasDocumentServiceAllowsUnconfiguredVideoNode(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
	}}})
	if err != nil || len(document.Nodes) != 1 || document.Nodes[0].GenerationVideoModel != "" {
		t.Fatalf("Save(video without model) = %#v, error = %v", document.Nodes, err)
	}
}

func TestCanvasDocumentServiceAllowsUnconfiguredAudioAndTextNodes(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{
		{ID: "audio-1", Type: "audio", Width: 340, Height: 160, ScaleX: 1, ScaleY: 1},
		{ID: "text-config", Type: "config", GenerationMode: "text", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
		{ID: "video-config", Type: "config", GenerationMode: "video", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
	}})
	if err != nil || len(document.Nodes) != 3 {
		t.Fatalf("Save(unconfigured nodes) = %#v, error = %v", document.Nodes, err)
	}
}

func TestCanvasDocumentServiceStoresVideoGenerationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	audio := true
	watermark := false
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: " sora-2 ", GenerationVideoSize: " 1280X720 ",
		GenerationVideoSeconds: 8, GenerationVideoResolution: " 1080P ",
		GenerationVideoAudio: &audio, GenerationVideoWatermark: &watermark,
	}}})
	if err != nil {
		t.Fatalf("Save(video) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationVideoModel != "sora-2" || node.GenerationVideoSize != "1280x720" || node.GenerationVideoSeconds != 8 || node.GenerationVideoResolution != "1080p" || node.GenerationVideoAudio == nil || !*node.GenerationVideoAudio || node.GenerationVideoWatermark == nil || *node.GenerationVideoWatermark {
		t.Fatalf("video generation parameters = %#v", node)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(video) error = %v", err)
	}
	if loaded.Nodes[0].GenerationVideoModel != "sora-2" {
		t.Fatalf("video model changed after reload: %q", loaded.Nodes[0].GenerationVideoModel)
	}
}

func TestCanvasDocumentServiceStoresAudioGenerationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "audio-1", Type: "audio", Width: 420, Height: 160, ScaleX: 1, ScaleY: 1,
		GenerationAudioModel: " mimo-v2.5-tts-voicedesign ", GenerationAudioVoice: "alloy", GenerationAudioFormat: " MP3 ", GenerationAudioSpeed: 1.25,
		GenerationAudioInstructions: " calm ", GenerationAudioGrokVoice: " eve ", GenerationAudioGrokLanguage: "pt-BR", GenerationAudioGrokFormat: " WAV ", GenerationAudioGrokSpeed: 1.5,
		GenerationAudioGLMVoice: "chuichui", GenerationAudioGLMFormat: " PCM ", GenerationAudioGLMSpeed: 2,
		GenerationAudioMiMoVoice: "茉莉", GenerationAudioMiMoFormat: " MP3 ", GenerationAudioMiMoVoiceDesignPrompt: " young voice ", GenerationAudioMiMoVoiceCloneNodeID: " reference-audio ",
		GenerationAudioGeminiVoice: "Kore", AudioTaskID: " task-1 ", AudioTaskResultID: " result-1 ", MimeType: " AUDIO/MPEG ", DurationMS: 1500,
	}}})
	if err != nil {
		t.Fatalf("Save(audio) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationAudioModel != "mimo-v2.5-tts-voicedesign" || node.GenerationAudioFormat != "mp3" || node.GenerationAudioInstructions != "calm" || node.GenerationAudioGrokVoice != "eve" || node.GenerationAudioGrokFormat != "wav" || node.GenerationAudioGLMFormat != "pcm" || node.GenerationAudioMiMoFormat != "mp3" || node.GenerationAudioMiMoVoiceDesignPrompt != "young voice" || node.GenerationAudioMiMoVoiceCloneNodeID != "reference-audio" || node.GenerationAudioGeminiVoice != "Kore" || node.AudioTaskID != "task-1" || node.AudioTaskResultID != "result-1" || node.MimeType != "audio/mpeg" || node.DurationMS != 1500 {
		t.Fatalf("audio generation parameters = %#v", node)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load(audio) error = %v", err)
	}
	if loaded.Nodes[0].AudioTaskID != "task-1" || loaded.Nodes[0].GenerationAudioGrokLanguage != "pt-BR" {
		t.Fatalf("audio parameters were not persisted: %#v", loaded.Nodes[0])
	}
}

func TestCanvasDocumentServiceStoresTextConfigurationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "config-text", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationMode: " TEXT ", GenerationTextModel: " gpt-5-mini ",
	}}})
	if err != nil {
		t.Fatalf("Save(text config) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationMode != "text" || node.GenerationTextModel != "gpt-5-mini" {
		t.Fatalf("text configuration parameters = %#v", node)
	}
	if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "config-text", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationMode: "text",
	}}}); err != nil {
		t.Fatalf("Save(text config without model) error = %v", err)
	}
}

func TestCanvasDocumentServiceValidatesAudioProviderParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	base := CanvasNode{ID: "audio-1", Type: "audio", Width: 420, Height: 160, ScaleX: 1, ScaleY: 1, GenerationAudioModel: "gpt-4o-mini-tts"}
	invalid := []CanvasNode{
		func() CanvasNode { node := base; node.GenerationAudioVoice = "unknown"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioSpeed = math.NaN(); return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGrokLanguage = "xx"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGrokFormat = "flac"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGrokSpeed = 1.6; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGrokSpeed = math.Inf(1); return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGLMVoice = "unknown"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGLMFormat = "mp3"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGLMSpeed = 2.1; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGLMSpeed = math.Inf(-1); return node }(),
		func() CanvasNode { node := base; node.GenerationAudioMiMoVoice = "unknown"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioMiMoFormat = "flac"; return node }(),
		func() CanvasNode { node := base; node.GenerationAudioGeminiVoice = "Unknown"; return node }(),
	}
	for _, node := range invalid {
		if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{node}}); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(invalid audio node %#v) error = %v", node, err)
		}
	}
}

func TestCanvasDocumentServiceAllowsVideoWithoutIndependentResolution(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720",
		GenerationVideoSeconds: 4,
	}}})
	if err != nil {
		t.Fatalf("Save(Sora video without resolution) error = %v", err)
	}
}

func TestCanvasDocumentServiceAllowsHailuoVideoWithoutSize(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "MiniMax-Hailuo-2.3", GenerationVideoSeconds: 6,
	}}})
	if err != nil {
		t.Fatalf("Save(Hailuo video without size) error = %v", err)
	}
}

func TestCanvasDocumentServiceAllowsKlingV3ThreeSecondDuration(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "kling-v3", GenerationVideoSize: "16:9",
		GenerationVideoSeconds: 3, GenerationVideoResolution: "1080p",
	}}})
	if err != nil {
		t.Fatalf("Save(Kling V3 three-second video) error = %v", err)
	}
}

func TestCanvasDocumentServiceStoresCustomVideoDuration(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "future-video-model", GenerationVideoSize: "16:9",
		GenerationVideoSeconds: 7,
	}}})
	if err != nil || document.Nodes[0].GenerationVideoSeconds != 7 {
		t.Fatalf("Save(custom video duration) = %#v, error = %v", document.Nodes, err)
	}
}

func TestCanvasDocumentServiceStoresReferenceVideoSizes(t *testing.T) {
	for _, size := range []string{"3:2", "2:3", "800x600", "auto", "adaptive"} {
		t.Run(size, func(t *testing.T) {
			service := NewCanvasDocumentService(newTestStorageBackend(t))
			document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
				ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
				GenerationVideoModel: "future-video-model", GenerationVideoSize: size, GenerationVideoSeconds: 7,
			}}})
			if err != nil || document.Nodes[0].GenerationVideoSize != size {
				t.Fatalf("Save(video size %q) = %#v, error = %v", size, document.Nodes, err)
			}
		})
	}
}

func TestCanvasDocumentServiceStoresVideoNodeBindings(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720", GenerationVideoSeconds: 8, GenerationVideoResolution: "1080p",
		ExcludeUpstreamText: true, GenerationVideoFirstFrameNodeID: " first ", GenerationVideoLastFrameNodeID: " last ",
		GenerationVideoLastFrameURL: " /api/files/tail/content ",
	}}})
	if err != nil {
		t.Fatalf("Save(video bindings) error = %v", err)
	}
	node := document.Nodes[0]
	if !node.ExcludeUpstreamText || node.GenerationVideoFirstFrameNodeID != "first" || node.GenerationVideoLastFrameNodeID != "last" || node.GenerationVideoLastFrameURL != "/api/files/tail/content" {
		t.Fatalf("frame bindings = %#v", node)
	}
}

func TestCanvasDocumentServiceRejectsStructurallyInvalidVideoGenerationParameters(t *testing.T) {
	valid := CanvasNode{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "sora-2", GenerationVideoSize: "1280x720",
		GenerationVideoSeconds: 8, GenerationVideoResolution: "1080p",
	}
	tests := []struct {
		name   string
		mutate func(*CanvasNode)
	}{
		{name: "model too long", mutate: func(node *CanvasNode) { node.GenerationVideoModel = strings.Repeat("m", 257) }},
		{name: "size too long", mutate: func(node *CanvasNode) { node.GenerationVideoSize = strings.Repeat("s", 65) }},
		{name: "invalid duration", mutate: func(node *CanvasNode) { node.GenerationVideoSeconds = 0 }},
		{name: "resolution too long", mutate: func(node *CanvasNode) { node.GenerationVideoResolution = strings.Repeat("r", 65) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := valid
			test.mutate(&node)
			service := NewCanvasDocumentService(newTestStorageBackend(t))
			if _, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{node}}); !errors.Is(err, ErrInvalidCanvasDocument) {
				t.Fatalf("Save(invalid video) error = %v, want ErrInvalidCanvasDocument", err)
			}
		})
	}
}

func TestCanvasDocumentServiceDefersVideoModelParameterValidationToContract(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "video-1", Type: "video", Width: 420, Height: 236, ScaleX: 1, ScaleY: 1,
		GenerationVideoModel: "future-video-model", GenerationVideoSize: "800-600",
		GenerationVideoSeconds: 7, GenerationVideoResolution: "2160p",
	}}})
	if err != nil {
		t.Fatalf("Save(contract-defined video parameters) error = %v", err)
	}
	node := document.Nodes[0]
	if node.GenerationVideoSize != "800-600" || node.GenerationVideoResolution != "2160p" {
		t.Fatalf("contract-defined video parameters = %#v", node)
	}
}

func TestCanvasDocumentServiceStoresIndependentConnections(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{
		Nodes: []CanvasNode{
			{ID: "source-a", Type: "text", Width: 320, Height: 160, ScaleX: 1, ScaleY: 1, Prompt: "a"},
			{ID: "source-b", Type: "text", Width: 320, Height: 160, ScaleX: 1, ScaleY: 1, Prompt: "b"},
			{ID: "target", Type: "image", Width: 320, Height: 240, ScaleX: 1, ScaleY: 1},
		},
		Connections: []CanvasConnection{
			{ID: "connection-a", FromNodeID: "source-a", ToNodeID: "target"},
			{ID: "connection-b", FromNodeID: "source-b", ToNodeID: "target"},
		},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if len(document.Connections) != 2 {
		t.Fatalf("connections = %#v", document.Connections)
	}
}

func TestCanvasDocumentServiceRejectsConnectionsBetweenConfigurationNodes(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{
		Nodes: []CanvasNode{
			{ID: "config-a", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
			{ID: "config-b", Type: "config", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1},
		},
		Connections: []CanvasConnection{{ID: "config-config", FromNodeID: "config-a", ToNodeID: "config-b"}},
	})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(config connection) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceStoresNodeGenerationParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	compression := 82
	stream := true
	snapToMultiple16 := false
	expanded := true
	composerContent := "使用 @[node:image-reference] 的构图"
	document, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "image-parameters", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		ComposerContent: &composerContent,
		NaturalWidth:    2048, NaturalHeight: 1536, FreeResize: true,
		GenerationModel: " gemini-3.1-flash-image ",
		GenerationSize:  "2048x2048", GenerationResolution: "2k", GenerationQuality: "high",
		GenerationCount: 15, GenerationOutputFormat: "webp", GenerationOutputCompression: &compression,
		GenerationStream: &stream, GenerationPartialImages: 2, GenerationSnapToMultiple16: &snapToMultiple16, GenerationStatus: "error",
		GenerationError: "request failed", GenerationType: "edit", GenerationReferenceURLs: []string{"/images/reference.png"},
		BatchChildIDs: []string{"image-child"}, BatchPrimaryID: "image-child", BatchExpanded: &expanded,
	}, {
		ID: "image-child", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		BatchRootID: "image-parameters",
	}}})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	node := document.Nodes[0]
	if node.NaturalWidth != 2048 || node.NaturalHeight != 1536 || !node.FreeResize || node.ComposerContent == nil || *node.ComposerContent != composerContent || node.GenerationModel != "gemini-3.1-flash-image" || node.GenerationSize != "2048x2048" || node.GenerationCount != 15 || node.GenerationOutputCompression == nil || *node.GenerationOutputCompression != compression || node.GenerationStream == nil || !*node.GenerationStream || node.GenerationSnapToMultiple16 == nil || *node.GenerationSnapToMultiple16 || node.GenerationStatus != "error" || node.GenerationError != "request failed" || node.GenerationType != "edit" || len(node.GenerationReferenceURLs) != 1 || len(node.BatchChildIDs) != 1 || node.BatchPrimaryID != "image-child" || node.BatchExpanded == nil || !*node.BatchExpanded || document.Nodes[1].BatchRootID != node.ID {
		t.Fatalf("generation parameters = %#v", node)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Nodes[0].GenerationSnapToMultiple16 == nil || *loaded.Nodes[0].GenerationSnapToMultiple16 {
		t.Fatalf("snap-to-multiple setting was not persisted: %#v", loaded.Nodes[0].GenerationSnapToMultiple16)
	}
}

func TestCanvasDocumentServicePreservesGeminiReferenceImageLimit(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	referenceURLs := make([]string, canvasDocumentMaxGenerationReferenceImages)
	for index := range referenceURLs {
		referenceURLs[index] = "/images/reference.png"
	}
	document := CanvasDocument{Nodes: []CanvasNode{{
		ID: "gemini-edit", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationType: "edit", GenerationReferenceURLs: referenceURLs,
	}}}

	saved, err := saveCanvas(service, "owner", document)
	if err != nil {
		t.Fatalf("Save(14 references) error = %v", err)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(saved.Nodes[0].GenerationReferenceURLs) != canvasDocumentMaxGenerationReferenceImages || len(loaded.Nodes[0].GenerationReferenceURLs) != canvasDocumentMaxGenerationReferenceImages {
		t.Fatalf("reference URLs were not preserved: saved=%d loaded=%d", len(saved.Nodes[0].GenerationReferenceURLs), len(loaded.Nodes[0].GenerationReferenceURLs))
	}

	document.Nodes[0].GenerationReferenceURLs = append(referenceURLs, "/images/overflow.png")
	if _, err := saveCanvas(service, "owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(15 references) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceUsesReferenceImageGenerationType(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document := CanvasDocument{Nodes: []CanvasNode{{
		ID: "generated-image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationType: "generation",
	}}}

	saved, err := saveCanvas(service, "owner", document)
	if err != nil {
		t.Fatalf("Save(generation) error = %v", err)
	}
	if saved.Nodes[0].GenerationType != "generation" {
		t.Fatalf("generation type = %q, want generation", saved.Nodes[0].GenerationType)
	}

	for _, invalid := range []string{"generate", "generate-image"} {
		document.Nodes[0].GenerationType = invalid
		if _, err := saveCanvas(service, "owner", document); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("Save(%s) error = %v, want ErrInvalidCanvasDocument", invalid, err)
		}
	}
}

func TestCanvasDocumentServiceRejectsStoredRemovedGenerateType(t *testing.T) {
	backend := newTestStorageBackend(t)
	store := jsonDocumentStoreFromBackend(backend)
	document := DefaultCanvasDocument()
	document.Nodes = []CanvasNode{{
		ID: "legacy-generated-image", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		GenerationType: "generate",
	}}
	workspace := canvasWorkspace{
		Version:         canvasWorkspaceVersion,
		ActiveProjectID: document.ID,
		Projects:        []CanvasDocument{document},
	}
	if err := store.SaveJSONDocument(canvasWorkspaceName("legacy-owner"), workspace); err != nil {
		t.Fatalf("SaveJSONDocument() error = %v", err)
	}

	if _, err := loadCanvas(NewCanvasDocumentService(backend), "legacy-owner"); !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Load() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceRejectsBrokenBatchRelationships(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{Nodes: []CanvasNode{{
		ID: "batch-root", Type: "image", Width: 340, Height: 240, ScaleX: 1, ScaleY: 1,
		BatchChildIDs: []string{"missing-child"}, BatchPrimaryID: "missing-child",
	}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save(broken batch) error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentServiceManagesProjects(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	if len(initial.Projects) != 1 || initial.Document.ID == "" {
		t.Fatalf("initial workspace = %#v", initial)
	}

	created, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create project error = %v", err)
	}
	if len(created.Projects) != 2 || created.Document.Title != "第二张画布" {
		t.Fatalf("created workspace = %#v", created)
	}
	secondID := created.Document.ID

	renamed, err := service.UpdateProject("owner", "rename", secondID, "产品海报")
	if err != nil {
		t.Fatalf("Rename project error = %v", err)
	}
	if renamed.Document.Title != "产品海报" {
		t.Fatalf("renamed workspace = %#v", renamed)
	}

	deleted, err := service.UpdateProject("owner", "delete", secondID, "")
	if err != nil {
		t.Fatalf("Delete project error = %v", err)
	}
	if len(deleted.Projects) != 1 || deleted.Document.ID == secondID {
		t.Fatalf("deleted workspace = %#v", deleted)
	}
}

func TestCanvasDocumentServiceActivatesProjectWithoutRewritingWorkspace(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	service := NewCanvasDocumentService(backend)
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	created, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create project error = %v", err)
	}
	workspaceName := canvasWorkspaceName("owner")
	workspaceSaves := backend.saves[workspaceName]

	activated, err := service.UpdateProject("owner", "activate", initial.Document.ID, "")
	if err != nil {
		t.Fatalf("Activate project error = %v", err)
	}
	if activated.Document.ID != initial.Document.ID {
		t.Fatalf("activated document = %q, want %q", activated.Document.ID, initial.Document.ID)
	}
	if backend.saves[workspaceName] != workspaceSaves {
		t.Fatalf("workspace saves = %d, want %d", backend.saves[workspaceName], workspaceSaves)
	}
	if backend.saves[canvasActiveProjectName("owner")] != 1 {
		t.Fatalf("active project pointer saves = %d, want 1", backend.saves[canvasActiveProjectName("owner")])
	}

	reloaded := NewCanvasDocumentService(backend)
	workspace, err := reloaded.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(after reload) error = %v", err)
	}
	if workspace.Document.ID != initial.Document.ID || workspace.ActiveProjectID != initial.Document.ID {
		t.Fatalf("reloaded workspace = %#v", workspace)
	}
	if len(created.Projects) != len(workspace.Projects) {
		t.Fatalf("project count = %d, want %d", len(workspace.Projects), len(created.Projects))
	}
}

func TestCanvasProjectActivationFailuresPreserveActiveProjectAndHistory(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	svc := NewCanvasDocumentService(backend)
	initial, err := svc.Workspace("owner")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := svc.Import("owner", CanvasDocument{Title: "Target", AgentSessions: json.RawMessage(`[{"id":"selected","messages":[{"role":"assistant","text":"Retain complete history"}]}]`), ActiveAgentSessionID: "selected"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateProject("owner", "activate", initial.Document.ID, ""); err != nil {
		t.Fatal(err)
	}
	rootName, activeName := canvasWorkspaceName("owner"), canvasActiveProjectName("owner")
	before, err := backend.documents.LoadJSONDocument(rootName)
	if err != nil {
		t.Fatal(err)
	}
	rootSaves, activeSaves := backend.saves[rootName], backend.saves[activeName]
	for _, id := range []string{"", "missing", initial.Document.ID + "-foreign"} {
		if _, err := svc.ActivateProjectWorkspace("owner", id, true); !errors.Is(err, ErrInvalidCanvasDocument) {
			t.Fatalf("invalid target accepted: %q %v", id, err)
		}
	}
	if backend.saves[activeName] != activeSaves {
		t.Fatal("invalid activation wrote active project")
	}
	injected := errors.New("active project storage unavailable")
	backend.failSave = func(name string) error {
		if name == activeName {
			return injected
		}
		return nil
	}
	if _, err := svc.ActivateProjectWorkspace("owner", selected.Document.ID, true); !errors.Is(err, injected) {
		t.Fatal("active pointer failure hidden", err)
	}
	backend.failSave = nil
	loaded, err := svc.Workspace("owner")
	if err != nil || loaded.ActiveProjectID != initial.Document.ID {
		t.Fatal("failed activation changed active project", err)
	}
	data, _ := json.Marshal(before)
	var manifest canvasWorkspace
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	ref := manifest.AgentHistories[selected.Document.ID].Sessions[0].Block
	chunkName := canvasAgentHistoryChunkName("owner", selected.Document.ID, ref.Chunks[0])
	chunk, err := backend.documents.LoadJSONDocument(chunkName)
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.documents.DeleteJSONDocument(chunkName); err != nil {
		t.Fatal(err)
	}
	activeSaves = backend.saves[activeName]
	if _, err := svc.ActivateProjectWorkspace("owner", selected.Document.ID, true); err == nil {
		t.Fatal("missing target history accepted")
	}
	if backend.saves[activeName] != activeSaves {
		t.Fatal("unreadable target changed active project")
	}
	if err := backend.documents.SaveJSONDocument(chunkName, chunk); err != nil {
		t.Fatal(err)
	}
	after, err := backend.documents.LoadJSONDocument(rootName)
	if err != nil || !reflect.DeepEqual(before, after) || backend.saves[rootName] != rootSaves {
		t.Fatal("activation rewrote manifest", err)
	}
	loaded, err = svc.Workspace("owner")
	if err != nil || loaded.ActiveProjectID != initial.Document.ID {
		t.Fatal("missing history activation changed active project", err)
	}
	retained, err := svc.Project("owner", selected.Document.ID)
	if err != nil || !reflect.DeepEqual(retained.AgentSessions, selected.Document.AgentSessions) {
		t.Fatal("failed activation changed target history", err)
	}
}

func TestCanvasDocumentServiceIgnoresStaleActiveProjectPointer(t *testing.T) {
	backend := newCountingCanvasDocumentBackend(t)
	service := NewCanvasDocumentService(backend)
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	second, err := service.UpdateProject("owner", "create", "", "第二张画布")
	if err != nil {
		t.Fatalf("Create second project error = %v", err)
	}
	if _, err := service.UpdateProject("owner", "activate", initial.Document.ID, ""); err != nil {
		t.Fatalf("Activate first project error = %v", err)
	}
	third, err := service.UpdateProject("owner", "create", "", "第三张画布")
	if err != nil {
		t.Fatalf("Create third project error = %v", err)
	}
	if third.Document.Title != "第三张画布" || third.Document.ID == second.Document.ID {
		t.Fatalf("third workspace = %#v", third)
	}

	reloaded := NewCanvasDocumentService(backend)
	workspace, err := reloaded.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(after create) error = %v", err)
	}
	if workspace.Document.ID != third.Document.ID {
		t.Fatalf("stale pointer selected %q, want %q", workspace.Document.ID, third.Document.ID)
	}
}

func TestCanvasDocumentServiceDoesNotReviveActivePointerAfterWorkspaceReturnsToProject(t *testing.T) {
	backend := newTestStorageBackend(t)
	service := NewCanvasDocumentService(backend)
	first, err := service.Workspace("owner")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.UpdateProject("owner", "create", "", "Second project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateProject("owner", "activate", first.Document.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveAtRevision("owner", first.Document); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveAtRevision("owner", second.Document); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewCanvasDocumentService(backend).Workspace("owner")
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Document.ID != second.Document.ID {
		t.Fatalf("old activation pointer revived: got %q, want %q", reloaded.Document.ID, second.Document.ID)
	}
}

func TestCanvasDocumentServiceRejectsBatchCycles(t *testing.T) {
	for _, cycle := range []bool{false, true} {
		t.Run(map[bool]string{false: "nested batch", true: "cycle"}[cycle], func(t *testing.T) {
			service := NewCanvasDocumentService(newTestStorageBackend(t))
			workspace, err := service.Workspace("owner")
			if err != nil {
				t.Fatal(err)
			}
			document := workspace.Document
			document.Nodes = []CanvasNode{
				{ID: "a", Type: "image", Width: 512, Height: 512, BatchChildIDs: []string{"b"}},
				{ID: "b", Type: "image", Width: 512, Height: 512, BatchRootID: "a", BatchChildIDs: []string{"c"}},
				{ID: "c", Type: "image", Width: 512, Height: 512, BatchRootID: "b"},
			}
			if cycle {
				document.Nodes[0].BatchRootID = "c"
				document.Nodes[2].BatchChildIDs = []string{"a"}
			}
			_, err = service.SaveAtRevision("owner", document)
			if cycle {
				if !errors.Is(err, ErrInvalidCanvasDocument) {
					t.Fatalf("save cyclic batch error = %v", err)
				}
				persisted, loadErr := service.Workspace("owner")
				if loadErr != nil || len(persisted.Document.Nodes) != 0 {
					t.Fatalf("rejected cycle changed workspace: nodes=%d, error=%v", len(persisted.Document.Nodes), loadErr)
				}
			} else if err != nil {
				t.Fatalf("save nested batch: %v", err)
			}
		})
	}
}

func TestCanvasDocumentServiceImportsAsNewProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	imported, err := service.Import("owner", CanvasDocument{
		ID:       initial.Document.ID,
		Revision: 99,
		Title:    "导入画布",
		Nodes: []CanvasNode{{
			ID: "text-imported", Type: "text", Width: 340, Height: 220, ScaleX: 1, ScaleY: 1, Prompt: "导入内容",
		}},
	})
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if len(imported.Projects) != 2 || imported.Document.ID == initial.Document.ID || imported.Document.Revision != 0 || imported.Document.Title != "导入画布" || len(imported.Document.Nodes) != 1 {
		t.Fatalf("imported workspace = %#v", imported)
	}
}

func TestCanvasDocumentServiceRejectsImportWithoutChangingWorkspace(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	initial, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace() error = %v", err)
	}
	_, err = service.Import("owner", CanvasDocument{Title: "损坏画布", Nodes: []CanvasNode{{ID: "bad", Type: "image", Width: 0, Height: 100}}})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Import() error = %v, want ErrInvalidCanvasDocument", err)
	}
	after, err := service.Workspace("owner")
	if err != nil {
		t.Fatalf("Workspace(after import) error = %v", err)
	}
	if len(after.Projects) != 1 || after.Document.ID != initial.Document.ID {
		t.Fatalf("workspace changed after rejected import: %#v", after)
	}
}

func TestCanvasDocumentServicePersistsValidatedAgentMessages(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := saveCanvas(service, "owner", CanvasDocument{
		Title: "Agent canvas",
		AgentMessages: []CanvasAgentMessage{
			{ID: "message-1", Role: "user", Content: "创建产品主视觉", CreatedAt: "2026-01-01T00:00:00Z"},
			{ID: "message-2", Role: "assistant", Content: "已创建", CreatedAt: "2026-01-01T00:00:01Z"},
		},
	})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if len(document.AgentMessages) != 2 || document.AgentMessages[1].Content != "已创建" {
		t.Fatalf("agent messages = %#v", document.AgentMessages)
	}
	loaded, err := loadCanvas(service, "owner")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(loaded.AgentMessages) != 2 || loaded.AgentMessages[0].Role != "user" {
		t.Fatalf("loaded agent messages = %#v", loaded.AgentMessages)
	}
}

func TestCanvasDocumentServiceRejectsInvalidAgentMessages(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	_, err := saveCanvas(service, "owner", CanvasDocument{
		Title:         "Agent canvas",
		AgentMessages: []CanvasAgentMessage{{ID: "message-1", Role: "system", Content: "unsafe"}},
	})
	if !errors.Is(err, ErrInvalidCanvasDocument) {
		t.Fatalf("Save() error = %v, want ErrInvalidCanvasDocument", err)
	}
}

func TestCanvasDocumentWorkflowInputsPersistScalarParameters(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	document, err := loadCanvas(service, "workflow-owner")
	if err != nil {
		t.Fatal(err)
	}
	inputs := map[string]any{"seed": 42, "prompt": "镜头向前移动", "enabled": false}
	document.Nodes = []CanvasNode{{ID: "video", Type: "video", Title: "video", Width: 320, Height: 180, GenerationVideoModel: "autodl:test", GenerationVideoSeconds: 5, GenerationWorkflowInputs: inputs}}
	saved, err := service.SaveAtRevision("workflow-owner", document)
	if err != nil {
		t.Fatal(err)
	}
	inputs["prompt"] = "changed after save"
	if saved.Nodes[0].GenerationWorkflowInputs["prompt"] != "镜头向前移动" {
		t.Fatal("workflow inputs retained caller-owned map")
	}
	reloaded, err := service.Project("workflow-owner", saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reloaded.Nodes[0].GenerationWorkflowInputs, map[string]any{"seed": float64(42), "prompt": "镜头向前移动", "enabled": false}) {
		t.Fatalf("workflow inputs lost on reload: %#v", reloaded.Nodes[0].GenerationWorkflowInputs)
	}
}

func TestCanvasDocumentRejectsInvalidWorkflowInputs(t *testing.T) {
	tooMany := map[string]any{}
	for index := 0; index < 129; index++ {
		tooMany[strings.Repeat("x", index+1)] = true
	}
	oversized := map[string]any{}
	for index := 0; index < 9; index++ {
		oversized[strings.Repeat("x", index+1)] = strings.Repeat("x", 8192)
	}
	for name, inputs := range map[string]map[string]any{"array": {"value": []string{"x"}}, "object": {"value": map[string]any{"x": true}}, "null": {"value": nil}, "nan": {"value": math.NaN()}, "text": {"value": strings.Repeat("x", 8193)}, "name": {" ": true}, "field count": tooMany, "total size": oversized} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizeCanvasWorkflowInputs(inputs); !errors.Is(err, ErrInvalidCanvasDocument) {
				t.Fatalf("accepted invalid workflow inputs: %v", err)
			}
		})
	}
}

func TestCanvasDocumentServiceStoresScriptProject(t *testing.T) {
	service := NewCanvasDocumentService(newTestStorageBackend(t))
	raw := []byte(`{"id":"script-1","type":"script","width":300,"height":260,"scale_x":1,"scale_y":1,"script_project":{"step":1,"confirmed":true,"assets":[{"id":"hero","kind":"character","name":"小雨","description":"红色雨衣","image_node_id":""}],"shots":[{"id":"shot-1","seconds":5,"description":"雨中行走","framing":"全景","lighting":"冷色","dialogue":[{"id":"line-1","kind":"dialogue","asset_id":"hero","text":"快到了"}],"sound":"雨声","camera":"跟镜","asset_ids":["hero"],"image_prompt":"雨中行走","video_prompt":"五秒跟镜","color":"#ef6b68","source_node_id":"original-storyboard","image_node_id":"original-image","video_node_id":"original-video"}]},"script_operation":{"kind":"prompts","shot_ids":["shot-1"]}}`)
	var node CanvasNode
	if err := json.Unmarshal(raw, &node); err != nil {
		t.Fatal(err)
	}
	saved, err := saveCanvas(service, "script-owner", CanvasDocument{Nodes: []CanvasNode{node}})
	if err != nil {
		t.Fatalf("Save(script) error = %v", err)
	}
	reloaded, err := loadCanvas(service, "script-owner")
	if err != nil {
		t.Fatal(err)
	}
	var want, got map[string]any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(reloaded.Nodes[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got["script_project"], want["script_project"]) || !reflect.DeepEqual(got["script_operation"], want["script_operation"]) {
		t.Fatalf("script state lost after save: %s", encoded)
	}
	if len(saved.Nodes) != 1 {
		t.Fatal("script node lost")
	}

	for name, change := range map[string]func(map[string]any){
		"invalid step":       func(p map[string]any) { p["step"] = 3 },
		"negative duration":  func(p map[string]any) { p["shots"].([]any)[0].(map[string]any)["seconds"] = -1 },
		"duplicate shot":     func(p map[string]any) { p["shots"] = append(p["shots"].([]any), p["shots"].([]any)[0]) },
		"invalid asset kind": func(p map[string]any) { p["assets"].([]any)[0].(map[string]any)["kind"] = "unknown" },
		"missing asset":      func(p map[string]any) { p["shots"].([]any)[0].(map[string]any)["asset_ids"] = []any{"missing"} },
		"invalid color":      func(p map[string]any) { p["shots"].([]any)[0].(map[string]any)["color"] = "red;display:none" },
	} {
		t.Run(name, func(t *testing.T) {
			var value map[string]any
			if err := json.Unmarshal(raw, &value); err != nil {
				t.Fatal(err)
			}
			change(value["script_project"].(map[string]any))
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var invalid CanvasNode
			if err := json.Unmarshal(encoded, &invalid); err != nil {
				t.Fatal(err)
			}
			if _, err := saveCanvas(service, "invalid-script-"+name, CanvasDocument{Nodes: []CanvasNode{invalid}}); !errors.Is(err, ErrInvalidCanvasDocument) {
				t.Fatalf("invalid script accepted: %v", err)
			}
		})
	}
}
