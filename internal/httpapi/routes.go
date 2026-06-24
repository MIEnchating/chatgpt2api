package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

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
		item := a.auth.UpdateKey(keyID, updates, filter)
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "user key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListKeys(filter)})
	case http.MethodDelete:
		if !a.auth.DeleteKey(keyID, filter) {
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
		a.writeLoginResponse(w, identity, "")
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		updated, err := a.auth.UpdateProfileName(identity, util.Clean(body["name"]))
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		a.writeLoginResponse(w, *updated, "")
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
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
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
		item := a.auth.UpdateKey(keyID, updates, filter)
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "profile API key not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.auth.ListPersonalAPIKey(identity)})
	case http.MethodDelete:
		if !a.auth.DeleteKey(keyID, filter) {
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
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.promptFavoritesForIdentity(ownerID, identity)})
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
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.promptFavoritesForIdentity(ownerID, identity)})
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
	if !a.prompts.Delete(ownerID, parts[3]) {
		util.WriteError(w, http.StatusNotFound, "prompt favorite not found")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.promptFavoritesForIdentity(ownerID, identity)})
}

func (a *App) promptFavoritesForIdentity(ownerID string, identity service.Identity) []map[string]any {
	items := a.prompts.List(ownerID)
	if a.identityCanAccessAPI(identity, http.MethodGet, service.PromptMarketAdultPermissionPath) {
		return items
	}
	filtered := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if util.ToBool(item["is_nsfw"]) {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered
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
			if item := a.auth.UpdateUser(userID, updates); item == nil {
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
		if !a.auth.DeleteUser(userID) {
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

func (a *App) handlePublicAnnouncements(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.announce.ListVisible(strings.TrimSpace(r.URL.Query().Get("target")))})
}

func (a *App) handleAdminAnnouncements(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r, ""); !ok {
		return
	}
	base := "/api/admin/announcements"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.announce.ListAll()})
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			if util.Clean(body["content"]) == "" {
				util.WriteError(w, http.StatusBadRequest, "content is required")
				return
			}
			item := a.announce.Create(body)
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.announce.ListAll()})
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
		if value, exists := body["content"]; exists && util.Clean(value) == "" {
			util.WriteError(w, http.StatusBadRequest, "content is required")
			return
		}
		item := a.announce.Update(id, body)
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "announcement not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": item, "items": a.announce.ListAll()})
	case http.MethodDelete:
		if !a.announce.Delete(id) {
			util.WriteError(w, http.StatusNotFound, "announcement not found")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.announce.ListAll()})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
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
		result := a.accounts.AddAccounts(tokens)
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
		result := a.accounts.DeleteAccounts(tokens)
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
		result := a.accounts.SetAccountsEnabledByIDs(accountIDs, util.ToBool(enabledRaw))
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
		item := a.accounts.UpdateAccount(token, updates)
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
		util.WriteJSON(w, http.StatusOK, a.tasks.ListTasks(identity, util.ParseCommaList(r.URL.Query().Get("ids"))))
		return
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "creation-tasks" && parts[3] == "cancel" {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		task, err := a.tasks.CancelTask(identity, parts[2])
		if err != nil {
			util.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/image-generations" && r.Method == http.MethodPost {
		body, _ := readJSONMap(r)
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			writeCreationTaskSubmitError(w, err)
			return
		}
		a.applyImageStreamParameter(body)
		model := a.applyDefaultImageModel(body)
		task, err := a.tasks.SubmitGenerationWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), util.Clean(body["quality"]), a.relayBaseURL(), util.ToInt(body["n"], 1), body["messages"], imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/chat-completions" && r.Method == http.MethodPost {
		body, _ := readJSONMap(r)
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			writeCreationTaskSubmitError(w, err)
			return
		}
		billable := protocol.IsImageChatRequest(body)
		model := a.applyDefaultChatCompletionModel(body)
		task, err := a.tasks.SubmitChatWithMetadata(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, body["messages"], billable, creationTaskRequestMetadata(body), util.ToInt(body["n"], 1))
		if err != nil {
			writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	if r.URL.Path == "/api/creation-tasks/image-edits" && r.Method == http.MethodPost {
		body, images, err := readMultipartImageBody(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := a.relayAPIKeyForIdentitySelection(r.Context(), identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body)); err != nil {
			writeCreationTaskSubmitError(w, err)
			return
		}
		a.applyImageStreamParameter(body)
		model := a.applyDefaultImageModel(body)
		task, err := a.tasks.SubmitEditWithOptions(r.Context(), identity, util.Clean(body["client_task_id"]), util.Clean(body["prompt"]), model, util.Clean(body["size"]), util.Clean(body["quality"]), a.relayBaseURL(), images, util.ToInt(body["n"], 1), body["messages"], imageTaskRequestMetadata(body), imageOutputOptionsFromBody(body), imageToolOptionsFromBody(body), util.Clean(body["visibility"]))
		if err != nil {
			writeCreationTaskSubmitError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, task)
		return
	}
	http.NotFound(w, r)
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
	size := util.Clean(body["size"])
	metadata := creationTaskRequestMetadata(body)
	if preset := service.NormalizeImageResolutionPreset(util.Clean(body["image_resolution"])); preset != "" {
		metadata["image_resolution"] = preset
	}
	if size != "" {
		metadata["requested_size"] = size
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
	format := service.NormalizeImageOutputFormat(util.Clean(body["output_format"]))
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
		Background:     util.Clean(body["background"]),
		Moderation:     util.Clean(body["moderation"]),
		InputImageMask: util.Clean(body["input_image_mask"]),
	}
	return options
}

func imageOutputCompressionFromBody(value any) (int, bool) {
	if value == nil || strings.TrimSpace(util.Clean(value)) == "" {
		return 0, false
	}
	compression := util.ToInt(value, -1)
	if compression < 0 {
		return 0, false
	}
	if compression > 100 {
		compression = 100
	}
	return compression, true
}

func writeCreationTaskSubmitError(w http.ResponseWriter, err error) {
	var limitErr service.ImageTaskLimitError
	if errors.As(err, &limitErr) {
		util.WriteError(w, http.StatusTooManyRequests, limitErr.Error())
		return
	}
	util.WriteError(w, http.StatusBadRequest, err.Error())
}

func splitPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}
