package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func oversizedJSONRequest() *http.Request {
	body := `{"v":"` + strings.Repeat("a", int(defaultJSONBodyLimit)) + `"}`
	return httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
}

func TestReadJSONMapRejectsBodiesOverDefaultLimit(t *testing.T) {
	_, err := readJSONMap(oversizedJSONRequest())
	var tooLarge *http.MaxBytesError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("readJSONMap() error = %v, want *http.MaxBytesError", err)
	}
}

func TestReadJSONMapLimitAllowsExplicitlyLargerBodies(t *testing.T) {
	body, err := readJSONMapLimit(oversizedJSONRequest(), defaultJSONBodyLimit*2)
	if err != nil {
		t.Fatalf("readJSONMapLimit() error = %v", err)
	}
	if got, _ := body["v"].(string); int64(len(got)) != defaultJSONBodyLimit {
		t.Fatalf("decoded value length = %d, want %d", len(got), defaultJSONBodyLimit)
	}
}
