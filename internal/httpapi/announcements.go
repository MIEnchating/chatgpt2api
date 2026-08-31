package httpapi

import (
	"net/http"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleAnnouncements(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	items, err := a.announce.ListVisible()
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, "failed to load announcements")
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) handleAnnouncementPreferences(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	ownerID := identityScope(identity)
	switch r.Method {
	case http.MethodGet:
		preferences, err := a.announce.Preferences(ownerID)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to load announcement preferences")
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	case http.MethodPost:
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		preferences, err := a.announce.UpdatePreferences(
			ownerID,
			util.Clean(body["version"]),
			util.Clean(body["action"]),
			util.Clean(body["local_date"]),
		)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"preferences": preferences})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleAdminAnnouncements(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "admin permission required")
		return
	}

	base := "/api/admin/announcements"
	if r.URL.Path == base {
		switch r.Method {
		case http.MethodGet:
			items, err := a.announce.ListAll()
			if err != nil {
				util.WriteError(w, http.StatusInternalServerError, "failed to load announcements")
				return
			}
			writeAdminAnnouncements(w, items, nil)
		case http.MethodPost:
			body, err := readJSONMap(r)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, "invalid json body")
				return
			}
			item, items, err := a.announce.CreateWithItems(body)
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			writeAdminAnnouncements(w, items, &item)
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
		item, items, err := a.announce.UpdateWithItems(id, body)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if item == nil {
			util.WriteError(w, http.StatusNotFound, "announcement not found")
			return
		}
		writeAdminAnnouncements(w, items, item)
	case http.MethodDelete:
		deleted, items, err := a.announce.DeleteWithItems(id)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to delete announcement")
			return
		}
		if !deleted {
			util.WriteError(w, http.StatusNotFound, "announcement not found")
			return
		}
		writeAdminAnnouncements(w, items, nil)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func writeAdminAnnouncements(w http.ResponseWriter, items []service.Announcement, item *service.Announcement) {
	payload := map[string]any{"items": items}
	if item != nil {
		payload["item"] = item
	}
	util.WriteJSON(w, http.StatusOK, payload)
}
