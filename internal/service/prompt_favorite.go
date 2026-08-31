package service

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const (
	promptFavoritesDocumentDir = "prompt_favorites"
	promptFavoriteSaveAttempts = 3
)

var referenceProjectPromptFavoriteSources = map[string]struct{}{
	"gpt-image-2-prompts":         {},
	"awesome-gpt-image":           {},
	"awesome-gpt4o-image-prompts": {},
	"xianyu-awesome-gptimage2":    {},
	"youmind-gpt-image-2":         {},
	"youmind-nano-banana-pro":     {},
	"davidwu-gpt-image2-prompts":  {},
	"freestylefly-gpt-image-2":    {},
}

type PromptFavoriteService struct {
	mu    sync.Mutex
	store storage.JSONDocumentBackend
}

func NewPromptFavoriteService(backend ...storage.Backend) *PromptFavoriteService {
	return &PromptFavoriteService{store: firstJSONDocumentStore(backend)}
}

func (s *PromptFavoriteService) ListWithError(ownerID string) ([]map[string]any, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return []map[string]any{}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked(ownerID)
	if err != nil {
		return nil, err
	}
	return copyPromptFavorites(items), nil
}

func copyPromptFavorites(items []map[string]any) []map[string]any {
	out := make([]map[string]any, len(items))
	for index, item := range items {
		out[index] = util.CopyMap(item)
	}
	return out
}

func (s *PromptFavoriteService) UpsertWithItems(ownerID string, body map[string]any) (map[string]any, []map[string]any, error) {
	ownerID = util.Clean(ownerID)
	if ownerID == "" {
		return nil, nil, fmt.Errorf("owner_id is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := util.NowISO()
	for attempt := 0; attempt < promptFavoriteSaveAttempts; attempt++ {
		items, err := s.loadLocked(ownerID)
		if err != nil {
			return nil, nil, err
		}
		existingIndex := -1
		existingFavoritedAt := ""
		for index, item := range items {
			if util.Clean(item["source"]) != util.Clean(body["source"]) || util.Clean(item["prompt_id"]) != util.Clean(body["prompt_id"]) {
				continue
			}
			existingIndex = index
			existingFavoritedAt = util.Clean(item["favorited_at"])
			break
		}

		item, err := normalizePromptFavoriteInput(body, now, existingFavoritedAt)
		if err != nil {
			return nil, nil, err
		}
		if existingIndex >= 0 {
			items[existingIndex] = item
		} else {
			items = append(items, item)
		}
		sortPromptFavorites(items)
		if err := s.saveLocked(ownerID, items); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < promptFavoriteSaveAttempts {
				continue
			}
			return nil, nil, err
		}
		return util.CopyMap(item), copyPromptFavorites(items), nil
	}
	return nil, nil, fmt.Errorf("failed to save prompt favorite")
}

func (s *PromptFavoriteService) DeleteWithItems(ownerID, id string) (bool, []map[string]any, error) {
	ownerID = util.Clean(ownerID)
	id = util.Clean(id)
	if ownerID == "" || id == "" {
		return false, []map[string]any{}, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	removedOnce := false
	for attempt := 0; attempt < promptFavoriteSaveAttempts; attempt++ {
		items, err := s.loadLocked(ownerID)
		if err != nil {
			return false, nil, err
		}
		next := items[:0]
		removed := false
		for _, item := range items {
			if util.Clean(item["id"]) == id {
				removed = true
				continue
			}
			next = append(next, item)
		}
		if !removed {
			return removedOnce, copyPromptFavorites(items), nil
		}
		removedOnce = true
		if err := s.saveLocked(ownerID, next); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) && attempt+1 < promptFavoriteSaveAttempts {
				continue
			}
			return false, nil, err
		}
		return true, copyPromptFavorites(next), nil
	}
	return false, nil, fmt.Errorf("failed to delete prompt favorite")
}

func (s *PromptFavoriteService) loadLocked(ownerID string) ([]map[string]any, error) {
	name := promptFavoriteDocumentName(ownerID)
	raw, err := loadStoredJSON(s.store, name)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0)
	for _, item := range util.AsMapSlice(util.StringMap(raw)["items"]) {
		if normalized := normalizeStoredPromptFavorite(item); normalized != nil {
			items = append(items, normalized)
		}
	}
	sortPromptFavorites(items)
	return items, nil
}

func (s *PromptFavoriteService) saveLocked(ownerID string, items []map[string]any) error {
	name := promptFavoriteDocumentName(ownerID)
	return saveStoredJSON(s.store, name, map[string]any{"items": items})
}

func promptFavoriteDocumentName(ownerID string) string {
	return promptFavoritesDocumentDir + "/" + util.SHA256Hex(ownerID) + ".json"
}

