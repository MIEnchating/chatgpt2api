package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestWorkflowAgentRepairsUndefinedTemplateVariableBeforeReturningDraft(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	owner := *app.auth.Authenticate(token)
	if _, err := app.config.Update(map[string]any{"text_models": []string{"workflow-text"}}); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		call := calls.Add(1)
		template := "{{missing}}"
		if call > 1 {
			messages := util.AsMapSlice(payload["messages"])
			last := messages[len(messages)-1]
			if last["role"] != "tool" || !strings.Contains(util.Clean(last["content"]), "未定义") {
				t.Errorf("model did not receive the template feedback: %v", last)
			}
			template = "{{product_name}}"
		}
		args := map[string]any{"draft": map[string]any{
			"name": "商品海报", "variables": []map[string]any{{"key": "product_name"}},
			"config": map[string]any{"prompt_template": template},
		}}
		delta := map[string]any{"tool_calls": []map[string]any{{
			"index": 0, "id": fmt.Sprintf("draft-%d", call), "type": "function",
			"function": map[string]any{"name": "submit_workflow", "arguments": agentJSONValue(args)},
		}}}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", agentJSONValue(map[string]any{"choices": []map[string]any{{"delta": delta, "finish_reason": "tool_calls"}}}))
	}))
	defer upstream.Close()
	externalWorkflowTestClient(app, upstream)
	channel, err := app.customRelayConfigs.Create(identityScope(owner), "text", "workflow text", "http://workflow-model.example", "test-key", "openai", "")
	if err != nil {
		t.Fatal(err)
	}
	body := agentJSONValue(service.WorkflowAgentDraftRequest{Prompt: "创建商品海报工作流", Model: "workflow-text", ChannelID: channel.TokenName})
	request := httptest.NewRequest(http.MethodPost, "/api/workflows/agent-draft", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	setRequestAuthCookie(request, token)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || calls.Load() != 2 || !strings.Contains(response.Body.String(), "{{product_name}}") {
		t.Fatalf("workflow draft was not repaired: status=%d calls=%d response=%s", response.Code, calls.Load(), response.Body.String())
	}
}

func TestAgentExecutionRoutesEnforceDomainPermissionsAndHidePrivateState(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	owner, ownerToken := createPasswordUserSession(t, app, "execution-owner", "", "Owner")
	_, otherToken := createPasswordUserSession(t, app, "execution-other", "", "Other")
	for _, domain := range []string{"workflow", "video_contract", "studio"} {
		app.agentExecutions.Register(domain, func(context.Context, service.Identity, *service.AgentExecutionWorker) error {
			return errors.New("上游 400，进度已保存")
		})
		if _, err := app.agentExecutions.Start(*owner, domain, domain, map[string]any{"private": "PRIVATE_INPUT"}); err != nil {
			t.Fatal(err)
		}
	}
	request := func(method, token, id string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "/api/agent-runs?id="+id, nil)
		if token != "" {
			setRequestAuthCookie(r, token)
		}
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		return w
	}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		if response := request(method, "", "workflow"); response.Code != 401 {
			t.Fatalf("unauthenticated %s=%d", method, response.Code)
		}
		if response := request(method, otherToken, "workflow"); response.Code != 200 || !strings.Contains(response.Body.String(), `"run":null`) {
			t.Fatalf("owner isolation: %d %s", response.Code, response.Body.String())
		}
		if response := request(method, ownerToken, "video_contract"); response.Code != 403 {
			t.Fatalf("admin boundary %s=%d", method, response.Code)
		}
	}
	for _, tc := range []struct {
		token, id string
		status    int
	}{
		{"", "workflow", http.StatusUnauthorized},
		{otherToken, "workflow", http.StatusOK},
		{ownerToken, "video_contract", http.StatusForbidden},
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/agent-runs?id="+tc.id, nil)
		r.Header.Set("Accept", "text/event-stream")
		if tc.token != "" {
			setRequestAuthCookie(r, tc.token)
		}
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != tc.status || tc.status == http.StatusOK && !strings.Contains(w.Body.String(), `"run":null`) {
			t.Fatalf("event stream access: %d %s", w.Code, w.Body.String())
		}
	}
	response := request(http.MethodGet, ownerToken, "workflow")
	if response.Code != 200 {
		t.Fatalf("workflow permission rejected: %d %s", response.Code, response.Body.String())
	}
	if response := request(http.MethodGet, ownerToken, "studio"); response.Code != 200 {
		t.Fatalf("studio permission rejected: %d %s", response.Code, response.Body.String())
	}
	req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/agent", strings.NewReader(`{}`))
	setRequestAuthCookie(req, ownerToken)
	startResponse := httptest.NewRecorder()
	app.Handler().ServeHTTP(startResponse, req)
	if startResponse.Code != http.StatusBadRequest {
		t.Fatalf("studio start permission rejected: %d %s", startResponse.Code, startResponse.Body.String())
	}
	for _, private := range []string{"PRIVATE_INPUT", `"sdk"`, `"receipts"`, `"input"`} {
		if strings.Contains(response.Body.String(), private) {
			t.Fatalf("private state exposed: %s", response.Body.String())
		}
	}
}

