package service

import (
	"strings"
	"testing"
)

func TestNormalizeWorkflowAgentDraftValidatesTemplateBindings(t *testing.T) {
	for _, tc := range []struct {
		template string
		missing  string
	}{
		{"{{ product_name }} / {{product_name}}", ""},
		{"{{product_name}} / {{missing}}", "missing"},
		{"{{ product name }}", "product name"},
	} {
		_, _, err := NormalizeWorkflowAgentDraft(`{"name":"商品图","variables":[{"key":"product_name"}],"config":{"prompt_template":`+agentJSON(tc.template)+`}}`, "private")
		if tc.missing == "" && err != nil || tc.missing != "" && (err == nil || !strings.Contains(err.Error(), tc.missing)) {
			t.Errorf("template %q validation error = %v, want missing %q", tc.template, err, tc.missing)
		}
	}
}

func TestNormalizeWorkflowAgentDraftRejectsNull(t *testing.T) {
	for _, content := range []string{"null", " null \n"} {
		if draft, _, err := NormalizeWorkflowAgentDraft(content, "private"); err == nil || draft != nil {
			t.Fatalf("NormalizeWorkflowAgentDraft(%q) = %#v, %v", content, draft, err)
		}
	}
}
