package httpapi

import (
	"net/http"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleProfileAssetGroups(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	if r.Method == http.MethodGet {
		groups, err := a.myAssets.ListGroups(ownerID)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "分组读取失败")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": groups})
		return
	}
	operation := map[string]string{http.MethodPost: "create", http.MethodPatch: "update", http.MethodDelete: "delete"}[r.Method]
	if operation == "" {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body service.MyAssetGroupMutation
	if err := util.DecodeJSON(r.Body, &body); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	groups, err := a.myAssets.MutateGroup(ownerID, operation, body)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": groups})
}
