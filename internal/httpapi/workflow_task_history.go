package httpapi

import (
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleWorkflowTaskHistory(w http.ResponseWriter, r *http.Request, identity service.Identity) {
	values := r.URL.Query()
	query := service.WorkflowTaskHistoryQuery{Page: 1, PageSize: 12, Status: "all"}
	switch values.Get("view") {
	case "active":
		query.Active = true
	case "history":
		if raw := values.Get("page"); raw != "" {
			page, err := strconv.Atoi(raw)
			if err != nil || page < 1 {
				util.WriteError(w, http.StatusBadRequest, "任务记录页码无效")
				return
			}
			query.Page = page
		}
		if raw := values.Get("page_size"); raw != "" {
			size, err := strconv.Atoi(raw)
			if err != nil || (size != 12 && size != 24 && size != 48) {
				util.WriteError(w, http.StatusBadRequest, "任务记录每页数量无效")
				return
			}
			query.PageSize = size
		}
		switch status := values.Get("status"); status {
		case "":
		case "all", "running", "success", "failed":
			query.Status = status
		default:
			util.WriteError(w, http.StatusBadRequest, "任务记录状态无效")
			return
		}
	default:
		util.WriteError(w, http.StatusBadRequest, "任务记录视图无效")
		return
	}
	result, err := a.tasks.WorkflowTaskHistory(identity, query)
	if err != nil {
		if !a.writeCreationTaskStorageError(w, err) {
			util.WriteError(w, http.StatusInternalServerError, "读取工作流任务记录失败")
		}
		return
	}
	util.WriteJSON(w, http.StatusOK, result)
}

func (a *App) handleClearWorkflowTaskHistory(w http.ResponseWriter, r *http.Request, identity service.Identity, body map[string]any) {
	excluded := util.AsStringSlice(body["exclude_batch_ids"])
	if len(excluded) > 1000 || body["confirm"] != true {
		util.WriteError(w, http.StatusBadRequest, "无效的任务记录清理请求")
		return
	}
	includeAssets := body["include_assets"] == true && a.identityCanAccessAPI(identity, http.MethodDelete, "/api/images")
	result, err := a.tasks.ClearWorkflowTaskHistory(identity, excluded, includeAssets)
	if err != nil {
		if service.IsConcurrentRowUpdate(err) {
			util.WriteError(w, http.StatusConflict, "任务记录正在更新，请重试")
			return
		}
		if !a.writeCreationTaskStorageError(w, err) {
			util.WriteError(w, http.StatusInternalServerError, "清理工作流任务记录失败")
		}
		return
	}
	if len(result.ResultURLs) > 0 {
		currentBase, _ := url.Parse(requestMediaBaseURL(r))
		configuredBase, _ := url.Parse(a.resolveImageBaseURL(r.Context()))
		result.ResultURLs = slices.DeleteFunc(result.ResultURLs, func(value string) bool {
			return !isWorkflowCleanupImageURL(value, currentBase, configuredBase)
		})
	}
	util.WriteJSON(w, http.StatusOK, result)
}

func isWorkflowCleanupImageURL(value string, bases ...*url.URL) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.User != nil || parsed.Opaque != "" {
		return false
	}
	if parsed.Host == "" && parsed.Scheme == "" {
		return strings.HasPrefix(parsed.EscapedPath(), "/images/")
	}
	for _, base := range bases {
		if base != nil && base.Host != "" && strings.EqualFold(base.Host, parsed.Host) &&
			base.Scheme == parsed.Scheme && strings.HasPrefix(parsed.EscapedPath(), strings.TrimRight(base.EscapedPath(), "/")+"/images/") {
			return true
		}
	}
	return false
}