func normalizePromptFavoriteInput(body map[string]any, now, existingFavoritedAt string) (map[string]any, error) {
	promptID := util.Clean(body["prompt_id"])
	if promptID == "" {
		return nil, fmt.Errorf("prompt_id is required")
	}
	source := normalizePromptFavoriteSource(util.Clean(body["source"]))
	if source == "" {
		return nil, fmt.Errorf("source is required")
	}
	title := util.Clean(body["title"])
	if title == "" {
		return nil, fmt.Errorf("title is required")
	}
	prompt := util.Clean(body["prompt"])
	if prompt == "" {
		return nil, fmt.Errorf("prompt is required")
	}
	preview := util.Clean(body["preview"])
	if preview == "" {
		return nil, fmt.Errorf("preview is required")
	}
	author := util.Clean(body["author"])
	if author == "" {
		return nil, fmt.Errorf("author is required")
	}
	category := util.Clean(body["category"])
	if category == "" {
		category = "未分类"
	}
	mode := normalizePromptFavoriteMode(util.Clean(body["mode"]))
	referenceImageURLs := normalizePromptFavoriteStringList(body["reference_image_urls"])
	if isReferenceProjectPromptFavoriteSource(source) {
		mode = ""
		referenceImageURLs = []string{}
	}
	sourceLabel := util.Clean(body["source_label"])
	if sourceLabel == "" {
		sourceLabel = source
	}
	favoritedAt := existingFavoritedAt
	if favoritedAt == "" {
		favoritedAt = now
	}

	item := map[string]any{
		"id":                   promptFavoriteID(source, promptID),
		"prompt_id":            promptID,
		"source":               source,
		"title":                title,
		"preview":              preview,
		"reference_image_urls": referenceImageURLs,
		"prompt":               prompt,
		"author":               author,
		"category":             category,
		"tags":                 normalizePromptFavoriteStringList(body["tags"]),
		"source_label":         sourceLabel,
		"is_nsfw":              util.ToBool(body["is_nsfw"]),
		"favorited_at":         favoritedAt,
		"updated_at":           now,
	}
	if mode != "" {
		item["mode"] = mode
	}
	if link := util.Clean(body["link"]); link != "" {
		item["link"] = link
	}
	if subCategory := util.Clean(body["sub_category"]); subCategory != "" {
		item["sub_category"] = subCategory
	}
	if created := util.Clean(body["created"]); created != "" {
		item["created"] = created
	}
	if localizations := normalizePromptFavoriteLocalizations(body["localizations"]); len(localizations) > 0 {
		item["localizations"] = localizations
	}
	return item, nil
}

func normalizeStoredPromptFavorite(raw map[string]any) map[string]any {
	item, err := normalizePromptFavoriteInput(raw, firstNonEmpty(util.Clean(raw["updated_at"]), util.NowISO()), util.Clean(raw["favorited_at"]))
	if err != nil {
		return nil
	}
	item["id"] = firstNonEmpty(util.Clean(raw["id"]), util.Clean(item["id"]))
	item["favorited_at"] = firstNonEmpty(util.Clean(raw["favorited_at"]), util.Clean(item["favorited_at"]))
	item["updated_at"] = firstNonEmpty(util.Clean(raw["updated_at"]), util.Clean(item["updated_at"]))
	return item
}

func promptFavoriteID(source, promptID string) string {
	return "pf_" + util.SHA256Hex(source + "\n" + promptID)[:24]
}

func normalizePromptFavoriteSource(source string) string {
	source = util.Clean(source)
	if source == "" || len(source) > 96 {
		return ""
	}
	if source != "banana-prompt-quicker" && source != "awesome-gpt-image-2-prompts" && !isReferenceProjectPromptFavoriteSource(source) && !strings.HasPrefix(source, "prompt-source-") {
		return ""
	}
	for _, r := range source {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return ""
	}
	return source
}

func isReferenceProjectPromptFavoriteSource(source string) bool {
	_, ok := referenceProjectPromptFavoriteSources[source]
	return ok
}

func normalizePromptFavoriteMode(mode string) string {
	if mode == "edit" || mode == "generate" {
		return mode
	}
	return ""
}

func normalizePromptFavoriteStringList(value any) []string {
	items := util.AsStringSlice(value)
	out := make([]string, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		cleaned := util.Clean(item)
		if cleaned == "" {
			continue
		}
		if _, ok := seen[cleaned]; ok {
			continue
		}
		seen[cleaned] = struct{}{}
		out = append(out, cleaned)
	}
	return out
}

func normalizePromptFavoriteLocalizations(value any) map[string]any {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]any{}
	for _, language := range []string{"zh-CN", "en"} {
		item, ok := raw[language].(map[string]any)
		if !ok {
			continue
		}
		title := util.Clean(item["title"])
		prompt := util.Clean(item["prompt"])
		category := util.Clean(item["category"])
		if title == "" || prompt == "" || category == "" {
			continue
		}
		normalized := map[string]any{
			"title":    title,
			"prompt":   prompt,
			"category": category,
		}
		if subCategory := util.Clean(item["sub_category"]); subCategory != "" {
			normalized["sub_category"] = subCategory
		}
		out[language] = normalized
	}
	return out
}

func sortPromptFavorites(items []map[string]any) {
	sort.SliceStable(items, func(i, j int) bool {
		return util.Clean(items[i]["favorited_at"]) > util.Clean(items[j]["favorited_at"])
	})
}
