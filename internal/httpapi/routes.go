package httpapi

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

const maxImageConversationHistoryBodyBytes = 96 << 20

func (a *App) handleAnnouncements(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r, ""); !ok {
		return
	}
	items, err := a.announce.ListVisible()
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to load announcements")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) handleAnnouncementPreferences(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	switch r.Method {
	case http.MethodGet:
		preferences, err := a.announce.Preferences(ownerID)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load announcement preferences")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		preferences, err := a.announce.UpdatePreferences(
			ownerID,
			util.Clean(body["version"]),
			util.Clean(body["action"]),
			util.Clean(body["local_date"]),
		)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleAdminAnnouncements(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "admin permission required")
		return
	}

	base := "/api/admin/announcements"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			a.writeAdminAnnouncements(w, nil)
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			item, err := a.announce.Create(body)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			a.writeAdminAnnouncements(w, &item)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "admin" || parts[2] != "announcements" {
		http.NotFound(w, r)
		return
	}
	id := parts[3]
	switch r.Method {
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		item, err := a.announce.Update(id, body)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "announcement not found")
			return
		}
		a.writeAdminAnnouncements(w, item)
	case http.MethodDelete:
		deleted, err := a.announce.Delete(id)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to delete announcement")
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "announcement not found")
			return
		}
		a.writeAdminAnnouncements(w, nil)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) writeAdminAnnouncements(w http.ResponseWriter, item *service.Announcement) {
	items, err := a.announce.ListAll()
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to load announcements")
		return
	}
	payload := map[string]any{"items": items}
	if item != nil {
		payload["item"] = item
	}
	util.WriteJSON(w, http.StatusOK, payload)
}

func (a *App) handleUserKeys(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	filter, owner, canManage := userKeyScope(identity)
	if !canManage {
		util.WriteError(w, http.StatusForbidden, "Linuxdo login or admin permission required")
		return
	}
	base := "/api/auth/users"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			items := a.auth.ListKeys(filter)
			if identity.Role != service.AuthRoleAdmin {
				items = a.auth.ListSingleAPIKeyForOwner(identity.OwnerID)
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost:
			body, _ := readJSONMap(r)
			var item map[string]any
			var raw string
			var err error
			if identity.Role == service.AuthRoleAdmin {
				item, raw, err = a.auth.CreateAPIKey(service.AuthRoleUser, util.Clean(body["name"]), owner)
			} else {
				item, raw, err = a.auth.UpsertAPIKeyForOwner(util.Clean(body["name"]), owner)
			}
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "key": raw, "items": a.auth.ListKeys(filter)})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}
	parts := splitPath(r.URL.Path)
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "auth" || parts[2] != "users" {
		http.NotFound(w, r)
		return
	}
	keyID := parts[3]
	if len(parts) == 5 && parts[4] == "key" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		key, found := a.auth.RevealKey(keyID, filter)
		if !found {
			util.WriteError(w, http.StatusNotFound, "user key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"key": key})
		return
	}
	if len(parts) != 4 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPost:
		body, _ := readJSONMap(r)
		updates := map[string]any{}
		if value, ok := body["name"]; ok {
			updates["name"] = value
		}
		if value, ok := body["enabled"]; ok {
			updates["enabled"] = value
		}
		if len(updates) == 0 {
			util.WriteError(w, http.StatusBadRequest, "no updates provided")
			return
		}
		item, err := a.auth.UpdateKey(keyID, updates, filter)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to update user key")
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "user key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListKeys(filter)})
	case http.MethodDelete:
		deleted, err := a.auth.DeleteKey(keyID, filter)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to delete user key")
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "user key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListKeys(filter)})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func userKeyScope(identity service.Identity) (service.AuthKeyFilter, service.AuthOwner, bool) {
	filter := service.AuthKeyFilter{Role: service.AuthRoleUser, Kind: service.AuthKindAPIKey}
	if identity.Role == service.AuthRoleAdmin {
		return filter, service.AuthOwner{}, true
	}
	if identity.Role != service.AuthRoleUser || identity.OwnerID == "" {
		return service.AuthKeyFilter{}, service.AuthOwner{}, false
	}
	filter.OwnerID = identity.OwnerID
	return filter, service.AuthOwner{ID: identity.OwnerID, Name: identity.Name, Provider: identity.Provider}, true
}

