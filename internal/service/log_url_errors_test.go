package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogDestinationsSanitizeURLsInErrorChains(t *testing.T) {
	requestErr := &url.Error{
		Op: "Get", URL: "https://private-user:private-password@cdn.example.test/image.png?signature=private-signature#private-fragment",
		Err: errors.New("upstream unavailable"),
	}
	secondErr := &url.Error{
		Op: "Post", URL: "https://upload.example.test/object?token=private-token",
		Err: errors.New("connection reset"),
	}
	for name, failure := range map[string]error{
		"direct":  requestErr,
		"wrapped": fmt.Errorf("download storage object: %w", requestErr),
		"joined":  errors.Join(requestErr, fmt.Errorf("rollback upload: %w", secondErr)),
	} {
		t.Run(name, func(t *testing.T) {
			logs := NewLogService(newTestStorageBackend(t))
			if err := logs.Add("storage operation failed", map[string]any{"error": failure}); err != nil {
				t.Fatal(err)
			}
			stored, err := json.Marshal(mustSearchLogs(t, logs, LogQuery{}))
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			logger, err := NewLogger(root, nil)
			if err != nil {
				t.Fatal(err)
			}
			logger.Error("storage operation failed", "error", failure)
			if err := logger.Close(); err != nil {
				t.Fatal(err)
			}
			file, err := os.ReadFile(filepath.Join(root, "logs", "server.log"))
			if err != nil {
				t.Fatal(err)
			}
			for destination, data := range map[string][]byte{"database": stored, "file": file} {
				text := string(data)
				if strings.Contains(text, "private-") || !strings.Contains(text, "https://cdn.example.test/image.png") || !strings.Contains(text, "upstream unavailable") {
					t.Fatalf("%s log did not sanitize error URL: %s", destination, text)
				}
			}
		})
	}
}
