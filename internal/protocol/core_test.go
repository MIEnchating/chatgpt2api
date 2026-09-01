package protocol

import (
	"bytes"
	"testing"
)

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

func TestExtractChatPromptUsesLatestAlternateInputTextField(t *testing.T) {
	messages := []map[string]any{
		{"role": "user", "content": []map[string]any{{"type": "input_text", "input_text": "older"}}},
		{"role": "assistant", "content": "response"},
		{"role": "user", "content": []map[string]any{{"type": "input_text", "input_text": "latest"}}},
	}
	if got := ExtractChatPrompt(map[string]any{"messages": messages}); got != "latest" {
		t.Fatalf("ExtractChatPrompt() = %q, want %q", got, "latest")
	}
}

func TestExtractChatPromptKeepsTypedPartConcatenationForAlternateInputTextFields(t *testing.T) {
	messages := []map[string]any{{
		"role": "user",
		"content": []map[string]any{
			{"type": "input_text", "input_text": "first"},
			{"type": "input_text", "input_text": " second"},
		},
	}}
	if got := ExtractChatPrompt(map[string]any{"messages": messages}); got != "firstsecond" {
		t.Fatalf("ExtractChatPrompt() = %q, want %q", got, "firstsecond")
	}
}

func TestExtractImagesFromMessageContentRejectsMalformedDataURLs(t *testing.T) {
	content := []map[string]any{
		{"type": "input_image", "image_url": "data:image/png;base64,AQID"},
		{"type": "input_image", "image_url": "DATA:image/jpeg;base64,BAUG"},
		{"type": "input_image", "image_url": "image/png;base64,AQID"},
		{"type": "input_image", "image_url": "data:image/png;base64,"},
		{"type": "input_image", "image_url": "data:text/plain;base64,AQID"},
		{"type": "input_image", "image_url": "data:image/png,AQID"},
		{"type": "input_image", "image_url": "data:image/png;base64,***"},
	}
	images := ExtractImagesFromMessageContent(content)
	if len(images) != 2 || images[0].ContentType != "image/png" || !bytes.Equal(images[0].Data, []byte{1, 2, 3}) ||
		images[1].ContentType != "image/jpeg" || !bytes.Equal(images[1].Data, []byte{4, 5, 6}) {
		t.Fatalf("ExtractImagesFromMessageContent() = %#v", images)
	}
}
