package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"chatgpt2api/internal/storage"
)

const (
	logCursorVersion   = 1
	maxLogCursorLength = 1024
)

var ErrInvalidLogCursor = errors.New("invalid log cursor")

type LogSearchPage struct {
	Items          []map[string]any
	SnapshotCursor string
	NextCursor     string
	HasMore        bool
}

type logOpaqueCursor struct {
	Version    int    `json:"v"`
	SnapshotID int64  `json:"s"`
	Day        string `json:"d"`
	ID         int64  `json:"i"`
	QueryHash  string `json:"q"`
}

type logCursorQueryScope struct {
	Username      string `json:"username"`
	Module        string `json:"module"`
	Method        string `json:"method"`
	Summary       string `json:"summary"`
	Status        string `json:"status"`
	IPAddress     string `json:"ip_address"`
	OperationType string `json:"operation_type"`
	LogLevel      string `json:"log_level"`
	StartDate     string `json:"start_date"`
	EndDate       string `json:"end_date"`
	StartTime     string `json:"start_time"`
	EndTime       string `json:"end_time"`
	View          string `json:"view"`
}

func (s *LogService) SearchPage(query LogQuery) (LogSearchPage, error) {
	limit := normalizedLogLimit(query.Limit)
	if s == nil || s.store == nil {
		return LogSearchPage{}, fmt.Errorf("log storage backend is required")
	}
	pager, ok := s.store.(storage.LogPageBackend)
	if !ok {
		return LogSearchPage{}, fmt.Errorf("log page storage backend is required")
	}
	queryHash := logQueryCursorHash(query)
	cursor, err := decodeLogCursor(query.Cursor, queryHash)
	if err != nil {
		return LogSearchPage{}, err
	}
	startDate, endDate := logQueryDateBounds(query)
	return searchFilteredLogPage(pager, query, startDate, endDate, cursor, queryHash, limit)
}

func searchFilteredLogPage(pager storage.LogPageBackend, query LogQuery, startDate, endDate string, cursor *storage.LogCursor, queryHash string, limit int) (LogSearchPage, error) {
	batchSize := min(max(256, limit*2), 1000)
	out := make([]map[string]any, 0, limit)
	snapshotID := int64(0)
	if cursor != nil {
		snapshotID = cursor.SnapshotID
	}
	var lastMatchCursor *storage.LogCursor
	for {
		page, err := pager.QueryLogPage(startDate, endDate, cursor, batchSize)
		if err != nil {
			return LogSearchPage{}, fmt.Errorf("query log page: %w", err)
		}
		if snapshotID == 0 {
			snapshotID = page.SnapshotID
		}
		for _, record := range page.Records {
			if !matchLogQuery(record.Item, query) {
				continue
			}
			if len(out) == limit {
				return newLogSearchPage(out, lastMatchCursor, true, snapshotID, queryHash)
			}
			out = append(out, publicLogItem(record.Item))
			matchCursor := record.Cursor
			lastMatchCursor = &matchCursor
		}
		if page.NextCursor == nil {
			return newLogSearchPage(out, nil, false, snapshotID, queryHash)
		}
		cursor = page.NextCursor
	}
}

func newLogSearchPage(items []map[string]any, next *storage.LogCursor, hasMore bool, snapshotID int64, queryHash string) (LogSearchPage, error) {
	result := LogSearchPage{Items: items, HasMore: hasMore}
	var err error
	if snapshotID > 0 {
		result.SnapshotCursor, err = encodeLogCursor(&storage.LogCursor{SnapshotID: snapshotID}, queryHash)
		if err != nil {
			return LogSearchPage{}, err
		}
	}
	if hasMore {
		result.NextCursor, err = encodeLogCursor(next, queryHash)
		if err != nil {
			return LogSearchPage{}, err
		}
	}
	return result, nil
}

func encodeLogCursor(cursor *storage.LogCursor, queryHash string) (string, error) {
	if cursor == nil || !validStorageLogCursor(*cursor) || queryHash == "" {
		return "", fmt.Errorf("encode log cursor: %w", ErrInvalidLogCursor)
	}
	payload, err := json.Marshal(logOpaqueCursor{
		Version:    logCursorVersion,
		SnapshotID: cursor.SnapshotID,
		Day:        cursor.Day,
		ID:         cursor.ID,
		QueryHash:  queryHash,
	})
	if err != nil {
		return "", fmt.Errorf("encode log cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeLogCursor(value, queryHash string) (*storage.LogCursor, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if len(value) > maxLogCursorLength {
		return nil, ErrInvalidLogCursor
	}
	payload, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(payload) > maxLogCursorLength {
		return nil, ErrInvalidLogCursor
	}
	decoded := logOpaqueCursor{}
	if err := json.Unmarshal(payload, &decoded); err != nil ||
		decoded.Version != logCursorVersion ||
		decoded.QueryHash != queryHash ||
		!validStorageLogCursor(storage.LogCursor{SnapshotID: decoded.SnapshotID, Day: decoded.Day, ID: decoded.ID}) {
		return nil, ErrInvalidLogCursor
	}
	return &storage.LogCursor{SnapshotID: decoded.SnapshotID, Day: decoded.Day, ID: decoded.ID}, nil
}

func validStorageLogCursor(cursor storage.LogCursor) bool {
	if cursor.SnapshotID <= 0 {
		return false
	}
	if cursor.ID == 0 || cursor.Day == "" {
		return cursor.ID == 0 && cursor.Day == ""
	}
	if cursor.ID <= 0 || cursor.ID > cursor.SnapshotID || len(cursor.Day) != len("2006-01-02") {
		return false
	}
	parsed, err := time.Parse("2006-01-02", cursor.Day)
	return err == nil && parsed.Format("2006-01-02") == cursor.Day
}

func logQueryCursorHash(query LogQuery) string {
	status := strings.TrimSpace(query.Status)
	if strings.EqualFold(status, "success") || strings.EqualFold(status, "failed") {
		status = strings.ToLower(status)
	}
	scope := logCursorQueryScope{
		Username:      strings.ToLower(strings.TrimSpace(query.Username)),
		Module:        strings.ToLower(strings.TrimSpace(query.Module)),
		Method:        strings.ToLower(strings.TrimSpace(query.Method)),
		Summary:       strings.ToLower(strings.TrimSpace(query.Summary)),
		Status:        status,
		IPAddress:     strings.ToLower(strings.TrimSpace(query.IPAddress)),
		OperationType: strings.ToLower(strings.TrimSpace(query.OperationType)),
		LogLevel:      strings.ToLower(strings.TrimSpace(query.LogLevel)),
		StartDate:     strings.TrimSpace(query.StartDate),
		EndDate:       strings.TrimSpace(query.EndDate),
		StartTime:     normalizeLogTimeFilter(query.StartTime, false),
		EndTime:       normalizeLogTimeFilter(query.EndTime, true),
		View:          NormalizeLogView(query.View, LogViewAll),
	}
	payload, _ := json.Marshal(scope)
	digest := sha256.Sum256(payload)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
