package httpapi

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const maxAPIRequestBodyBytes = 256 << 20

type routeMatch int

const (
	exactRoute routeMatch = iota
	prefixRoute
)

type appRoute struct {
	method  string
	path    string
	match   routeMatch
	handler http.HandlerFunc
}

func (a *App) Handler() http.Handler {
	routes := a.routes()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.serveObservedHTTP(w, r, routes)
	})
}

func (a *App) routes() []appRoute {
	return []appRoute{
		exact(http.MethodPost, "/auth/login", a.handleLogin),
		exact(http.MethodPost, "/auth/logout", a.handleLogout),
		exact(http.MethodGet, "/auth/session", a.handleSession),
		exact(http.MethodGet, "/health", a.handleHealth),
		exact(http.MethodGet, "/api/storage/config", a.handleStorageConfig),

		subtree("/api/admin/roles", a.handleAdminRoles),
		subtree("/api/admin/users", a.handleAdminUsers),
		subtree("/api/admin/announcements", a.handleAdminAnnouncements),
		subtree("/api/admin/video-model-contracts", a.handleAdminVideoModelContracts),
		exact(http.MethodGet, "/api/announcements", a.handleAnnouncements),
		exact("", "/api/profile/announcement-preferences", a.handleAnnouncementPreferences),
		exact("", "/api/profile/image-generation-preferences", a.handleImageGenerationPreferences),
		subtree("/api/profile/storage-provider", a.handleProfileStorageProvider),
		exact(http.MethodPost, "/api/profile/image-conversation-assets", a.handleImageConversationAssetUpload),
		exact("", "/api/profile/relay-key", a.handleProfileRelayKey),
		subtree("/api/profile/custom-relay-configs", a.handleProfileCustomRelayConfigs),
		exact("", "/api/profile/balance", a.handleProfileBalance),
		subtree("/api/profile/prompt-favorites", a.handleProfilePromptFavorites),
		exact("", "/api/profile/assets", a.handleProfileAssets),
		subtree("/api/profile/image-conversations", a.handleProfileImageConversations),
		subtree("/api/workflows", a.handleWorkflows),
		exact("", "/api/canvas", a.handleCanvasDocument),
		exact(http.MethodPost, "/api/canvas/images", a.handleCanvasImageUpload),
		exact(http.MethodPost, "/api/creation-tasks/video-reference-uploads", a.handleVideoReferenceUpload),
		exact(http.MethodPost, "/api/creation-tasks/video-image-reference-uploads", a.handleVideoImageReferenceUpload),
		exact(http.MethodPost, "/api/creation-tasks/audio-reference-uploads", a.handleAudioReferenceUpload),
		subtree("/api/creation-tasks", a.handleCreationTasks),
		exact("", "/api/settings", a.handleSettings),
		exact("", "/api/settings/login-page-image", a.handleLoginPageImageSettings),
		exact("", "/api/settings/site-icon", a.handleSiteIconSettings),
		exact(http.MethodPost, "/api/settings/storage/measure", a.handleAdminStorageMeasure),
		exact("", "/api/files/direct", a.handleStorageFileDirect),
		exact(http.MethodGet, "/api/proxy-image", a.handleImageProxy),
		subtree("/api/files", a.handleStorageFiles),
		exact(http.MethodGet, "/api/model-config", a.handleModelConfig),
		exact(http.MethodGet, "/api/prompt-sources", a.handlePromptSources),
		exact(http.MethodGet, "/api/profile/upstream-models", a.handleUpstreamModels),
		exact(http.MethodGet, "/api/app-meta", a.handleAppMeta),
		exact(http.MethodGet, "/api/admin/permissions", a.handlePermissionCatalog),
		exact("", "/api/images/visibility", a.handleImageVisibility),
		exact("", "/api/images", a.handleImages),
		exact("", "/api/images/storage-governance", a.handleImageStorageGovernance),
		exact("", "/api/logs/governance", a.handleLogGovernance),
		exact(http.MethodGet, "/api/logs", a.handleLogs),
		exact(http.MethodPost, "/api/proxy/test", a.handleProxyTest),
		exact(http.MethodGet, "/api/storage/info", a.handleStorageInfo),

		prefix("/images/", a.handleImageFile),
		prefix("/videos/", a.handleVideoFile),
		prefix("/audios/", a.handleAudioFile),
		prefix("/video-references/", a.handleVideoReferenceFile),
		prefix("/video-image-references/", a.handleVideoImageReferenceFile),
		prefix("/audio-references/", a.handleAudioReferenceFile),
		prefix(service.ImageConversationAssetURLPrefix, a.handleImageConversationAssetFile),
		prefix("/image-references/", a.handleImageReferenceFile),
		prefix("/image-thumbnails/", a.handleImageThumbnail),
		prefix("/login-page-images/", a.handleLoginPageImageFile),
		prefix("/site-icons/", a.handleSiteIconFile),
	}
}

