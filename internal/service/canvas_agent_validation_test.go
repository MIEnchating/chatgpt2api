package service

import (
	"strings"
	"testing"
)

func TestValidateAgentValueCountsTitleCharactersNotBytes(t *testing.T) {
	schema := map[string]any{"type": "string"}
	if err := validateAgentValue(strings.Repeat("画", 100), schema, "create_text_node.title"); err != nil {
		t.Fatalf("100-character title rejected: %v", err)
	}
	if err := validateAgentValue(strings.Repeat("画", 201), schema, "create_text_node.title"); err == nil {
		t.Fatal("201-character title accepted")
	}
}
