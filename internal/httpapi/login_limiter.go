package httpapi

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	loginRateWindow       = 10 * time.Minute
	loginAccountMaxFails  = 6
	loginIPMaxFails       = 30
	loginAccountBlockTime = 15 * time.Minute
	loginIPBlockTime      = 10 * time.Minute
	maxLoginRateEntries   = 10_000
)

type loginRateEntry struct {
	failures     []time.Time
	blockedUntil time.Time
	lastSeen     time.Time
}

type loginRateLimiter struct {
	mu      sync.Mutex
	entries map[string]*loginRateEntry
	now     func() time.Time
}

func newLoginRateLimiter() *loginRateLimiter {
	return &loginRateLimiter{entries: make(map[string]*loginRateEntry), now: time.Now}
}

func (l *loginRateLimiter) allow(ip, account string) (time.Duration, bool) {
	if l == nil {
		return 0, true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.currentTime()
	for _, key := range loginRateKeys(ip, account) {
		entry := l.entries[key]
		if entry == nil {
			continue
		}
		entry.lastSeen = now
		entry.failures = recentLoginFailures(entry.failures, now)
		if entry.blockedUntil.After(now) {
			return entry.blockedUntil.Sub(now), false
		}
	}
	return 0, true
}

func (l *loginRateLimiter) recordFailure(ip, account string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.currentTime()
	for _, key := range loginRateKeys(ip, account) {
		entry := l.entries[key]
		if entry == nil {
			entry = &loginRateEntry{}
			l.entries[key] = entry
		}
		entry.lastSeen = now
		entry.failures = append(recentLoginFailures(entry.failures, now), now)
		limit, blockTime := loginRatePolicy(key)
		if len(entry.failures) >= limit {
			entry.blockedUntil = now.Add(blockTime)
		}
	}
	l.trimLocked(now)
}

func (l *loginRateLimiter) recordSuccess(account string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	delete(l.entries, "account:"+normalizeLoginRateValue(account))
	l.mu.Unlock()
}

func (l *loginRateLimiter) currentTime() time.Time {
	if l.now != nil {
		return l.now().UTC()
	}
	return time.Now().UTC()
}

func (l *loginRateLimiter) trimLocked(now time.Time) {
	for key, entry := range l.entries {
		if !entry.blockedUntil.After(now) && now.Sub(entry.lastSeen) > loginRateWindow {
			delete(l.entries, key)
		}
	}
	for len(l.entries) > maxLoginRateEntries {
		oldestKey := ""
		var oldest time.Time
		for key, entry := range l.entries {
			if oldestKey == "" || entry.lastSeen.Before(oldest) {
				oldestKey = key
				oldest = entry.lastSeen
			}
		}
		if oldestKey == "" {
			break
		}
		delete(l.entries, oldestKey)
	}
}

func loginRateKeys(ip, account string) []string {
	keys := make([]string, 0, 2)
	if value := normalizeLoginRateValue(ip); value != "" {
		keys = append(keys, "ip:"+value)
	}
	if value := normalizeLoginRateValue(account); value != "" {
		keys = append(keys, "account:"+value)
	}
	return keys
}

func loginRatePolicy(key string) (int, time.Duration) {
	if strings.HasPrefix(key, "account:") {
		return loginAccountMaxFails, loginAccountBlockTime
	}
	return loginIPMaxFails, loginIPBlockTime
}

func recentLoginFailures(failures []time.Time, now time.Time) []time.Time {
	cutoff := now.Add(-loginRateWindow)
	first := 0
	for first < len(failures) && failures[first].Before(cutoff) {
		first++
	}
	return failures[first:]
}

func normalizeLoginRateValue(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func loginRetryAfterSeconds(wait time.Duration) string {
	seconds := int(wait.Round(time.Second) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	return strconv.Itoa(seconds)
}
