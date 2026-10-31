package httpapi

import (
	"fmt"
	"testing"
	"time"
)

func newFixedClockLoginLimiter() *loginRateLimiter {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	limiter := newLoginRateLimiter()
	limiter.now = func() time.Time { return now }
	return limiter
}

func TestLoginRateLimiterScopesAccountLockoutToClientIP(t *testing.T) {
	limiter := newFixedClockLoginLimiter()
	for range loginAccountMaxFails {
		limiter.recordFailure("203.0.113.1", "Bob")
	}
	if _, allowed := limiter.allow("203.0.113.1", "bob"); allowed {
		t.Fatal("attacking address must be blocked for the targeted account")
	}
	if _, allowed := limiter.allow("198.51.100.2", "bob"); !allowed {
		t.Fatal("another address must not be locked out of the same account")
	}
}

func TestLoginRateLimiterEvictionKeepsActiveBlocks(t *testing.T) {
	limiter := newFixedClockLoginLimiter()
	for range loginAccountMaxFails {
		limiter.recordFailure("203.0.113.1", "bob")
	}
	future := limiter.currentTime().Add(time.Second)
	limiter.mu.Lock()
	for index := range maxLoginRateEntries {
		limiter.entries[fmt.Sprintf("ip:filler-%d", index)] = &loginRateEntry{lastSeen: future}
	}
	limiter.mu.Unlock()
	limiter.recordFailure("203.0.113.9", "")
	if _, allowed := limiter.allow("203.0.113.1", "bob"); allowed {
		t.Fatal("capacity eviction must not lift an active lockout")
	}
	limiter.mu.Lock()
	size := len(limiter.entries)
	limiter.mu.Unlock()
	if size > maxLoginRateEntries {
		t.Fatalf("entries = %d, want at most %d", size, maxLoginRateEntries)
	}
}

func TestLoginRateLimiterSuccessClearsOnlyMatchingAddress(t *testing.T) {
	limiter := newFixedClockLoginLimiter()
	for range loginAccountMaxFails - 1 {
		limiter.recordFailure("203.0.113.1", "bob")
		limiter.recordFailure("198.51.100.2", "bob")
	}
	limiter.recordSuccess("203.0.113.1", "bob")
	limiter.recordFailure("203.0.113.1", "bob")
	if _, allowed := limiter.allow("203.0.113.1", "bob"); !allowed {
		t.Fatal("success must reset the counter for the same address and account")
	}
	limiter.recordFailure("198.51.100.2", "bob")
	if _, allowed := limiter.allow("198.51.100.2", "bob"); allowed {
		t.Fatal("success from one address must not reset another address's counter")
	}
}
