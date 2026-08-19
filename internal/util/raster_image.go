package util

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"strings"

	_ "github.com/HugoSmits86/nativewebp"
)

const (
	MaxRasterImageEncodedBytes = 40 << 20
	MaxRasterImageDimension    = 32_768
	MaxRasterImagePixels       = 64 * 1024 * 1024
)

var (
	ErrUnsupportedRasterImage  = errors.New("unsupported raster image format")
	ErrRasterImageTypeMismatch = errors.New("image type does not match file content")
	ErrRasterImageTooLarge     = errors.New("image dimensions are too large")
)

type RasterImageInfo struct {
	ContentType string
	Format      string
	Width       int
	Height      int
}

// InspectRasterImage validates the encoded type and dimensions before a caller
// performs a full decode. When allowedContentTypes is empty, all registered
// raster formats supported by this application are accepted.
func InspectRasterImage(data []byte, allowedContentTypes ...string) (RasterImageInfo, error) {
	if len(data) == 0 {
		return RasterImageInfo{}, ErrUnsupportedRasterImage
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return RasterImageInfo{}, fmt.Errorf("%w: %v", ErrUnsupportedRasterImage, err)
	}
	contentType, normalizedFormat := rasterImageFormat(format)
	if contentType == "" {
		return RasterImageInfo{}, ErrUnsupportedRasterImage
	}
	detectedType := normalizeRasterContentType(http.DetectContentType(data))
	if detectedType == "" || detectedType != contentType {
		return RasterImageInfo{}, ErrRasterImageTypeMismatch
	}
	if err := ValidateRasterImageDimensions(config.Width, config.Height); err != nil {
		return RasterImageInfo{}, err
	}
	if len(allowedContentTypes) > 0 && !containsRasterContentType(allowedContentTypes, contentType) {
		return RasterImageInfo{}, ErrUnsupportedRasterImage
	}
	return RasterImageInfo{
		ContentType: contentType,
		Format:      normalizedFormat,
		Width:       config.Width,
		Height:      config.Height,
	}, nil
}

func ValidateRasterImageDimensions(width, height int) error {
	if width < 1 || height < 1 {
		return ErrUnsupportedRasterImage
	}
	if width > MaxRasterImageDimension || height > MaxRasterImageDimension || int64(width)*int64(height) > MaxRasterImagePixels {
		return ErrRasterImageTooLarge
	}
	return nil
}

func rasterImageFormat(value string) (string, string) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "png":
		return "image/png", "png"
	case "jpeg", "jpg":
		return "image/jpeg", "jpeg"
	case "webp":
		return "image/webp", "webp"
	case "gif":
		return "image/gif", "gif"
	default:
		return "", ""
	}
}

func normalizeRasterContentType(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	switch value {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return value
	default:
		return ""
	}
}

func containsRasterContentType(values []string, target string) bool {
	for _, value := range values {
		if normalizeRasterContentType(value) == target {
			return true
		}
	}
	return false
}
