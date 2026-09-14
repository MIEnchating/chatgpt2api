package service

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"
)

// Serialize initialization for the same upstream user within this process.
var relayOnboardingLocks [64]sync.Mutex

// EnsureCreationGroupTokens matches groups against token membership, never names.
// create is called only after a successful database read found no usable token.
func (r *NewAPITokenReader) EnsureCreationGroupTokens(ctx context.Context, identity Identity, mappings map[string]string, create func(context.Context, string) error) (map[string][]string, []string) {
	result := map[string][]string{}
	if len(mappings) == 0 {
		return result, nil
	}
	if r == nil || !r.configured || r.db == nil {
		return result, []string{"请先配置上游数据库连接"}
	}
	userID, ok := r.identityUserID(identity)
	if !ok {
		return result, []string{"平台用户身份无效，请重新登录"}
	}
	lock := &relayOnboardingLocks[uint64(userID)%uint64(len(relayOnboardingLocks))]
	lock.Lock()
	defer lock.Unlock()
	// Keep the identity read inside the lock so it cannot race another login's write.
	if _, err := r.relayOnboardingUserID(ctx, identity); err != nil {
		return result, []string{err.Error()}
	}
	warnings := []string{}
	resolved := map[string][]string{}
	for _, kind := range []string{"text", "image", "video", "audio"} {
		group := strings.TrimSpace(mappings[kind])
		if group == "" {
			continue
		}
		if names, done := resolved[group]; done {
			if len(names) > 0 {
				result[kind] = names
			}
			continue
		}
		// Mark failed groups too, so one login never repeats a failed creation.
		resolved[group] = nil
		if !r.IsSub2API() && group == "auto" {
			warnings = append(warnings, "默认 Key 必须选择具体分组，不能使用 auto")
			continue
		}
		names, err := r.relayGroupTokenNames(ctx, userID, group)
		if err == nil && len(names) == 0 {
			if create == nil {
				err = fmt.Errorf("分组“%s”没有可用 Key，请在平台创建后重试", group)
			} else if err = create(ctx, group); err == nil {
				names, err = r.relayGroupTokenNames(ctx, userID, group)
				if err == nil && len(names) == 0 {
					err = fmt.Errorf("分组“%s”的 Key 创建后尚未在数据库中可用，请稍后重新登录", group)
				}
			}
		}
		if err != nil {
			warnings = append(warnings, err.Error())
			continue
		}
		resolved[group] = names
		result[kind] = names
	}
	return result, warnings
}

func (r *NewAPITokenReader) relayOnboardingUserID(ctx context.Context, identity Identity) (int64, error) {
	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	return r.lookupUserIDForIdentity(queryCtx, identity, newAPIIdentityLookupValues(identity), "")
}

func (r *NewAPITokenReader) relayGroupTokenNames(ctx context.Context, userID int64, group string) ([]string, error) {
	queryCtx, cancel := context.WithTimeout(contextOrBackground(ctx), r.timeout)
	defer cancel()
	userGroup, err := r.lookupUserGroup(queryCtx, userID)
	if err != nil {
		return nil, err
	}
	candidates, err := r.lookupTokenCandidates(queryCtx, userID)
	if err != nil {
		return nil, err
	}
	nameCounts := map[string]int{}
	for _, candidate := range candidates {
		nameCounts[candidate.Name]++
	}
	names := []string{}
	for _, candidate := range candidates {
		groups, ok := newAPITokenCandidateGroups(candidate, userGroup)
		if !ok || len(groups) != 1 || groups[0] != group {
			continue
		}
		// The current selection API requires token names to identify a single key.
		if nameCounts[candidate.Name] != 1 {
			return nil, fmt.Errorf("分组“%s”的 Key 名称“%s”不唯一，请在上游重命名；未创建新 Key", group, candidate.Name)
		}
		names = append(names, candidate.Name)
	}
	return names, nil
}

func RelayCreationTokenName(group string) string {
	digest := sha256.Sum256([]byte(group))
	label := group
	// New API limits names to 50 bytes; the prefix and digest consume 16 bytes.
	for index, char := range group {
		if index+utf8.RuneLen(char) > 34 {
			label = group[:index]
			break
		}
	}
	return fmt.Sprintf("云棉-%s-%x", label, digest[:4])
}
