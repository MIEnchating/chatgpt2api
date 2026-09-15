package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"chatgpt2api/internal/model"
)

// FileLifecycleBackend supplies authoritative inventory without provider listing.
type FileLifecycleBackend interface {
	ListStorageObjects(context.Context, string, int) ([]model.StorageObject, error)
	VisitImageConversationDocuments(context.Context, func(any) error) error
	VisitJSONDocuments(context.Context, func(string, any) error) error
	StorageObjectIDsForPublicURLs(context.Context, []string) ([]string, error)
}

func (b *DatabaseBackend) StorageObjectIDsForPublicURLs(ctx context.Context, urls []string) ([]string, error) {
	result := []string{}
	for start := 0; start < len(urls); start += 500 {
		batch := urls[start:min(start+500, len(urls))]
		placeholders := make([]string, len(batch))
		args := make([]any, len(batch))
		for i, value := range batch {
			placeholders[i], args[i] = b.placeholder(i+1), value
		}
		rows, err := b.db.QueryContext(ctx, `SELECT id FROM storage_objects WHERE public_url IN (`+strings.Join(placeholders, ",")+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			result = append(result, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (b *DatabaseBackend) ListStorageObjects(ctx context.Context, afterID string, limit int) ([]model.StorageObject, error) {
	if limit < 1 || limit > 1000 {
		return nil, fmt.Errorf("invalid storage inventory limit")
	}
	query := `SELECT id, provider_id, bucket, object_key, public_url, mime_type, bytes, width, height, sha256, direct, created_by, created_at, deleted_at FROM storage_objects WHERE id > ` + b.placeholder(1) + ` ORDER BY id LIMIT ` + b.placeholder(2)
	rows, err := b.db.QueryContext(ctx, query, afterID, limit)
	if err != nil {
		return nil, fmt.Errorf("list storage objects: %w", err)
	}
	defer rows.Close()
	result := []model.StorageObject{}
	for rows.Next() {
		var object model.StorageObject
		if err := rows.Scan(&object.ID, &object.ProviderID, &object.Bucket, &object.ObjectKey, &object.PublicURL, &object.MIMEType, &object.Bytes, &object.Width, &object.Height, &object.SHA256, &object.Direct, &object.CreatedBy, &object.CreatedAt, &object.DeletedAt); err != nil {
			return nil, err
		}
		result = append(result, object)
	}
	return result, rows.Err()
}

func (b *DatabaseBackend) VisitImageConversationDocuments(ctx context.Context, visit func(any) error) error {
	rows, err := b.db.QueryContext(ctx, `SELECT c.data FROM image_conversations c JOIN image_conversation_owners o ON c.owner_key = o.owner_key WHERE c.deleted_at_ms = 0 AND c.updated_at_ms > o.cleared_at_ms AND c.data IS NOT NULL`)
	if err != nil {
		return fmt.Errorf("list history references: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return err
		}
		var value any
		if err := json.Unmarshal([]byte(data), &value); err != nil {
			return fmt.Errorf("decode history references: %w", err)
		}
		if err := visit(value); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (b *DatabaseBackend) VisitJSONDocuments(ctx context.Context, visit func(string, any) error) error {
	rows, err := b.db.QueryContext(ctx, `SELECT name, data FROM json_documents ORDER BY name`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name, data string
		if err := rows.Scan(&name, &data); err != nil {
			return err
		}
		value, err := decodeJSONString(data)
		if err != nil {
			return fmt.Errorf("decode reference document: %w", err)
		}
		if err := visit(name, value); err != nil {
			return err
		}
	}
	return rows.Err()
}
