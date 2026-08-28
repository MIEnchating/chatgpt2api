package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

const (
	defaultImageConversationPageSize = 50
	maxImageConversationPageSize     = 200
	MaxImageConversationSummaryBytes = 64 << 10

	imageConversationAssetURLPrefix       = "/conversation-assets/"
	imageConversationAssetPathsSummaryKey = "_conversationAssetPaths"
	imageConversationAssetRefsCompleteKey = "_conversationAssetPathsComplete"
)

var (
	ErrImageConversationGenerationStale = errors.New("image conversation generation is stale")
	ErrImageConversationCursorStale     = errors.New("image conversation cursor generation is stale")
	ErrImageConversationCASConflict     = errors.New("image conversation compare-and-swap conflict")
	ErrImageConversationGone            = errors.New("image conversation was deleted")
	ErrImageConversationHashCollision   = errors.New("image conversation key hash collision")
	ErrImageConversationBatchDuplicate  = errors.New("duplicate image conversation in batch")
)

// ImageConversationRecord is one independently persisted conversation snapshot.
// StorageVersion is managed by the backend and is separate from the client revision.
type ImageConversationRecord struct {
	ID              string          `json:"id"`
	Revision        int64           `json:"revision"`
	StorageVersion  int64           `json:"storage_version"`
	AcceptedHash    string          `json:"accepted_hash"`
	CreatedAtMillis int64           `json:"created_at_millis"`
	UpdatedAtMillis int64           `json:"updated_at_millis"`
	Active          bool            `json:"active"`
	DeletedAtMillis int64           `json:"deleted_at_millis,omitempty"`
	Summary         json.RawMessage `json:"summary,omitempty"`
	Data            json.RawMessage `json:"data,omitempty"`
}

type ImageConversationCASRequest struct {
	ExpectedStorageVersion int64
	Record                 ImageConversationRecord
}

type ImageConversationCASStatus string

const (
	ImageConversationCASReady           ImageConversationCASStatus = "ready"
	ImageConversationCASSaved           ImageConversationCASStatus = "saved"
	ImageConversationCASConflict        ImageConversationCASStatus = "conflict"
	ImageConversationCASGone            ImageConversationCASStatus = "gone"
	ImageConversationCASGenerationStale ImageConversationCASStatus = "generation_stale"
)

type ImageConversationCASResult struct {
	ID      string
	Status  ImageConversationCASStatus
	Exists  bool
	Current ImageConversationRecord
}

type ImageConversationBatchCASResult struct {
	Generation       int64
	CursorGeneration int64
	Items            []ImageConversationCASResult
}

type ImageConversationOwnerState struct {
	ClearedAt        string `json:"cleared_at,omitempty"`
	ClearedAtMillis  int64  `json:"cleared_at_millis,omitempty"`
	Generation       int64  `json:"generation"`
	CursorGeneration int64  `json:"cursor_generation"`
}

// ImageConversationCursor is a stable keyset cursor ordered newest first.
type ImageConversationCursor struct {
	Generation      int64  `json:"generation"`
	UpdatedAtMillis int64  `json:"updated_at_millis"`
	ConversationKey string `json:"conversation_key"`
}

type ImageConversationPage struct {
	Records    []ImageConversationRecord `json:"records"`
	NextCursor *ImageConversationCursor  `json:"next_cursor,omitempty"`
}

// ImageConversationBackend stores each conversation independently. ownerID is
// hashed by the backend and is never persisted in plaintext. Generation is a
// destructive epoch used by writes. CursorGeneration is a read-snapshot epoch
// advanced by every mutation so keyset cursors cannot skip reordered rows.
type ImageConversationBackend interface {
	LoadOwnerState(ctx context.Context, ownerID string) (ImageConversationOwnerState, error)
	Load(ctx context.Context, ownerID, conversationID string) (ImageConversationRecord, bool, error)
	List(ctx context.Context, ownerID string, generation int64, cursor *ImageConversationCursor, limit int) (ImageConversationPage, error)
	ListActive(ctx context.Context, ownerID string, generation int64, limit int) ([]ImageConversationRecord, error)
	BatchSaveCAS(ctx context.Context, ownerID string, expectedGeneration int64, requests []ImageConversationCASRequest) (ImageConversationBatchCASResult, error)
	SaveCAS(ctx context.Context, ownerID string, expectedGeneration, expectedStorageVersion int64, record ImageConversationRecord) (ImageConversationRecord, error)
	Delete(ctx context.Context, ownerID, conversationID string, deletedAtMillis int64) (bool, error)
	Clear(ctx context.Context, ownerID, clearedAt string, clearedAtMillis int64) (ImageConversationOwnerState, error)
}

var _ ImageConversationBackend = (*DatabaseBackend)(nil)

type imageConversationScanner interface {
	Scan(dest ...any) error
}

