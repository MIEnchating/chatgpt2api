package service

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

func TestNewAPITokenReaderSchemaProbesIgnoreOtherDatabases(t *testing.T) {
	for _, environment := range []string{"TEST_POSTGRES_DATABASE_URL", "TEST_MYSQL_DATABASE_URL"} {
		t.Run(environment, func(t *testing.T) {
			databaseURL := strings.TrimSpace(os.Getenv(environment))
			if databaseURL == "" {
				t.Skip(environment + " is not configured")
			}
			driver, dsn, err := storage.ParseDatabaseURL(databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open(driver, dsn)
			if err != nil {
				t.Fatal(err)
			}
			db.SetMaxOpenConns(1)
			t.Cleanup(func() { _ = db.Close() })
			reader := &NewAPITokenReader{db: db, driver: driver}
			local := "review_local_" + util.NewHex(6)
			other := "review_other_" + util.NewHex(6)
			execute := func(query string) {
				t.Helper()
				if _, err := db.Exec(query); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{local, other} {
				if driver == "postgres" {
					execute("CREATE SCHEMA " + reader.quoteIdentifier(name))
					t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA " + reader.quoteIdentifier(name) + " CASCADE") })
				} else {
					execute("CREATE DATABASE " + reader.quoteIdentifier(name))
					t.Cleanup(func() { _, _ = db.Exec("DROP DATABASE " + reader.quoteIdentifier(name)) })
				}
			}
			execute("CREATE TABLE " + reader.quoteIdentifier(local) + ".users (id INTEGER)")
			execute("CREATE TABLE " + reader.quoteIdentifier(other) + ".users (id INTEGER, role INTEGER)")
			execute("CREATE TABLE " + reader.quoteIdentifier(other) + ".usage_logs (id INTEGER)")
			if driver == "postgres" {
				execute("SET search_path TO " + reader.quoteIdentifier(local))
			} else {
				execute("USE " + reader.quoteIdentifier(local))
			}
			ctx := context.Background()
			if !reader.hasTable(ctx, "users") || !reader.hasTableColumn(ctx, "users", "id") {
				t.Fatal("schema probes failed to find the selected database table")
			}
			if reader.hasTableColumn(ctx, "users", "role") {
				t.Error("schema probe accepted a role column from another database")
			}
			if reader.hasTable(ctx, "usage_logs") {
				t.Error("schema probe accepted a table from another database")
			}
		})
	}
}
