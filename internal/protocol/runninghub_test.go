package protocol

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunningHubInspectWorkflowAndAppFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["apiKey"] != "secret-key" {
			t.Errorf("api key payload = %#v", payload["apiKey"])
		}
		switch r.URL.Path {
		case "/api/openapi/getJsonApiFormat":
			_, _ = w.Write([]byte(`{"code":0,"data":{"prompt":"{\"1\":{\"class_type\":\"CLIPTextEncode\",\"inputs\":{\"text\":\"hello\",\"clip\":[\"2\",0]}}}"}}`))
		case "/api/webapp/apiCallDemo":
			_, _ = w.Write([]byte(`{"code":0,"data":{"nodeInfoList":[{"nodeId":"1","fieldName":"prompt","fieldType":"STRING","required":true},{"nodeId":"2","fieldName":"image","fieldType":"IMAGE"}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := RunningHubClient{HTTP: server.Client()}
	workflow, err := client.InspectWorkflow(context.Background(), RunningHubInspectInput{BaseURL: server.URL, APIKey: "secret-key", Kind: "workflow", WorkflowID: "wf-1", Title: "", Capability: "image"})
	if err != nil {
		t.Fatal(err)
	}
	if workflow.Title != "wf-1" || len(workflow.Fields) != 1 || workflow.Fields[0].Role != "prompt" || workflow.WorkflowJSON["1"] == nil {
		t.Fatalf("workflow = %#v", workflow)
	}
	app, err := client.InspectWorkflow(context.Background(), RunningHubInspectInput{BaseURL: server.URL + "/openapi/v2", APIKey: "secret-key", Kind: "app", WorkflowID: "app-1", Title: "App", Capability: "video"})
	if err != nil {
		t.Fatal(err)
	}
	if len(app.Fields) != 2 || !app.Fields[0].Required || app.Fields[1].FieldType != "IMAGE" {
		t.Fatalf("app = %#v", app)
	}
}

func TestRunningHubInspectRejectsMalformedErrorAndOversizedResponses(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{name: "error code", body: `{"code":1001,"msg":"bad key"}`, want: "bad key"},
		{name: "malformed", body: "not-json", want: "不是有效 JSON"},
		{name: "oversized", body: strings.Repeat("x", 8<<20+1), want: "响应过大"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(tc.body)) }))
			client := RunningHubClient{HTTP: server.Client()}
			_, err := client.InspectWorkflow(context.Background(), RunningHubInspectInput{BaseURL: server.URL, APIKey: "secret-key", Kind: "workflow", WorkflowID: "wf-1", Title: "", Capability: "image"})
			server.Close()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestRunningHubBaseURLValidation(t *testing.T) {
	if got, err := RunningHubBaseURL("https://example.test/openapi/v2/"); err != nil || got != "https://example.test" {
		t.Fatalf("normalized base URL = %q, %v", got, err)
	}
	for _, value := range []string{"", "ftp://example.test", "https://user@example.test", "https://example.test?token=1"} {
		if value == "" {
			continue
		}
		if _, err := RunningHubBaseURL(value); err == nil {
			t.Fatalf("accepted invalid base URL %q", value)
		}
	}
}