func (b *DatabaseBackend) initImageConversationSchema() error {
	var schema []string
	switch b.driver {
	case "postgres":
		schema = []string{
			`CREATE TABLE IF NOT EXISTS image_conversation_owners (
				owner_key TEXT PRIMARY KEY,
				cleared_at TEXT NOT NULL DEFAULT '',
				cleared_at_ms BIGINT NOT NULL DEFAULT 0,
				generation BIGINT NOT NULL DEFAULT 1,
				cursor_generation BIGINT NOT NULL DEFAULT 1
			)`,
			`CREATE TABLE IF NOT EXISTS image_conversations (
				owner_key TEXT NOT NULL,
				conversation_key TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				revision BIGINT NOT NULL DEFAULT 0,
				storage_version BIGINT NOT NULL DEFAULT 1,
				accepted_hash TEXT NOT NULL,
				created_at_ms BIGINT NOT NULL DEFAULT 0,
				updated_at_ms BIGINT NOT NULL DEFAULT 0,
				active SMALLINT NOT NULL DEFAULT 0,
				deleted_at_ms BIGINT NOT NULL DEFAULT 0,
				summary TEXT,
				data TEXT,
				PRIMARY KEY (owner_key, conversation_key)
			)`,
			`CREATE INDEX IF NOT EXISTS idx_image_conversations_owner_list ON image_conversations (owner_key, deleted_at_ms, updated_at_ms, conversation_key)`,
			`CREATE INDEX IF NOT EXISTS idx_image_conversations_owner_active ON image_conversations (owner_key, active, deleted_at_ms, updated_at_ms, conversation_key)`,
		}
	case "mysql":
		schema = []string{
			`CREATE TABLE IF NOT EXISTS image_conversation_owners (
				owner_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
				cleared_at TEXT NOT NULL,
				cleared_at_ms BIGINT NOT NULL DEFAULT 0,
				generation BIGINT NOT NULL DEFAULT 1,
				cursor_generation BIGINT NOT NULL DEFAULT 1
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			`CREATE TABLE IF NOT EXISTS image_conversations (
				owner_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
				conversation_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
				conversation_id TEXT NOT NULL,
				revision BIGINT NOT NULL DEFAULT 0,
				storage_version BIGINT NOT NULL DEFAULT 1,
				accepted_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
					created_at_ms BIGINT NOT NULL DEFAULT 0,
					updated_at_ms BIGINT NOT NULL DEFAULT 0,
					active TINYINT(1) NOT NULL DEFAULT 0,
					deleted_at_ms BIGINT NOT NULL DEFAULT 0,
					summary LONGTEXT,
					data LONGTEXT,
					PRIMARY KEY (owner_key, conversation_key)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			`CREATE INDEX idx_image_conversations_owner_list ON image_conversations (owner_key, deleted_at_ms, updated_at_ms, conversation_key)`,
			`CREATE INDEX idx_image_conversations_owner_active ON image_conversations (owner_key, active, deleted_at_ms, updated_at_ms, conversation_key)`,
		}
	default:
		schema = []string{
			`CREATE TABLE IF NOT EXISTS image_conversation_owners (
				owner_key TEXT PRIMARY KEY,
				cleared_at TEXT NOT NULL DEFAULT '',
				cleared_at_ms INTEGER NOT NULL DEFAULT 0,
				generation INTEGER NOT NULL DEFAULT 1,
				cursor_generation INTEGER NOT NULL DEFAULT 1
			)`,
			`CREATE TABLE IF NOT EXISTS image_conversations (
				owner_key TEXT NOT NULL,
				conversation_key TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 0,
				storage_version INTEGER NOT NULL DEFAULT 1,
				accepted_hash TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL DEFAULT 0,
				updated_at_ms INTEGER NOT NULL DEFAULT 0,
				active INTEGER NOT NULL DEFAULT 0,
				deleted_at_ms INTEGER NOT NULL DEFAULT 0,
				summary TEXT,
				data TEXT,
				PRIMARY KEY (owner_key, conversation_key)
			)`,
			`CREATE INDEX IF NOT EXISTS idx_image_conversations_owner_list ON image_conversations (owner_key, deleted_at_ms, updated_at_ms, conversation_key)`,
			`CREATE INDEX IF NOT EXISTS idx_image_conversations_owner_active ON image_conversations (owner_key, active, deleted_at_ms, updated_at_ms, conversation_key)`,
		}
	}
	for _, statement := range schema {
		if _, err := b.db.Exec(statement); err != nil {
			var mysqlError *mysqlDriver.MySQLError
			if b.driver == "mysql" && errors.As(err, &mysqlError) && mysqlError.Number == 1061 {
				continue
			}
			return fmt.Errorf("initialize image conversation schema: %w", err)
		}
	}
	return nil
}

func imageConversationStorageKey(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("image conversation key is required")
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:]), nil
}

func imageConversationDataHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func deriveImageConversationSummary(data []byte) json.RawMessage {
	var object map[string]any
	if len(data) == 0 || json.Unmarshal(data, &object) != nil || object == nil {
		return incompleteImageConversationSummary()
	}
	turns, _ := object["turns"].([]any)
	queued := 0
	running := 0
	for _, rawTurn := range turns {
		turn, _ := rawTurn.(map[string]any)
		hasQueued := false
		hasRunning := false
		images, _ := turn["images"].([]any)
		for _, rawImage := range images {
			image, _ := rawImage.(map[string]any)
			status := strings.TrimSpace(fmt.Sprint(image["status"]))
			taskStatus := strings.TrimSpace(fmt.Sprint(image["taskStatus"]))
			terminal := status == "success" || status == "error" || status == "cancelled" || status == "message" ||
				taskStatus == "success" || taskStatus == "error" || taskStatus == "cancelled"
			if terminal {
				continue
			}
			if status == "generating" || taskStatus == "running" {
				hasRunning = true
				break
			}
			if status == "queued" || status == "loading" || taskStatus == "queued" {
				hasQueued = true
			}
		}
		turnStatus := strings.TrimSpace(fmt.Sprint(turn["status"]))
		if hasRunning || (!hasQueued && turnStatus == "generating") {
			running++
			continue
		}
		if hasQueued || turnStatus == "queued" {
			queued++
		}
	}
	assetPaths, assetRefsComplete := deriveImageConversationAssetSummary(object)
	summaryObject := map[string]any{
		"id":                                  object["id"],
		"revision":                            object["revision"],
		"title":                               object["title"],
		"createdAt":                           object["createdAt"],
		"updatedAt":                           object["updatedAt"],
		"historySummary":                      map[string]any{"turnCount": len(turns), "queued": queued, "running": running},
		"historySummaryOnly":                  true,
		imageConversationAssetPathsSummaryKey: assetPaths,
		imageConversationAssetRefsCompleteKey: assetRefsComplete,
	}
	summary, err := json.Marshal(summaryObject)
	if err == nil && len(summary) <= MaxImageConversationSummaryBytes {
		return summary
	}
	// An incomplete marker is fail-closed: asset governance must read Data for
	// this row instead of interpreting an omitted or truncated path list as no
	// references.
	delete(summaryObject, imageConversationAssetPathsSummaryKey)
	summaryObject[imageConversationAssetRefsCompleteKey] = false
	summary, err = json.Marshal(summaryObject)
	if err == nil && len(summary) <= MaxImageConversationSummaryBytes {
		return summary
	}
	return incompleteImageConversationSummary()
}

