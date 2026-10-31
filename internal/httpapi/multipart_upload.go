package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func readMultipartImageBody(w http.ResponseWriter, r *http.Request) (map[string]any, []protocol.UploadedImage, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRelayImageEditRequestBytes)
	if err := r.ParseMultipartForm(maxRelayImageMultipartMemory); err != nil {
		return nil, nil, err
	}
	defer r.MultipartForm.RemoveAll()
	body := map[string]any{
		"client_task_id":           firstForm(r.MultipartForm, "client_task_id"),
		"api_mode":                 firstForm(r.MultipartForm, "api_mode"),
		"generation_source":        firstForm(r.MultipartForm, "generation_source"),
		"frontend_conversation_id": firstForm(r.MultipartForm, "frontend_conversation_id"),
		"prompt":                   firstForm(r.MultipartForm, "prompt"),
		"model":                    firstForm(r.MultipartForm, "model"),
		"n":                        firstForm(r.MultipartForm, "n"),
		"size":                     firstForm(r.MultipartForm, "size"),
		"requested_size":           firstForm(r.MultipartForm, "requested_size"),
		"image_resolution":         firstForm(r.MultipartForm, "image_resolution"),
		"quality":                  firstForm(r.MultipartForm, "quality"),
		"moderation":               firstForm(r.MultipartForm, "moderation"),
		"input_image_mask":         firstForm(r.MultipartForm, "input_image_mask"),
		"output_format":            firstForm(r.MultipartForm, "output_format"),
		"output_compression":       firstForm(r.MultipartForm, "output_compression"),
		"stream":                   firstForm(r.MultipartForm, "stream"),
		"partial_images":           firstForm(r.MultipartForm, "partial_images"),
		"share_prompt_parameters":  firstForm(r.MultipartForm, "share_prompt_parameters"),
		"share_reference_images":   firstForm(r.MultipartForm, "share_reference_images"),
		"visibility":               firstForm(r.MultipartForm, "visibility"),
		"token_group":              firstForm(r.MultipartForm, "token_group"),
		"token_name":               firstForm(r.MultipartForm, "token_name"),
		"api_key":                  firstForm(r.MultipartForm, "api_key"),
		"response_format":          firstForm(r.MultipartForm, "response_format"),
	}
	maskHeaders := r.MultipartForm.File["mask"]
	if len(maskHeaders) > 1 {
		return nil, nil, errTooManyRelayMasks
	}
	if len(maskHeaders) == 1 {
		if strings.TrimSpace(util.Clean(body["input_image_mask"])) != "" {
			return nil, nil, errors.New("provide either mask or input_image_mask, not both")
		}
		mask, err := readUpload(maskHeaders[0])
		if err != nil {
			return nil, nil, err
		}
		body["input_image_mask"] = uploadedImageDataURL(mask)
	}
	if rawFallback := strings.TrimSpace(firstForm(r.MultipartForm, "fallback_reference_image")); rawFallback != "" {
		var fallback any
		if err := json.Unmarshal([]byte(rawFallback), &fallback); err != nil {
			return nil, nil, fmt.Errorf("invalid fallback_reference_image")
		}
		body["fallback_reference_image"] = fallback
	}
	if rawContext := strings.TrimSpace(firstForm(r.MultipartForm, "workflow_context")); rawContext != "" {
		var workflowContext map[string]any
		if err := json.Unmarshal([]byte(rawContext), &workflowContext); err != nil {
			return nil, nil, fmt.Errorf("invalid workflow_context")
		}
		body["workflow_context"] = workflowContext
	}
	headers := multipartImageFileHeaders(r.MultipartForm)
	images := make([]protocol.UploadedImage, 0, len(headers))
	for _, header := range headers {
		image, err := readUpload(header)
		if err != nil {
			return nil, nil, err
		}
		if len(image.Data) == 0 {
			return nil, nil, fmt.Errorf("image file is empty")
		}
		images = append(images, image)
	}
	rawReferences := firstForm(r.MultipartForm, "image_references")
	if rawReferences != "" && r.URL.Path != "/api/creation-tasks/image-edits" {
		return nil, nil, fmt.Errorf("image_references is only supported by creation task image edits")
	}
	images, err := orderedImageReferences(rawReferences, images, body, r.Host)
	if err != nil {
		return nil, nil, err
	}
	return body, images, nil
}

func uploadedImageDataURL(image protocol.UploadedImage) string {
	if len(image.Data) == 0 {
		return ""
	}
	contentType := normalizeUploadedImageContentType(image.ContentType)
	if contentType == "" {
		contentType = "image/png"
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(image.Data)
}

func multipartImageFileHeaders(form *multipart.Form) []*multipart.FileHeader {
	if form == nil {
		return nil
	}
	headers := make([]*multipart.FileHeader, 0)
	for _, field := range []string{"image", "image[]"} {
		headers = append(headers, form.File[field]...)
	}
	return headers
}

func firstForm(form *multipart.Form, key string) string {
	if form == nil || len(form.Value[key]) == 0 {
		return ""
	}
	return form.Value[key][0]
}

func readUpload(header *multipart.FileHeader) (protocol.UploadedImage, error) {
	file, err := header.Open()
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	defer file.Close()
	data, err := readLimitedUploadData(file, maxRelayImageBytes)
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	contentType, err := uploadedImageContentType(data)
	if err != nil {
		return protocol.UploadedImage{}, err
	}
	filename := header.Filename
	if filename == "" {
		filename = "image.png"
	}
	return protocol.UploadedImage{Data: data, Filename: filename, ContentType: contentType}, nil
}

func readLimitedUploadData(reader io.Reader, maxBytes int64) ([]byte, error) {
	if reader == nil || maxBytes < 1 {
		return nil, errUnsupportedRelayImage
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errRelayImageTooLarge
	}
	return data, nil
}

func uploadedImageContentType(data []byte) (string, error) {
	if len(data) == 0 {
		return "", fmt.Errorf("image file is empty")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp", "image/gif")
	if err != nil {
		return "", errUnsupportedRelayImage
	}
	return info.ContentType, nil
}

func writeMultipartImageBodyError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) || errors.Is(err, errRelayImageTooLarge) {
		status = http.StatusRequestEntityTooLarge
	}
	util.WriteError(w, status, err.Error())
}

func normalizeUploadedImageContentType(contentType string) string {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return contentType
	default:
		return ""
	}
}
