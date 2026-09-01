package httpapi

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAppStartupCleanupRunsOnceInShutdownOrder(t *testing.T) {
	order := make([]string, 0, 4)
	cleanup := &appStartupCleanup{
		cancel: func() { order = append(order, "cancel") },
	}
	for _, name := range []string{"backend", "logger", "scheduler"} {
		name := name
		cleanup.add(func() { order = append(order, name) })
	}

	cleanup.run()
	cleanup.run()
	if want := []string{"cancel", "scheduler", "logger", "backend"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("cleanup order = %#v, want %#v", order, want)
	}
}

func TestAppStartupCleanupCommitTransfersOwnership(t *testing.T) {
	called := false
	cleanup := &appStartupCleanup{cancel: func() { called = true }}
	cleanup.add(func() { called = true })

	cleanup.commit()
	cleanup.run()
	if called {
		t.Fatal("committed startup cleanup released application-owned resources")
	}
}

func TestNewAppClosesResourcesAfterLateInitializationFailure(t *testing.T) {
	if _, err := os.ReadDir("/proc/self/fd"); err != nil {
		t.Skip("open file descriptor inspection is unavailable")
	}

	root := t.TempDir()
	t.Setenv("ROOT_DIR", root)
	t.Setenv("ADMIN_USERNAME", testAdminUsername)
	t.Setenv("ADMIN_PASSWORD", testAdminPassword)
	t.Setenv("STORAGE_BACKEND", "sqlite")
	t.Setenv("STORAGE_DATABASE_URL", "")
	for _, key := range []string{
		"OBJECT_STORAGE_SETTINGS",
		"DATABASE_URL",
		"DATABASE_TYPE",
		"DATABASE_DRIVER",
		"DATABASE_HOST",
		"DATABASE_PORT",
		"DATABASE_NAME",
		"DATABASE_USER",
		"DATABASE_PASSWORD",
	} {
		unsetTestEnv(t, key)
	}

	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "videos"), []byte("block directory creation"), 0o600); err != nil {
		t.Fatalf("create video directory blocker: %v", err)
	}

	app, err := NewApp()
	if err == nil || app != nil || !strings.Contains(err.Error(), "initialize video storage") {
		if app != nil {
			app.Close()
		}
		t.Fatalf("NewApp() = (%v, %v), want video storage initialization failure", app, err)
	}
	if open := openFileDescriptorsUnder(t, dataDir); len(open) != 0 {
		t.Fatalf("NewApp() left startup file descriptors open: %#v", open)
	}
}

func openFileDescriptorsUnder(t *testing.T, root string) []string {
	t.Helper()
	root, err := filepath.Abs(root)
	if err != nil {
		t.Fatalf("resolve descriptor root: %v", err)
	}
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatalf("read process descriptors: %v", err)
	}
	prefix := root + string(os.PathSeparator)
	targets := make([]string, 0)
	for _, entry := range entries {
		target, readErr := os.Readlink(filepath.Join("/proc/self/fd", entry.Name()))
		if readErr != nil {
			continue
		}
		target = strings.TrimSuffix(target, " (deleted)")
		if target == root || strings.HasPrefix(target, prefix) {
			targets = append(targets, target)
		}
	}
	return targets
}