func incompleteImageConversationSummary() json.RawMessage {
	return json.RawMessage(`{"_conversationAssetPathsComplete":false}`)
}

func deriveImageConversationAssetSummary(object map[string]any) ([]string, bool) {
	paths := make(map[string]struct{})
	complete := true
	turns, _ := object["turns"].([]any)
	for _, rawTurn := range turns {
		turn, _ := rawTurn.(map[string]any)
		references, _ := turn["referenceImages"].([]any)
		for _, rawReference := range references {
			reference, _ := rawReference.(map[string]any)
			value := firstImageConversationSummaryAssetValue(reference)
			if value == "" {
				continue
			}
			assetPath, managed, valid := normalizeImageConversationSummaryAssetPath(value)
			switch {
			case valid:
				paths[assetPath] = struct{}{}
			case managed:
				complete = false
			}
		}
	}
	result := make([]string, 0, len(paths))
	for assetPath := range paths {
		result = append(result, assetPath)
	}
	sort.Strings(result)
	return result, complete
}

func firstImageConversationSummaryAssetValue(item map[string]any) string {
	for _, key := range []string{"assetPath", "asset_path", "dataUrl", "data_url", "url"} {
		if value := strings.TrimSpace(fmt.Sprint(item[key])); value != "" && value != "<nil>" {
			return value
		}
	}
	return ""
}

func normalizeImageConversationSummaryAssetPath(value string) (string, bool, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", false, false
	}
	managed := false
	if parsed, err := url.Parse(text); err == nil {
		pathValue := parsed.EscapedPath()
		if pathValue == "" {
			pathValue = parsed.Path
		}
		if parsed.Scheme != "" || strings.HasPrefix(pathValue, "/") {
			if !strings.HasPrefix(pathValue, imageConversationAssetURLPrefix) {
				return "", false, false
			}
			managed = true
			decoded, err := url.PathUnescape(strings.TrimPrefix(pathValue, imageConversationAssetURLPrefix))
			if err != nil {
				return "", true, false
			}
			text = decoded
		}
	}
	assetPath := strings.ReplaceAll(text, "\\", "/")
	parts := strings.Split(assetPath, "/")
	if len(parts) != 2 {
		return "", managed || strings.Contains(assetPath, "/"), false
	}
	managed = managed || isImageConversationSummaryHexDigest(parts[0])
	if path.Clean(assetPath) != assetPath || !isImageConversationSummaryHexDigest(parts[0]) {
		return "", managed, false
	}
	extension := strings.ToLower(path.Ext(parts[1]))
	contentHash := strings.TrimSuffix(parts[1], extension)
	if !isImageConversationSummaryHexDigest(contentHash) {
		return "", managed, false
	}
	switch extension {
	case ".png", ".jpg", ".webp":
		return assetPath, true, true
	default:
		return "", true, false
	}
}

func isImageConversationSummaryHexDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func normalizeImageConversationSummary(summary, data json.RawMessage) (json.RawMessage, error) {
	if len(summary) == 0 {
		return deriveImageConversationSummary(data), nil
	}
	if !json.Valid(summary) {
		return nil, fmt.Errorf("image conversation summary must be valid JSON")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(summary, &object); err != nil || object == nil {
		return nil, fmt.Errorf("image conversation summary must be a JSON object")
	}
	delete(object, "turns")
	normalized, err := json.Marshal(object)
	if err != nil {
		return nil, fmt.Errorf("encode image conversation summary: %w", err)
	}
	if len(normalized) > MaxImageConversationSummaryBytes {
		return deriveImageConversationSummary(data), nil
	}
	return normalized, nil
}

func normalizeImageConversationAcceptedHash(value string, data []byte) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return imageConversationDataHash(data), nil
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("accepted hash must be a SHA-256 hex value")
	}
	return value, nil
}

func normalizeLiveImageConversationRecord(record ImageConversationRecord) (ImageConversationRecord, string, error) {
	record.ID = strings.TrimSpace(record.ID)
	key, err := imageConversationStorageKey(record.ID)
	if err != nil {
		return ImageConversationRecord{}, "", err
	}
	if record.Revision < 0 || record.CreatedAtMillis < 0 || record.UpdatedAtMillis < 0 {
		return ImageConversationRecord{}, "", fmt.Errorf("image conversation metadata cannot be negative")
	}
	if len(record.Data) == 0 || !json.Valid(record.Data) {
		return ImageConversationRecord{}, "", fmt.Errorf("image conversation data must be valid JSON")
	}
	record.Data = append(json.RawMessage(nil), record.Data...)
	record.DeletedAtMillis = 0
	record.Summary, err = normalizeImageConversationSummary(record.Summary, record.Data)
	if err != nil {
		return ImageConversationRecord{}, "", err
	}
	record.AcceptedHash, err = normalizeImageConversationAcceptedHash(record.AcceptedHash, record.Data)
	if err != nil {
		return ImageConversationRecord{}, "", err
	}
	return record, key, nil
}

