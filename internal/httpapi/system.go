package httpapi

import (
	"net/http"
	"os"

	"chatgpt2api/internal/util"
)

func (a *App) handleHealth(w http.ResponseWriter, _ *http.Request) {
	if os.Getenv("DESKTOP_RUNTIME") == "1" {
		if token := os.Getenv("DESKTOP_INSTANCE_TOKEN"); token != "" {
			w.Header().Set("X-Desktop-Instance", token)
		}
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
	})
}
