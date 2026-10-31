package protocol

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func relayTestEnvelope(provider, data string) string {
	if provider == "sub2api" {
		return `{"code":0,"data":` + data + `}`
	}
	return `{"success":true,"data":` + data + `}`
}

func newRelayTestClient(t *testing.T, server *httptest.Server, provider string) *RelayManagementClient {
	t.Helper()
	client, err := NewRelayManagementClient(server.URL, provider, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	client.token, client.userID = "tok", 7
	return client
}

func relayTestKey(t *testing.T, bits int) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func decryptRelayPassword(key *rsa.PrivateKey, keyID, encrypted string) (string, error) {
	parts := strings.Split(encrypted, ".")
	if len(parts) != 4 || parts[0] != "v2" {
		return "", fmt.Errorf("unexpected format %q", encrypted)
	}
	raw := make([][]byte, 3)
	for index := range raw {
		decoded, err := base64.StdEncoding.DecodeString(parts[index+1])
		if err != nil {
			return "", err
		}
		raw[index] = decoded
	}
	secret, err := rsa.DecryptOAEP(sha256.New(), nil, key, raw[0], []byte("password-v2"))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(secret)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, raw[1], raw[2], []byte("password-v2:"+keyID))
	return string(plain), err
}

func TestEncryptRelayPasswordRoundTripsAndBindsKeyID(t *testing.T) {
	key, publicPEM := relayTestKey(t, 2048)
	first, err := encryptRelayPassword("p@ss word", "kid-1", publicPEM)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := decryptRelayPassword(key, "kid-1", first); err != nil || got != "p@ss word" {
		t.Fatalf("decrypted = %q, %v", got, err)
	}
	if _, err := decryptRelayPassword(key, "kid-2", first); err == nil {
		t.Fatal("ciphertext decrypts under a different key id")
	}
	second, err := encryptRelayPassword("p@ss word", "kid-1", publicPEM)
	if err != nil || second == first {
		t.Fatalf("ciphertext is not randomized: %v", err)
	}
}

func TestEncryptRelayPasswordRejectsInvalidKeys(t *testing.T) {
	_, goodPEM := relayTestKey(t, 2048)
	_, weakPEM := relayTestKey(t, 1024)
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecDER, err := x509.MarshalPKIXPublicKey(&ecKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct{ keyID, publicKey string }{
		"not pem":      {"k", "not a key"},
		"empty key id": {"", goodPEM},
		"garbage der":  {"k", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte{1, 2, 3}}))},
		"weak rsa":     {"k", weakPEM},
		"non rsa":      {"k", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: ecDER}))},
	} {
		if _, err := encryptRelayPassword("pw", tc.keyID, tc.publicKey); err == nil {
			t.Errorf("%s: accepted invalid key", name)
		}
	}
}

func TestNewRelayManagementClientRestrictsSchemeAndRequiresClient(t *testing.T) {
	client := &http.Client{}
	for _, tc := range []struct {
		name, baseURL, provider string
		client                  *http.Client
		ok                      bool
	}{
		{"https", "https://relay.example.com/", "newapi", client, true},
		{"https sub2api", "https://relay.example.com", "sub2api", client, true},
		{"loopback ipv4", "http://127.0.0.1:8080", "newapi", client, true},
		{"loopback name", "http://localhost:8080", "newapi", client, true},
		{"loopback ipv6", "http://[::1]:8080", "newapi", client, true},
		{"plain http", "http://relay.example.com", "newapi", client, false},
		{"http private", "http://192.168.1.2", "newapi", client, false},
		{"http lookalike", "http://127.0.0.1.example.com", "newapi", client, false},
		{"ftp", "ftp://relay.example.com", "newapi", client, false},
		{"credentials", "https://user:pw@relay.example.com", "newapi", client, false},
		{"query", "https://relay.example.com?x=1", "newapi", client, false},
		{"fragment", "https://relay.example.com#x", "newapi", client, false},
		{"empty", "", "newapi", client, false},
		{"bad provider", "https://relay.example.com", "other", client, false},
		{"nil client", "https://relay.example.com", "newapi", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NewRelayManagementClient(tc.baseURL, tc.provider, tc.client)
			if (err == nil) != tc.ok {
				t.Fatalf("error = %v, want success %v", err, tc.ok)
			}
			if tc.ok && got.client == client {
				t.Fatal("injected client was not cloned")
			}
		})
	}
	if client.CheckRedirect != nil {
		t.Fatal("injected client was mutated")
	}
}