func (a *App) handleProfile(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.writeLoginResponse(w, identity)
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		updated, err := a.auth.UpdateProfileName(identity, util.Clean(body["name"]))
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		a.writeLoginResponse(w, *updated)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleProfilePassword(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	body, err := readJSONMap(r)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := a.auth.ChangeProfilePassword(identity, util.Clean(body["current_password"]), util.Clean(body["new_password"])); err != nil {
		if a.writeAuthPersistenceError(w, err) {
			return
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	clearAuthSessionCookie(w, r)
	util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleProfileRelayKey(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		if a.newAPIKeys == nil {
			util.WriteJSON(w, http.StatusOK, map[string]any{"has_key": false, "key_preview": "", "source": "newapi", "message": "请先配置云棉数据库连接，并在云棉创建指定分组的令牌"})
			return
		}
		util.WriteJSON(w, http.StatusOK, a.newAPIKeys.StatusForGroupAndName(r.Context(), identity, r.URL.Query().Get("group"), r.URL.Query().Get("token_name")))
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleProfileBalance(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		if a.newAPIKeys == nil {
			util.WriteJSON(w, http.StatusOK, map[string]any{"has_balance": false, "source": "newapi", "message": "请先配置云棉数据库连接"})
			return
		}
		util.WriteJSON(w, http.StatusOK, a.newAPIKeys.BalanceStatus(r.Context(), identity))
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleProfileAPIKey(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	filter, ok := profileAPIKeyFilter(identity)
	if !ok {
		util.WriteError(w, http.StatusForbidden, "profile API key requires a bound user account")
		return
	}
	base := "/api/profile/api-key"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListPersonalAPIKey(identity)})
		case http.MethodPost:
			body, _ := readJSONMap(r)
			item, raw, err := a.auth.UpsertPersonalAPIKey(identity, util.Clean(body["name"]))
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "key": raw, "items": a.auth.ListPersonalAPIKey(identity)})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "profile" || parts[2] != "api-key" {
		http.NotFound(w, r)
		return
	}
	keyID := parts[3]
	if len(parts) == 5 && parts[4] == "key" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		key, found := a.auth.RevealKey(keyID, filter)
		if !found {
			util.WriteError(w, http.StatusNotFound, "profile API key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"key": key})
		return
	}
	if len(parts) != 4 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPost:
		body, _ := readJSONMap(r)
		updates := map[string]any{}
		if value, ok := body["name"]; ok {
			updates["name"] = value
		}
		if value, ok := body["enabled"]; ok {
			updates["enabled"] = value
		}
		if len(updates) == 0 {
			util.WriteError(w, http.StatusBadRequest, "no updates provided")
			return
		}
		item, err := a.auth.UpdateKey(keyID, updates, filter)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to update profile API key")
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "profile API key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListPersonalAPIKey(identity)})
	case http.MethodDelete:
		deleted, err := a.auth.DeleteKey(keyID, filter)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to delete profile API key")
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "profile API key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListPersonalAPIKey(identity)})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func profileAPIKeyFilter(identity service.Identity) (service.AuthKeyFilter, bool) {
	role := identity.Role
	if role != service.AuthRoleAdmin && role != service.AuthRoleUser {
		return service.AuthKeyFilter{}, false
	}
	ownerID := util.Clean(identity.OwnerID)
	if ownerID == "" {
		return service.AuthKeyFilter{}, false
	}
	return service.AuthKeyFilter{Role: role, Kind: service.AuthKindAPIKey, OwnerID: ownerID}, true
}

func (a *App) handleProfilePromptFavorites(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	ownerID := util.Clean(identity.OwnerID)
	if ownerID == "" {
		util.WriteError(w, http.StatusForbidden, "prompt favorites require a bound user account")
		return
	}

	base := "/api/profile/prompt-favorites"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			items, err := a.promptFavoritesForIdentity(ownerID, identity)
			if err != nil {
				util.WriteError(w, http.StatusInternalServerError, "failed to load prompt favorites")
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			if util.ToBool(body["is_nsfw"]) && !a.identityCanAccessAPI(identity, http.MethodGet, service.PromptMarketAdultPermissionPath) {
				util.WriteError(w, http.StatusForbidden, "adult prompt market access is not enabled for this user")
				return
			}
			item, err := a.prompts.Upsert(ownerID, body)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			items, err := a.promptFavoritesForIdentity(ownerID, identity)
			if err != nil {
				util.WriteError(w, http.StatusInternalServerError, "failed to load prompt favorites")
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": items})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "profile" || parts[2] != "prompt-favorites" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	deleted, err := a.prompts.Delete(ownerID, parts[3])
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to delete prompt favorite")
		return
	}
	if !deleted {
		util.WriteError(w, http.StatusNotFound, "prompt favorite not found")
		return
	}
	items, err := a.promptFavoritesForIdentity(ownerID, identity)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to load prompt favorites")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) promptFavoritesForIdentity(ownerID string, identity service.Identity) ([]map[string]any, error) {
	items, err := a.prompts.ListWithError(ownerID)
	if err != nil {
		return nil, err
	}
	if a.identityCanAccessAPI(identity, http.MethodGet, service.PromptMarketAdultPermissionPath) {
		return items, nil
	}
	filtered := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if util.ToBool(item["is_nsfw"]) {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered, nil
}

func (a *App) handleProfileImageConversations(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	base := "/api/profile/image-conversations"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
			limit := 0
			if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
				parsed, parseErr := strconv.Atoi(rawLimit)
				if parseErr != nil {
					util.WriteError(w, http.StatusBadRequest, "invalid conversation history limit")
					return
				}
				limit = parsed
			}
			page, err := a.history.ListPage(r.Context(), ownerID, cursor, limit)
			if err != nil {
				writeImageConversationHistoryError(w, err)
				return
			}
			util.WriteJSON(w, http.StatusOK, page)
		case http.MethodPost:
			release, acquired := a.acquireImageConversationHistoryWrite(r)
			if !acquired {
				util.WriteError(w, http.StatusRequestTimeout, "conversation history request was canceled")
				return
			}
			defer release()
			r.Body = http.MaxBytesReader(w, r.Body, maxImageConversationHistoryBodyBytes)
			body, err := readJSONMap(r)
			if err != nil {
				status := http.StatusBadRequest
				message := "invalid json body"
				var maxBytesError *http.MaxBytesError
				if errors.As(err, &maxBytesError) {
					status = http.StatusRequestEntityTooLarge
					message = "conversation history payload is too large"
				}
				util.WriteError(w, status, message)
				return
			}
			items := util.AsMapSlice(body["items"])
			if item := util.StringMap(body["item"]); len(item) > 0 {
				items = append(items, item)
			}
			if len(items) == 0 {
				util.WriteError(w, http.StatusBadRequest, "conversation items are required")
				return
			}
			// Assetization happens before the row CAS. Always enqueue owner GC so
			// files created by a rejected/conflicting write are reclaimed after the
			// orphan grace window as well as files released by a successful update.
			defer a.scheduleImageConversationAssetCleanupDebounced(ownerID)
			expectedGeneration, generationErr := imageConversationHistoryRequestGeneration(body)
			if generationErr != nil {
				util.WriteError(w, http.StatusBadRequest, generationErr.Error())
				return
			}
			acknowledgements, generation, mergeErr := a.history.MergeWithAcknowledgementsMinimal(r.Context(), ownerID, items, expectedGeneration)
			if mergeErr != nil {
				writeImageConversationHistoryError(w, mergeErr)
				return
			}
			// A durable task submission always saves one conversation and needs a
			// strict acknowledgement. Bulk background sync can legitimately contain
			// both accepted and stale snapshots, so report each result without
			// turning a partially successful write into a request-level failure.
			if len(acknowledgements) == 1 {
				acknowledgement := acknowledgements[0]
				if acknowledgement.Gone {
					util.WriteJSON(w, http.StatusGone, map[string]any{
						"error":      "conversation history item was deleted or cleared",
						"id":         acknowledgement.ID,
						"generation": generation,
					})
					return
				}
				if !acknowledgement.Accepted {
					util.WriteJSON(w, http.StatusConflict, map[string]any{
						"error":      "conversation history revision is stale",
						"id":         acknowledgement.ID,
						"revision":   acknowledgement.ActualRevision,
						"generation": generation,
					})
					return
				}
			}
			response := map[string]any{
				"ok":         true,
				"generation": generation,
			}
			if len(acknowledgements) == 1 {
				response["accepted"] = true
				response["id"] = acknowledgements[0].ID
				response["revision"] = acknowledgements[0].ActualRevision
			} else {
				response["acknowledgements"] = acknowledgements
			}
			util.WriteJSON(w, http.StatusOK, response)
		case http.MethodDelete:
			generation, err := a.history.ClearMinimal(r.Context(), ownerID)
			if err != nil {
				writeImageConversationHistoryError(w, err)
				return
			}
			a.scheduleImageConversationAssetCleanup(ownerID)
			util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "generation": generation})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "profile" || parts[2] != "image-conversations" {
		http.NotFound(w, r)
		return
	}
	if parts[3] == "active" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		limit := 0
		if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
			parsed, parseErr := strconv.Atoi(rawLimit)
			if parseErr != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid active conversation limit")
				return
			}
			limit = parsed
		}
		items, generation, err := a.history.ListActive(r.Context(), ownerID, limit)
		if err != nil {
			writeImageConversationHistoryError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": items, "generation": generation})
		return
	}
	if r.Method == http.MethodGet {
		item, found, generation, err := a.history.GetItem(r.Context(), ownerID, parts[3])
		if err != nil {
			writeImageConversationHistoryError(w, err)
			return
		}
		if !found {
			util.WriteError(w, http.StatusNotFound, "image conversation not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "generation": generation})
		return
	}
	if r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	removed, generation, err := a.history.DeleteMinimal(r.Context(), ownerID, parts[3])
	if err != nil {
		writeImageConversationHistoryError(w, err)
		return
	}
	a.scheduleImageConversationAssetCleanup(ownerID)
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"removed":    removed,
		"generation": generation,
	})
}

func (a *App) acquireImageConversationHistoryWrite(r *http.Request) (func(), bool) {
	if a == nil || a.historyWriteLimiter == nil {
		return func() {}, true
	}
	return a.historyWriteLimiter.acquire(
		r.Context(),
		imageConversationHistoryWriteWeight(r.ContentLength),
	)
}

