package protocol

import (
	"bytes"
	"encoding/base64"
	"fmt"
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

func TestExtractChatContextImagesKeepsLatestValidImagesInOrder(t *testing.T) {
	for _, textContent := range []bool{false, true} {
		t.Run(fmt.Sprintf("text=%v", textContent), func(t *testing.T) {
			var messages []map[string]any
			for start := 0; start < 24; start += 6 {
				var parts []map[string]any
				var text string
				for index := start; index < start+6; index++ {
					value := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte{byte(index)})
					parts = append(parts, map[string]any{"type": "input_image", "image_url": value})
					text += "![image](" + value + ")\n"
				}
				parts = append(parts, map[string]any{"type": "input_image", "image_url": "data:image/png;base64,A"})
				text += "![invalid](data:image/png;base64,A)\n"
				var content any = parts
				if textContent {
					content = text
				}
				messages = append(messages, map[string]any{"role": "user", "content": content})
			}
			images := ExtractChatContextImages(map[string]any{"messages": messages})
			if len(images) != 14 {
				t.Fatalf("image count = %d, want 14", len(images))
			}
			for index, image := range images {
				if !bytes.Equal(image.Data, []byte{byte(index + 10)}) || image.ContentType != "image/png" {
					t.Errorf("image %d = %#v, want data %d", index, image, index+10)
				}
			}
		})
	}
}

func BenchmarkExtractChatContextImagesLongHistory(b *testing.B) {
	encoded := "data:image/png;base64," + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 64<<10))
	messages := make([]map[string]any, 100)
	for index := range messages {
		messages[index] = map[string]any{"role": "user", "content": []map[string]any{{"type": "input_image", "image_url": encoded}}}
	}
	payload := map[string]any{"messages": messages}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if images := ExtractChatContextImages(payload); len(images) != 14 {
			b.Fatalf("image count = %d, want 14", len(images))
		}
	}
}
