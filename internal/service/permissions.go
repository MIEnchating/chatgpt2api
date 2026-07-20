package service

import (
	"sort"
	"strings"

	"chatgpt2api/internal/util"
)

type MenuPermission struct {
	ID       string           `json:"id"`
	Label    string           `json:"label"`
	Path     string           `json:"path"`
	Icon     string           `json:"icon"`
	Order    int              `json:"order"`
	Children []MenuPermission `json:"children,omitempty"`
}

type APIPermission struct {
	Key     string `json:"key"`
	Method  string `json:"method"`
	Path    string `json:"path"`
	Label   string `json:"label"`
	Group   string `json:"group"`
	Subtree bool   `json:"subtree,omitempty"`
}

type PermissionSet struct {
	MenuPaths      []string `json:"menu_paths"`
	APIPermissions []string `json:"api_permissions"`
}

const PromptMarketAdultPermissionPath = "/api/prompt-market/adult-content"

var fullMenuPermissions = []MenuPermission{
	{ID: "image", Label: "创作台", Path: "/image", Icon: "image", Order: 10},
	{ID: "canvas", Label: "无限画布", Path: "/canvas", Icon: "panels-top-left", Order: 15},
	{ID: "image-manager", Label: "图片库", Path: "/image-manager", Icon: "images", Order: 20},
	{ID: "users", Label: "用户管理", Path: "/users", Icon: "users", Order: 50},
	{ID: "rbac", Label: "角色权限", Path: "/rbac", Icon: "shield-check", Order: 60},
	{ID: "logs", Label: "日志管理", Path: "/logs", Icon: "scroll-text", Order: 70},
	{ID: "settings", Label: "设置", Path: "/settings", Icon: "settings", Order: 80},
}

var apiPermissionCatalog = []APIPermission{
	apiPermission("GET", "/v1/models", "模型列表", "创作", false),
	apiPermission("POST", "/v1/images/generations", "文生图", "创作", false),
	apiPermission("POST", "/v1/images/edits", "图生图", "创作", false),
	apiPermission("GET", "/api/creation-tasks", "查看创作任务", "创作", true),
	apiPermission("POST", "/api/creation-tasks", "提交/取消创作任务", "创作", true),
	apiPermission("GET", "/api/canvas", "读取画布", "无限画布", false),
	apiPermission("POST", "/api/canvas", "管理画布项目", "无限画布", false),
	apiPermission("PUT", "/api/canvas", "保存画布", "无限画布", false),
	apiPermission("DELETE", "/api/canvas", "清空画布", "无限画布", false),
	apiPermission("GET", PromptMarketAdultPermissionPath, "开放成人提示词市场", "创作", false),
	apiPermission("GET", "/api/images", "查看图片库", "图片库", false),
	apiPermission("PATCH", "/api/images/visibility", "发布/收回图片", "图片库", false),
	apiPermission("DELETE", "/api/images", "删除图片", "图片库", false),
	apiPermission("GET", "/api/images/storage-governance", "查看图片存储治理", "图片库", false),
	apiPermission("POST", "/api/images/storage-governance", "清理图片存储", "图片库", false),
	apiPermission("GET", "/api/auth/users", "查看个人访问凭据", "账号凭据", true),
	apiPermission("POST", "/api/auth/users", "创建/更新个人访问凭据", "账号凭据", true),
	apiPermission("DELETE", "/api/auth/users", "删除个人访问凭据", "账号凭据", true),

	apiPermission("GET", "/api/logs", "查看日志", "日志管理", false),
	apiPermission("GET", "/api/logs/governance", "查看日志治理", "日志管理", false),
	apiPermission("POST", "/api/logs/governance", "清理日志数据", "日志管理", false),
	apiPermission("GET", "/api/settings", "查看设置", "设置", false),
	apiPermission("POST", "/api/settings", "修改设置", "设置", false),
	apiPermission("POST", "/api/settings/login-page-image", "修改登录页图片", "设置", false),
	apiPermission("GET", "/api/proxy", "查看代理", "设置", true),
	apiPermission("POST", "/api/proxy", "修改/测试代理", "设置", true),
	apiPermission("GET", "/api/storage/info", "查看存储状态", "设置", false),
	apiPermission("GET", "/api/admin/users", "查看用户", "用户管理", true),
	apiPermission("POST", "/api/admin/users", "创建/修改用户", "用户管理", true),
	apiPermission("DELETE", "/api/admin/users", "删除用户", "用户管理", true),
	apiPermission("GET", "/api/admin/roles", "查看角色", "权限管理", true),
	apiPermission("POST", "/api/admin/roles", "创建/修改角色", "权限管理", true),
	apiPermission("DELETE", "/api/admin/roles", "删除角色", "权限管理", true),
	apiPermission("GET", "/api/admin/permissions", "查看权限目录", "权限管理", false),
}

