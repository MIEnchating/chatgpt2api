package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

// Upload only temporary files; public URLs already satisfy the generation API.
// The request is ephemeral and the durable task retains its original references.
func (a *App) uploadVideoContractMaterials(ctx context.Context, request map[string]any, contract protocol.VideoModelContract, kind, contractID string) error {
	upload := contract.Transport.MaterialUpload
	if upload == nil {
		return nil
	}
	seenFields := map[string]bool{}
	uploaded := map[string]string{}
	apiKey := ""
	for _, field := range videoContractMaterialFields(contract, kind) {
		if seenFields[field.name] {
			continue
		}
		seenFields[field.name] = true
		value := videoJSONPathValue(request, field.name)
		values := slices.Clone(util.AsStringSlice(value))
		if field.scalar && util.Clean(value) != "" {
			values = []string{util.Clean(value)}
		}
		for i, reference := range values {
			if cached := uploaded[reference]; cached != "" {
				values[i] = cached
				continue
			}
			file, local, err := a.localVideoReferenceFile(reference)
			if err != nil {
				return err
			}
			if !local {
				if !strings.HasPrefix(reference, "https://") || !isPublicReferenceURL(reference) {
					return fmt.Errorf("供应商参考素材必须使用公网 HTTPS 链接或平台暂存文件")
				}
				continue
			}
			if int64(len(file.Data)) > upload.MaxBytes {
				return fmt.Errorf("素材超过供应商上传大小限制 %d 字节", upload.MaxBytes)
			}
			if apiKey == "" {
				if a.videoContracts == nil || contractID == "" {
					return fmt.Errorf("视频任务缺少上传密钥所属的契约标识")
				}
				apiKey, err = a.videoContracts.MaterialUploadAPIKey(contractID, upload.BaseURL)
				if err != nil {
					return fmt.Errorf("读取视频契约上传密钥失败")
				}
				if apiKey == "" {
					return fmt.Errorf("请在此视频契约中配置当前上传地址的供应商密钥")
				}
			}
			result, err := a.uploadVideoMaterial(ctx, *upload, apiKey, file)
			if err != nil {
				return err
			}
			uploaded[reference], values[i] = result, result
		}
		if len(values) == 0 {
			continue
		}
		if field.scalar {
			videoSetObjectPath(request, field.name, values[0])
		} else {
			videoSetObjectPath(request, field.name, values)
		}
	}
	return nil
}

func (a *App) uploadVideoMaterial(ctx context.Context, upload protocol.VideoMaterialUpload, key string, file videoMultipartFile) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var req *http.Request
	var err error
	if upload.Encoding == "multipart" {
		req, err = relayVideoMultipartRequest(ctx, upload.BaseURL, key, upload.Path, nil, upload.Field, []videoMultipartFile{file})
	} else {
		encoded := base64.StdEncoding.EncodeToString(file.Data)
		if upload.Base64Format == "data_url" {
			encoded = "data:" + file.ContentType + ";base64," + encoded
		}
		body := map[string]any{}
		videoSetObjectPath(body, upload.Field, encoded)
		data, encodeErr := json.Marshal(body)
		if encodeErr != nil {
			return "", encodeErr
		}
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, upload.BaseURL+upload.Path, bytes.NewReader(data))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	if err != nil {
		return "", fmt.Errorf("构建供应商素材上传请求失败")
	}
	// Do not follow redirects or retry uploads with provider credentials.
	client := *a.relayHTTPClientForContext(ctx)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("供应商素材上传请求失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("供应商素材上传失败（HTTP %d）", resp.StatusCode)
	}
	result, err := relayDecodeJSONResponseWithLimits(resp, 1<<20, 1<<16)
	if err != nil {
		return "", fmt.Errorf("供应商素材上传响应无效")
	}
	url := util.Clean(videoJSONPathValue(result, upload.URLField))
	if !strings.HasPrefix(url, "https://") || !isPublicReferenceURL(url) {
		return "", fmt.Errorf("供应商素材上传未返回有效的公网 HTTPS URL")
	}
	return url, nil
}
