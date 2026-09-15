package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatgpt2api/internal/model"
)

type autoDLWorkflowProviderStub struct {
	workflows func(context.Context, string) ([]model.AutoDLWorkflow, error)
	workflow  func(context.Context, string, string) (model.AutoDLWorkflow, error)
}

func (s autoDLWorkflowProviderStub) Workflows(ctx context.Context, baseURL string) ([]model.AutoDLWorkflow, error) {
	return s.workflows(ctx, baseURL)
}

func (s autoDLWorkflowProviderStub) Workflow(ctx context.Context, baseURL, id string) (model.AutoDLWorkflow, error) {
	return s.workflow(ctx, baseURL, id)
}

func TestAutoDLMetadataCacheExpiresAndDetachesResults(t *testing.T) {
	calls := 0
	client := autoDLWorkflowProviderStub{workflow: func(_ context.Context, baseURL, id string) (model.AutoDLWorkflow, error) {
		if baseURL != "https://autodl.example" || id != "video" {
			t.Fatalf("unexpected workflow request: %q %q", baseURL, id)
		}
		calls++
		return model.AutoDLWorkflow{UUID: "video", InputRules: map[string]model.AutoDLInputRule{"duration": {Type: "integer", Default: float64(5)}}}, nil
	}}
	svc := NewAutoDLService()
	now := time.Now()
	svc.now = func() time.Time { return now }
	items, err := svc.Workflows(context.Background(), client, "https://autodl.example", "video")
	if err != nil {
		t.Fatal(err)
	}
	items[0].InputRules["duration"] = model.AutoDLInputRule{Default: 999}
	items, err = svc.Workflows(context.Background(), client, "https://autodl.example", "video")
	if err != nil || calls != 1 || items[0].InputRules["duration"].Default != float64(5) {
		t.Fatalf("cached result = %#v %v calls=%d", items, err, calls)
	}
	now = now.Add(11 * time.Minute)
	_, err = svc.Workflows(context.Background(), client, "https://autodl.example", "video")
	if err != nil || calls != 2 {
		t.Fatalf("expiry err=%v calls=%d", err, calls)
	}
}

func TestAutoDLMetadataProviderFailuresAreNotCached(t *testing.T) {
	wantErr := errors.New("metadata unavailable")
	calls := 0
	client := autoDLWorkflowProviderStub{workflows: func(ctx context.Context, _ string) ([]model.AutoDLWorkflow, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("metadata requests must have a deadline")
		}
		calls++
		if calls == 1 {
			return nil, wantErr
		}
		return []model.AutoDLWorkflow{{UUID: "video", Kind: "video"}}, nil
	}}
	svc := NewAutoDLService()
	if _, err := svc.Workflows(context.Background(), client, "https://autodl.example", ""); !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
	for range 2 {
		items, err := svc.Workflows(context.Background(), client, "https://autodl.example", "")
		if err != nil || len(items) != 1 || items[0].UUID != "video" {
			t.Fatalf("metadata = %#v, error = %v", items, err)
		}
	}
	if calls != 2 {
		t.Fatalf("provider calls = %d, want 2", calls)
	}
}
