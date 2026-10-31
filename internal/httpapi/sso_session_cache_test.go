package httpapi

import (
	"testing"
	"time"
)

func TestSSOSessionCacheExpiresAfterTTL(t *testing.T) {
	now := time.Now()
	cache := &ssoSessionCache{now: func() time.Time { return now }}
	user := &ssoUser{ID: 7, Username: "alice", ExpiresAt: now.Add(time.Hour).Unix()}
	if _, ok := cache.get("https://issuer.test", "ref"); ok {
		t.Fatal("empty cache returned a hit")
	}
	cache.put("https://issuer.test", "ref", user)
	if got, ok := cache.get("https://issuer.test", "ref"); !ok || got.ID != 7 {
		t.Fatalf("cache hit = %v, %v", got, ok)
	}
	if _, ok := cache.get("https://issuer.test", "other"); ok {
		t.Fatal("cache must be keyed by reference")
	}
	now = now.Add(ssoSessionCacheTTL + time.Second)
	if _, ok := cache.get("https://issuer.test", "ref"); ok {
		t.Fatal("entry must expire after the TTL")
	}
}

func TestSSOSessionCacheHonorsSessionExpiry(t *testing.T) {
	now := time.Now()
	cache := &ssoSessionCache{now: func() time.Time { return now }}
	cache.put("https://issuer.test", "ref", &ssoUser{ID: 7, ExpiresAt: now.Add(5 * time.Second).Unix()})
	now = now.Add(10 * time.Second)
	if _, ok := cache.get("https://issuer.test", "ref"); ok {
		t.Fatal("entry must not outlive the issuer session expiry")
	}
}
