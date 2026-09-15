package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

// A manifest preserves the order of remote references and uploaded files.
func orderedImageReferences(raw string, uploads []protocol.UploadedImage, body map[string]any, requestHost string) ([]protocol.UploadedImage, error) {
	if raw == "" {
		return uploads, nil
	}
	if mode := util.Clean(body["api_mode"]); mode != "chat" && mode != "responses" {
		return nil, fmt.Errorf("image_references requires chat or responses mode")
	}
	if len(raw) > 128*1024 {
		return nil, fmt.Errorf("image_references is too large")
	}
	var refs []struct {
		URL         *string `json:"url"`
		UploadIndex *int    `json:"upload_index"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&refs); err != nil {
		return nil, fmt.Errorf("invalid image_references: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("image_references must contain one JSON array")
	}
	if len(refs) < 1 || len(refs) > 64 {
		return nil, fmt.Errorf("image_references must contain 1 to 64 references")
	}
	images := make([]protocol.UploadedImage, 0, len(refs))
	used := make(map[int]bool, len(uploads))
	for _, ref := range refs {
		if (ref.URL == nil) == (ref.UploadIndex == nil) {
			return nil, fmt.Errorf("each image reference requires exactly one url or upload_index")
		}
		if ref.UploadIndex != nil {
			index := *ref.UploadIndex
			if index < 0 || index >= len(uploads) || used[index] {
				return nil, fmt.Errorf("image reference upload_index is missing or repeated")
			}
			used[index] = true
			images = append(images, uploads[index])
			continue
		}
		value := strings.TrimSpace(*ref.URL)
		parsed, err := url.Parse(value)
		if err != nil || !isPublicReferenceURL(value) || strings.EqualFold(parsed.Host, requestHost) || strings.HasPrefix(parsed.Path, "/api/files/") {
			return nil, fmt.Errorf("image reference url must be a public external HTTP(S) image URL")
		}
		if hasRelayImageMask(body["input_image_mask"]) {
			return nil, fmt.Errorf("mask editing requires uploaded image references")
		}
		images = append(images, protocol.UploadedImage{URL: value})
	}
	if len(used) != len(uploads) {
		return nil, fmt.Errorf("image_references must include every uploaded image")
	}
	return images, nil
}