func exact(method, path string, handler http.HandlerFunc) appRoute {
	return appRoute{method: method, path: path, match: exactRoute, handler: handler}
}

func prefix(path string, handler http.HandlerFunc) appRoute {
	return appRoute{path: path, match: prefixRoute, handler: handler}
}

func subtree(path string, handler http.HandlerFunc) appRoute {
	return prefix(path, handler)
}

func (a *App) serveHTTP(w http.ResponseWriter, r *http.Request, routes []appRoute) {
	applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if isAPISpace(r.URL.Path) && r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
		if r.ContentLength > maxAPIRequestBodyBytes {
			util.WriteError(w, http.StatusRequestEntityTooLarge, "request body is too large")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxAPIRequestBodyBytes)
	}
	if route := matchAppRoute(routes, r.Method, r.URL.Path); route != nil {
		route.handler(w, r)
		return
	}
	if isAPISpace(r.URL.Path) {
		http.NotFound(w, r)
		return
	}
	a.serveWeb(w, r)
}

func matchAppRoute(routes []appRoute, method, path string) *appRoute {
	for i := range routes {
		route := &routes[i]
		if route.method != "" && route.method != method {
			continue
		}
		switch route.match {
		case exactRoute:
			if path == route.path {
				return route
			}
		case prefixRoute:
			if path == route.path || strings.HasPrefix(path, strings.TrimRight(route.path, "/")+"/") {
				return route
			}
		}
	}
	return nil
}

func isAPISpace(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/") ||
		path == "/auth" || strings.HasPrefix(path, "/auth/") ||
		path == "/v1" || strings.HasPrefix(path, "/v1/")
}

func applyCORS(w http.ResponseWriter, r *http.Request) {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" || !isAllowedCredentialedOrigin(origin, r.Host) {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Add("Vary", "Origin")
	if requestedMethod := strings.TrimSpace(r.Header.Get("Access-Control-Request-Method")); requestedMethod != "" {
		w.Header().Set("Access-Control-Allow-Methods", requestedMethod)
		w.Header().Add("Vary", "Access-Control-Request-Method")
	} else {
		w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS")
	}
	if requestedHeaders := strings.TrimSpace(r.Header.Get("Access-Control-Request-Headers")); requestedHeaders != "" {
		w.Header().Set("Access-Control-Allow-Headers", requestedHeaders)
		w.Header().Add("Vary", "Access-Control-Request-Headers")
	} else {
		w.Header().Set("Access-Control-Allow-Headers", "*")
	}
}

func isAllowedCredentialedOrigin(origin, requestHost string) bool {
	originURL, err := url.Parse(origin)
	if err != nil || originURL.Hostname() == "" ||
		originURL.Scheme != "http" && originURL.Scheme != "https" {
		return false
	}
	requestHostname := requestHost
	if host, _, err := net.SplitHostPort(requestHost); err == nil {
		requestHostname = host
	}
	requestHostname = strings.Trim(requestHostname, "[]")
	originHostname := originURL.Hostname()
	return strings.EqualFold(originHostname, requestHostname) ||
		isLoopbackHostname(originHostname) && isLoopbackHostname(requestHostname)
}

func isLoopbackHostname(hostname string) bool {
	switch strings.ToLower(strings.TrimSpace(hostname)) {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}