func imageConversationHistoryRequestGeneration(body map[string]any) (*int64, error) {
	value, exists := body["generation"]
	if !exists {
		value, exists = body["history_epoch"]
	}
	if !exists || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
		return nil, nil
	}
	generation, err := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
	if err != nil || generation < 1 {
		return nil, fmt.Errorf("invalid conversation history generation")
	}
	return &generation, nil
}

func writeImageConversationHistoryError(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrImageConversationAssetStorageLimit) {
		util.WriteError(w, http.StatusInsufficientStorage, "image storage limit exceeded")
		return
	}
	var cursorInvalidated service.ImageConversationHistoryCursorInvalidatedError
	if errors.As(err, &cursorInvalidated) {
		util.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":      cursorInvalidated.Error(),
			"code":       "history_reset",
			"generation": cursorInvalidated.Generation,
		})
		return
	}
	var cursorError service.ImageConversationHistoryCursorError
	if errors.As(err, &cursorError) {
		util.WriteError(w, http.StatusBadRequest, cursorError.Error())
		return
	}
	var validationErr service.ImageConversationHistoryValidationError
	if errors.As(err, &validationErr) {
		util.WriteError(w, http.StatusBadRequest, validationErr.Error())
		return
	}
	util.WriteError(w, http.StatusServiceUnavailable, "历史记录数据库暂时不可用，请稍后重试")
}

