package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"chatgpt2api/internal/model"

	"golang.org/x/net/webdav"
)

func TestGenericWebDAVEncodedRootPath(t *testing.T) {
	ctx := context.Background()
	root := "/素材 空格+%#?"
	fs := webdav.NewMemFS()
	if err := fs.Mkdir(ctx, root, 0o755); err != nil {
		t.Fatal(err)
	}
	handler := &webdav.Handler{FileSystem: fs, LockSystem: webdav.NewMemLS()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	defer server.Close()
	provider := model.StorageProvider{Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL + "/" + url.PathEscape(strings.TrimPrefix(root, "/")), PathPrefix: "assets"}
	key := "assets/图片 +%#?.png"
	if err := putGenericWebDAVObject(ctx, provider, key, strings.NewReader("image"), 5); err != nil {
		t.Fatal(err)
	}
	object, err := downloadGenericWebDAVObject(ctx, provider, model.StorageObject{ObjectKey: key, Bytes: 5}, "")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(object.Stream)
	object.Stream.Close()
	if err != nil || string(data) != "image" {
		t.Fatalf("download = %q, %v", data, err)
	}
	if err := deleteGenericWebDAVObject(ctx, provider, key); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Stat(ctx, root+"/"+key); err == nil {
		t.Fatal("object was not deleted")
	}
}

func TestCleanStorageObjectPath(t *testing.T) {
	for input, want := range map[string]string{
		"a/b.png":   "a/b.png",
		"/a/b/":     "a/b",
		"a:1/b.png": "a:1/b.png",
	} {
		got, err := cleanStorageObjectPath(input)
		if err != nil || got != want {
			t.Errorf("cleanStorageObjectPath(%q) = (%q, %v), want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"", "a//b", "a/../b", "./a", "a/./b", "..", "a/b\x00c"} {
		if got, err := cleanStorageObjectPath(input); err == nil {
			t.Errorf("cleanStorageObjectPath(%q) = %q, want error", input, got)
		}
	}
}

func TestNewGenericWebDAVClientValidatesEndpoint(t *testing.T) {
	for _, endpoint := range []string{"", "not a url", "ftp://dav.example.test", "https://user:pass@dav.example.test", "https://dav.example.test/root#fragment"} {
		if _, err := newGenericWebDAVClient(context.Background(), model.StorageProvider{Endpoint: endpoint}); err == nil {
			t.Errorf("newGenericWebDAVClient(%q) succeeded, want error", endpoint)
		}
	}
	if _, err := newGenericWebDAVClient(context.Background(), model.StorageProvider{Endpoint: " https://dav.example.test/root/ "}); err != nil {
		t.Fatalf("newGenericWebDAVClient(valid) error = %v", err)
	}
}

func TestMeasureGenericWebDAVProviderSumsNestedFiles(t *testing.T) {
	server := httptest.NewServer(&webdav.Handler{FileSystem: webdav.NewMemFS(), LockSystem: webdav.NewMemLS()})
	defer server.Close()
	provider := model.StorageProvider{Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL, PathPrefix: "assets"}
	ctx := context.Background()
	if err := putGenericWebDAVObject(ctx, provider, "assets/nested/one.bin", strings.NewReader("123"), 3); err != nil {
		t.Fatalf("put nested object: %v", err)
	}
	if err := putGenericWebDAVObject(ctx, provider, "assets/two.bin", strings.NewReader("4567"), 4); err != nil {
		t.Fatalf("put top-level object: %v", err)
	}
	used, err := measureGenericWebDAVProvider(ctx, provider)
	if err != nil || used != 7 {
		t.Fatalf("measureGenericWebDAVProvider() = (%d, %v), want 7", used, err)
	}
	missing := provider
	missing.PathPrefix = "missing"
	if used, err := measureGenericWebDAVProvider(ctx, missing); err != nil || used != 0 {
		t.Fatalf("measureGenericWebDAVProvider(missing prefix) = (%d, %v), want 0", used, err)
	}
}

func TestDeleteGenericWebDAVObjectRemovesEmptyParentsBelowPrefix(t *testing.T) {
	fileSystem := webdav.NewMemFS()
	server := httptest.NewServer(&webdav.Handler{FileSystem: fileSystem, LockSystem: webdav.NewMemLS()})
	defer server.Close()
	provider := model.StorageProvider{Type: model.StorageProviderTypeWebDAV, Endpoint: server.URL, PathPrefix: "assets"}
	ctx := context.Background()
	key := "assets/a/b/object.bin"
	if err := putGenericWebDAVObject(ctx, provider, key, strings.NewReader("x"), 1); err != nil {
		t.Fatalf("put object: %v", err)
	}
	if err := deleteGenericWebDAVObject(ctx, provider, key); err != nil {
		t.Fatalf("delete object: %v", err)
	}
	if _, err := fileSystem.Stat(ctx, "/assets/a"); err == nil {
		t.Fatal("empty parent directory below the prefix was not removed")
	}
	if _, err := fileSystem.Stat(ctx, "/assets"); err != nil {
		t.Fatalf("prefix directory must be kept: %v", err)
	}
	if err := deleteGenericWebDAVObject(ctx, provider, "assets/../escape"); err == nil {
		t.Fatal("deleteGenericWebDAVObject accepted a traversal key")
	}
}
