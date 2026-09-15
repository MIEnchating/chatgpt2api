package service

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"chatgpt2api/internal/storage"
)

func agentSkillTestInput() AgentSkillInput {
	return AgentSkillInput{Name: "视觉方案", Description: "保持产品细节", Content: "先确认产品参考，再设计画面。", Enabled: true}
}

func TestAgentSkillOwnerIsolationAndRevision(t *testing.T) {
	svc := NewAgentSkillService(newTestStorageBackend(t))
	input := agentSkillTestInput()
	created, err := svc.Save("alice", "", false, input)
	if err != nil || created.Scope != "personal" || created.Revision != 1 {
		t.Fatalf("create = %#v, %v", created, err)
	}
	if _, err := svc.Get("bob", created.ID, false); !errors.Is(err, ErrAgentSkillNotFound) {
		t.Fatalf("cross-owner read = %v", err)
	}
	input.Revision = created.Revision
	if _, err := svc.Save("bob", created.ID, false, input); !errors.Is(err, ErrAgentSkillNotFound) {
		t.Fatalf("cross-owner write = %v", err)
	}
	if err := svc.Delete("bob", created.ID, false, created.Revision); !errors.Is(err, ErrAgentSkillNotFound) {
		t.Fatalf("cross-owner delete = %v", err)
	}
	input.Content = "新的内容"
	updated, err := svc.Save("alice", created.ID, false, input)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("update = %#v, %v", updated, err)
	}
	if _, err := svc.Save("alice", created.ID, false, input); !errors.Is(err, ErrAgentSkillConflict) {
		t.Fatalf("stale update = %v", err)
	}
	if err := svc.Delete("alice", created.ID, false, 1); !errors.Is(err, ErrAgentSkillConflict) {
		t.Fatalf("stale delete = %v", err)
	}
	stored, err := svc.Get("alice", created.ID, false)
	if err != nil || stored.Content != updated.Content || stored.Revision != 2 {
		t.Fatalf("rejected mutations changed skill = %#v, %v", stored, err)
	}
	if _, err := svc.Save(" ", "", false, input); !errors.Is(err, ErrInvalidAgentSkill) {
		t.Fatalf("empty owner = %v", err)
	}
	if _, err := svc.Save("alice", created.ID, true, input); !errors.Is(err, ErrAgentSkillNotFound) {
		t.Fatalf("scope-crossing update = %v", err)
	}
}

func TestAgentSkillSystemVisibilityFilesAndDeletionStayEmpty(t *testing.T) {
	backend := newTestStorageBackend(t)
	svc := NewAgentSkillService(backend)
	items, err := svc.List("", true)
	if err != nil || len(items) == 0 {
		t.Fatalf("defaults = %#v, %v", items, err)
	}
	first := items[0]
	if content, err := svc.ReadFile("alice", first.ID, "references/storyboard.md"); err != nil || content == "" {
		t.Fatalf("system reference = %q, %v", content, err)
	}
	input := AgentSkillInput{Name: first.Name, Content: first.Content, Files: first.Files, Revision: first.Revision, Enabled: false}
	updated, err := svc.Save("", first.ID, true, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get("alice", first.ID, false); !errors.Is(err, ErrAgentSkillNotFound) {
		t.Fatalf("disabled system skill visible = %v", err)
	}
	if _, err := svc.ReadFile("alice", first.ID, "references/storyboard.md"); !errors.Is(err, ErrAgentSkillNotFound) {
		t.Fatalf("disabled system reference visible = %v", err)
	}
	if stored, err := svc.Get("", first.ID, true); err != nil || stored.Enabled || stored.Revision != updated.Revision {
		t.Fatalf("admin cannot manage disabled skill = %#v, %v", stored, err)
	}
	items, _ = svc.List("", true)
	for _, item := range items {
		if err := svc.Delete("", item.ID, true, item.Revision); err != nil {
			t.Fatal(err)
		}
	}
	for _, restarted := range []*AgentSkillService{svc, NewAgentSkillService(backend)} {
		items, err := restarted.List("", true)
		if err != nil || len(items) != 0 {
			t.Fatalf("deleted defaults resurrected = %#v, %v", items, err)
		}
	}
}

func TestAgentSkillInputPathsAndSizes(t *testing.T) {
	valid := agentSkillTestInput()
	valid.Files = map[string]string{"references/分镜.md": "示例", "notes.txt": "笔记"}
	if err := validateAgentSkillInput(valid, true); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"../escape.md", "/absolute.md", "a/../b.md", "a//b.md", "a\\b.md", "C:/secret.md", "https:/host/a.md", "a\x00.md", "a\n.md", "a\x7f.md", "file.png", "\xff.md", strings.Repeat("a", 238) + ".md"} {
		t.Run(filename, func(t *testing.T) {
			input := agentSkillTestInput()
			input.Files = map[string]string{filename: "text"}
			if err := validateAgentSkillInput(input, true); !errors.Is(err, ErrInvalidAgentSkill) {
				t.Fatalf("invalid path accepted: %q, error = %v", filename, err)
			}
		})
	}
	tests := map[string]func(*AgentSkillInput){
		"empty name":           func(i *AgentSkillInput) { i.Name = " " },
		"long name":            func(i *AgentSkillInput) { i.Name = strings.Repeat("字", 81) },
		"invalid name":         func(i *AgentSkillInput) { i.Name = "\xff" },
		"long description":     func(i *AgentSkillInput) { i.Description = strings.Repeat("字", 501) },
		"empty content":        func(i *AgentSkillInput) { i.Content = " " },
		"large content":        func(i *AgentSkillInput) { i.Content = strings.Repeat("x", 128*1024+1) },
		"invalid UTF8 content": func(i *AgentSkillInput) { i.Content = "\xff" },
		"large file":           func(i *AgentSkillInput) { i.Files = map[string]string{"large.md": strings.Repeat("x", 128*1024+1)} },
		"invalid UTF8 file":    func(i *AgentSkillInput) { i.Files = map[string]string{"invalid.md": "\xff"} },
		"total size": func(i *AgentSkillInput) {
			i.Content = strings.Repeat("x", 128*1024)
			i.Files = map[string]string{}
			for n := 0; n < 4; n++ {
				i.Files[fmt.Sprintf("%d.md", n)] = strings.Repeat("x", 128*1024)
			}
		},
		"file count": func(i *AgentSkillInput) {
			i.Files = map[string]string{}
			for n := 0; n < 31; n++ {
				i.Files[fmt.Sprintf("%d.md", n)] = "x"
			}
		},
	}
	for name, change := range tests {
		t.Run(name, func(t *testing.T) {
			input := agentSkillTestInput()
			change(&input)
			if err := validateAgentSkillInput(input, true); !errors.Is(err, ErrInvalidAgentSkill) {
				t.Fatalf("invalid input accepted: %v", err)
			}
		})
	}
	if err := validateAgentSkillInput(valid, false); !errors.Is(err, ErrInvalidAgentSkill) {
		t.Fatalf("personal skill accepted directory files: %v", err)
	}
}