func TestAgentExecutionStreamFollowsStartProgressAndResume(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	identity := *app.auth.Authenticate(token)
	progress, pause, finish := make(chan struct{}), make(chan struct{}), make(chan struct{})
	app.agentExecutions.Register("studio", func(ctx context.Context, _ service.Identity, worker *service.AgentExecutionWorker) error {
		select {
		case <-progress:
		case <-ctx.Done():
			return ctx.Err()
		}
		if err := worker.Event(map[string]any{"stage": "progress"}); err != nil {
			return err
		}
		select {
		case <-pause:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	open := func(query string) *http.Response {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/agent-runs?id=live"+query, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Accept", "text/event-stream")
		setRequestAuthCookie(request, token)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" {
			response.Body.Close()
			t.Fatalf("unexpected stream response: %v %v", response.StatusCode, response.Header)
		}
		return response
	}
	read := func(scanner *bufio.Scanner) *service.AgentExecution {
		t.Helper()
		for scanner.Scan() {
			frame, ok := strings.CutPrefix(scanner.Text(), "data: ")
			if !ok {
				continue
			}
			var event struct {
				Type string                  `json:"type"`
				Run  *service.AgentExecution `json:"run"`
			}
			if err := json.Unmarshal([]byte(frame), &event); err != nil || event.Type != "snapshot" || strings.Contains(frame, "PRIVATE_INPUT") {
				t.Fatalf("unexpected Agent event: %s (%v)", frame, err)
			}
			return event.Run
		}
		t.Fatalf("Agent stream ended early: %v", scanner.Err())
		return nil
	}
	first := open("&await_start=1&await_resume=1")
	defer first.Body.Close()
	firstScanner := bufio.NewScanner(first.Body)
	if run := read(firstScanner); run != nil {
		t.Fatalf("expected no run before submission: %+v", run)
	}
	if _, err := app.agentExecutions.Start(identity, "live", "studio", map[string]any{"private": "PRIVATE_INPUT"}); err != nil {
		t.Fatal(err)
	}
	if run := read(firstScanner); run == nil || run.Status != "running" {
		t.Fatalf("start update: %+v", run)
	}
	close(progress)
	if run := read(firstScanner); run == nil || len(run.Events) != 1 || run.Events[0]["stage"] != "progress" {
		t.Fatalf("progress update: %+v", run)
	}
	close(pause)
	if run := read(firstScanner); run == nil || run.Status != "waiting" {
		t.Fatalf("waiting update: %+v", run)
	}
	app.agentExecutions.Register("studio", func(ctx context.Context, _ service.Identity, _ *service.AgentExecutionWorker) error {
		select {
		case <-finish:
			return errors.New("saved interruption")
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if _, err := app.agentExecutions.Resume(identity, "live"); err != nil {
		t.Fatal(err)
	}
	if run := read(firstScanner); run == nil || run.Status != "running" {
		t.Fatalf("resume update: %+v", run)
	}
	first.Body.Close()
	reconnected := open("")
	defer reconnected.Body.Close()
	reconnectedScanner := bufio.NewScanner(reconnected.Body)
	if run := read(reconnectedScanner); run == nil || run.Status != "running" || len(run.Events) != 1 {
		t.Fatalf("reconnected snapshot: %+v", run)
	}
	close(finish)
	if run := read(reconnectedScanner); run == nil || run.Status != "error" || run.Error != "saved interruption" {
		t.Fatalf("terminal update: %+v", run)
	}
	reconnectedScanner.Scan() // The terminating SSE blank line.
	if reconnectedScanner.Scan() || reconnectedScanner.Err() != nil {
		t.Fatalf("stream remained open after terminal update: %v", reconnectedScanner.Err())
	}
}

func TestAgentExecutionStreamRevalidatesSessionBeforeProgress(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	identity := *app.auth.Authenticate(token)
	release := make(chan struct{})
	app.agentExecutions.Register("workflow", func(ctx context.Context, _ service.Identity, worker *service.AgentExecutionWorker) error {
		select {
		case <-release:
			return worker.Event(map[string]any{"message": "PRIVATE_PROGRESS"})
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if _, err := app.agentExecutions.Start(identity, "revoked", "workflow", nil); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/agent-runs?id=revoked", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "text/event-stream")
	setRequestAuthCookie(request, token)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"snapshot"`) {
		t.Fatalf("initial snapshot missing: %s", scanner.Text())
	}
	if _, err := app.auth.RevokeSessions(token); err != nil {
		t.Fatal(err)
	}
	close(release)
	for scanner.Scan() {
		if scanner.Text() == "" {
			continue
		}
		if !strings.Contains(scanner.Text(), `"status":401`) || strings.Contains(scanner.Text(), "PRIVATE_PROGRESS") {
			t.Fatalf("revoked stream disclosed progress: %s", scanner.Text())
		}
		return
	}
	t.Fatalf("missing revocation event: %v", scanner.Err())
}

func TestAgentExecutionObserverDisconnectKeepsBackgroundRun(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	token := adminSessionToken(t, app)
	identity := app.auth.Authenticate(token)
	entered, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	app.agentExecutions.Register("workflow", func(ctx context.Context, _ service.Identity, _ *service.AgentExecutionWorker) error {
		close(entered)
		select {
		case <-release:
			return errors.New("saved progress")
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if _, err := app.agentExecutions.Start(*identity, "detached", "workflow", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	<-entered
	observer, cancel := context.WithCancel(context.Background())
	_, err := service.WaitAgentExecution(observer, app.agentExecutions, *identity, "detached", func(service.AgentExecution) { cancel() })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("observer error=%v", err)
	}
	run, err := app.agentExecutions.Snapshot(*identity, "detached", "")
	if err != nil || run.Status != "running" {
		t.Fatalf("disconnect cancelled worker: %+v %v", run, err)
	}
	if err = app.agentExecutions.Stop(*identity, "detached"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		run, err = app.agentExecutions.Snapshot(*identity, "detached", "")
		if err == nil && run.Status == "cancelled" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("explicit stop did not cancel: %+v %v", run, err)
}