func (a *App) handleAdminRoles(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r, ""); !ok {
		return
	}
	base := "/api/admin/roles"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListRoles()})
		case http.MethodPost:
			body, _ := readJSONMap(r)
			item, err := a.auth.CreateRole(body)
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListRoles()})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "admin" || parts[2] != "roles" {
		http.NotFound(w, r)
		return
	}
	roleID := parts[3]
	switch r.Method {
	case http.MethodPost:
		body, _ := readJSONMap(r)
		item, err := a.auth.UpdateRole(roleID, body)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			status := http.StatusBadRequest
			if err.Error() == "role not found" {
				status = http.StatusNotFound
			}
			util.WriteError(w, status, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListRoles()})
	case http.MethodDelete:
		deleted, err := a.auth.DeleteRole(roleID)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			status := http.StatusBadRequest
			if err.Error() == "role is assigned to users" {
				status = http.StatusConflict
			}
			util.WriteError(w, status, err.Error())
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "role not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListRoles()})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	_, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	base := "/api/admin/users"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			response, err := a.managedUsersResponse(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusOK, response)
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			enabled := true
			if value, ok := body["enabled"]; ok {
				enabled = util.ToBool(value)
			}
			item, err := a.auth.CreatePasswordUser(
				util.Clean(body["username"]),
				util.Clean(body["password"]),
				util.Clean(body["name"]),
				util.Clean(body["role_id"]),
				enabled,
			)
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			response, err := a.managedUsersResponse(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			if current := a.managedUser(util.Clean(item["id"])); current != nil {
				item = current
			}
			response["item"] = item
			util.WriteJSON(w, http.StatusOK, response)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}

	parts := splitPath(r.URL.Path)
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "admin" || parts[2] != "users" {
		http.NotFound(w, r)
		return
	}
	userID := parts[3]
	if len(parts) == 5 && parts[4] == "key" {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		user := findManagedUser(a.auth.ListUsers(), userID)
		if user == nil {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		if util.Clean(user["provider"]) == service.AuthProviderLinuxDo {
			util.WriteError(w, http.StatusForbidden, "Linuxdo user tokens are not managed by administrators")
			return
		}
		key, found := a.auth.RevealUserAPIKey(userID)
		if !found {
			util.WriteError(w, http.StatusNotFound, "user API key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"key": key})
		return
	}
	if len(parts) == 5 && parts[4] == "reset-key" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, _ := readJSONMap(r)
		user := findManagedUser(a.auth.ListUsers(), userID)
		if user == nil {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		if util.Clean(user["provider"]) == service.AuthProviderLinuxDo {
			util.WriteError(w, http.StatusForbidden, "Linuxdo user tokens are not managed by administrators")
			return
		}
		item, apiKey, raw, found, err := a.auth.ResetUserAPIKey(userID, util.Clean(body["name"]))
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if !found {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		response, err := a.managedUsersResponse(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if current := a.managedUser(userID); current != nil {
			item = current
		}
		response["item"] = item
		response["api_key"] = apiKey
		response["key"] = raw
		util.WriteJSON(w, http.StatusOK, response)
		return
	}
	if len(parts) != 4 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		item := a.managedUser(userID)
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item})
	case http.MethodPost:
		body, _ := readJSONMap(r)
		updates := map[string]any{}
		if value, ok := body["name"]; ok {
			updates["name"] = value
		}
		if value, ok := body["enabled"]; ok {
			updates["enabled"] = value
		}
		if value, ok := body["role_id"]; ok {
			if roleID := util.Clean(value); roleID != "" && !a.auth.RoleExists(roleID) {
				util.WriteError(w, http.StatusBadRequest, "role not found")
				return
			}
			updates["role_id"] = value
		}
		if len(updates) == 0 {
			util.WriteError(w, http.StatusBadRequest, "no updates provided")
			return
		}
		if len(updates) > 0 {
			item, err := a.auth.UpdateUser(userID, updates)
			if err != nil {
				if a.writeAuthPersistenceError(w, err) {
					return
				}
				util.WriteError(w, http.StatusInternalServerError, "failed to update user")
				return
			}
			if item == nil {
				util.WriteError(w, http.StatusNotFound, "user not found")
				return
			}
		} else if findManagedUser(a.auth.ListUsers(), userID) == nil {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		response, err := a.managedUsersResponse(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		item := a.managedUser(userID)
		response["item"] = item
		util.WriteJSON(w, http.StatusOK, response)
	case http.MethodDelete:
		deleted, err := a.auth.DeleteUser(userID)
		if err != nil {
			if a.writeAuthPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusInternalServerError, "failed to delete user")
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "user not found")
			return
		}
		response, err := a.managedUsersResponse(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, response)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

type managedUsersQuery struct {
	Page       int
	PageSize   int
	Search     string
	Provider   string
	Status     string
	SortBy     string
	SortOrder  string
	Total      int
	TotalPages int
}

func (a *App) managedUsersResponse(r *http.Request) (map[string]any, error) {
	query, err := parseManagedUsersQuery(r)
	if err != nil {
		return nil, err
	}
	items := filterManagedUsers(a.auth.ListUsers(), query)
	a.prepareManagedUsersSortValues(items, query.SortBy)
	sortManagedUsers(items, query)
	query.Total = len(items)
	query.TotalPages = managedUsersTotalPages(query.Total, query.PageSize)
	if query.Page > query.TotalPages {
		query.Page = query.TotalPages
	}
	start := (query.Page - 1) * query.PageSize
	if start > query.Total {
		start = query.Total
	}
	end := start + query.PageSize
	if end > query.Total {
		end = query.Total
	}
	pageItems := items[start:end]
	a.attachManagedUserUsage(pageItems)
	return map[string]any{
		"items":       pageItems,
		"total":       query.Total,
		"page":        query.Page,
		"page_size":   query.PageSize,
		"sort_by":     query.SortBy,
		"sort_order":  query.SortOrder,
		"total_pages": query.TotalPages,
	}, nil
}

func (a *App) managedUser(id string) map[string]any {
	item := findManagedUser(a.auth.ListUsers(), id)
	if item == nil {
		return nil
	}
	a.attachManagedUserUsage([]map[string]any{item})
	return item
}

func (a *App) attachManagedUserUsage(items []map[string]any) {
	userIDs := managedUserIDs(items)
	if len(userIDs) == 0 {
		return
	}
	a.attachManagedUserUsageStats(items, userIDs)
}

func managedUserIDs(items []map[string]any) []string {
	userIDs := make([]string, 0, len(items))
	for _, item := range items {
		if userID := util.Clean(item["id"]); userID != "" {
			userIDs = append(userIDs, userID)
		}
	}
	return userIDs
}

func (a *App) attachManagedUserUsageStats(items []map[string]any, userIDs []string) {
	stats := a.logs.UserUsageStatsForUsers(14, userIDs)
	for _, item := range items {
		userID := util.Clean(item["id"])
		usage := stats[userID]
		if usage == nil {
			usage = service.ZeroUserUsageStats(14)
		}
		for key, value := range usage {
			item[key] = value
		}
	}
}

func (a *App) prepareManagedUsersSortValues(items []map[string]any, sortBy string) {
	if len(items) == 0 {
		return
	}
	switch sortBy {
	case "call_count", "quota_used", "failure_count":
		a.attachManagedUserUsageStats(items, managedUserIDs(items))
	}
}

func parseManagedUsersQuery(r *http.Request) (managedUsersQuery, error) {
	values := r.URL.Query()
	page, err := parseManagedUsersPage(values.Get("page"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	pageSize, err := parseManagedUsersPageSize(values.Get("page_size"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	sortBy, err := parseManagedUsersSortBy(values.Get("sort_by"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	sortOrder, err := parseManagedUsersSortOrder(values.Get("sort_order"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	return managedUsersQuery{
		Page:      page,
		PageSize:  pageSize,
		Search:    strings.TrimSpace(values.Get("search")),
		Provider:  strings.TrimSpace(values.Get("provider")),
		Status:    strings.TrimSpace(values.Get("status")),
		SortBy:    sortBy,
		SortOrder: sortOrder,
	}, nil
}

func parseManagedUsersPage(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 1, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("page 参数无效")
	}
	return value, nil
}

func parseManagedUsersPageSize(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 20, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("page_size 参数无效")
	}
	return normalizedManagedUsersPageSize(value), nil
}

func normalizedManagedUsersPageSize(value int) int {
	if value <= 0 {
		return 20
	}
	if value > 100 {
		return 100
	}
	return value
}

func managedUsersTotalPages(total, pageSize int) int {
	if pageSize <= 0 {
		pageSize = 20
	}
	if total <= 0 {
		return 1
	}
	return (total + pageSize - 1) / pageSize
}

func parseManagedUsersSortBy(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "created_at", nil
	}
	switch value {
	case "id", "name", "username", "provider", "enabled", "role_id", "role_name", "call_count", "quota_used", "failure_count", "created_at", "last_used_at", "updated_at":
		return value, nil
	default:
		return "", fmt.Errorf("sort_by 参数无效")
	}
}

func parseManagedUsersSortOrder(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "desc", nil
	}
	switch value {
	case "asc", "desc":
		return value, nil
	default:
		return "", fmt.Errorf("sort_order 参数无效")
	}
}

func filterManagedUsers(items []map[string]any, query managedUsersQuery) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	search := strings.ToLower(strings.TrimSpace(query.Search))
	provider := strings.TrimSpace(query.Provider)
	status := strings.TrimSpace(query.Status)
	for _, item := range items {
		if provider != "" && provider != "all" && util.Clean(item["provider"]) != provider {
			continue
		}
		if status == "enabled" && !util.ToBool(item["enabled"]) {
			continue
		}
		if status == "disabled" && util.ToBool(item["enabled"]) {
			continue
		}
		if search != "" && !strings.Contains(managedUserSearchText(item), search) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func sortManagedUsers(items []map[string]any, query managedUsersQuery) {
	desc := query.SortOrder == "desc"
	sort.SliceStable(items, func(i, j int) bool {
		cmp := compareManagedUsers(items[i], items[j], query.SortBy)
		if cmp == 0 {
			cmp = strings.Compare(util.Clean(items[i]["id"]), util.Clean(items[j]["id"]))
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
}

func compareManagedUsers(left, right map[string]any, sortBy string) int {
	switch sortBy {
	case "enabled":
		return compareManagedUserInts(managedUserSortBool(left, sortBy), managedUserSortBool(right, sortBy))
	case "call_count", "quota_used", "failure_count":
		return compareManagedUserInts(managedUserSortInt(left, sortBy), managedUserSortInt(right, sortBy))
	default:
		return strings.Compare(strings.ToLower(managedUserSortString(left, sortBy)), strings.ToLower(managedUserSortString(right, sortBy)))
	}
}

func managedUserSortString(item map[string]any, sortBy string) string {
	switch sortBy {
	case "name":
		return util.Clean(item["name"])
	case "username":
		return util.Clean(item["username"])
	case "provider":
		return util.Clean(item["provider"])
	case "role_id":
		return util.Clean(item["role_id"])
	case "role_name":
		return util.Clean(item["role_name"])
	case "created_at":
		return util.Clean(item["created_at"])
	case "last_used_at":
		return util.Clean(item["last_used_at"])
	case "updated_at":
		return util.Clean(item["updated_at"])
	default:
		return util.Clean(item["id"])
	}
}

func managedUserSortBool(item map[string]any, sortBy string) int {
	if sortBy == "enabled" && util.ToBool(item["enabled"]) {
		return 1
	}
	return 0
}

func managedUserSortInt(item map[string]any, sortBy string) int {
	return util.ToInt(item[sortBy], 0)
}

func compareManagedUserInts(left, right int) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}

func managedUserSearchText(item map[string]any) string {
	parts := []string{
		util.Clean(item["id"]),
		util.Clean(item["username"]),
		util.Clean(item["name"]),
		util.Clean(item["role_id"]),
		util.Clean(item["role_name"]),
		util.Clean(item["owner_id"]),
		util.Clean(item["owner_name"]),
		util.Clean(item["provider"]),
		util.Clean(item["linuxdo_level"]),
		util.Clean(item["session_id"]),
		util.Clean(item["session_name"]),
	}
	return strings.ToLower(strings.Join(parts, " "))
}

func findManagedUser(items []map[string]any, id string) map[string]any {
	for _, item := range items {
		if item["id"] == id {
			return item
		}
	}
	return nil
}

func (a *App) handleAccounts(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	switch {
	case r.URL.Path == "/api/accounts" && r.Method == http.MethodGet:
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.accountItemsForIdentity(identity)})
	case r.URL.Path == "/api/accounts/tokens" && r.Method == http.MethodGet:
		util.WriteJSON(w, http.StatusOK, map[string]any{"tokens": a.accounts.ListTokens()})
	case r.URL.Path == "/api/accounts/session" && r.Method == http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		sessionJSON := util.Clean(body["session_json"])
		if sessionJSON == "" {
			util.WriteError(w, http.StatusBadRequest, "session_json is required")
			return
		}
		result, err := a.accounts.AddAccountFromSession(sessionJSON)
		if err != nil {
			if a.writeAccountPersistenceError(w, err) {
				return
			}
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		delete(result, "tokens")
		a.redactAccountPayloadForIdentity(identity, result)
		util.WriteJSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/accounts" && r.Method == http.MethodPost:
		body, _ := readJSONMap(r)
		tokens := util.AsStringSlice(body["tokens"])
		if len(tokens) == 0 {
			util.WriteError(w, http.StatusBadRequest, "tokens is required")
			return
		}
		result, err := a.accounts.AddAccounts(tokens)
		if err != nil {
			a.writeAccountPersistenceError(w, err)
			return
		}
		refresh := a.accounts.RefreshAccounts(r.Context(), tokens)
		for key, value := range refresh {
			if key == "refreshed" || key == "errors" || key == "items" {
				result[key] = value
			}
		}
		a.redactAccountPayloadForIdentity(identity, result)
		util.WriteJSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/accounts" && r.Method == http.MethodDelete:
		body, _ := readJSONMap(r)
		tokens := util.AsStringSlice(body["tokens"])
		accountIDs := util.AsStringSlice(body["account_ids"])
		if len(tokens) == 0 {
			tokens = a.accounts.ListTokensByIDs(accountIDs)
		}
		if len(tokens) == 0 {
			if len(accountIDs) > 0 {
				util.WriteError(w, http.StatusNotFound, "account not found")
				return
			}
			util.WriteError(w, http.StatusBadRequest, "tokens or account_ids is required")
			return
		}
		result, err := a.accounts.DeleteAccounts(tokens)
		if err != nil {
			a.writeAccountPersistenceError(w, err)
			return
		}
		a.redactAccountPayloadForIdentity(identity, result)
		util.WriteJSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/accounts/refresh" && r.Method == http.MethodPost:
		body, _ := readJSONMap(r)
		tokens := util.AsStringSlice(body["access_tokens"])
		accountIDs := util.AsStringSlice(body["account_ids"])
		if len(tokens) == 0 && len(accountIDs) > 0 {
			tokens = a.accounts.ListTokensByIDs(accountIDs)
		}
		if len(tokens) == 0 && len(accountIDs) == 0 {
			tokens = a.accounts.ListTokens()
		}
		if len(tokens) == 0 {
			if len(accountIDs) > 0 {
				util.WriteError(w, http.StatusNotFound, "account not found")
				return
			}
			util.WriteError(w, http.StatusBadRequest, "access_tokens or account_ids is required")
			return
		}
		result := a.accounts.RefreshAccounts(r.Context(), tokens)
		a.redactAccountPayloadForIdentity(identity, result)
		util.WriteJSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/accounts/upstream-actions" && r.Method == http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		tokens := util.AsStringSlice(body["access_tokens"])
		accountIDs := util.AsStringSlice(body["account_ids"])
		if len(tokens) == 0 && len(accountIDs) > 0 {
			tokens = a.accounts.ListTokensByIDs(accountIDs)
		}
		if len(tokens) == 0 {
			if len(accountIDs) > 0 {
				util.WriteError(w, http.StatusNotFound, "account not found")
				return
			}
			util.WriteError(w, http.StatusBadRequest, "access_tokens or account_ids is required")
			return
		}
		options := service.UpstreamAccountActionOptions{
			DisableMemory:     util.ToBool(body["disable_memory"]),
			HideConversations: util.ToBool(body["hide_conversations"]),
			DeleteFiles:       util.ToBool(body["delete_files"]),
			FilePageLimit:     util.ToInt(body["file_page_limit"], 100),
		}
		if !options.DisableMemory && !options.HideConversations && !options.DeleteFiles {
			util.WriteError(w, http.StatusBadRequest, "at least one upstream action is required")
			return
		}
		result := a.accounts.RunUpstreamAccountActions(r.Context(), tokens, options)
		a.redactAccountPayloadForIdentity(identity, result)
		util.WriteJSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/accounts/toggle-enabled" && r.Method == http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		accountIDs := util.AsStringSlice(body["account_ids"])
		if accountID := util.Clean(body["account_id"]); accountID != "" {
			accountIDs = append(accountIDs, accountID)
		}
		if len(accountIDs) == 0 {
			util.WriteError(w, http.StatusBadRequest, "account_id or account_ids is required")
			return
		}
		enabledRaw, ok := body["enabled"]
		if !ok {
			util.WriteError(w, http.StatusBadRequest, "enabled is required")
			return
		}
		result, err := a.accounts.SetAccountsEnabledByIDs(accountIDs, util.ToBool(enabledRaw))
		if err != nil {
			a.writeAccountPersistenceError(w, err)
			return
		}
		a.redactAccountPayloadForIdentity(identity, result)
		util.WriteJSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/accounts/update" && r.Method == http.MethodPost:
		body, _ := readJSONMap(r)
		token := util.Clean(body["access_token"])
		accountID := util.Clean(body["account_id"])
		if token == "" && accountID != "" {
			token = a.accounts.GetTokenByID(accountID)
			if token == "" {
				util.WriteError(w, http.StatusNotFound, "account not found")
				return
			}
		}
		if token == "" {
			util.WriteError(w, http.StatusBadRequest, "access_token or account_id is required")
			return
		}
		updates := map[string]any{}
		for _, key := range []string{"type", "status", "quota"} {
			if value, ok := body[key]; ok && value != nil {
				updates[key] = value
			}
		}
		if len(updates) == 0 {
			util.WriteError(w, http.StatusBadRequest, "no updates provided")
			return
		}
		item, err := a.accounts.UpdateAccount(token, updates)
		if err != nil {
			a.writeAccountPersistenceError(w, err)
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "account not found")
			return
		}
		result := map[string]any{"item": item, "items": a.accounts.ListAccounts()}
		a.redactAccountPayloadForIdentity(identity, result)
		util.WriteJSON(w, http.StatusOK, result)
	default:
		http.NotFound(w, r)
	}
}

func (a *App) writeAccountPersistenceError(w http.ResponseWriter, err error) bool {
	var persistenceErr service.AccountPersistenceError
	if !errors.As(err, &persistenceErr) {
		return false
	}
	if a != nil && a.logger != nil {
		a.logger.Error("account persistence failed", "error", persistenceErr.Err)
	}
	if errors.Is(err, storage.ErrConcurrentRowUpdate) {
		util.WriteError(w, http.StatusConflict, "账号数据已被其他实例更新，请重试")
		return true
	}
	util.WriteError(w, http.StatusServiceUnavailable, "账号数据库暂时不可用，请稍后重试")
	return true
}

func (a *App) writeAuthPersistenceError(w http.ResponseWriter, err error) bool {
	var persistenceErr service.AuthPersistenceError
	if !errors.As(err, &persistenceErr) {
		return false
	}
	if a != nil && a.logger != nil {
		a.logger.Error("auth persistence failed", "error", persistenceErr.Err)
	}
	if errors.Is(err, storage.ErrConcurrentRowUpdate) {
		util.WriteError(w, http.StatusConflict, "认证数据已被其他实例更新，请重试")
		return true
	}
	util.WriteError(w, http.StatusServiceUnavailable, "认证数据库暂时不可用，请稍后重试")
	return true
}

func (a *App) accountItemsForIdentity(identity service.Identity) []map[string]any {
	items := a.accounts.ListAccounts()
	if !a.identityCanAccessAPI(identity, http.MethodGet, "/api/accounts/tokens") {
		redactAccountTokens(items)
	}
	return items
}

func (a *App) redactAccountPayloadForIdentity(identity service.Identity, payload map[string]any) {
	if a.identityCanAccessAPI(identity, http.MethodGet, "/api/accounts/tokens") {
		return
	}
	if item, ok := payload["item"].(map[string]any); ok {
		redactAccountToken(item)
	}
	if items, ok := payload["items"].([]map[string]any); ok {
		redactAccountTokens(items)
	}
	if errors, ok := payload["errors"].([]map[string]string); ok {
		for _, item := range errors {
			token := item["access_token"]
			delete(item, "access_token")
			if token != "" {
				item["account_id"] = util.SHA1Short(token, 16)
			}
		}
	}
	if results, ok := payload["results"].([]map[string]any); ok {
		for _, item := range results {
			token := util.Clean(item["access_token"])
			delete(item, "access_token")
			if token != "" {
				item["account_id"] = util.SHA1Short(token, 16)
			}
		}
	}
}

func redactAccountTokens(items []map[string]any) {
	for _, item := range items {
		redactAccountToken(item)
	}
}

func redactAccountToken(item map[string]any) {
	delete(item, "access_token")
}

func (a *App) handleCreationTasks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	identity, ok := a.requireIdentity(w, r, "")
	if !ok {
		return
	}
	parts := splitPath(r.URL.Path)
	if r.URL.Path == "/api/creation-tasks" && r.Method == http.MethodGet {
		tasks, err := a.tasks.ListTasksWithError(identity, util.ParseCommaList(r.URL.Query().Get("ids")))
		if err != nil {
			a.writeCreationTaskStorageError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, tasks)
		return
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "creation-tasks" && parts[3] == "cancel" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		task, err := a.tasks.CancelTask(identity, parts[2])
		if err != nil {
			if a.writeCreationTaskStorageError(w, err) {
				return
			}
			util.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/image-generations" && r.Method == http.MethodPost {
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := a.applyDefaultImageModel(body)
		if err := validateRelayImageRequest("/api/creation-tasks/image-generations", model, body, nil); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		normalizeImagePayloadForModel(body)
		if !validProtocolImageCount(body["n"], model) {
			util.WriteError(w, http.StatusBadRequest, protocolImageCountRangeMessage(model))
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		if err := validateGoogleGeminiInlineRequest(body, nil); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitGenerationWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), util.Clean(body["quality"]), a.relayBaseURL(), util.ToInt(body["n"], 1), body["messages"], imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/video-generations" && r.Method == http.MethodPost {
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		model := util.Clean(body["model"])
		if model == "" {
			model = firstString(a.config.VideoModels(), "sora-2")
			body["model"] = model
		}
		allowed := false
		for _, candidate := range a.config.VideoModels() {
			if candidate == model {
				allowed = true
				break
			}
		}
		if !allowed {
			util.WriteError(w, http.StatusBadRequest, "视频模型不可用")
			return
		}
		seconds := util.ToInt(body["seconds"], videoDefaultSeconds(model))
		refs := util.AsStringSlice(body["reference_image_urls"])
		referenceVideoURLs := util.AsStringSlice(body["reference_video_urls"])
		referenceAudioURLs := util.AsStringSlice(body["reference_audio_urls"])
		referenceMode := normalizeVideoReferenceMode(util.Clean(body["reference_mode"]))
		if referenceMode == "" {
			if len(referenceVideoURLs) > 0 || len(referenceAudioURLs) > 0 {
				referenceMode = "reference"
			} else {
				referenceMode = "first-frame"
			}
		}
		body["reference_mode"] = referenceMode
		if err := validateVideoPrompt(model, util.Clean(body["prompt"])); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		firstFrameCount := len(refs)
		multimodalReferenceCount := 0
		if referenceMode == "reference" {
			firstFrameCount = 0
			multimodalReferenceCount = len(refs) + len(referenceVideoURLs) + len(referenceAudioURLs)
		}
		if err := validateVideoParameters(model, util.Clean(body["size"]), seconds, util.Clean(body["resolution"]), firstFrameCount, multimodalReferenceCount); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := validateVideoReferences(model, referenceMode, refs, referenceVideoURLs, referenceAudioURLs); err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitVideo(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), seconds, util.Clean(body["resolution"]), util.ToBool(body["generate_audio"]), util.ToBool(body["watermark"]), referenceMode, refs, referenceVideoURLs, referenceAudioURLs, creationTaskRequestMetadata(body))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/chat-completions" && r.Method == http.MethodPost {
		util.WriteError(w, http.StatusNotFound, "chat creation tasks are disabled")
		return
	}
	if r.URL.Path == "/api/creation-tasks/image-edits" && r.Method == http.MethodPost {
		release, acquired := a.acquireImageUpload(r.Context())
		if !acquired {
			util.WriteError(w, http.StatusRequestTimeout, "image upload was canceled")
			return
		}
		defer release()
		body, images, err := readMultipartImageBody(w, r)
		if err != nil {
			writeMultipartImageBodyError(w, err)
			return
		}
		model := a.applyDefaultImageModel(body)
		if err := validateRelayImageRequest("/api/creation-tasks/image-edits", model, body, images); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		normalizeImagePayloadForModel(body)
		if !validProtocolImageCount(body["n"], model) {
			util.WriteError(w, http.StatusBadRequest, protocolImageCountRangeMessage(model))
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		if err := validateRelayImageReferenceCount(model, len(images)); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		if err := validateGoogleGeminiInlineRequest(body, images); err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		task, err := a.tasks.SubmitEditWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), util.Clean(body["quality"]), a.relayBaseURL(), images, util.ToInt(body["n"], 1), body["messages"], imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			a.writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	http.NotFound(w, r)
}

func validateVideoReferences(model, mode string, imageURLs, videoURLs, audioURLs []string) error {
	mode = normalizeVideoReferenceMode(mode)
	if mode != "first-frame" && mode != "reference" {
		return fmt.Errorf("视频参考模式仅支持 first-frame 或 reference")
	}
	if mode == "first-frame" {
		if len(videoURLs) > 0 || len(audioURLs) > 0 {
			return fmt.Errorf("首帧图生视频不能同时传入参考视频或参考音频")
		}
		if len(imageURLs) > 1 {
			return fmt.Errorf("当前视频图生视频入口只支持一张首帧参考图")
		}
		return nil
	}
	if !isMiniMaxH3Model(model) {
		return fmt.Errorf("当前模型尚未接入多模态参考生视频")
	}
	if len(imageURLs)+len(videoURLs)+len(audioURLs) == 0 {
		return fmt.Errorf("多模态参考生视频至少需要一个参考图片、视频或音频 URL")
	}
	if len(imageURLs) > 9 || len(videoURLs) > 3 || len(audioURLs) > 3 {
		return fmt.Errorf("MiniMax H3 最多支持 9 张参考图片、3 个参考视频和 3 个参考音频")
	}
	for kind, values := range map[string][]string{"图片": imageURLs, "视频": videoURLs, "音频": audioURLs} {
		for _, value := range values {
			if !isPublicReferenceURL(value) {
				return fmt.Errorf("参考%s必须使用公网可访问的 http:// 或 https:// URL", kind)
			}
		}
	}
	return nil
}

// normalizeVideoReferenceMode keeps the public API aligned with the provider
// vocabulary: MiniMax calls mixed media and video-to-video reference-to-video.
func normalizeVideoReferenceMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "first-frame", "image-to-video":
		return "first-frame"
	case "":
		return ""
	case "reference", "reference-generation", "reference-to-video", "video-to-video", "multimodal":
		return "reference"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func isPublicReferenceURL(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 2083 {
		return false
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(parsed.Hostname())), ".")
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".home.arpa") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return isPublicReferenceIP(ip)
	}
	return strings.Contains(host, ".")
}

func isPublicReferenceIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, raw := range []string{
		"100.64.0.0/10",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"240.0.0.0/4",
		"2001:db8::/32",
	} {
		_, block, err := net.ParseCIDR(raw)
		if err == nil && block.Contains(ip) {
			return false
		}
	}
	return true
}

func validateVideoParameters(model, size string, seconds int, resolution string, referenceCountValues ...int) error {
	name := strings.ToLower(strings.TrimSpace(model))
	size = strings.ToLower(strings.TrimSpace(size))
	resolution = strings.ToLower(strings.TrimSpace(resolution))
	referenceCount := 0
	multimodalReferenceCount := 0
	if len(referenceCountValues) > 0 {
		referenceCount = referenceCountValues[0]
	}
	if len(referenceCountValues) > 1 {
		multimodalReferenceCount = referenceCountValues[1]
	}
	hasH3Reference := referenceCount > 0 || multimodalReferenceCount > 0
	if referenceCount > 1 {
		return fmt.Errorf("当前视频图生视频入口只支持一张首帧参考图")
	}
	contains := func(values ...string) bool {
		for _, value := range values {
			if value == size {
				return true
			}
		}
		return false
	}
	validRange := func(min, max int) bool { return seconds >= min && seconds <= max }
	if profile := seedanceVideoProfile(name); profile != "" {
		if !contains("", "adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9") {
			return fmt.Errorf("Seedance 官方画幅仅支持 adaptive、16:9、4:3、1:1、3:4、9:16、21:9")
		}
		min, max, smart := 4, 15, true
		resolutionValues := []string{"480p", "720p", "1080p"}
		switch profile {
		case "2.5":
			max = 30
		case "1.5":
			max = 12
		case "1.0":
			min, smart = 2, false
		case "2.0":
			resolutionValues = []string{"480p", "720p", "1080p", "4k"}
		case "2.0-fast", "2.0-mini":
			resolutionValues = []string{"480p", "720p"}
		}
		if (seconds == -1 && !smart) || (seconds != -1 && !validRange(min, max)) {
			return fmt.Errorf("Seedance 官方视频时长不在当前模型支持范围内")
		}
		if resolution != "" && !stringIn(resolution, resolutionValues...) {
			return fmt.Errorf("Seedance 官方清晰度不受支持")
		}
		return nil
	}
	if strings.Contains(name, "seedance") && (size != "" || resolution != "") {
		return fmt.Errorf("尚未录入当前 Seedance 型号的官方画幅和清晰度，请留空并使用上游默认值")
	}
	if isKnownGrokVideoModel(name) {
		if !contains("", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3") || !validRange(1, 15) {
			return fmt.Errorf("Grok 官方视频支持 1-15 秒及 1:1、16:9、9:16、4:3、3:4、3:2、2:3 画幅")
		}
		if resolution != "" && !stringIn(resolution, "480p", "720p", "1080p") {
			return fmt.Errorf("Grok 官方清晰度仅支持 480p、720p、1080p")
		}
		if !strings.Contains(name, "1.5") && !strings.Contains(name, "1-5") && resolution == "1080p" {
			return fmt.Errorf("Grok 官方 1080p 仅支持 grok-imagine-video-1.5")
		}
		return nil
	}
	if strings.Contains(name, "kling") && (isKling3Model(name) || isKlingLegacyModel(name)) {
		if !contains("", "16:9", "9:16", "1:1") {
			return fmt.Errorf("Kling 官方画幅仅支持 16:9、9:16、1:1")
		}
		if isKling3Model(name) {
			if !validRange(3, 15) {
				return fmt.Errorf("Kling 3.0 官方视频时长支持 3-15 秒")
			}
		} else if seconds != 5 && seconds != 10 {
			return fmt.Errorf("Kling 当前模型官方视频时长支持 5 秒或 10 秒")
		}
		resolutionValues := []string{"720p", "1080p"}
		if isKling3Model(name) {
			resolutionValues = append(resolutionValues, "4k")
		}
		if resolution != "" && !stringIn(resolution, resolutionValues...) {
			return fmt.Errorf("Kling 官方清晰度不支持当前选择")
		}
		return nil
	}
	if strings.Contains(name, "kling") && (size != "" || resolution != "") {
		return fmt.Errorf("尚未录入当前 Kling 型号的官方画幅和清晰度，请留空并使用上游默认值")
	}
	if strings.Contains(name, "minimax") || strings.Contains(name, "hailuo") || strings.HasPrefix(name, "t2v-") || strings.HasPrefix(name, "i2v-") || strings.HasPrefix(name, "s2v-") {
		if strings.Contains(name, "h3") {
			if !hasH3Reference && !contains("21:9", "16:9", "4:3", "1:1", "3:4", "9:16") {
				return fmt.Errorf("MiniMax H3 文生视频必须选择 21:9、16:9、4:3、1:1、3:4 或 9:16，不能使用自适应画幅")
			}
			if hasH3Reference && !contains("", "adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16") {
				return fmt.Errorf("MiniMax H3 图生视频画幅由首帧参考图决定")
			}
			if !validRange(4, 15) {
				return fmt.Errorf("MiniMax H3 官方视频时长仅支持 4-15 秒")
			}
			if !stringIn(resolution, "768p", "2k") {
				return fmt.Errorf("MiniMax H3 官方清晰度仅支持 768P、2K")
			}
			return nil
		}
		if size != "" {
			return fmt.Errorf("MiniMax v1 官方接口没有画幅参数")
		}
		if seconds != 6 && seconds != 10 {
			return fmt.Errorf("MiniMax 官方视频时长支持 6 秒或 10 秒")
		}
		if resolution != "" {
			if strings.Contains(name, "hailuo") && !stringIn(resolution, "768p", "1080p") {
				return fmt.Errorf("MiniMax Hailuo 官方清晰度仅支持 768P、1080P")
			}
			if !strings.Contains(name, "hailuo") && resolution != "720p" {
				return fmt.Errorf("MiniMax 旧版官方清晰度仅支持 720P")
			}
		}
		if strings.Contains(name, "hailuo") && seconds == 10 && resolution == "1080p" {
			return fmt.Errorf("MiniMax Hailuo 官方 10 秒视频仅支持 768P")
		}
		if strings.Contains(name, "hailuo-2.3-fast") && referenceCount == 0 {
			return fmt.Errorf("MiniMax-Hailuo-2.3-Fast 官方仅支持图生视频，请上传一张首帧参考图")
		}
		if strings.HasPrefix(name, "i2v-") && referenceCount == 0 {
			return fmt.Errorf("MiniMax I2V 官方模型仅支持图生视频，请上传一张首帧参考图")
		}
		return nil
	}
	if isSora2Model(name) {
		allowedSizes := []string{"1280x720", "720x1280"}
		if strings.Contains(name, "pro") {
			allowedSizes = append(allowedSizes, "1792x1024", "1024x1792", "1920x1080", "1080x1920")
		}
		if !stringIn(size, allowedSizes...) {
			return fmt.Errorf("Sora 官方视频尺寸不支持当前选择")
		}
		if !stringIn(strconv.Itoa(seconds), "4", "8", "12", "16", "20") {
			return fmt.Errorf("Sora 官方视频时长仅支持 4、8、12、16、20 秒")
		}
		if resolution != "" {
			return fmt.Errorf("Sora 官方接口使用 size 指定尺寸，不支持独立 resolution 参数")
		}
		if referenceCount > 1 {
			return fmt.Errorf("Sora 官方 input_reference 只支持一张首帧参考图")
		}
		return nil
	}
	if size != "" && !contains("", "1280x720", "720x1280") {
		return fmt.Errorf("视频画幅仅支持 16:9 或 9:16")
	}
	if seconds != 4 && seconds != 8 && seconds != 12 {
		return fmt.Errorf("视频时长支持 4 秒、8 秒或 12 秒")
	}
	if resolution != "" && resolution != "720p" && resolution != "1080p" {
		return fmt.Errorf("视频清晰度仅支持 720p 或 1080p")
	}
	return nil
}

func validateVideoPrompt(model, prompt string) error {
	characters := utf8.RuneCountInString(prompt)
	if isMiniMaxH3Model(model) && characters > 7000 {
		return fmt.Errorf("MiniMax H3 官方提示词最多支持 7000 个字符")
	}
	if isKling3Model(model) && characters > 3072 {
		return fmt.Errorf("Kling 3.0 官方提示词最多支持 3072 个字符")
	}
	return nil
}

func seedanceVideoProfile(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	if !strings.Contains(name, "seedance") {
		return ""
	}
	switch {
	case strings.Contains(name, "2-5") || strings.Contains(name, "2.5"):
		return "2.5"
	case strings.Contains(name, "2-0") || strings.Contains(name, "2.0"):
		if strings.Contains(name, "fast") {
			return "2.0-fast"
		}
		if strings.Contains(name, "mini") {
			return "2.0-mini"
		}
		return "2.0"
	case strings.Contains(name, "1-5") || strings.Contains(name, "1.5"):
		return "1.5"
	case strings.Contains(name, "1-0") || strings.Contains(name, "1.0"):
		return "1.0"
	default:
		return ""
	}
}

func isKling3Model(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(name, "kling") && (strings.Contains(name, "v3") || strings.Contains(name, "3-0") || strings.Contains(name, "3.0"))
}

func isKnownGrokVideoModel(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return name == "grok-imagine-video" || name == "grok-imagine-video-latest" || strings.Contains(name, "grok-imagine-video-1.5") || strings.Contains(name, "grok-imagine-video-1-5")
}

func isKlingLegacyModel(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	if !strings.Contains(name, "kling") || isKling3Model(name) {
		return false
	}
	return strings.Contains(name, "kling-v1") || strings.Contains(name, "kling-v2") || strings.Contains(name, "kling-1") || strings.Contains(name, "kling-2")
}

func isSora2Model(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(name, "sora-2") || strings.Contains(name, "sora_2")
}

func stringIn(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func videoDefaultSeconds(model string) int {
	name := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(name, "grok") {
		return 10
	}
	if strings.Contains(name, "minimax") || strings.Contains(name, "hailuo") || strings.HasPrefix(name, "t2v-") || strings.HasPrefix(name, "i2v-") || strings.HasPrefix(name, "s2v-") {
		if strings.Contains(name, "h3") {
			return 5
		}
		return 6
	}
	if strings.Contains(name, "kling") {
		if strings.Contains(name, "v3") || strings.Contains(name, "3-0") {
			return 5
		}
		return 5
	}
	if strings.Contains(name, "seedance") || strings.Contains(name, "doubao-seedance") {
		return 5
	}
	return 4
}

func creationTaskRequestMetadata(body map[string]any) map[string]any {
	metadata := map[string]any{}
	if tokenGroup := selectedRelayTokenGroupFromPayload(body); tokenGroup != "" {
		metadata["token_group"] = tokenGroup
	}
	if tokenName := selectedRelayTokenNameFromPayload(body); tokenName != "" {
		metadata["token_name"] = tokenName
	}
	return metadata
}

func imageTaskRequestMetadata(body map[string]any) map[string]any {
	requestedSize := firstNonEmpty(util.Clean(body["requested_size"]), util.Clean(body["size"]))
	metadata := creationTaskRequestMetadata(body)
	if preset := service.NormalizeImageResolutionPreset(util.Clean(body["image_resolution"])); preset != "" {
		metadata["image_resolution"] = preset
	}
	if requestedSize != "" {
		metadata["requested_size"] = requestedSize
	}
	if util.ToBool(body["share_prompt_parameters"]) {
		metadata["share_prompt_parameters"] = true
		if util.ToBool(body["share_reference_images"]) {
			metadata["share_reference_images"] = true
		}
	}
	if conversationID := util.Clean(body["frontend_conversation_id"]); conversationID != "" {
		metadata["frontend_conversation_id"] = conversationID
	}
	if fallback := util.StringMap(body["fallback_reference_image"]); len(fallback) > 0 {
		metadata["fallback_reference_image"] = fallback
	}
	return metadata
}

func imageOutputOptionsFromBody(body map[string]any) service.ImageOutputOptions {
	rawFormat := util.Clean(body["output_format"])
	if rawFormat == "" {
		return service.ImageOutputOptions{}
	}
	format := service.NormalizeImageOutputFormat(rawFormat)
	options := service.ImageOutputOptions{Format: format}
	if service.SupportsImageOutputCompression(format) {
		if compression, ok := imageOutputCompressionFromBody(body["output_compression"]); ok {
			options.Compression = &compression
		}
	}
	return options
}

func imageToolOptionsFromBody(body map[string]any) service.ImageToolOptions {
	options := service.ImageToolOptions{
		Moderation:     util.Clean(body["moderation"]),
		InputImageMask: util.Clean(body["input_image_mask"]),
		Stream:         util.ToBool(body["stream"]),
	}
	if partialImages, ok := imagePartialImagesFromBody(body["partial_images"]); ok {
		options.PartialImages = partialImages
	}
	return options
}

func imagePartialImagesFromBody(value any) (int, bool) {
	partialImages, ok := util.StrictInt(value)
	if !ok {
		return 0, false
	}
	if partialImages < 1 || partialImages > 3 {
		return 0, false
	}
	return partialImages, true
}

func imageOutputCompressionFromBody(value any) (int, bool) {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return 0, false
	}
	compression, ok := util.StrictInt(value)
	if !ok {
		return 0, false
	}
	if compression < 0 {
		return 0, false
	}
	if compression > 100 {
		compression = 100
	}
	return compression, true
}

func (a *App) writeCreationTaskSubmitError(w http.ResponseWriter, err error) {
	var httpErr protocol.HTTPError
	if errors.As(err, &httpErr) {
		status := httpErr.Status
		if status < http.StatusBadRequest || status > 599 {
			status = http.StatusBadRequest
		}
		util.WriteError(w, status, httpErr.Message)
		return
	}
	var limitErr service.ImageTaskLimitError
	if errors.As(err, &limitErr) {
		util.WriteError(w, http.StatusTooManyRequests, limitErr.Error())
		return
	}
	if a.writeCreationTaskStorageError(w, err) {
		return
	}
	util.WriteError(w, http.StatusBadRequest, err.Error())
}

func (a *App) writeCreationTaskStorageError(w http.ResponseWriter, err error) bool {
	var persistenceErr service.ImageTaskPersistenceError
	if errors.As(err, &persistenceErr) {
		if a != nil && a.logger != nil {
			a.logger.Error("creation task persistence failed", "error", persistenceErr.Err)
		}
		util.WriteError(w, http.StatusServiceUnavailable, persistenceErr.Error())
		return true
	}
	var loadErr service.ImageTaskLoadError
	if !errors.As(err, &loadErr) {
		return false
	}
	if a != nil && a.logger != nil {
		a.logger.Error("creation task database load failed", "error", loadErr.Err)
	}
	util.WriteError(w, http.StatusServiceUnavailable, loadErr.Error())
	return true
}

func splitPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}