func TestAgentSkillStorageErrorsAndCorruptionAreNotEmptySuccess(t *testing.T) {
	failure := errors.New("private database unavailable")
	input := agentSkillTestInput()
	for _, operation := range []string{"list", "get", "save", "delete", "file"} {
		t.Run(operation, func(t *testing.T) {
			svc := NewAgentSkillService(&serviceDocumentErrorBackend{loadErr: failure})
			var err error
			switch operation {
			case "list":
				_, err = svc.List("owner", false)
			case "get":
				_, err = svc.Get("owner", "id", false)
			case "save":
				_, err = svc.Save("owner", "", false, input)
			case "delete":
				err = svc.Delete("owner", "id", false, 1)
			case "file":
				_, err = svc.ReadFile("owner", "id", "notes.md")
			}
			if !errors.Is(err, failure) {
				t.Fatalf("storage failure swallowed: %v", err)
			}
		})
	}
	for _, raw := range []any{map[string]any{}, map[string]any{"items": nil}, map[string]any{"items": "invalid"}} {
		if items, err := NewAgentSkillService(&serviceDocumentErrorBackend{loadValue: raw}).List("", true); err == nil {
			t.Fatalf("corrupt document accepted as %#v", items)
		}
	}
	stored := AgentSkill{ID: "personal-existing", Scope: "personal", Name: input.Name, Content: input.Content, Revision: 1}
	backend := &serviceDocumentErrorBackend{loadValue: map[string]any{"items": []AgentSkill{stored}}, saveErr: failure}
	svc := NewAgentSkillService(backend)
	if _, err := svc.Save("owner", "", false, input); !errors.Is(err, failure) {
		t.Fatalf("write failure swallowed: %v", err)
	}
	if err := svc.Delete("owner", stored.ID, false, 1); !errors.Is(err, failure) {
		t.Fatalf("delete failure swallowed: %v", err)
	}
	if _, err := NewAgentSkillService(nil).List("owner", false); err == nil {
		t.Fatal("nil storage returned success")
	}
}

type agentSkillRetryBackend struct {
	storage.Backend
	storage.JSONDocumentBackend
	once func()
}

func (b *agentSkillRetryBackend) SaveJSONDocument(name string, value any) error {
	if b.once != nil {
		update := b.once
		b.once = nil
		update()
		return storage.ErrConcurrentRowUpdate
	}
	return b.JSONDocumentBackend.SaveJSONDocument(name, value)
}

func TestAgentSkillConflictReloadPreservesConcurrentChanges(t *testing.T) {
	backend := newTestStorageBackend(t)
	concurrent := NewAgentSkillService(backend)
	retry := &agentSkillRetryBackend{Backend: backend, JSONDocumentBackend: backend.(storage.JSONDocumentBackend)}
	retry.once = func() {
		if _, err := concurrent.Save("owner", "", false, agentSkillTestInput()); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewAgentSkillService(retry)
	if _, err := svc.Save("owner", "", false, agentSkillTestInput()); err != nil {
		t.Fatal(err)
	}
	items, err := svc.List("owner", false)
	personal := 0
	for _, item := range items {
		if item.Scope == "personal" {
			personal++
		}
	}
	if err != nil || personal != 2 {
		t.Fatalf("concurrent creation was lost: %#v, %v", items, err)
	}
	created, err := svc.Save("owner", "", false, agentSkillTestInput())
	if err != nil {
		t.Fatal(err)
	}
	input := agentSkillTestInput()
	input.Revision = created.Revision
	retry.once = func() {
		if _, err := concurrent.Save("owner", created.ID, false, input); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.Save("owner", created.ID, false, input); !errors.Is(err, ErrAgentSkillConflict) {
		t.Fatalf("stale item was overwritten after rebase: %v", err)
	}
}
