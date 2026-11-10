package service

import (
	"encoding/json"
	"testing"
)

func TestCanvasAgentMessageQueueSurvivesConcurrentBrowserAndWorkerSaves(t *testing.T) {
	svc, identity, doc, _ := agentFixture(t, nil, nil)
	doc.AgentRun = &CanvasAgentRun{ID: "run", SessionID: "session", AssistantID: "a", Status: "running"}
	var err error
	doc, err = svc.canvas.saveAgent(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	base := cloneCanvasAgentDocument(doc)
	sessions, session, _ := agentSession(doc, "session")
	session["messageQueue"] = map[string]any{"paused": false, "messages": []map[string]any{{"id": "q1", "text": "先调整脚本", "createdAt": "now", "references": []any{}}}}
	session["messages"] = []map[string]any{{"id": "forged", "role": "assistant", "text": "forged browser progress"}}
	doc.AgentSessions, _ = json.Marshal(sessions)
	saved, err := svc.canvas.SaveAtRevision(identity.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	_, current, _ := agentSession(saved, "session")
	if len(current["messageQueue"].(map[string]any)["messages"].([]any)) != 1 {
		t.Fatal("browser queue was discarded during execution")
	}
	if len(current["messages"].([]any)) != 2 {
		t.Fatal("browser replaced worker progress")
	}
	edited := cloneCanvasAgentDocument(base)
	workerSessions, worker, _ := agentSession(edited, "session")
	worker["messages"] = []map[string]any{{"id": "a", "role": "assistant", "text": "worker result"}}
	edited.AgentSessions, _ = json.Marshal(workerSessions)
	edited.AgentRun.Status = "success"
	finished, err := svc.canvas.saveAgentChanges(identity.ID, base, edited)
	if err != nil {
		t.Fatal(err)
	}
	_, after, _ := agentSession(finished, "session")
	if after["messageQueue"] == nil {
		t.Fatal("worker completion erased queued messages")
	}
	if after["messages"].([]any)[0].(map[string]any)["text"] != "worker result" {
		t.Fatal("worker progress was discarded")
	}
	reloaded, err := svc.canvas.Project(identity.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, persisted, _ := agentSession(reloaded, "session")
	if persisted["messageQueue"] == nil {
		t.Fatal("queue was not persisted")
	}
}

func TestCanvasAgentMessageQueueValidation(t *testing.T) {
	valid := json.RawMessage(`[{"id":"session","messageQueue":{"paused":true,"messages":[{"id":"q","text":"new direction","createdAt":"now","references":[]}]}}]`)
	if err := validateCanvasAgentJSON(valid, true); err != nil {
		t.Fatal(err)
	}
	for _, queue := range []string{
		`{"paused":false,"messages":[{"id":"q","text":" ","createdAt":"now","references":[]}]}`,
		`{"paused":false,"messages":[],"steeringId":"missing"}`,
		`{"paused":"false","messages":[]}`,
		`{"paused":false,"messages":[{"id":"q","text":"a","createdAt":"now","references":[]},{"id":"q","text":"b","createdAt":"now","references":[]}]}`,
	} {
		if validateCanvasAgentJSON(json.RawMessage(`[{"id":"session","messageQueue":`+queue+`}]`), true) == nil {
			t.Fatalf("accepted malformed queue: %s", queue)
		}
	}
}
