package httpapi

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleAgentSkills(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	system := strings.HasPrefix(r.URL.Path, "/api/admin/agent-skills")
	if system && identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "只有管理员可以管理系统 Skill")
		return
	}
	if a.agentSkills == nil {
		util.WriteError(w, http.StatusServiceUnavailable, "Skill 存储不可用")
		return
	}
	root := "/api/profile/agent-skills"
	if system {
		root = "/api/admin/agent-skills"
	}
	remainder := strings.TrimPrefix(r.URL.Path, root)
	parts := strings.Split(strings.TrimPrefix(remainder, "/"), "/")
	id := parts[0]
	ownerID := identityScope(identity)
	if len(parts) == 2 && parts[1] == "file" && id != "" && !system && r.Method == http.MethodGet {
		content, err := a.agentSkills.ReadFile(ownerID, id, r.URL.Query().Get("path"))
		if err != nil {
			writeAgentSkillError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"path": r.URL.Query().Get("path"), "content": content})
		return
	}
	if len(parts) != 1 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		if id != "" {
			item, err := a.agentSkills.Get(ownerID, id, system)
			if err != nil {
				writeAgentSkillError(w, err)
				return
			}
			util.WriteJSON(w, http.StatusOK, map[string]any{"item": agentSkillResponse(item, system)})
			return
		}
		items, err := a.agentSkills.List(ownerID, system)
		if err != nil {
			writeAgentSkillError(w, err)
			return
		}
		views := make([]map[string]any, len(items))
		for index, item := range items {
			views[index] = agentSkillResponse(item, system)
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"items": views})
	case http.MethodPost, http.MethodPut:
		if r.Method == http.MethodPost && id != "" || r.Method == http.MethodPut && id == "" {
			http.NotFound(w, r)
			return
		}
		var input service.AgentSkillInput
		r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
		if err := util.DecodeJSON(r.Body, &input); err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				util.WriteError(w, http.StatusRequestEntityTooLarge, "Skill 请求不能超过 4 MiB")
				return
			}
			util.WriteError(w, http.StatusBadRequest, "Skill 请求格式无效")
			return
		}
		item, err := a.agentSkills.Save(ownerID, id, system, input)
		if err != nil {
			writeAgentSkillError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"item": agentSkillResponse(item, system)})
	case http.MethodDelete:
		revision, err := strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
		if err != nil || revision < 1 {
			util.WriteError(w, http.StatusBadRequest, "删除需要当前版本号")
			return
		}
		if err := a.agentSkills.Delete(ownerID, id, system, revision); err != nil {
			writeAgentSkillError(w, err)
			return
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func agentSkillResponse(item service.AgentSkill, includeFiles bool) map[string]any {
	paths := make([]string, 0, len(item.Files))
	for filename := range item.Files {
		paths = append(paths, filename)
	}
	slices.Sort(paths)
	result := map[string]any{"id": item.ID, "name": item.Name, "description": item.Description, "content": item.Content, "scope": item.Scope, "enabled": item.Enabled, "revision": item.Revision, "updated_at": item.UpdatedAt, "file_paths": paths}
	if includeFiles {
		result["files"] = item.Files
	}
	return result
}

func writeAgentSkillError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidAgentSkill):
		util.WriteError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, service.ErrAgentSkillNotFound):
		util.WriteError(w, http.StatusNotFound, "Skill 或附属文件不存在")
	case errors.Is(err, service.ErrAgentSkillConflict):
		util.WriteError(w, http.StatusConflict, "Skill 已被更新，请刷新后重试")
	default:
		util.WriteError(w, http.StatusInternalServerError, "Skill 存储操作失败")
	}
}
