package protocol

import (
	"context"
	"encoding/base64"
	"regexp"
	"strings"
	"sync"

	"chatgpt2api/internal/util"
)

type StreamResult struct {
	Items <-chan map[string]any
	Err   <-chan error
	Kind  string
}

const ImageOutputSlotAcquirerPayloadKey = "image_output_slot_acquirer"

var inlineImageDataURLRE = regexp.MustCompile(`data:(image/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)`)

type accountUsageContextKey struct{}

type AccountUsageTracker struct {
	mu     sync.Mutex
	tokens []string
	seen   map[string]struct{}
}

func WithAccountUsageTracker(ctx context.Context) (context.Context, *AccountUsageTracker) {
	tracker := &AccountUsageTracker{seen: map[string]struct{}{}}
	return context.WithValue(ctx, accountUsageContextKey{}, tracker), tracker
}

func AccountUsageFromContext(ctx context.Context) []map[string]any {
	tracker, _ := ctx.Value(accountUsageContextKey{}).(*AccountUsageTracker)
	if tracker == nil {
		return nil
	}
	return tracker.Accounts()
}

func RecordAccountUsage(ctx context.Context, token string) {
	tracker, _ := ctx.Value(accountUsageContextKey{}).(*AccountUsageTracker)
	if tracker != nil {
		tracker.Record(token)
	}
}

func (t *AccountUsageTracker) Record(token string) {
	token = strings.TrimSpace(token)
	if t == nil || token == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen == nil {
		t.seen = map[string]struct{}{}
	}
	if _, ok := t.seen[token]; ok {
		return
	}
	t.seen[token] = struct{}{}
	t.tokens = append(t.tokens, token)
}

func (t *AccountUsageTracker) Accounts() []map[string]any {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]map[string]any, 0, len(t.tokens))
	for _, token := range t.tokens {
		out = append(out, map[string]any{
			"account_id":    util.SHA1Short(token, 16),
			"token_preview": util.AnonymizeToken(token),
		})
	}
	return out
}

type HTTPError struct {
	Status  int
	Message string
}

func (e HTTPError) Error() string { return e.Message }

type ImageOutputProgressCallback func([]map[string]any)
type ImageOutputSlotAcquirer func(context.Context, int) (func(), error)

type ImageGenerationError struct {
	Message    string
	StatusCode int
	Type       string
	Code       string
	Param      any
}

func (e *ImageGenerationError) Error() string { return e.Message }

func (e *ImageGenerationError) OpenAIError() map[string]any {
	return map[string]any{"error": map[string]any{"message": e.Message, "type": e.Type, "param": e.Param, "code": e.Code}}
}

type UploadedImage struct {
	Data        []byte
	Filename    string
	ContentType string
}

func ExtractChatPrompt(body map[string]any) string {
	if prompt := strings.TrimSpace(util.Clean(body["prompt"])); prompt != "" {
		return prompt
	}
	messages := NormalizeMessages(util.AsMapSlice(body["messages"]), nil)
	if prompt := LatestUserPrompt(messages); prompt != "" {
		return prompt
	}
	for _, message := range util.AsMapSlice(body["messages"]) {
		if strings.ToLower(util.Clean(message["role"])) != "user" {
			continue
		}
		if prompt := ExtractPromptFromMessageContent(message["content"]); prompt != "" {
			return prompt
		}
	}
	return ""
}

func ExtractChatContextImages(body map[string]any) []UploadedImage {
	const maxContextImages = 14
	var images []UploadedImage
	for _, message := range util.AsMapSlice(body["messages"]) {
		images = append(images, ExtractImagesFromMessageContent(message["content"])...)
	}
	if len(images) > maxContextImages {
		images = images[len(images)-maxContextImages:]
	}
	return images
}

func ExtractPromptFromMessageContent(content any) string {
	if text, ok := content.(string); ok {
		return strings.TrimSpace(text)
	}
	var parts []string
	for _, raw := range anyList(content) {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch util.Clean(item["type"]) {
		case "text":
			if text := strings.TrimSpace(util.Clean(item["text"])); text != "" {
				parts = append(parts, text)
			}
		case "input_text":
			if text := strings.TrimSpace(firstNonEmpty(util.Clean(item["text"]), util.Clean(item["input_text"]))); text != "" {
				parts = append(parts, text)
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func ExtractImagesFromMessageContent(content any) []UploadedImage {
	if text, ok := content.(string); ok {
		return extractImagesFromText(text)
	}
	var images []UploadedImage
	for _, raw := range anyList(content) {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		itemType := util.Clean(item["type"])
		imageURL := ""
		if itemType == "image_url" {
			if obj, ok := item["image_url"].(map[string]any); ok {
				imageURL = util.Clean(obj["url"])
			} else {
				imageURL = util.Clean(item["image_url"])
			}
		}
		if itemType == "input_image" {
			imageURL = util.Clean(item["image_url"])
		}
		if strings.HasPrefix(imageURL, "data:") {
			header, data, _ := strings.Cut(imageURL, ",")
			mime := strings.TrimPrefix(strings.Split(header, ";")[0], "data:")
			bytes, err := base64.StdEncoding.DecodeString(data)
			if err == nil {
				images = append(images, UploadedImage{Data: bytes, Filename: "image.png", ContentType: firstNonEmpty(mime, "image/png")})
			}
		}
	}
	return images
}

func extractImagesFromText(text string) []UploadedImage {
	var images []UploadedImage
	for _, match := range inlineImageDataURLRE.FindAllStringSubmatch(text, -1) {
		if len(match) < 3 {
			continue
		}
		bytes, err := base64.StdEncoding.DecodeString(match[2])
		if err == nil {
			images = append(images, UploadedImage{Data: bytes, Filename: "image.png", ContentType: firstNonEmpty(match[1], "image/png")})
		}
	}
	return images
}

func MessageText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var parts []string
		for _, raw := range value {
			switch item := raw.(type) {
			case string:
				parts = append(parts, item)
			case map[string]any:
				typeName := util.Clean(item["type"])
				if typeName == "text" || typeName == "input_text" || typeName == "output_text" {
					parts = append(parts, util.Clean(item["text"]))
				}
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

func NormalizeMessages(messages any, system any) []map[string]any {
	var normalized []map[string]any
	if text := MessageText(system); text != "" {
		normalized = append(normalized, map[string]any{"role": "system", "content": text})
	}
	for _, raw := range anyList(messages) {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		normalized = append(normalized, map[string]any{
			"role":    firstNonEmpty(util.Clean(message["role"]), "user"),
			"content": MessageText(message["content"]),
		})
	}
	return normalized
}

func LatestUserPrompt(messages []map[string]any) string {
	for index := len(messages) - 1; index >= 0; index-- {
		if strings.ToLower(util.Clean(messages[index]["role"])) != "user" {
			continue
		}
		if text := strings.TrimSpace(util.Clean(messages[index]["content"])); text != "" {
			return text
		}
	}
	return ""
}

func anyList(value any) []any {
	switch list := value.(type) {
	case []any:
		return list
	case []map[string]any:
		out := make([]any, 0, len(list))
		for _, item := range list {
			out = append(out, item)
		}
		return out
	default:
		return nil
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
