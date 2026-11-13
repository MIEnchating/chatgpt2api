package videocontract

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/storage"
)

func TestVideoMaterialUploadCredentialsArePrivateAndScoped(t *testing.T) {
	backend, err := storage.NewDatabaseBackend("sqlite:///" + filepath.ToSlash(filepath.Join(t.TempDir(), "upload-keys.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	svc := NewVideoModelContractService(backend)
	if err := svc.Initialize(); err != nil {
		t.Fatal(err)
	}
	items, err := svc.List()
	if err != nil || len(items) < 2 {
		t.Fatalf("contracts: %v", err)
	}
	a, b := items[0], items[1]
	const origin = "https://upload-a.example.com"
	const other = "https://upload-b.example.com"
	for _, entry := range []struct{ id, url, key string }{{a.ID, origin, "private-key-a"}, {b.ID, origin, "private-key-b"}, {a.ID, other, "private-key-c"}} {
		if err := svc.SetMaterialUploadAPIKey(entry.id, entry.url, entry.key); err != nil {
			t.Fatal(err)
		}
	}
	// Reopening the service must preserve credentials and their independent scopes.
	svc = NewVideoModelContractService(backend)
	if err := svc.Initialize(); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct{ id, url, want string }{{a.ID, origin, "private-key-a"}, {b.ID, origin, "private-key-b"}, {a.ID, other, "private-key-c"}, {b.ID, other, ""}} {
		got, err := svc.MaterialUploadAPIKey(entry.id, entry.url)
		if err != nil || got != entry.want {
			t.Fatalf("credential scope mismatch for %s at %s", entry.id, entry.url)
		}
	}
	if err := svc.SetMaterialUploadAPIKey(a.ID, origin, ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := svc.MaterialUploadAPIKey(b.ID, origin); got != "private-key-b" {
		t.Fatal("clearing A changed B")
	}
	if got, _ := svc.MaterialUploadAPIKey(a.ID, other); got != "private-key-c" {
		t.Fatal("clearing one address changed another")
	}
	if err := svc.SetMaterialUploadAPIKey(a.ID, "http://upload.example.com", "key"); err == nil {
		t.Fatal("insecure key binding accepted")
	}
	if err := svc.SetMaterialUploadAPIKey(a.ID, origin, "key\r\ninjected"); err == nil {
		t.Fatal("header injection accepted")
	}
	if err := svc.SetMaterialUploadAPIKey("missing", origin, "key"); err == nil {
		t.Fatal("missing contract accepted")
	}
	// Public contracts and versions carry no credentials; imports preserve the
	// existing contract's private credentials and copies start unconfigured.
	if _, _, err := svc.Import([]ImportedVideoModelContract{{Contract: b.Contract, Enabled: b.Enabled}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := svc.MaterialUploadAPIKey(b.ID, origin); got != "private-key-b" {
		t.Fatal("reimport lost private key")
	}
	versions, err := svc.Versions(b.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{b.Contract, versions} {
		data, _ := json.Marshal(value)
		if strings.Contains(string(data), "private-key") {
			t.Fatal("public export leaked credential")
		}
	}
	copyContract := b.Contract
	copyContract.Name = "Credential-free copy"
	copyContract.Models = []string{"credential-free-copy"}
	copyContract.ModelProfiles = nil
	copied, err := svc.Create(copyContract, false)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := svc.MaterialUploadAPIKey(copied.ID, origin); got != "" {
		t.Fatal("copy inherited credential")
	}
	if _, err := svc.Delete(b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.MaterialUploadAPIKey(b.ID, origin); err == nil {
		t.Fatal("deleted contract retained accessible key")
	}
}
