package protocol

import (
	"fmt"
	"slices"
	"strings"
)

// VideoMaterialUpload describes a provider upload performed before task creation.
// Credentials are resolved on the server and never serialized into a contract.
type VideoMaterialUpload struct {
	BaseURL      string `json:"base_url"`
	Path         string `json:"path"`
	Encoding     string `json:"encoding"`
	Field        string `json:"field"`
	URLField     string `json:"url_field"`
	Base64Format string `json:"base64_format"`
	MaxBytes     int64  `json:"max_bytes"`
}

func validateVideoMaterialUpload(transport VideoModelContractTransport) error {
	upload := transport.MaterialUpload
	if upload == nil {
		return nil
	}
	if transport.LocalMaterial != "url" || len(transport.MaterialTransports) > 1 {
		return fmt.Errorf("供应商预上传要求生成接口的素材提交方式为 url")
	}
	provider, err := NormalizeVideoContractProvider(&VideoContractProvider{BaseURL: upload.BaseURL})
	if err != nil || provider == nil || !strings.HasPrefix(upload.BaseURL, "https://") || provider.BaseURL != upload.BaseURL {
		return fmt.Errorf("素材上传地址必须为规范化的 HTTPS Base URL")
	}
	if !validVideoContractEndpointPath(upload.Path) {
		return fmt.Errorf("素材上传路径无效")
	}
	if !slices.Contains([]string{"multipart", "base64"}, upload.Encoding) {
		return fmt.Errorf("素材预上传编码仅支持 multipart 或 base64")
	}
	if !safeVideoParameterPath(upload.URLField) || !safeVideoParameterPath(upload.Field) || upload.Encoding == "multipart" && strings.ContainsAny(upload.Field, ".[") {
		return fmt.Errorf("素材上传字段或响应 URL 字段无效")
	}
	if upload.MaxBytes <= 0 || upload.MaxBytes > 100<<20 {
		return fmt.Errorf("素材上传大小限制须在 1 到 104857600 字节之间")
	}
	if upload.Encoding == "base64" && !slices.Contains([]string{"data_url", "raw"}, upload.Base64Format) || upload.Encoding == "multipart" && upload.Base64Format != "" {
		return fmt.Errorf("素材预上传的 Base64 格式无效")
	}
	return nil
}