func boolDatabaseValue(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func (b *DatabaseBackend) ensureImageConversationOwnerTx(ctx context.Context, tx *sql.Tx, ownerKey string) error {
	var statement string
	switch b.driver {
	case "postgres":
		statement = `INSERT INTO image_conversation_owners (owner_key, cleared_at, cleared_at_ms, generation, cursor_generation)
			VALUES ($1, '', 0, 1, 1) ON CONFLICT (owner_key) DO NOTHING`
	case "mysql":
		statement = `INSERT IGNORE INTO image_conversation_owners (owner_key, cleared_at, cleared_at_ms, generation, cursor_generation)
			VALUES (?, '', 0, 1, 1)`
	default:
		statement = `INSERT INTO image_conversation_owners (owner_key, cleared_at, cleared_at_ms, generation, cursor_generation)
			VALUES (?, '', 0, 1, 1) ON CONFLICT(owner_key) DO NOTHING`
	}
	_, err := tx.ExecContext(ctx, statement, ownerKey)
	return err
}

func (b *DatabaseBackend) loadImageConversationOwnerTx(ctx context.Context, tx *sql.Tx, ownerKey string, lock bool) (ImageConversationOwnerState, error) {
	query := `SELECT cleared_at, cleared_at_ms, generation, cursor_generation
		FROM image_conversation_owners WHERE owner_key = ` + b.placeholder(1)
	if lock && b.driver != "sqlite" {
		query += " FOR UPDATE"
	}
	return scanImageConversationOwnerState(tx.QueryRowContext(ctx, query, ownerKey))
}

func scanImageConversationOwnerState(scanner imageConversationScanner) (ImageConversationOwnerState, error) {
	var state ImageConversationOwnerState
	if err := scanner.Scan(
		&state.ClearedAt,
		&state.ClearedAtMillis,
		&state.Generation,
		&state.CursorGeneration,
	); err != nil {
		return ImageConversationOwnerState{}, err
	}
	if state.Generation <= 0 {
		return ImageConversationOwnerState{}, fmt.Errorf("invalid image conversation owner generation")
	}
	if state.CursorGeneration <= 0 {
		return ImageConversationOwnerState{}, fmt.Errorf("invalid image conversation owner cursor generation")
	}
	return state, nil
}

func (b *DatabaseBackend) beginImageConversationOwnerTx(ctx context.Context, ownerKey string) (*sql.Tx, ImageConversationOwnerState, error) {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, ImageConversationOwnerState{}, err
	}
	if err := b.ensureImageConversationOwnerTx(ctx, tx, ownerKey); err != nil {
		_ = tx.Rollback()
		return nil, ImageConversationOwnerState{}, err
	}
	state, err := b.loadImageConversationOwnerTx(ctx, tx, ownerKey, true)
	if err != nil {
		_ = tx.Rollback()
		return nil, ImageConversationOwnerState{}, err
	}
	return tx, state, nil
}

