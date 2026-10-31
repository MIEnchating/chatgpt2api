package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxLoginRequestBodyBytes)
	body, err := readJSONMap(r)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			util.WriteError(w, http.StatusRequestEntityTooLarge, "login payload is too large")
			return
		}
		util.WriteError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	username := util.Clean(body["username"])
	password, _ := body["password"].(string)
	loginLimiter := a.loginLimiter
	requestIP := clientIP(r)
	if retryAfter, allowed := loginLimiter.allow(requestIP, username); !allowed {
		w.Header().Set("Retry-After", loginRetryAfterSeconds(retryAfter))
		util.WriteError(w, http.StatusTooManyRequests, "登录尝试过于频繁，请稍后再试")
		return
	}
	var onboardingWarnings []string
	identity, token, err := a.auth.LoginPassword(username, password)
	if err != nil {
		if a.writeAuthPersistenceError(w, err) {
			return
		}
		if !errors.Is(err, service.ErrInvalidPasswordCredentials) {
			loginLimiter.recordFailure(requestIP, username)
			util.WriteError(w, http.StatusUnauthorized, "用户名或密码错误")
			return
		}
		newAPIKeys, releaseRelayTokenReader := a.acquireRelayTokenReader()
		defer releaseRelayTokenReader()
		if strings.EqualFold(username, a.config.AdminUsername()) || newAPIKeys == nil {
			loginLimiter.recordFailure(requestIP, username)
			util.WriteError(w, http.StatusUnauthorized, "用户名或密码错误")
			return
		}
		newAPIUser, newAPIErr := newAPIKeys.AuthenticatePassword(r.Context(), username, password)
		if newAPIErr != nil {
			loginLimiter.recordFailure(requestIP, username)
			if a.logger != nil {
				a.logger.Warning("upstream password login failed", "error", newAPIErr)
			}
			util.WriteError(w, http.StatusUnauthorized, "用户名或密码错误")
			return
		}
		identity, token, err = a.auth.UpsertNewAPISession(newAPIUser)
		if err != nil {
			if errors.Is(err, service.ErrAuthUserDisabled) {
				util.WriteError(w, http.StatusForbidden, err.Error())
				return
			}
			if !a.writeAuthPersistenceError(w, err) {
				util.WriteError(w, http.StatusInternalServerError, "登录会话保存失败")
			}
			return
		}
		onboardingWarnings = a.initializeRelayGroups(r.Context(), newAPIKeys, *identity, &newAPIUser, password)
	}
	loginLimiter.recordSuccess(requestIP, username)
	setAuthSessionCookie(w, r, token)
	a.writeLoginResponseWithOnboarding(w, *identity, onboardingWarnings)
}

func (a *App) handleSession(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if token := requestAuthCookieToken(r); token != "" {
		setAuthSessionCookie(w, r, token)
	}
	a.writeLoginResponse(w, identity)
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if _, err := a.auth.RevokeSessions(requestAuthCookieToken(r)); err != nil {
		if !a.writeAuthPersistenceError(w, err) {
			util.WriteError(w, http.StatusInternalServerError, "failed to revoke session")
		}
		return
	}
	clearAuthSessionCookie(w, r)
	util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) writeLoginResponse(w http.ResponseWriter, identity service.Identity) {
	a.writeLoginResponseWithOnboarding(w, identity, nil)
}

func (a *App) writeLoginResponseWithOnboarding(w http.ResponseWriter, identity service.Identity, warnings []string) {
	permissions := a.identityPermissions(identity)
	payload := map[string]any{
		"ok":                        true,
		"role":                      identity.Role,
		"role_id":                   identity.RoleID,
		"role_name":                 identity.RoleName,
		"subject_id":                identity.ID,
		"username":                  identity.Username,
		"name":                      identity.Name,
		"provider":                  identity.Provider,
		"credential_id":             identity.CredentialID,
		"credential_name":           identity.CredentialName,
		"creation_concurrent_limit": a.identityCreationConcurrentLimit(identity),
		"creation_rpm_limit":        a.identityCreationRPMLimit(identity),
		"menu_paths":                permissions.MenuPaths,
		"api_permissions":           permissions.APIPermissions,
		"menus":                     service.FilterMenuPermissions(permissions.MenuPaths),
	}
	if len(warnings) > 0 {
		payload["relay_onboarding_warnings"] = warnings
	}
	util.WriteJSON(w, http.StatusOK, payload)
}

func (a *App) identityCreationConcurrentLimit(identity service.Identity) int {
	if identity.Role != service.AuthRoleUser {
		return 0
	}
	return a.config.UserDefaultConcurrentLimit()
}

func (a *App) identityCreationRPMLimit(identity service.Identity) int {
	if identity.Role != service.AuthRoleUser {
		return 0
	}
	return a.config.UserDefaultRPMLimit()
}
