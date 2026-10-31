package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

type managedUsersQuery struct {
	Page       int
	PageSize   int
	Search     string
	Provider   string
	Status     string
	SortBy     string
	SortOrder  string
	Total      int
	TotalPages int
}

var errManagedUserUsageStatsUnavailable = errors.New("managed user usage stats unavailable")

func (a *App) managedUsersResponse(r *http.Request) (map[string]any, error) {
	query, err := parseManagedUsersQuery(r)
	if err != nil {
		return nil, err
	}
	return a.managedUsersResponseForQuery(query)
}

func (a *App) managedUsersResponseForQuery(query managedUsersQuery) (map[string]any, error) {
	items := filterManagedUsers(a.auth.ListUsers(), query)
	usageSort := managedUsersSortUsesUsage(query.SortBy)
	if err := a.prepareManagedUsersSortValues(items, query.SortBy); err != nil {
		return nil, fmt.Errorf("%w: %v", errManagedUserUsageStatsUnavailable, err)
	}
	sortManagedUsers(items, query)
	query.Total = len(items)
	query.TotalPages = managedUsersTotalPages(query.Total, query.PageSize)
	if query.Page > query.TotalPages {
		query.Page = query.TotalPages
	}
	start := (query.Page - 1) * query.PageSize
	if start > query.Total {
		start = query.Total
	}
	end := start + query.PageSize
	if end > query.Total {
		end = query.Total
	}
	pageItems := items[start:end]
	usageStatsAvailable := true
	if !usageSort {
		usageStatsAvailable = a.attachManagedUserUsage(pageItems) == nil
	}
	return map[string]any{
		"items":                 pageItems,
		"total":                 query.Total,
		"page":                  query.Page,
		"page_size":             query.PageSize,
		"sort_by":               query.SortBy,
		"sort_order":            query.SortOrder,
		"total_pages":           query.TotalPages,
		"usage_stats_available": usageStatsAvailable,
	}, nil
}

func (a *App) managedUsersResponseAfterMutation(query managedUsersQuery) map[string]any {
	response, err := a.managedUsersResponseForQuery(query)
	if err == nil {
		return response
	}

	// The mutation has already committed. Return a truthful fallback page instead
	// of turning a secondary usage-statistics failure into a retryable write error.
	fallback := query
	fallback.SortBy = "created_at"
	fallback.SortOrder = "desc"
	response, _ = a.managedUsersResponseForQuery(fallback)
	response["usage_stats_available"] = false
	return response
}

func (a *App) managedUser(id string) map[string]any {
	item := findManagedUser(a.auth.ListUsers(), id)
	if item == nil {
		return nil
	}
	return item
}

func (a *App) attachManagedUserUsage(items []map[string]any) error {
	userIDs := managedUserIDs(items)
	if len(userIDs) == 0 {
		return nil
	}
	return a.attachManagedUserUsageStats(items, userIDs)
}

func managedUserIDs(items []map[string]any) []string {
	userIDs := make([]string, 0, len(items))
	for _, item := range items {
		if userID := util.Clean(item["id"]); userID != "" {
			userIDs = append(userIDs, userID)
		}
	}
	return userIDs
}

func (a *App) attachManagedUserUsageStats(items []map[string]any, userIDs []string) error {
	if a.logs == nil {
		return errors.New("log service is unavailable")
	}
	stats, err := a.logs.UserUsageStatsForUsers(14, userIDs)
	if err != nil {
		return err
	}
	for _, item := range items {
		userID := util.Clean(item["id"])
		usage := stats[userID]
		if usage == nil {
			usage = service.ZeroUserUsageStats(14)
		}
		for key, value := range usage {
			item[key] = value
		}
	}
	return nil
}

func (a *App) prepareManagedUsersSortValues(items []map[string]any, sortBy string) error {
	if len(items) == 0 {
		return nil
	}
	if managedUsersSortUsesUsage(sortBy) {
		return a.attachManagedUserUsageStats(items, managedUserIDs(items))
	}
	return nil
}

func managedUsersSortUsesUsage(sortBy string) bool {
	switch sortBy {
	case "call_count", "quota_used", "failure_count":
		return true
	default:
		return false
	}
}

