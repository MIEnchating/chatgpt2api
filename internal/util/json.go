package util

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	ImageModelAuto      = "auto"
	ImageModelGPT       = "gpt-image-2"
	ImageModelCodex     = "codex-gpt-image-2"
	ImageModelGemini    = "gemini-3.1-flash-image"
	ImageModelGrok      = "grok-imagine-image"
	ImageModelGPT5      = "gpt-5"
	ImageModelGPT51     = "gpt-5-1"
	ImageModelGPT52     = "gpt-5-2"
	ImageModelGPT53     = "gpt-5-3"
	ImageModelGPT53Mini = "gpt-5-3-mini"
	ImageModelGPT54     = "gpt-5.4"
	ImageModelGPT55     = "gpt-5.5"
	ImageModelGPTMini   = "gpt-5-mini"
)

var ImageModels = map[string]struct{}{
	ImageModelGPT:   {},
	ImageModelCodex: {},
}

var ModelIDs = []string{
	ImageModelGPT,
	ImageModelCodex,
	ImageModelAuto,
	ImageModelGPTMini,
	ImageModelGPT53Mini,
	ImageModelGPT5,
	ImageModelGPT51,
	ImageModelGPT52,
	ImageModelGPT53,
	ImageModelGPT54,
	ImageModelGPT55,
}

var ImageGenerationModelIDs = []string{
	ImageModelGPT,
	ImageModelCodex,
	ImageModelAuto,
}

var ImageGenerationModels = map[string]struct{}{}

func init() {
	for _, model := range ImageGenerationModelIDs {
		ImageGenerationModels[model] = struct{}{}
	}
}

var ResponsesImageToolModels = map[string]struct{}{
	ImageModelAuto:      {},
	ImageModelGPT:       {},
	ImageModelCodex:     {},
	ImageModelGPTMini:   {},
	ImageModelGPT53Mini: {},
	ImageModelGPT5:      {},
	ImageModelGPT51:     {},
	ImageModelGPT52:     {},
	ImageModelGPT53:     {},
	ImageModelGPT54:     {},
	ImageModelGPT55:     {},
}

func Clean(v any) string {
	return strings.TrimSpace(fmt.Sprint(ValueOr(v, "")))
}

func ValueOr(v any, fallback any) any {
	if v == nil {
		return fallback
	}
	return v
}

func StringMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func CopyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func AsStringSlice(v any) []string {
	switch x := v.(type) {
	case []string:
		return x
	case []any:
		out := make([]string, 0, len(x))
		for _, item := range x {
			if s := Clean(item); s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func AsMapSlice(v any) []map[string]any {
	switch x := v.(type) {
	case []map[string]any:
		return x
	case []any:
		out := make([]map[string]any, 0, len(x))
		for _, item := range x {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	default:
		return nil
	}
}

func ToInt(v any, fallback int) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case json.Number:
		n, err := x.Int64()
		if err == nil {
			return int(n)
		}
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err == nil {
			return n
		}
	}
	return fallback
}

// StrictInt returns an integer only when the input represents one exactly.
func StrictInt(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int8:
		return int(x), true
	case int16:
		return int(x), true
	case int32:
		return int(x), true
	case int64:
		return strictParsedInt(strconv.FormatInt(x, 10))
	case uint:
		return strictParsedInt(strconv.FormatUint(uint64(x), 10))
	case uint8:
		return int(x), true
	case uint16:
		return int(x), true
	case uint32:
		return strictParsedInt(strconv.FormatUint(uint64(x), 10))
	case uint64:
		return strictParsedInt(strconv.FormatUint(x, 10))
	case float32:
		return strictParsedInt(strconv.FormatFloat(float64(x), 'f', -1, 32))
	case float64:
		return strictParsedInt(strconv.FormatFloat(x, 'f', -1, 64))
	case json.Number:
		return strictParsedInt(x.String())
	case string:
		return strictParsedInt(strings.TrimSpace(x))
	default:
		return 0, false
	}
}

func strictParsedInt(value string) (int, bool) {
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return n, true
}

func ToBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		switch strings.ToLower(strings.TrimSpace(x)) {
		case "1", "true", "yes", "on":
			return true
		}
		return false
	default:
		return v != nil
	}
}

func DecodeJSON(r io.Reader, out any) error {
	dec := json.NewDecoder(r)
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("request body must contain a single JSON value")
		}
		return err
	}
	return nil
}

func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}

func ErrorPayload(message string) map[string]any {
	return map[string]any{"error": message}
}

func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]any{"detail": ErrorPayload(message)})
}

func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func NewHex(n int) string {
	if n <= 0 {
		n = 16
	}
	buf := make([]byte, (n+1)/2)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)[:n]
}

func SHA256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func SHA1Short(text string, n int) string {
	sum := sha1.Sum([]byte(text))
	hexed := hex.EncodeToString(sum[:])
	if n > 0 && n < len(hexed) {
		return hexed[:n]
	}
	return hexed
}

func RandomTokenURL(n int) string {
	if n <= 0 {
		n = 24
	}
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

func B64Decode(text string) ([]byte, error) {
	if idx := strings.Index(text, ","); strings.HasPrefix(text, "data:") && idx >= 0 {
		text = text[idx+1:]
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(text))
}

func NowLocal() string {
	return time.Now().Format("2006-01-02 15:04:05")
}

func NowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func AnonymizeToken(token any) string {
	value := Clean(token)
	if value == "" {
		return "token:empty"
	}
	return "token:" + SHA256Hex(value)[:10]
}

func ParseCommaList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			out = append(out, item)
		}
	}
	return out
}
