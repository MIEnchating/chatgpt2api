package util

import (
	"mime"
	"strconv"
	"strings"
)

// AcceptsGzip reports whether the client's Accept-Encoding permits gzip.
func AcceptsGzip(header string) bool {
	wildcard := false
	for _, entry := range strings.Split(header, ",") {
		encoding, params, err := mime.ParseMediaType(strings.TrimSpace(entry))
		if err != nil {
			continue
		}
		quality := 1.0
		if raw, exists := params["q"]; exists {
			quality, err = strconv.ParseFloat(raw, 64)
			if err != nil || quality < 0 || quality > 1 {
				quality = 0
			}
		}
		if encoding == "gzip" {
			return quality > 0
		}
		if encoding == "*" {
			wildcard = quality > 0
		}
	}
	return wildcard
}
