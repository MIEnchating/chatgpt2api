package httpapi

import (
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) requireIdentity(w http.ResponseWriter, r *http.Request) (service.Identity, bool) {
	token := requestAuthCookieToken(r)
	identity, authErr := a.authenticateSession(r, token)
	if authErr != nil {
		a.writeAuthPersistenceError(w, authErr)
		return service.Identity{}, false
	}
	if identity != nil {
		if !a.identityCanAccessRequest(*identity, r) {
			util.WriteError(w, http.StatusForbidden, "permission denied")
			return service.Identity{}, false
		}
		*r = *r.WithContext(withRequestIdentity(r.Context(), *identity))
		return *identity, true
	}
	util.WriteError(w, http.StatusUnauthorized, "authorization is invalid")
	return service.Identity{}, false
}

func requestAuthCookieToken(r *http.Request) string {
	cookie, err := r.Cookie(authSessionCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

func (a *App) imageRequestIdentity(w http.ResponseWriter, r *http.Request) (service.Identity, bool) {
	token := requestAuthCookieToken(r)
	if token == "" {
		util.WriteError(w, http.StatusUnauthorized, "authorization is invalid")
		return service.Identity{}, false
	}
	identity, authErr := a.authenticateSession(r, token)
	if authErr != nil {
		a.writeAuthPersistenceError(w, authErr)
		return service.Identity{}, false
	}
	if identity != nil {
		return *identity, true
	}
	util.WriteError(w, http.StatusUnauthorized, "authorization is invalid")
	return service.Identity{}, false
}

func (a *App) identityPermissions(identity service.Identity) service.PermissionSet {
	if identity.Role == service.AuthRoleAdmin {
		return service.DefaultPermissionSetForRole(service.AuthRoleAdmin)
	}
	return service.PermissionSet{
		MenuPaths:      service.NormalizeMenuPermissions(identity.MenuPaths),
		APIPermissions: service.NormalizeAPIPermissions(identity.APIPermissions),
	}
}

func (a *App) identityCanAccessRequest(identity service.Identity, r *http.Request) bool {
	if identity.Role == service.AuthRoleAdmin || isPermissionCheckSkipped(r.Method, r.URL.Path) {
		return true
	}
	return a.identityCanAccessAPI(identity, r.Method, r.URL.Path)
}

func (a *App) identityCanAccessAPI(identity service.Identity, method, path string) bool {
	if identity.Role == service.AuthRoleAdmin {
		return true
	}
	return service.HasAPIPermission(a.identityPermissions(identity), method, path)
}

func isPermissionCheckSkipped(method, path string) bool {
	switch path {
	case "/auth/login":
		return true
	case "/auth/logout":
		return true
	case "/auth/session":
		return true
	case "/api/profile/relay-key":
		return true
	case "/api/profile/custom-relay-configs":
		return true
	case "/api/profile/balance":
		return true
	case "/api/model-config":
		return true
	case "/api/prompt-sources":
		return true
	case "/api/storage/config":
		return true
	case "/api/announcements":
		return true
	case "/api/profile/announcement-preferences":
		return true
	case "/api/profile/image-generation-preferences":
		return true
	case "/api/profile/storage-provider":
		return true
	case "/api/profile/storage-provider/measure":
		return true
	case "/api/profile/upstream-models":
		return true
	case "/api/profile/agent-skills", "/api/profile/autodl-workflows", "/api/profile/runninghub-workflows":
		return true
	case "/api/profile/prompt-favorites":
		return true
	case "/api/profile/assets":
		return true
	case "/api/profile/asset-groups":
		return true
	case "/api/profile/image-conversations":
		return true
	default:
		return strings.HasPrefix(path, "/api/profile/agent-skills/") ||
			strings.HasPrefix(path, "/api/profile/custom-relay-configs/") ||
			strings.HasPrefix(path, "/api/profile/prompt-favorites/") ||
			strings.HasPrefix(path, "/api/profile/image-conversations/") ||
			(method == http.MethodGet || method == http.MethodHead) && strings.HasPrefix(path, "/api/files/")
	}
}

func setAuthSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	token = strings.TrimSpace(token)
	if token == "" {
		return
	}
	setAuthSessionCookieValue(w, r, token, int(service.AuthSessionLifetime/time.Second))
}

func setAuthSessionCookieValue(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	cookie := &http.Cookie{
		Name:     authSessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		SameSite: http.SameSiteLaxMode,
	}
	http.SetCookie(w, cookie)
}

func clearAuthSessionCookie(w http.ResponseWriter, r *http.Request) {
	setAuthSessionCookieValue(w, r, "", -1)
}
