package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"chatgpt2api/internal/model"
)

func TestLocalUploadCapacityUsesReservationsWithoutRemeasuring(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{LocalCapacityLimitBytes: 10})
	upload := func() error {
		_, err := service.UploadReader(context.Background(), "user-1", false, "a.bin", "application/octet-stream", strings.NewReader("123456"), 6, nil)
		return err
	}
	if err := upload(); err != nil {
		t.Fatalf("first upload: %v", err)
	}
	if err := upload(); !errors.Is(err, ErrLocalStorageCapacityExceeded) {
		t.Fatalf("second upload error = %v, want capacity exceeded", err)
	}
}

func TestLocalUploadCapacityIgnoresFailedUploads(t *testing.T) {
	service := newGenericStorageTestService(t, model.StorageSetting{LocalCapacityLimitBytes: 10})
	// The declared size does not match the payload, so the upload fails after reserving capacity.
	if _, err := service.UploadReader(context.Background(), "user-1", false, "bad.bin", "application/octet-stream", strings.NewReader("123"), 6, nil); err == nil {
		t.Fatal("mismatched upload succeeded, want error")
	}
	if service.localReservedBytes != 0 || service.localUsedBytes != 0 {
		t.Fatalf("after failed upload reserved = %d, used = %d, want 0, 0", service.localReservedBytes, service.localUsedBytes)
	}
	if _, err := service.UploadReader(context.Background(), "user-1", false, "ok.bin", "application/octet-stream", strings.NewReader("123456"), 6, nil); err != nil {
		t.Fatalf("upload after a failed upload error = %v, want success", err)
	}
	if service.localReservedBytes != 0 || service.localUsedBytes != 6 {
		t.Fatalf("after successful upload reserved = %d, used = %d, want 0, 6", service.localReservedBytes, service.localUsedBytes)
	}
}