func TestRelayManagementLoginEncryptsPasswordAndVerifiesIdentity(t *testing.T) {
	key, publicPEM := relayTestKey(t, 2048)
	encodedPEM, err := json.Marshal(publicPEM)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name         string
		serverUserID int64
		ok           bool
	}{{"matching identity", 7, true}, {"other identity", 8, false}} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/user/login/encryption-key":
					w.Write([]byte(relayTestEnvelope("newapi", `{"enabled":true,"kid":"k1","public_key":`+string(encodedPEM)+`}`)))
				case "/api/user/login":
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Errorf("login body: %v", err)
						return
					}
					if _, plain := body["password"]; plain || r.Method != http.MethodPost || body["username"] != "alice" || body["encryption_key_id"] != "k1" {
						t.Errorf("login body = %#v", body)
					}
					encrypted, _ := body["password_encrypted"].(string)
					if got, err := decryptRelayPassword(key, "k1", encrypted); err != nil || got != "secret-pw" {
						t.Errorf("decrypted password = %q, %v", got, err)
					}
					w.Write([]byte(relayTestEnvelope("newapi", fmt.Sprintf(`{"access_token":"tok","user":{"id":%d}}`, tc.serverUserID))))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			client, err := NewRelayManagementClient(server.URL, "newapi", server.Client())
			if err != nil {
				t.Fatal(err)
			}
			err = client.Login(context.Background(), 7, "alice", "alice@example.com", "secret-pw")
			if (err == nil) != tc.ok {
				t.Fatalf("Login() error = %v, want success %v", err, tc.ok)
			}
			if tc.ok && (client.token != "tok" || client.userID != 7) {
				t.Fatalf("session = %q, %d", client.token, client.userID)
			}
			if !tc.ok && (client.token != "" || client.userID != 0) {
				t.Fatal("credential kept after identity mismatch")
			}
		})
	}
}

func TestRelayManagementLoginStopsWhenEncryptionKeyUnavailable(t *testing.T) {
	var logins atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/user/login" {
			logins.Add(1)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	client, err := NewRelayManagementClient(server.URL, "newapi", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Login(context.Background(), 7, "alice", "alice@example.com", "secret-pw"); err == nil {
		t.Fatal("Login() succeeded without the encryption key")
	}
	if logins.Load() != 0 {
		t.Fatal("password was sent without the encryption key")
	}
}

func TestRelayManagementTokensPaginatesWithAuthorization(t *testing.T) {
	for _, tc := range []struct{ provider, path, pageKey string }{{"newapi", "/api/token/", "p"}, {"sub2api", "/api/v1/keys", "page"}} {
		t.Run(tc.provider, func(t *testing.T) {
			var mu sync.Mutex
			var pages []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer tok" || r.URL.Path != tc.path || r.URL.Query().Get("page_size") != "100" {
					t.Errorf("unexpected request %q %s", r.Header.Get("Authorization"), r.URL.String())
				}
				page := r.URL.Query().Get(tc.pageKey)
				mu.Lock()
				pages = append(pages, page)
				mu.Unlock()
				data := `{"items":[{"id":3,"user_id":7}],"total":3}`
				if page == "1" {
					data = `{"items":[{"id":1,"user_id":7},{"id":2,"user_id":7}],"total":3}`
				}
				w.Write([]byte(relayTestEnvelope(tc.provider, data)))
			}))
			defer server.Close()
			tokens, err := newRelayTestClient(t, server, tc.provider).Tokens(context.Background())
			mu.Lock()
			defer mu.Unlock()
			if err != nil || len(tokens) != 3 || tokens[2].ID != 3 || strings.Join(pages, ",") != "1,2" {
				t.Fatalf("tokens = %#v, pages = %v, err = %v", tokens, pages, err)
			}
		})
	}
}

func TestRelayManagementTokensAcceptsEmptyList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(relayTestEnvelope("newapi", `{"items":[],"total":0}`)))
	}))
	defer server.Close()
	tokens, err := newRelayTestClient(t, server, "newapi").Tokens(context.Background())
	if err != nil || len(tokens) != 0 {
		t.Fatalf("tokens = %#v, err = %v", tokens, err)
	}
}

