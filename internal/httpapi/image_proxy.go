package httpapi

import (
	"io"
	"net/http"
	"net/url"
	"strings"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleImageProxy(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	target := strings.TrimSpace(r.URL.Query().Get("url"))
	parsed, err := url.ParseRequestURI(target)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Scheme != "http" && parsed.Scheme != "https" {
		util.WriteError(w, http.StatusBadRequest, "无效的图片地址")
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, parsed.String(), nil)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "无效的图片地址")
		return
	}
	request.Header.Set("User-Agent", "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36")
	request.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
	response, err := service.SafeMediaProxyHTTPClient().Do(request)
	if err != nil {
		util.WriteError(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		util.WriteError(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	contentType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		util.WriteError(w, http.StatusBadGateway, "远程地址没有返回图片")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxRelayImageBytes+1))
	if err != nil {
		util.WriteError(w, http.StatusBadGateway, "代理图片读取失败")
		return
	}
	if len(data) > maxRelayImageBytes {
		util.WriteError(w, http.StatusRequestEntityTooLarge, "图片不能超过 40MB")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
