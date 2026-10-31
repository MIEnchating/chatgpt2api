package service

import (
	"errors"
	"strings"
	"testing"

	"chatgpt2api/internal/storage"
)

func TestLogCursorRoundTrip(t *testing.T) {
	cursor := &storage.LogCursor{SnapshotID: 5, Day: "2026-10-30", ID: 3}
	encoded, err := encodeLogCursor(cursor, "hash")
	if err != nil {
		t.Fatalf("encodeLogCursor() error = %v", err)
	}
	decoded, err := decodeLogCursor(encoded, "hash")
	if err != nil || decoded == nil || *decoded != *cursor {
		t.Fatalf("decodeLogCursor() = (%#v, %v), want %#v", decoded, err, cursor)
	}
	if _, err := decodeLogCursor(encoded, "other"); !errors.Is(err, ErrInvalidLogCursor) {
		t.Fatalf("decodeLogCursor(mismatched hash) error = %v, want invalid cursor", err)
	}
}

func TestDecodeLogCursorHandlesEmptyOversizedAndMalformedValues(t *testing.T) {
	if cursor, err := decodeLogCursor("   ", "hash"); cursor != nil || err != nil {
		t.Fatalf("decodeLogCursor(blank) = (%#v, %v), want nil, nil", cursor, err)
	}
	for name, value := range map[string]string{
		"oversized":  strings.Repeat("a", maxLogCursorLength+1),
		"not base64": "!!!",
		"not json":   "bm90LWpzb24",
	} {
		if _, err := decodeLogCursor(value, "hash"); !errors.Is(err, ErrInvalidLogCursor) {
			t.Errorf("decodeLogCursor(%s) error = %v, want invalid cursor", name, err)
		}
	}
}

func TestEncodeLogCursorRejectsInvalidInput(t *testing.T) {
	if _, err := encodeLogCursor(nil, "hash"); !errors.Is(err, ErrInvalidLogCursor) {
		t.Fatalf("encodeLogCursor(nil) error = %v, want invalid cursor", err)
	}
	if _, err := encodeLogCursor(&storage.LogCursor{SnapshotID: 1}, ""); !errors.Is(err, ErrInvalidLogCursor) {
		t.Fatalf("encodeLogCursor(empty hash) error = %v, want invalid cursor", err)
	}
}

func TestValidStorageLogCursor(t *testing.T) {
	for name, testCase := range map[string]struct {
		cursor storage.LogCursor
		want   bool
	}{
		"zero snapshot":       {storage.LogCursor{}, false},
		"snapshot only":       {storage.LogCursor{SnapshotID: 5}, true},
		"full position":       {storage.LogCursor{SnapshotID: 5, Day: "2026-10-30", ID: 3}, true},
		"id beyond snapshot":  {storage.LogCursor{SnapshotID: 5, Day: "2026-10-30", ID: 6}, false},
		"day without id":      {storage.LogCursor{SnapshotID: 5, Day: "2026-10-30"}, false},
		"id without day":      {storage.LogCursor{SnapshotID: 5, ID: 2}, false},
		"impossible calendar": {storage.LogCursor{SnapshotID: 5, Day: "2026-02-30", ID: 1}, false},
		"wrong day format":    {storage.LogCursor{SnapshotID: 5, Day: "2026-1-3", ID: 1}, false},
		"negative id":         {storage.LogCursor{SnapshotID: 5, Day: "2026-10-30", ID: -1}, false},
	} {
		if got := validStorageLogCursor(testCase.cursor); got != testCase.want {
			t.Errorf("%s: validStorageLogCursor() = %v, want %v", name, got, testCase.want)
		}
	}
}

func TestLogQueryCursorHashNormalizesCaseAndWhitespace(t *testing.T) {
	left := logQueryCursorHash(LogQuery{Username: " Alice ", Module: "Auth", Status: " SUCCESS "})
	right := logQueryCursorHash(LogQuery{Username: "alice", Module: "auth", Status: "success"})
	if left != right {
		t.Fatal("equivalent queries produced different cursor hashes")
	}
	if left == logQueryCursorHash(LogQuery{Username: "alice", Module: "other", Status: "success"}) {
		t.Fatal("different queries produced the same cursor hash")
	}
}

func TestNewLogSearchPageEncodesCursorsOnlyWhenAvailable(t *testing.T) {
	page, err := newLogSearchPage(nil, nil, false, 0, "hash")
	if err != nil || page.SnapshotCursor != "" || page.NextCursor != "" || page.HasMore {
		t.Fatalf("newLogSearchPage(no snapshot) = (%#v, %v)", page, err)
	}
	page, err = newLogSearchPage(nil, nil, false, 7, "hash")
	if err != nil || page.SnapshotCursor == "" || page.NextCursor != "" {
		t.Fatalf("newLogSearchPage(snapshot) = (%#v, %v)", page, err)
	}
	if _, err := newLogSearchPage(nil, nil, true, 7, "hash"); !errors.Is(err, ErrInvalidLogCursor) {
		t.Fatalf("newLogSearchPage(hasMore without next) error = %v, want invalid cursor", err)
	}
	next := &storage.LogCursor{SnapshotID: 7, Day: "2026-10-30", ID: 2}
	page, err = newLogSearchPage(nil, next, true, 7, "hash")
	if err != nil || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("newLogSearchPage(hasMore) = (%#v, %v)", page, err)
	}
}
