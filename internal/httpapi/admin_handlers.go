package httpapi

import (
	"errors"
	"net/http"

	"chatgpt2api/internal/util"
)

func (a *App) handleAdminRoles(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	base := "/api/admin/roles"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			util.WriteJSON(w, http.StatusOK, map[string]any{"items": a.auth.ListRoles()})
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
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
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
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
	_, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	base := "/api/admin/users"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			response, err := a.managedUsersResponse(r)
			if err != nil {
				if errors.Is(err, errManagedUserUsageStatsUnavailable) {
					util.WriteError(w, http.StatusServiceUnavailable, "用户使用统计暂时不可用，请稍后重试")
					return
				}
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
			query, err := parseManagedUsersQuery(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			enabled := true
			if value, ok := body["enabled"]; ok {
				enabled = util.ToBool(value)
			}
			password, _ := body["password"].(string)
			item, err := a.auth.CreatePasswordUser(
				util.Clean(body["username"]),
				password,
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
			response := a.managedUsersResponseAfterMutation(query)
			if current := a.managedUser(util.Clean(item["id"])); current != nil {
				if err := a.attachManagedUserUsage([]map[string]any{current}); err != nil {
					response["usage_stats_available"] = false
				}
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
	if len(parts) != 4 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
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
		query, err := parseManagedUsersQuery(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
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
		response := a.managedUsersResponseAfterMutation(query)
		item := a.managedUser(userID)
		if item != nil {
			if err := a.attachManagedUserUsage([]map[string]any{item}); err != nil {
				response["usage_stats_available"] = false
			}
		}
		response["item"] = item
		util.WriteJSON(w, http.StatusOK, response)
	case http.MethodDelete:
		query, err := parseManagedUsersQuery(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
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
		response := a.managedUsersResponseAfterMutation(query)
		util.WriteJSON(w, http.StatusOK, response)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
