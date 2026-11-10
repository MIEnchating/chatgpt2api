package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
)

// UploadTemporaryMedia forwards only the selected file, never session credentials.
func UploadTemporaryMedia(ctx context.Context, client *http.Client, filename string, source io.Reader, size int64) (string, error) {
	if size <= 0 || size > 100<<20 {
		return "", fmt.Errorf("临时上传文件必须在 1 字节到 100 MB 之间")
	}
	var envelope bytes.Buffer
	writer := multipart.NewWriter(&envelope)
	if _, err := writer.CreateFormFile("file", filename); err != nil {
		return "", err
	}
	prefix := append([]byte(nil), envelope.Bytes()...)
	envelope.Reset()
	if err := writer.Close(); err != nil {
		return "", err
	}
	suffix := envelope.Bytes()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://tmpfile.link/api/upload", io.MultiReader(bytes.NewReader(prefix), io.LimitReader(source, size), bytes.NewReader(suffix)))
	if err != nil {
		return "", err
	}
	request.ContentLength = int64(len(prefix)) + size + int64(len(suffix))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("临时上传服务不可达: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("临时上传失败（HTTP %d）", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return "", fmt.Errorf("临时上传响应无效")
	}
	var result struct {
		URL string `json:"downloadLinkEncoded"`
	}
	if json.Unmarshal(body, &result) != nil {
		return "", fmt.Errorf("临时上传响应无效")
	}
	result.URL = strings.TrimSpace(result.URL)
	parsed, err := url.Parse(result.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return "", fmt.Errorf("临时上传未返回有效 HTTPS 链接")
	}
	return result.URL, nil
}
