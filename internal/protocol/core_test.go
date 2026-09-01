package protocol

import "testing"

func TestMessageTextAcceptsTypedContentParts(t *testing.T) {
	content := []map[string]any{
		{"type": "input_text", "text": "first"},
		{"type": "image_url", "image_url": map[string]any{"url": "https://example.test/image.png"}},
		{"type": "output_text", "text": " second"},
	}
	if got := MessageText(content); got != "firstsecond" {
		t.Fatalf("MessageText() = %q, want %q", got, "firstsecond")
	}
}

func TestTypedMessageContentFlowsThroughPromptNormalization(t *testing.T) {
	messages := []map[string]any{{
		"role": "user",
		"content": []map[string]any{
			{"type": "input_text", "text": "describe this"},
			{"type": "image_url", "image_url": map[string]any{"url": "https://example.test/image.png"}},
		},
	}}
	normalized := NormalizeMessages(messages, nil)
	if len(normalized) != 1 || normalized[0]["content"] != "describe this" {
		t.Fatalf("NormalizeMessages() = %#v", normalized)
	}
	if got := ExtractChatPrompt(map[string]any{"messages": messages}); got != "describe this" {
		t.Fatalf("ExtractChatPrompt() = %q, want %q", got, "describe this")
	}
}
