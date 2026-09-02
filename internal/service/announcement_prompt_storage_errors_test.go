package service

import (
	"errors"
	"testing"

	"chatgpt2api/internal/storage"
)

type serviceDocumentErrorBackend struct {
	storage.Backend
	loadValue any
	loadErr   error
	saveErr   error
}

func (b *serviceDocumentErrorBackend) LoadJSONDocument(string) (any, error) {
	return b.loadValue, b.loadErr
}

func (b *serviceDocumentErrorBackend) SaveJSONDocument(string, any) error {
	return b.saveErr
}

func (b *serviceDocumentErrorBackend) DeleteJSONDocument(string) error {
	return nil
}

func TestAnnouncementServiceClassifiesStorageErrors(t *testing.T) {
	storageFailure := errors.New("announcement database unavailable")
	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "announcement read",
			run: func() error {
				_, err := NewAnnouncementService(&serviceDocumentErrorBackend{loadErr: storageFailure}).ListAll()
				return err
			},
		},
		{
			name: "preference read",
			run: func() error {
				_, err := NewAnnouncementService(&serviceDocumentErrorBackend{loadErr: storageFailure}).Preferences("owner")
				return err
			},
		},
		{
			name: "announcement write",
			run: func() error {
				_, _, err := NewAnnouncementService(&serviceDocumentErrorBackend{loadValue: map[string]any{}, saveErr: storageFailure}).CreateWithItems(map[string]any{"content": "Maintenance"})
				return err
			},
		},
		{
			name: "preference write",
			run: func() error {
				_, err := NewAnnouncementService(&serviceDocumentErrorBackend{loadValue: map[string]any{}, saveErr: storageFailure}).UpdatePreferences("owner", "announcement:v1", "seen", "")
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.run()
			var classified *AnnouncementStorageError
			if !errors.As(err, &classified) || !errors.Is(err, storageFailure) {
				t.Fatalf("error = %T %v, want announcement storage error wrapping %v", err, err, storageFailure)
			}
		})
	}

	_, _, validationErr := NewAnnouncementService(&serviceDocumentErrorBackend{loadValue: map[string]any{}}).CreateWithItems(map[string]any{"content": ""})
	var classified *AnnouncementStorageError
	if validationErr == nil || errors.As(validationErr, &classified) {
		t.Fatalf("validation error = %T %v, want unclassified validation error", validationErr, validationErr)
	}
}

func TestPromptFavoriteServiceClassifiesStorageErrors(t *testing.T) {
	storageFailure := errors.New("prompt favorite database unavailable")
	payload := testPromptFavoritePayload("prompt-a")
	favoriteID := promptFavoriteID("banana-prompt-quicker", "prompt-a")
	storedFavorite := testPromptFavoritePayload("prompt-a")
	storedFavorite["id"] = favoriteID
	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "read",
			run: func() error {
				_, err := NewPromptFavoriteService(&serviceDocumentErrorBackend{loadErr: storageFailure}).ListWithError("owner")
				return err
			},
		},
		{
			name: "upsert",
			run: func() error {
				_, _, err := NewPromptFavoriteService(&serviceDocumentErrorBackend{loadValue: map[string]any{}, saveErr: storageFailure}).UpsertWithItems("owner", payload)
				return err
			},
		},
		{
			name: "delete",
			run: func() error {
				backend := &serviceDocumentErrorBackend{
					loadValue: map[string]any{"items": []any{storedFavorite}},
					saveErr:   storageFailure,
				}
				_, _, err := NewPromptFavoriteService(backend).DeleteWithItems("owner", favoriteID)
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.run()
			var classified *PromptFavoriteStorageError
			if !errors.As(err, &classified) || !errors.Is(err, storageFailure) {
				t.Fatalf("error = %T %v, want prompt favorite storage error wrapping %v", err, err, storageFailure)
			}
		})
	}

	invalidPayload := testPromptFavoritePayload("prompt-a")
	delete(invalidPayload, "prompt_id")
	_, _, validationErr := NewPromptFavoriteService(&serviceDocumentErrorBackend{loadValue: map[string]any{}}).UpsertWithItems("owner", invalidPayload)
	var classified *PromptFavoriteStorageError
	if validationErr == nil || errors.As(validationErr, &classified) {
		t.Fatalf("validation error = %T %v, want unclassified validation error", validationErr, validationErr)
	}
}

func testPromptFavoritePayload(promptID string) map[string]any {
	return map[string]any{
		"prompt_id": promptID,
		"source":    "banana-prompt-quicker",
		"title":     "Prompt",
		"preview":   "https://example.test/preview.png",
		"prompt":    "draw",
		"author":    "Alice",
	}
}
