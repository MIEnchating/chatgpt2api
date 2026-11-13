package httpapi

import (
	"net/http"
	"strings"

	"chatgpt2api/internal/util"
)

// This action is reached only through the administrator contract router.
func (a *App) handleVideoMaterialUploadCredential(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet {
		key, err := a.videoContracts.MaterialUploadAPIKey(id, r.URL.Query().Get("base_url"))
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"configured": key != ""})
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(w, r.Body, 20<<10), &body); err != nil {
		util.WriteError(w, http.StatusBadRequest, "上传密钥配置请求无效")
		return
	}
	if r.Method == http.MethodPut && strings.TrimSpace(body.APIKey) == "" {
		util.WriteError(w, http.StatusBadRequest, "请输入上传密钥；清除密钥请使用删除操作")
		return
	}
	if r.Method == http.MethodDelete {
		body.APIKey = ""
	}
	if err := a.videoContracts.SetMaterialUploadAPIKey(id, body.BaseURL, body.APIKey); err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"configured": body.APIKey != ""})
}
