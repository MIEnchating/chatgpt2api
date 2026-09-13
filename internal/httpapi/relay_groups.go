package httpapi

import (
	"net/http"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleRelayCreationGroups(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "仅管理员可以读取默认密钥分组")
		return
	}
	reader, release := a.acquireRelayTokenReader()
	defer release()
	groups, err := reader.CreationGroups(r.Context())
	if err != nil {
		util.WriteError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"groups": groups})
}