func parseManagedUsersQuery(r *http.Request) (managedUsersQuery, error) {
	values := r.URL.Query()
	page, err := parseManagedUsersPage(values.Get("page"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	pageSize, err := parseManagedUsersPageSize(values.Get("page_size"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	sortBy, err := parseManagedUsersSortBy(values.Get("sort_by"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	sortOrder, err := parseManagedUsersSortOrder(values.Get("sort_order"))
	if err != nil {
		return managedUsersQuery{}, err
	}
	return managedUsersQuery{
		Page:      page,
		PageSize:  pageSize,
		Search:    strings.TrimSpace(values.Get("search")),
		Provider:  strings.TrimSpace(values.Get("provider")),
		Status:    strings.TrimSpace(values.Get("status")),
		SortBy:    sortBy,
		SortOrder: sortOrder,
	}, nil
}

func parseManagedUsersPage(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 1, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("page 参数无效")
	}
	return value, nil
}

func parseManagedUsersPageSize(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 20, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("page_size 参数无效")
	}
	return normalizedManagedUsersPageSize(value), nil
}

func normalizedManagedUsersPageSize(value int) int {
	if value <= 0 {
		return 20
	}
	if value > 100 {
		return 100
	}
	return value
}

func managedUsersTotalPages(total, pageSize int) int {
	if pageSize <= 0 {
		pageSize = 20
	}
	if total <= 0 {
		return 1
	}
	return (total + pageSize - 1) / pageSize
}

func parseManagedUsersSortBy(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "created_at", nil
	}
	switch value {
	case "id", "name", "username", "provider", "enabled", "role_id", "role_name", "call_count", "quota_used", "failure_count", "created_at", "last_used_at", "updated_at":
		return value, nil
	default:
		return "", fmt.Errorf("sort_by 参数无效")
	}
}

func parseManagedUsersSortOrder(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "desc", nil
	}
	switch value {
	case "asc", "desc":
		return value, nil
	default:
		return "", fmt.Errorf("sort_order 参数无效")
	}
}

func filterManagedUsers(items []map[string]any, query managedUsersQuery) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	search := strings.ToLower(strings.TrimSpace(query.Search))
	provider := strings.TrimSpace(query.Provider)
	status := strings.TrimSpace(query.Status)
	for _, item := range items {
		if provider != "" && provider != "all" && util.Clean(item["provider"]) != provider {
			continue
		}
		if status == "enabled" && !util.ToBool(item["enabled"]) {
			continue
		}
		if status == "disabled" && util.ToBool(item["enabled"]) {
			continue
		}
		if search != "" && !strings.Contains(managedUserSearchText(item), search) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func sortManagedUsers(items []map[string]any, query managedUsersQuery) {
	desc := query.SortOrder == "desc"
	sort.SliceStable(items, func(i, j int) bool {
		cmp := compareManagedUsers(items[i], items[j], query.SortBy)
		if cmp == 0 {
			cmp = strings.Compare(util.Clean(items[i]["id"]), util.Clean(items[j]["id"]))
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
}

func compareManagedUsers(left, right map[string]any, sortBy string) int {
	switch sortBy {
	case "enabled":
		return compareManagedUserInts(managedUserSortBool(left, sortBy), managedUserSortBool(right, sortBy))
	case "call_count", "quota_used", "failure_count":
		return compareManagedUserInts(managedUserSortInt(left, sortBy), managedUserSortInt(right, sortBy))
	default:
		return strings.Compare(strings.ToLower(managedUserSortString(left, sortBy)), strings.ToLower(managedUserSortString(right, sortBy)))
	}
}

func managedUserSortString(item map[string]any, sortBy string) string {
	switch sortBy {
	case "name":
		return util.Clean(item["name"])
	case "username":
		return util.Clean(item["username"])
	case "provider":
		return util.Clean(item["provider"])
	case "role_id":
		return util.Clean(item["role_id"])
	case "role_name":
		return util.Clean(item["role_name"])
	case "created_at":
		return util.Clean(item["created_at"])
	case "last_used_at":
		return util.Clean(item["last_used_at"])
	case "updated_at":
		return util.Clean(item["updated_at"])
	default:
		return util.Clean(item["id"])
	}
}

func managedUserSortBool(item map[string]any, sortBy string) int {
	if sortBy == "enabled" && util.ToBool(item["enabled"]) {
		return 1
	}
	return 0
}

func managedUserSortInt(item map[string]any, sortBy string) int {
	return util.ToInt(item[sortBy], 0)
}

func compareManagedUserInts(left, right int) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}

func managedUserSearchText(item map[string]any) string {
	parts := []string{
		util.Clean(item["id"]),
		util.Clean(item["username"]),
		util.Clean(item["name"]),
		util.Clean(item["role_id"]),
		util.Clean(item["role_name"]),
		util.Clean(item["owner_id"]),
		util.Clean(item["owner_name"]),
		util.Clean(item["provider"]),
		util.Clean(item["linuxdo_level"]),
		util.Clean(item["session_id"]),
		util.Clean(item["session_name"]),
	}
	return strings.ToLower(strings.Join(parts, " "))
}

func findManagedUser(items []map[string]any, id string) map[string]any {
	for _, item := range items {
		if item["id"] == id {
			return item
		}
	}
	return nil
}
