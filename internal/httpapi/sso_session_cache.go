package httpapi

import (
	"sync"
	"time"
)

const (
	ssoSessionCacheTTL     = 30 * time.Second
	ssoSessionCacheMaxSize = 1024
)

type ssoSessionCacheEntry struct {
	user    ssoUser
	expires time.Time
}

// ssoSessionCache remembers recent issuer session confirmations so that a burst
// of requests does not call the issuer once per request. The TTL bounds how
// long a revoked platform session can stay usable.
type ssoSessionCache struct {
	mu      sync.Mutex
	entries map[string]ssoSessionCacheEntry
	now     func() time.Time
}

func (c *ssoSessionCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func ssoSessionCacheKey(issuer, reference string) string {
	return issuer + "|" + reference
}

func (c *ssoSessionCache) get(issuer, reference string) (*ssoUser, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := ssoSessionCacheKey(issuer, reference)
	entry, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	now := c.clock()
	if !now.Before(entry.expires) || entry.user.ExpiresAt <= now.Unix() {
		delete(c.entries, key)
		return nil, false
	}
	user := entry.user
	return &user, true
}

func (c *ssoSessionCache) put(issuer, reference string, user *ssoUser) {
	if user == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock()
	if c.entries == nil {
		c.entries = make(map[string]ssoSessionCacheEntry)
	}
	if len(c.entries) >= ssoSessionCacheMaxSize {
		for key, entry := range c.entries {
			if !now.Before(entry.expires) {
				delete(c.entries, key)
			}
		}
		if len(c.entries) >= ssoSessionCacheMaxSize {
			c.entries = make(map[string]ssoSessionCacheEntry)
		}
	}
	c.entries[ssoSessionCacheKey(issuer, reference)] = ssoSessionCacheEntry{user: *user, expires: now.Add(ssoSessionCacheTTL)}
}
