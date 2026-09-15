package service

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"chatgpt2api/internal/model"
)

type AutoDLWorkflowProvider interface {
	Workflows(context.Context, string) ([]model.AutoDLWorkflow, error)
	Workflow(context.Context, string, string) (model.AutoDLWorkflow, error)
}

type autoDLMetadata struct {
	Data    []byte
	Expires time.Time
}
type AutoDLService struct {
	mu       sync.Mutex
	metadata map[string]autoDLMetadata
	now      func() time.Time
}

func NewAutoDLService() *AutoDLService {
	return &AutoDLService{metadata: make(map[string]autoDLMetadata), now: time.Now}
}

// The caller supplies a normalized endpoint. Only successful public metadata is cached.
// Decoding returns detached values.
func (s *AutoDLService) Workflows(ctx context.Context, client AutoDLWorkflowProvider, baseURL, id string) ([]model.AutoDLWorkflow, error) {
	key := baseURL + "\n" + id
	s.mu.Lock()
	entry, found := s.metadata[key]
	now := s.now()
	s.mu.Unlock()
	if found && now.Before(entry.Expires) {
		var result []model.AutoDLWorkflow
		if json.Unmarshal(entry.Data, &result) == nil {
			return result, nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var result []model.AutoDLWorkflow
	var err error
	if id == "" {
		result, err = client.Workflows(ctx, baseURL)
	} else {
		var item model.AutoDLWorkflow
		item, err = client.Workflow(ctx, baseURL, id)
		if err == nil {
			result = []model.AutoDLWorkflow{item}
		}
	}
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	for key, value := range s.metadata {
		if !now.Before(value.Expires) {
			delete(s.metadata, key)
		}
	}
	if len(s.metadata) >= 256 {
		var oldest string
		var expiry time.Time
		for candidate, value := range s.metadata {
			if oldest == "" || value.Expires.Before(expiry) {
				oldest = candidate
				expiry = value.Expires
			}
		}
		delete(s.metadata, oldest)
	}
	s.metadata[key] = autoDLMetadata{Data: data, Expires: now.Add(10 * time.Minute)}
	s.mu.Unlock()
	return result, nil
}
