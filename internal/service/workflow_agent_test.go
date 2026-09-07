package service

import "testing"

func TestNormalizeWorkflowAgentDraftRejectsNull(t *testing.T) {
	for _, content := range []string{"null", " null \n"} {
		if draft, _, err := NormalizeWorkflowAgentDraft(content, "private"); err == nil || draft != nil {
			t.Fatalf("NormalizeWorkflowAgentDraft(%q) = %#v, %v", content, draft, err)
		}
	}
}
