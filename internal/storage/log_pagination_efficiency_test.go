package storage

import (
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLogPageSeeksWithinCursorDay(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "logs.db"))
	query, args := backend.positionedLogPageQuery("2026-09-01", "2026-09-14", LogCursor{
		SnapshotID: 100000, Day: "2026-09-14", ID: 500,
	}, 101)
	rows, err := backend.db.Query("EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var detail string
		if err := rows.Scan(new(int), new(int), new(int), &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(plan, "\n"), "idx_logs_day_id (day=? AND id<?)") {
		t.Fatalf("cursor page does not seek by both day and ID: %v", plan)
	}
}

func TestLogPageCursorRespectsDateBoundsAcrossBackfilledDays(t *testing.T) {
	backend := openSQLiteStorageTestBackend(t, filepath.Join(t.TempDir(), "logs.db"))
	for _, day := range []string{"10", "12", "11", "12", "09", "11", "12", "13"} {
		if err := backend.AppendLog(map[string]any{"time": "2026-09-" + day + " 10:00:00", "summary": day}); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		name  string
		start string
		end   string
		ids   []int64
	}{
		{name: "all", ids: []int64{8, 7, 4, 2, 6, 3, 1, 5}},
		{name: "same day", start: "2026-09-12", end: "2026-09-12", ids: []int64{7, 4, 2}},
		{name: "bounded", start: "2026-09-10", end: "2026-09-12", ids: []int64{7, 4, 2, 6, 3, 1}},
		{name: "before cursor", end: "2026-09-11", ids: []int64{6, 3, 1, 5}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var ids []int64
			var cursor *LogCursor
			for pageIndex := 0; ; pageIndex++ {
				if pageIndex > 10 {
					t.Fatal("pagination did not terminate")
				}
				page, err := backend.QueryLogPage(test.start, test.end, cursor, 2)
				if err != nil {
					t.Fatal(err)
				}
				for _, record := range page.Records {
					ids = append(ids, record.Cursor.ID)
				}
				if page.NextCursor == nil {
					break
				}
				cursor = page.NextCursor
			}
			if !reflect.DeepEqual(ids, test.ids) {
				t.Fatalf("page IDs = %v, want %v", ids, test.ids)
			}
		})
	}
	for _, test := range []struct {
		start string
		end   string
		ids   []int64
	}{
		{end: "2026-09-11", ids: []int64{6, 3, 1, 5}},
		{start: "2026-09-13"},
	} {
		page, err := backend.QueryLogPage(test.start, test.end, &LogCursor{SnapshotID: 8, Day: "2026-09-12", ID: 7}, 10)
		if err != nil {
			t.Fatal(err)
		}
		var ids []int64
		for _, record := range page.Records {
			ids = append(ids, record.Cursor.ID)
		}
		if !reflect.DeepEqual(ids, test.ids) {
			t.Fatalf("positioned page %q..%q = %v, want %v", test.start, test.end, ids, test.ids)
		}
	}
}

func BenchmarkLogPageDeepCursor(b *testing.B) {
	backend, err := NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(b.TempDir(), "logs.db")))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = backend.Close() })
	if _, err := backend.db.Exec(`WITH RECURSIVE sequence(id) AS (
		VALUES(1) UNION ALL SELECT id + 1 FROM sequence WHERE id < 100000
	) INSERT INTO logs (id, created_at, type, day, data)
		SELECT id, '2026-09-14 12:00:00', 'event', '2026-09-14', '{"time":"2026-09-14 12:00:00"}' FROM sequence`); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		page, err := backend.QueryLogPage("2026-09-01", "2026-09-14", &LogCursor{SnapshotID: 100000, Day: "2026-09-14", ID: 500}, 100)
		if err != nil || len(page.Records) != 100 {
			b.Fatal(fmt.Errorf("deep log page: records=%d: %w", len(page.Records), err))
		}
	}
}
