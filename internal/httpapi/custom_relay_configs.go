package httpapi

import (
	"net/http"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleProfileCustomRelayConfigs(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if a.customRelayConfigs == nil {
		util.WriteError(w, http.StatusServiceUnavailable, "自定义 API 配置存储不可用")
		return
	}
	configurable := identity.Role == service.AuthRoleAdmin || a.config.AllowUserCustomRelayConfig()
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/profile/custom-relay-configs"), "/")
	if path == "" {
		switch r.Method {
		case http.MethodGet:
			statuses, err := a.customRelayConfigs.Statuses(identityScope(identity))
			if err != nil {
				util.WriteError(w, http.StatusInternalServerError, "读取自定义 API 配置失败")
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"configurable": configurable, "configs": statuses})
		case http.MethodPost:
			if !configurable {
				util.WriteError(w, http.StatusForbidden, "管理员尚未允许用户添加自定义 API 配置")
				return
			}
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			status, err := a.customRelayConfigs.Create(identityScope(identity), util.Clean(body["kind"]), util.Clean(body["name"]), util.Clean(body["base_url"]), util.Clean(body["api_key"]))
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			util.WriteJSON(w, http.StatusCreated, map[string]any{"item": status})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}
	if !configurable {
		util.WriteError(w, http.StatusForbidden, "管理员尚未允许用户添加自定义 API 配置")
		return
	}
	switch r.Method {
	case http.MethodPut:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		status, err := a.customRelayConfigs.Update(identityScope(identity), path, util.Clean(body["name"]), util.Clean(body["base_url"]), util.Clean(body["api_key"]))
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": status})
	case http.MethodDelete:
		if err := a.customRelayConfigs.Delete(identityScope(identity), path); err != nil {
			util.WriteError(w, http.StatusInternalServerError, "删除自定义 API 配置失败")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
