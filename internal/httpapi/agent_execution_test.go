package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/service"
)

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