func apiPermission(method, path, label, group string, subtree bool) APIPermission {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = normalizePermissionPath(path)
	return APIPermission{
		Key:     APIPermissionKey(method, path),
		Method:  method,
		Path:    path,
		Label:   label,
		Group:   group,
		Subtree: subtree,
	}
}

func AllMenuPermissions() []MenuPermission {
	return cloneMenuPermissions(fullMenuPermissions)
}

func AllAPIPermissions() []APIPermission {
	return append([]APIPermission(nil), apiPermissionCatalog...)
}

func FilterMenuPermissions(menuPaths []string) []MenuPermission {
	allowed := sliceSet(NormalizeMenuPermissions(menuPaths))
	return filterMenuPermissions(fullMenuPermissions, allowed)
}

func DefaultPermissionSetForRole(role string) PermissionSet {
	if role == AuthRoleAdmin {
		return PermissionSet{
			MenuPaths:      allMenuPaths(),
			APIPermissions: allAPIPermissionKeys(),
		}
	}
	return PermissionSet{
		MenuPaths: NormalizeMenuPermissions([]string{
			"/image",
			"/canvas",
			"/image-manager",
		}),
		APIPermissions: NormalizeAPIPermissions([]string{
			APIPermissionKey("GET", "/v1/models"),
			APIPermissionKey("POST", "/v1/images/generations"),
			APIPermissionKey("POST", "/v1/images/edits"),
			APIPermissionKey("GET", "/api/creation-tasks"),
			APIPermissionKey("POST", "/api/creation-tasks"),
			APIPermissionKey("GET", "/api/canvas"),
			APIPermissionKey("POST", "/api/canvas"),
			APIPermissionKey("PUT", "/api/canvas"),
			APIPermissionKey("DELETE", "/api/canvas"),
			APIPermissionKey("GET", "/api/images"),
			APIPermissionKey("PATCH", "/api/images/visibility"),
			APIPermissionKey("GET", "/api/auth/users"),
			APIPermissionKey("POST", "/api/auth/users"),
			APIPermissionKey("DELETE", "/api/auth/users"),
		}),
	}
}

func NormalizeMenuPermissions(paths []string) []string {
	known := map[string]struct{}{}
	for _, path := range allMenuPaths() {
		known[path] = struct{}{}
	}
	return normalizeKnownStrings(paths, known)
}

