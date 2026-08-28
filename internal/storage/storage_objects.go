package storage

import (
	"database/sql"
	"errors"
	"fmt"

	"chatgpt2api/internal/model"
)

var ErrStorageObjectNotFound = errors.New("storage object not found")

type StorageObjectBackend interface {
	SaveStorageObject(model.StorageObject) error
	LoadStorageObject(string) (model.StorageObject, error)
	DeleteStorageObject(string) error
	StorageObjectUsageByMIME(string) (map[string]StorageObjectUsage, error)
}

type StorageObjectUsage struct {
	Count int
	Bytes int64
}

func (b *DatabaseBackend) SaveStorageObject(object model.StorageObject) error {
	query := `INSERT INTO storage_objects
		(id, provider_id, bucket, object_key, public_url, mime_type, bytes, width, height, sha256, direct, created_by, created_at, deleted_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if b.driver == "postgres" {
		query = `INSERT INTO storage_objects
			(id, provider_id, bucket, object_key, public_url, mime_type, bytes, width, height, sha256, direct, created_by, created_at, deleted_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`
	}
	_, err := b.db.Exec(query,
		object.ID, object.ProviderID, object.Bucket, object.ObjectKey, object.PublicURL,
		object.MIMEType, object.Bytes, object.Width, object.Height, object.SHA256,
		object.Direct, object.CreatedBy, object.CreatedAt, object.DeletedAt,
	)
	if err != nil {
		return fmt.Errorf("save storage object: %w", err)
	}
	return nil
}

func (b *DatabaseBackend) LoadStorageObject(id string) (model.StorageObject, error) {
	var object model.StorageObject
	query := `SELECT id, provider_id, bucket, object_key, public_url, mime_type, bytes, width, height, sha256, direct, created_by, created_at, deleted_at
		FROM storage_objects WHERE id = ` + b.placeholder(1)
	err := b.db.QueryRow(query, id).Scan(
		&object.ID, &object.ProviderID, &object.Bucket, &object.ObjectKey, &object.PublicURL,
		&object.MIMEType, &object.Bytes, &object.Width, &object.Height, &object.SHA256,
		&object.Direct, &object.CreatedBy, &object.CreatedAt, &object.DeletedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return model.StorageObject{}, ErrStorageObjectNotFound
	}
	if err != nil {
		return model.StorageObject{}, fmt.Errorf("load storage object: %w", err)
	}
	return object, nil
}

func (b *DatabaseBackend) DeleteStorageObject(id string) error {
	result, err := b.db.Exec("DELETE FROM storage_objects WHERE id = "+b.placeholder(1), id)
	if err != nil {
		return fmt.Errorf("delete storage object: %w", err)
	}
	if affected, rowsErr := result.RowsAffected(); rowsErr == nil && affected == 0 {
		return ErrStorageObjectNotFound
	}
	return nil
}

func (b *DatabaseBackend) StorageObjectUsageByMIME(providerID string) (map[string]StorageObjectUsage, error) {
	query := `SELECT mime_type, COUNT(*), COALESCE(SUM(bytes), 0)
		FROM storage_objects WHERE provider_id = ` + b.placeholder(1) + ` GROUP BY mime_type`
	rows, err := b.db.Query(query, providerID)
	if err != nil {
		return nil, fmt.Errorf("query storage object usage: %w", err)
	}
	defer rows.Close()
	result := make(map[string]StorageObjectUsage)
	for rows.Next() {
		var mimeType string
		var usage StorageObjectUsage
		if err := rows.Scan(&mimeType, &usage.Count, &usage.Bytes); err != nil {
			return nil, fmt.Errorf("scan storage object usage: %w", err)
		}
		result[mimeType] = usage
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate storage object usage: %w", err)
	}
	return result, nil
}