func (b *DatabaseBackend) LoadOwnerState(ctx context.Context, ownerID string) (ImageConversationOwnerState, error) {
	ownerKey, err := imageConversationStorageKey(ownerID)
	if err != nil {
		return ImageConversationOwnerState{}, err
	}
	query := `SELECT cleared_at, cleared_at_ms, generation, cursor_generation
		FROM image_conversation_owners WHERE owner_key = ` + b.placeholder(1)
	state, err := scanImageConversationOwnerState(b.db.QueryRowContext(ctx, query, ownerKey))
	if err == nil {
		return state, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ImageConversationOwnerState{}, err
	}
	tx, state, err := b.beginImageConversationOwnerTx(ctx, ownerKey)
	if err != nil {
		return ImageConversationOwnerState{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.Commit(); err != nil {
		return ImageConversationOwnerState{}, err
	}
	return state, nil
}

const imageConversationRecordColumns = `conversation_id, revision, storage_version, accepted_hash,
	created_at_ms, updated_at_ms, active, deleted_at_ms, summary, data`

const imageConversationSummaryColumns = `conversation_id, revision, storage_version, accepted_hash,
	created_at_ms, updated_at_ms, active, deleted_at_ms, summary`

func scanImageConversationRecord(scanner imageConversationScanner) (ImageConversationRecord, error) {
	return scanImageConversationRecordAndKey(scanner, nil, true)
}

func scanImageConversationSummaryAndKey(scanner imageConversationScanner, conversationKey *string) (ImageConversationRecord, error) {
	return scanImageConversationRecordAndKey(scanner, conversationKey, false)
}

func scanImageConversationRecordAndKey(scanner imageConversationScanner, conversationKey *string, includeData bool) (ImageConversationRecord, error) {
	var record ImageConversationRecord
	var active int64
	var summary sql.NullString
	var data sql.NullString
	destinations := make([]any, 0, 11)
	if conversationKey != nil {
		destinations = append(destinations, conversationKey)
	}
	destinations = append(destinations,
		&record.ID,
		&record.Revision,
		&record.StorageVersion,
		&record.AcceptedHash,
		&record.CreatedAtMillis,
		&record.UpdatedAtMillis,
		&active,
		&record.DeletedAtMillis,
		&summary,
	)
	if includeData {
		destinations = append(destinations, &data)
	}
	if err := scanner.Scan(destinations...); err != nil {
		return ImageConversationRecord{}, err
	}
	record.Active = active != 0
	if summary.Valid {
		var object map[string]any
		if json.Unmarshal([]byte(summary.String), &object) == nil && object != nil {
			record.Summary = json.RawMessage(summary.String)
		}
	}
	if data.Valid {
		record.Data = json.RawMessage(data.String)
	}
	return record, nil
}

func (b *DatabaseBackend) loadImageConversationRecordTx(ctx context.Context, tx *sql.Tx, ownerKey, conversationKey string, lock bool) (ImageConversationRecord, bool, error) {
	query := `SELECT ` + imageConversationRecordColumns + ` FROM image_conversations
		WHERE owner_key = ` + b.placeholder(1) + ` AND conversation_key = ` + b.placeholder(2)
	if lock && b.driver != "sqlite" {
		query += " FOR UPDATE"
	}
	record, err := scanImageConversationRecord(tx.QueryRowContext(ctx, query, ownerKey, conversationKey))
	if errors.Is(err, sql.ErrNoRows) {
		return ImageConversationRecord{}, false, nil
	}
	return record, err == nil, err
}

func (b *DatabaseBackend) Load(ctx context.Context, ownerID, conversationID string) (ImageConversationRecord, bool, error) {
	ownerKey, err := imageConversationStorageKey(ownerID)
	if err != nil {
		return ImageConversationRecord{}, false, err
	}
	conversationID = strings.TrimSpace(conversationID)
	conversationKey, err := imageConversationStorageKey(conversationID)
	if err != nil {
		return ImageConversationRecord{}, false, err
	}
	query := `SELECT ` + imageConversationRecordColumns + ` FROM image_conversations
		WHERE owner_key = ` + b.placeholder(1) + ` AND conversation_key = ` + b.placeholder(2)
	record, err := scanImageConversationRecord(b.db.QueryRowContext(ctx, query, ownerKey, conversationKey))
	if errors.Is(err, sql.ErrNoRows) {
		return ImageConversationRecord{}, false, nil
	}
	if err != nil {
		return ImageConversationRecord{}, false, err
	}
	if record.ID != conversationID {
		return ImageConversationRecord{}, false, ErrImageConversationHashCollision
	}
	return record, true, nil
}

func (b *DatabaseBackend) imageConversationPlaceholders(count int) string {
	values := make([]string, count)
	for index := range values {
		values[index] = b.placeholder(index + 1)
	}
	return strings.Join(values, ", ")
}

func imageConversationDatabaseData(data json.RawMessage) any {
	if len(data) == 0 {
		return nil
	}
	return string(data)
}

func (b *DatabaseBackend) insertImageConversationRecordTx(
	ctx context.Context,
	tx *sql.Tx,
	ownerKey, conversationKey string,
	record ImageConversationRecord,
	ignoreConflict bool,
) (bool, error) {
	prefix := "INSERT INTO"
	if b.driver == "mysql" && ignoreConflict {
		prefix = "INSERT IGNORE INTO"
	}
	statement := prefix + ` image_conversations (
		owner_key, conversation_key, conversation_id, revision, storage_version,
		accepted_hash, created_at_ms, updated_at_ms, active, deleted_at_ms, summary, data
	) VALUES (` + b.imageConversationPlaceholders(12) + `)`
	if ignoreConflict && b.driver == "postgres" {
		statement += " ON CONFLICT (owner_key, conversation_key) DO NOTHING"
	} else if ignoreConflict && b.driver == "sqlite" {
		statement += " ON CONFLICT(owner_key, conversation_key) DO NOTHING"
	}
	result, err := tx.ExecContext(
		ctx,
		statement,
		ownerKey,
		conversationKey,
		record.ID,
		record.Revision,
		record.StorageVersion,
		record.AcceptedHash,
		record.CreatedAtMillis,
		record.UpdatedAtMillis,
		boolDatabaseValue(record.Active),
		record.DeletedAtMillis,
		imageConversationDatabaseData(record.Summary),
		imageConversationDatabaseData(record.Data),
	)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return true, nil
	}
	return rows > 0, nil
}

func (b *DatabaseBackend) updateImageConversationRecordCASTx(
	ctx context.Context,
	tx *sql.Tx,
	ownerKey, conversationKey string,
	expectedStorageVersion int64,
	record ImageConversationRecord,
) (bool, error) {
	statement := `UPDATE image_conversations SET
		conversation_id = ` + b.placeholder(1) + `,
		revision = ` + b.placeholder(2) + `,
		storage_version = ` + b.placeholder(3) + `,
		accepted_hash = ` + b.placeholder(4) + `,
		created_at_ms = ` + b.placeholder(5) + `,
		updated_at_ms = ` + b.placeholder(6) + `,
		active = ` + b.placeholder(7) + `,
		deleted_at_ms = 0,
		summary = ` + b.placeholder(8) + `,
		data = ` + b.placeholder(9) + `
		WHERE owner_key = ` + b.placeholder(10) + `
			AND conversation_key = ` + b.placeholder(11) + `
			AND storage_version = ` + b.placeholder(12)
	result, err := tx.ExecContext(
		ctx,
		statement,
		record.ID,
		record.Revision,
		record.StorageVersion,
		record.AcceptedHash,
		record.CreatedAtMillis,
		record.UpdatedAtMillis,
		boolDatabaseValue(record.Active),
		imageConversationDatabaseData(record.Summary),
		imageConversationDatabaseData(record.Data),
		ownerKey,
		conversationKey,
		expectedStorageVersion,
	)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	return rows > 0, err
}

type normalizedImageConversationCASRequest struct {
	expectedStorageVersion int64
	conversationKey        string
	record                 ImageConversationRecord
}

func normalizeImageConversationCASRequests(requests []ImageConversationCASRequest) ([]normalizedImageConversationCASRequest, error) {
	normalized := make([]normalizedImageConversationCASRequest, 0, len(requests))
	seen := make(map[string]string, len(requests))
	for _, request := range requests {
		if request.ExpectedStorageVersion < 0 {
			return nil, fmt.Errorf("invalid image conversation CAS precondition")
		}
		record, conversationKey, err := normalizeLiveImageConversationRecord(request.Record)
		if err != nil {
			return nil, err
		}
		if existingID, exists := seen[conversationKey]; exists {
			if existingID != record.ID {
				return nil, ErrImageConversationHashCollision
			}
			return nil, fmt.Errorf("%w: %s", ErrImageConversationBatchDuplicate, record.ID)
		}
		seen[conversationKey] = record.ID
		normalized = append(normalized, normalizedImageConversationCASRequest{
			expectedStorageVersion: request.ExpectedStorageVersion,
			conversationKey:        conversationKey,
			record:                 record,
		})
	}
	return normalized, nil
}

func (b *DatabaseBackend) BatchSaveCAS(
	ctx context.Context,
	ownerID string,
	expectedGeneration int64,
	requests []ImageConversationCASRequest,
) (ImageConversationBatchCASResult, error) {
	if expectedGeneration <= 0 {
		return ImageConversationBatchCASResult{}, fmt.Errorf("invalid image conversation CAS precondition")
	}
	ownerKey, err := imageConversationStorageKey(ownerID)
	if err != nil {
		return ImageConversationBatchCASResult{}, err
	}
	normalized, err := normalizeImageConversationCASRequests(requests)
	if err != nil {
		return ImageConversationBatchCASResult{}, err
	}
	tx, state, err := b.beginImageConversationOwnerTx(ctx, ownerKey)
	if err != nil {
		return ImageConversationBatchCASResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	result := ImageConversationBatchCASResult{
		Generation:       state.Generation,
		CursorGeneration: state.CursorGeneration,
		Items:            make([]ImageConversationCASResult, len(normalized)),
	}
	currentRecords := make([]ImageConversationRecord, len(normalized))
	currentExists := make([]bool, len(normalized))
	hasConflict := false
	hasGone := false
	for index, request := range normalized {
		current, exists, loadErr := b.loadImageConversationRecordTx(ctx, tx, ownerKey, request.conversationKey, true)
		if loadErr != nil {
			return result, loadErr
		}
		if exists && current.ID != request.record.ID {
			return result, ErrImageConversationHashCollision
		}
		currentRecords[index] = current
		currentExists[index] = exists
		item := ImageConversationCASResult{
			ID:      request.record.ID,
			Status:  ImageConversationCASReady,
			Exists:  exists,
			Current: current,
		}
		switch {
		case state.Generation != expectedGeneration:
			item.Status = ImageConversationCASGenerationStale
		case exists && current.DeletedAtMillis > 0:
			item.Status = ImageConversationCASGone
			hasGone = true
		case (!exists && request.expectedStorageVersion != 0) || (exists && current.StorageVersion != request.expectedStorageVersion):
			item.Status = ImageConversationCASConflict
			hasConflict = true
		}
		result.Items[index] = item
	}
	if state.Generation != expectedGeneration {
		return result, fmt.Errorf(
			"%w: expected %d, actual %d",
			ErrImageConversationGenerationStale,
			expectedGeneration,
			state.Generation,
		)
	}
	if hasGone || hasConflict {
		failures := make([]error, 0, 2)
		if hasGone {
			failures = append(failures, ErrImageConversationGone)
		}
		if hasConflict {
			failures = append(failures, ErrImageConversationCASConflict)
		}
		return result, errors.Join(failures...)
	}
	savedRecords := make([]ImageConversationRecord, len(normalized))
	for index, request := range normalized {
		record := request.record
		if currentExists[index] {
			current := currentRecords[index]
			if current.StorageVersion <= 0 || current.StorageVersion == math.MaxInt64 {
				return result, fmt.Errorf("image conversation storage version is exhausted")
			}
			record.StorageVersion = current.StorageVersion + 1
			updated, updateErr := b.updateImageConversationRecordCASTx(
				ctx,
				tx,
				ownerKey,
				request.conversationKey,
				current.StorageVersion,
				record,
			)
			if updateErr != nil {
				return result, updateErr
			}
			if !updated {
				return result, ErrImageConversationCASConflict
			}
		} else {
			record.StorageVersion = 1
			if _, insertErr := b.insertImageConversationRecordTx(ctx, tx, ownerKey, request.conversationKey, record, false); insertErr != nil {
				return result, insertErr
			}
		}
		savedRecords[index] = record
	}
	if len(savedRecords) > 0 {
		nextCursorGeneration, nextErr := nextImageConversationCursorGeneration(state.CursorGeneration)
		if nextErr != nil {
			return result, nextErr
		}
		if err := b.updateImageConversationOwnerCursorGenerationTx(ctx, tx, ownerKey, nextCursorGeneration); err != nil {
			return result, err
		}
		result.CursorGeneration = nextCursorGeneration
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	for index, record := range savedRecords {
		result.Items[index].Status = ImageConversationCASSaved
		result.Items[index].Exists = true
		result.Items[index].Current = record
	}
	return result, nil
}

func (b *DatabaseBackend) SaveCAS(
	ctx context.Context,
	ownerID string,
	expectedGeneration, expectedStorageVersion int64,
	record ImageConversationRecord,
) (ImageConversationRecord, error) {
	result, err := b.BatchSaveCAS(ctx, ownerID, expectedGeneration, []ImageConversationCASRequest{{
		ExpectedStorageVersion: expectedStorageVersion,
		Record:                 record,
	}})
	if len(result.Items) == 0 {
		return ImageConversationRecord{}, err
	}
	if errors.Is(err, ErrImageConversationGenerationStale) {
		return ImageConversationRecord{}, err
	}
	return result.Items[0].Current, err
}

func normalizeImageConversationPageLimit(limit int) int {
	if limit <= 0 {
		return defaultImageConversationPageSize
	}
	if limit > maxImageConversationPageSize {
		return maxImageConversationPageSize
	}
	return limit
}

func validateImageConversationCursor(cursor *ImageConversationCursor) error {
	if cursor == nil {
		return nil
	}
	if cursor.Generation <= 0 {
		return fmt.Errorf("invalid image conversation cursor generation")
	}
	if cursor.UpdatedAtMillis < 0 {
		return fmt.Errorf("invalid image conversation cursor timestamp")
	}
	decoded, err := hex.DecodeString(cursor.ConversationKey)
	if err != nil || len(decoded) != sha256.Size || cursor.ConversationKey != strings.ToLower(cursor.ConversationKey) {
		return fmt.Errorf("invalid image conversation cursor key")
	}
	return nil
}

func (b *DatabaseBackend) validateImageConversationGeneration(ctx context.Context, ownerID string, generation int64) (string, ImageConversationOwnerState, error) {
	if generation <= 0 {
		return "", ImageConversationOwnerState{}, fmt.Errorf("invalid image conversation generation")
	}
	ownerKey, err := imageConversationStorageKey(ownerID)
	if err != nil {
		return "", ImageConversationOwnerState{}, err
	}
	state, err := b.LoadOwnerState(ctx, ownerID)
	if err != nil {
		return "", ImageConversationOwnerState{}, err
	}
	if state.Generation != generation {
		return "", state, fmt.Errorf(
			"%w: expected %d, actual %d",
			ErrImageConversationGenerationStale,
			generation,
			state.Generation,
		)
	}
	return ownerKey, state, nil
}

func (b *DatabaseBackend) List(
	ctx context.Context,
	ownerID string,
	generation int64,
	cursor *ImageConversationCursor,
	limit int,
) (ImageConversationPage, error) {
	if err := validateImageConversationCursor(cursor); err != nil {
		return ImageConversationPage{}, err
	}
	ownerKey, state, err := b.validateImageConversationGeneration(ctx, ownerID, generation)
	if err != nil {
		return ImageConversationPage{}, err
	}
	cursorGeneration := state.CursorGeneration
	if cursor != nil {
		cursorGeneration = cursor.Generation
		if cursorGeneration != state.CursorGeneration {
			return ImageConversationPage{}, fmt.Errorf(
				"%w: expected %d, actual %d",
				ErrImageConversationCursorStale,
				cursorGeneration,
				state.CursorGeneration,
			)
		}
	}
	limit = normalizeImageConversationPageLimit(limit)
	arguments := []any{ownerKey}
	query := `SELECT conversation_key, ` + imageConversationSummaryColumns + `
		FROM image_conversations
		WHERE owner_key = ` + b.placeholder(1) + ` AND deleted_at_ms = 0`
	if cursor != nil {
		arguments = append(arguments, cursor.UpdatedAtMillis, cursor.UpdatedAtMillis, cursor.ConversationKey)
		query += ` AND (updated_at_ms < ` + b.placeholder(2) + `
			OR (updated_at_ms = ` + b.placeholder(3) + ` AND conversation_key < ` + b.placeholder(4) + `))`
	}
	arguments = append(arguments, limit+1)
	query += ` ORDER BY updated_at_ms DESC, conversation_key DESC LIMIT ` + b.placeholder(len(arguments))
	rows, err := b.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return ImageConversationPage{}, err
	}
	defer rows.Close()
	records := make([]ImageConversationRecord, 0, limit+1)
	keys := make([]string, 0, limit+1)
	for rows.Next() {
		var key string
		record, scanErr := scanImageConversationSummaryAndKey(rows, &key)
		if scanErr != nil {
			return ImageConversationPage{}, scanErr
		}
		records = append(records, record)
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return ImageConversationPage{}, err
	}
	if err := rows.Close(); err != nil {
		return ImageConversationPage{}, err
	}
	for index := range records {
		if len(records[index].Summary) == 0 {
			return ImageConversationPage{}, fmt.Errorf("image conversation %q has no summary", records[index].ID)
		}
	}
	_, latest, err := b.validateImageConversationGeneration(ctx, ownerID, generation)
	if err != nil {
		return ImageConversationPage{}, err
	}
	if latest.CursorGeneration != cursorGeneration {
		return ImageConversationPage{}, fmt.Errorf(
			"%w: expected %d, actual %d",
			ErrImageConversationCursorStale,
			cursorGeneration,
			latest.CursorGeneration,
		)
	}
	page := ImageConversationPage{Records: records}
	if len(records) > limit {
		page.Records = records[:limit]
		page.NextCursor = &ImageConversationCursor{
			Generation:      cursorGeneration,
			UpdatedAtMillis: records[limit-1].UpdatedAtMillis,
			ConversationKey: keys[limit-1],
		}
	}
	return page, nil
}

func (b *DatabaseBackend) ListActive(ctx context.Context, ownerID string, generation int64, limit int) ([]ImageConversationRecord, error) {
	ownerKey, state, err := b.validateImageConversationGeneration(ctx, ownerID, generation)
	if err != nil {
		return nil, err
	}
	arguments := []any{ownerKey}
	query := `SELECT ` + imageConversationRecordColumns + `
		FROM image_conversations
		WHERE owner_key = ` + b.placeholder(1) + ` AND active = 1 AND deleted_at_ms = 0
		ORDER BY updated_at_ms DESC, conversation_key DESC`
	if limit > 0 {
		arguments = append(arguments, limit)
		query += ` LIMIT ` + b.placeholder(len(arguments))
	}
	rows, err := b.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]ImageConversationRecord, 0)
	for rows.Next() {
		record, scanErr := scanImageConversationRecord(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	_, latest, err := b.validateImageConversationGeneration(ctx, ownerID, generation)
	if err != nil {
		return nil, err
	}
	if latest.CursorGeneration != state.CursorGeneration {
		return nil, fmt.Errorf(
			"%w: expected %d, actual %d",
			ErrImageConversationCursorStale,
			state.CursorGeneration,
			latest.CursorGeneration,
		)
	}
	return records, nil
}

func nextImageConversationGeneration(current int64) (int64, error) {
	if current <= 0 || current == math.MaxInt64 {
		return 0, fmt.Errorf("image conversation generation is exhausted")
	}
	return current + 1, nil
}

func nextImageConversationCursorGeneration(current int64) (int64, error) {
	if current <= 0 || current == math.MaxInt64 {
		return 0, fmt.Errorf("image conversation cursor generation is exhausted")
	}
	return current + 1, nil
}

func (b *DatabaseBackend) tombstoneImageConversationTx(
	ctx context.Context,
	tx *sql.Tx,
	ownerKey, conversationKey string,
	deletedAtMillis int64,
) error {
	statement := `UPDATE image_conversations SET
		storage_version = storage_version + 1,
		active = 0,
		deleted_at_ms = ` + b.placeholder(1) + `,
		summary = NULL,
		data = NULL
		WHERE owner_key = ` + b.placeholder(2) + ` AND conversation_key = ` + b.placeholder(3)
	_, err := tx.ExecContext(ctx, statement, deletedAtMillis, ownerKey, conversationKey)
	return err
}

func (b *DatabaseBackend) updateImageConversationOwnerGenerationTx(
	ctx context.Context,
	tx *sql.Tx,
	ownerKey string,
	generation int64,
) error {
	statement := `UPDATE image_conversation_owners SET generation = ` + b.placeholder(1) + `
		WHERE owner_key = ` + b.placeholder(2)
	_, err := tx.ExecContext(ctx, statement, generation, ownerKey)
	return err
}

func (b *DatabaseBackend) updateImageConversationOwnerCursorGenerationTx(
	ctx context.Context,
	tx *sql.Tx,
	ownerKey string,
	cursorGeneration int64,
) error {
	statement := `UPDATE image_conversation_owners SET cursor_generation = ` + b.placeholder(1) + `
		WHERE owner_key = ` + b.placeholder(2)
	_, err := tx.ExecContext(ctx, statement, cursorGeneration, ownerKey)
	return err
}

func (b *DatabaseBackend) Delete(ctx context.Context, ownerID, conversationID string, deletedAtMillis int64) (bool, error) {
	ownerKey, err := imageConversationStorageKey(ownerID)
	if err != nil {
		return false, err
	}
	conversationID = strings.TrimSpace(conversationID)
	conversationKey, err := imageConversationStorageKey(conversationID)
	if err != nil {
		return false, err
	}
	if deletedAtMillis <= 0 {
		deletedAtMillis = time.Now().UTC().UnixMilli()
	}
	tx, state, err := b.beginImageConversationOwnerTx(ctx, ownerKey)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	current, exists, err := b.loadImageConversationRecordTx(ctx, tx, ownerKey, conversationKey, true)
	if err != nil {
		return false, err
	}
	if exists && current.ID != conversationID {
		return false, ErrImageConversationHashCollision
	}
	removed := exists && current.DeletedAtMillis == 0
	if exists {
		if current.DeletedAtMillis == 0 {
			if err := b.tombstoneImageConversationTx(ctx, tx, ownerKey, conversationKey, deletedAtMillis); err != nil {
				return false, err
			}
		}
	} else {
		tombstone := ImageConversationRecord{
			ID:              conversationID,
			StorageVersion:  1,
			AcceptedHash:    imageConversationDataHash(nil),
			DeletedAtMillis: deletedAtMillis,
		}
		if _, err := b.insertImageConversationRecordTx(ctx, tx, ownerKey, conversationKey, tombstone, false); err != nil {
			return false, err
		}
	}
	nextGeneration, err := nextImageConversationGeneration(state.Generation)
	if err != nil {
		return false, err
	}
	if err := b.updateImageConversationOwnerGenerationTx(ctx, tx, ownerKey, nextGeneration); err != nil {
		return false, err
	}
	nextCursorGeneration, err := nextImageConversationCursorGeneration(state.CursorGeneration)
	if err != nil {
		return false, err
	}
	if err := b.updateImageConversationOwnerCursorGenerationTx(ctx, tx, ownerKey, nextCursorGeneration); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return removed, nil
}

func (b *DatabaseBackend) Clear(
	ctx context.Context,
	ownerID, clearedAt string,
	clearedAtMillis int64,
) (ImageConversationOwnerState, error) {
	ownerKey, err := imageConversationStorageKey(ownerID)
	if err != nil {
		return ImageConversationOwnerState{}, err
	}
	if clearedAtMillis <= 0 {
		clearedAtMillis = time.Now().UTC().UnixMilli()
	}
	clearedAt = strings.TrimSpace(clearedAt)
	if clearedAt == "" {
		clearedAt = time.UnixMilli(clearedAtMillis).UTC().Format(time.RFC3339Nano)
	}
	tx, state, err := b.beginImageConversationOwnerTx(ctx, ownerKey)
	if err != nil {
		return ImageConversationOwnerState{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if state.ClearedAtMillis > clearedAtMillis {
		clearedAtMillis = state.ClearedAtMillis
		clearedAt = state.ClearedAt
	}
	nextGeneration, err := nextImageConversationGeneration(state.Generation)
	if err != nil {
		return ImageConversationOwnerState{}, err
	}
	nextCursorGeneration, err := nextImageConversationCursorGeneration(state.CursorGeneration)
	if err != nil {
		return ImageConversationOwnerState{}, err
	}
	statement := `UPDATE image_conversations SET
		storage_version = storage_version + 1,
		active = 0,
		deleted_at_ms = CASE WHEN deleted_at_ms = 0 THEN ` + b.placeholder(1) + ` ELSE deleted_at_ms END,
		summary = NULL,
		data = NULL
		WHERE owner_key = ` + b.placeholder(2)
	if _, err := tx.ExecContext(ctx, statement, clearedAtMillis, ownerKey); err != nil {
		return ImageConversationOwnerState{}, err
	}
	statement = `UPDATE image_conversation_owners SET
		cleared_at = ` + b.placeholder(1) + `,
		cleared_at_ms = ` + b.placeholder(2) + `,
		generation = ` + b.placeholder(3) + `,
		cursor_generation = ` + b.placeholder(4) + `
		WHERE owner_key = ` + b.placeholder(5)
	if _, err := tx.ExecContext(ctx, statement, clearedAt, clearedAtMillis, nextGeneration, nextCursorGeneration, ownerKey); err != nil {
		return ImageConversationOwnerState{}, err
	}
	if err := tx.Commit(); err != nil {
		return ImageConversationOwnerState{}, err
	}
	return ImageConversationOwnerState{
		ClearedAt:        clearedAt,
		ClearedAtMillis:  clearedAtMillis,
		Generation:       nextGeneration,
		CursorGeneration: nextCursorGeneration,
	}, nil
}
