package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
)

func TestWriteCustomRelayConfigErrorDoesNotLeakUnclassifiedErrors(t *testing.T) {
	app := &App{}
	res := httptest.NewRecorder()
	app.writeCustomRelayConfigError(res, errors.New("dial tcp 10.0.0.5:5432: secret-host failure"))
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", res.Code)
	}
	if strings.Contains(res.Body.String(), "secret-host") {
		t.Fatalf("response leaked internal error: %s", res.Body.String())
	}
}

func TestWriteCustomRelayConfigErrorKeepsValidationAndConflictSemantics(t *testing.T) {
	app := &App{}
	validation := httptest.NewRecorder()
	app.writeCustomRelayConfigError(validation, &service.CustomRelayConfigValidationError{Message: "配置名称不能为空"})
	if validation.Code != http.StatusBadRequest || !strings.Contains(validation.Body.String(), "配置名称不能为空") {
		t.Fatalf("validation response = %d %s", validation.Code, validation.Body.String())
	}
	conflict := httptest.NewRecorder()
	app.writeCustomRelayConfigError(conflict, &service.CustomRelayConfigStorageError{Err: fmt.Errorf("save: %w", storage.ErrConcurrentRowUpdate)})
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409", conflict.Code)
	}
	unavailable := httptest.NewRecorder()
	app.writeCustomRelayConfigError(unavailable, &service.CustomRelayConfigStorageError{Err: errors.New("disk")})
	if unavailable.Code != http.StatusServiceUnavailable {
		t.Fatalf("storage status = %d, want 503", unavailable.Code)
	}
}