func TestRelayManagementTokensRejectsInvalidPages(t *testing.T) {
	for _, tc := range []struct{ name, data, want string }{
		{"foreign user", `{"items":[{"id":1,"user_id":8}],"total":1}`, "身份不一致"},
		{"zero id", `{"items":[{"id":0,"user_id":7}],"total":1}`, "身份不一致"},
		{"missing total", `{"items":[]}`, "分页信息无效"},
		{"negative total", `{"items":[],"total":-1}`, "分页信息无效"},
		{"short page", `{"items":[],"total":2}`, "不完整"},
		{"page limit", `{"items":[{"id":1,"user_id":7}],"total":5000}`, "超过读取上限"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(relayTestEnvelope("newapi", tc.data)))
			}))
			defer server.Close()
			_, err := newRelayTestClient(t, server, "newapi").Tokens(context.Background())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Tokens() error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestRelayManagementRequestClassifiesFailuresAndRejectsRedirects(t *testing.T) {
	for _, tc := range []struct {
		status   int
		rejected bool
	}{{http.StatusInternalServerError, false}, {http.StatusForbidden, true}, {http.StatusRequestTimeout, false}} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				w.Write([]byte("private-secret"))
			}))
			defer server.Close()
			_, err := newRelayTestClient(t, server, "newapi").Tokens(context.Background())
			var failure *RelayManagementError
			if !errors.As(err, &failure) || failure.Status != tc.status || failure.Rejected != tc.rejected || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("Tokens() error = %v, want status %d rejected %v", err, tc.status, tc.rejected)
			}
		})
	}
	var followed atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	if _, err := newRelayTestClient(t, server, "newapi").Tokens(context.Background()); err == nil {
		t.Fatal("redirect response was accepted")
	}
	if followed.Load() != 0 {
		t.Fatal("redirect was followed with the dashboard credential")
	}
}

func TestRelayManagedTokenUsable(t *testing.T) {
	at := func(offset time.Duration) *time.Time {
		value := time.Now().Add(offset)
		return &value
	}
	now := time.Now().Unix()
	for _, tc := range []struct {
		name     string
		provider string
		token    RelayManagedToken
		want     bool
	}{
		{"newapi unlimited", "newapi", RelayManagedToken{Status: json.RawMessage(`1`), ExpiredTime: -1, UnlimitedQuota: true}, true},
		{"newapi disabled", "newapi", RelayManagedToken{Status: json.RawMessage(`2`), ExpiredTime: -1, UnlimitedQuota: true}, false},
		{"newapi expired", "newapi", RelayManagedToken{Status: json.RawMessage(`1`), ExpiredTime: now - 10, UnlimitedQuota: true}, false},
		{"newapi future expiry", "newapi", RelayManagedToken{Status: json.RawMessage(`1`), ExpiredTime: now + 3600, UnlimitedQuota: true}, true},
		{"newapi zero expiry is not permanent", "newapi", RelayManagedToken{Status: json.RawMessage(`1`), ExpiredTime: 0, UnlimitedQuota: true}, false},
		{"newapi exhausted", "newapi", RelayManagedToken{Status: json.RawMessage(`1`), ExpiredTime: -1}, false},
		{"newapi remaining quota", "newapi", RelayManagedToken{Status: json.RawMessage(`1`), ExpiredTime: -1, RemainQuota: 5}, true},
		{"sub2api active", "sub2api", RelayManagedToken{Status: json.RawMessage(`"active"`)}, true},
		{"sub2api inactive", "sub2api", RelayManagedToken{Status: json.RawMessage(`"inactive"`)}, false},
		{"sub2api numeric status", "sub2api", RelayManagedToken{Status: json.RawMessage(`1`)}, false},
		{"sub2api expired", "sub2api", RelayManagedToken{Status: json.RawMessage(`"active"`), ExpiresAt: at(-time.Minute)}, false},
		{"sub2api future expiry", "sub2api", RelayManagedToken{Status: json.RawMessage(`"active"`), ExpiresAt: at(time.Hour)}, true},
		{"sub2api quota used up", "sub2api", RelayManagedToken{Status: json.RawMessage(`"active"`), Quota: 10, QuotaUsed: 10}, false},
		{"sub2api quota left", "sub2api", RelayManagedToken{Status: json.RawMessage(`"active"`), Quota: 10, QuotaUsed: 5}, true},
		{"sub2api unlimited quota", "sub2api", RelayManagedToken{Status: json.RawMessage(`"active"`), Quota: 0, QuotaUsed: 99}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.token.Usable(tc.provider); got != tc.want {
				t.Fatalf("Usable(%q) = %v, want %v", tc.provider, got, tc.want)
			}
		})
	}
}
