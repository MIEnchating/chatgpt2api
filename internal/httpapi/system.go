package httpapi

import (
	"net/http"

	"chatgpt2api/internal/util"
)

func (a *App) handleHealth(w http.ResponseWriter, _ *http.Request) {
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
	})
}
