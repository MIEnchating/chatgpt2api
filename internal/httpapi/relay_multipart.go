package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func relayMultipartRequest(ctx context.Context, baseURL, pathValue, apiKey string, payload map[string]any, images []protocol.UploadedImage) (*http.Request, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	var mask *protocol.UploadedImage
	if hasRelayImageMask(payload["input_image_mask"]) {
		parsed, _, err := relayImageMask(payload["input_image_mask"])
		if err != nil {
			return nil, err
		}
		mask = &parsed
	}
	for key, value := range payload {
		if key == "input_image_mask" {
			continue
		}
		if value == nil {
			continue
		}
		text := util.Clean(value)
		if text == "" {
			continue
		}
		if err := writer.WriteField(key, text); err != nil {
			return nil, err
		}
	}
	for _, image := range images {
		filename := strings.TrimSpace(image.Filename)
		if filename == "" {
			filename = "image.png"
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image"; filename="%s"`, escapeMultipartQuote(filename)))
		header.Set("Content-Type", relayUploadImageContentType(image))
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(image.Data); err != nil {
			return nil, err
		}
	}
	if mask != nil {
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", `form-data; name="mask"; filename="mask.png"`)
		header.Set("Content-Type", "image/png")
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(mask.Data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return protocol.NewRelayMultipartRequest(ctx, baseURL, pathValue, apiKey, writer.FormDataContentType(), &body)
}

func relayUploadImageContentType(image protocol.UploadedImage) string {
	contentType := normalizeRelayUploadImageContentType(image.ContentType)
	if contentType != "" {
		return contentType
	}
	if detected := normalizeRelayUploadImageContentType(http.DetectContentType(image.Data)); detected != "" {
		return detected
	}
	return "image/png"
}

func normalizeRelayUploadImageContentType(contentType string) string {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return contentType
	default:
		return ""
	}
}

func escapeMultipartQuote(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(value)
}