func NormalizeAPIPermissions(keys []string) []string {
	known := map[string]struct{}{}
	for _, permission := range apiPermissionCatalog {
		known[permission.Key] = struct{}{}
	}
	out := make([]string, 0, len(keys))
	seen := map[string]struct{}{}
	for _, key := range keys {
		normalized := normalizeAPIPermissionKey(key)
		if _, ok := known[normalized]; !ok {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	sort.Strings(out)
	return out
}

func APIPermissionKey(method, path string) string {
	return strings.ToLower(strings.TrimSpace(method)) + normalizePermissionPath(path)
}

func MatchAPIPermissionKey(method, path string) (string, bool) {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = normalizePermissionPath(path)
	// Reference-asset upload is part of image editing. Reuse that permission so
	// existing custom creator roles keep working without an RBAC data migration.
	if method == "POST" && path == "/api/profile/image-conversation-assets" {
		path = "/v1/images/edits"
	}
	for _, permission := range apiPermissionCatalog {
		if permission.Method != method {
			continue
		}
		if path == permission.Path {
			return permission.Key, true
		}
	}
	for _, permission := range apiPermissionCatalog {
		if permission.Method != method || !permission.Subtree {
			continue
		}
		base := strings.TrimRight(permission.Path, "/")
		if path == base || strings.HasPrefix(path, base+"/") {
			return permission.Key, true
		}
	}
	return "", false
}

func HasAPIPermission(set PermissionSet, method, path string) bool {
	key, ok := MatchAPIPermissionKey(method, path)
	if !ok {
		return false
	}
	for _, allowed := range NormalizeAPIPermissions(set.APIPermissions) {
		if allowed == key {
			return true
		}
	}
	return false
}

func normalizePermissionPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if path != "/" {
		path = strings.TrimRight(path, "/")
	}
	return path
}

func normalizeAPIPermissionKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	if strings.Contains(key, " ") {
		method, path, _ := strings.Cut(key, " ")
		return migrateAPIPermissionKey(APIPermissionKey(method, path))
	}
	for _, method := range []string{"delete", "patch", "post", "put", "get"} {
		if strings.HasPrefix(strings.ToLower(key), method+"/") {
			return migrateAPIPermissionKey(method + normalizePermissionPath(key[len(method):]))
		}
	}
	return migrateAPIPermissionKey(strings.ToLower(key))
}

func migrateAPIPermissionKey(key string) string {
	switch key {
	case APIPermissionKey("GET", "/api/image-tasks"):
		return APIPermissionKey("GET", "/api/creation-tasks")
	case APIPermissionKey("POST", "/api/image-tasks"):
		return APIPermissionKey("POST", "/api/creation-tasks")
	default:
		return key
	}
}

func allMenuPaths() []string {
	var paths []string
	walkMenuPermissions(fullMenuPermissions, func(item MenuPermission) {
		if item.Path != "" {
			paths = append(paths, item.Path)
		}
	})
	sort.Strings(paths)
	return paths
}

func allAPIPermissionKeys() []string {
	out := make([]string, 0, len(apiPermissionCatalog))
	for _, permission := range apiPermissionCatalog {
		out = append(out, permission.Key)
	}
	sort.Strings(out)
	return out
}

func normalizeKnownStrings(values []string, known map[string]struct{}) []string {
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		item := normalizePermissionPath(util.Clean(value))
		if _, ok := known[item]; !ok {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func cloneMenuPermissions(items []MenuPermission) []MenuPermission {
	out := make([]MenuPermission, 0, len(items))
	for _, item := range items {
		next := item
		next.Children = cloneMenuPermissions(item.Children)
		out = append(out, next)
	}
	return out
}

func filterMenuPermissions(items []MenuPermission, allowed map[string]struct{}) []MenuPermission {
	out := make([]MenuPermission, 0, len(items))
	for _, item := range items {
		children := filterMenuPermissions(item.Children, allowed)
		_, ok := allowed[item.Path]
		if !ok && len(children) == 0 {
			continue
		}
		next := item
		next.Children = children
		out = append(out, next)
	}
	return out
}

func walkMenuPermissions(items []MenuPermission, visit func(MenuPermission)) {
	for _, item := range items {
		visit(item)
		walkMenuPermissions(item.Children, visit)
	}
}

func sliceSet(values []string) map[string]struct{} {
	out := make(map[string]struct{}, len(values))
	for _, value := range values {
		out[value] = struct{}{}
	}
	return out
}
