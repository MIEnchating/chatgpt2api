package httpapi

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleSiteIconSettings(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	if identity.Role != service.AuthRoleAdmin {
		util.WriteError(w, http.StatusForbidden, "admin permission required")
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(maxSiteIconSize + (1 << 20)); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	currentIconURL := a.config.SiteIconURL()
	nextIconURL := currentIconURL
	uploadedIconURL := ""
	switch strings.ToLower(strings.TrimSpace(r.FormValue("site_icon_action"))) {
	case "remove":
		nextIconURL = ""
	case "replace":
		fileHeader := firstMultipartFile(r.MultipartForm, "site_icon_file")
		if fileHeader == nil {
			util.WriteError(w, http.StatusBadRequest, "site icon file is required")
			return
		}
		storedURL, err := a.storeSiteIcon(fileHeader)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		nextIconURL = storedURL
		uploadedIconURL = storedURL
	case "keep", "":
	default:
		util.WriteError(w, http.StatusBadRequest, "invalid site icon action")
		return
	}

	updated, err := a.config.Update(map[string]any{"site_icon_url": nextIconURL})
	if err != nil {
		if uploadedIconURL != "" {
			a.deleteLocalSiteIcon(uploadedIconURL)
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if currentIconURL != "" && currentIconURL != nextIconURL {
		a.deleteLocalSiteIcon(currentIconURL)
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"config": updated})
}

func (a *App) storeSiteIcon(header *multipart.FileHeader) (string, error) {
	data, ext, err := readSiteIconFile(header)
	if err != nil {
		return "", err
	}
	filename := fmt.Sprintf("%d-site-icon%s", time.Now().UnixNano(), ext)
	if _, err := service.StoreMediaFile(bytes.NewReader(data), service.MediaFileWrite{
		Directory:   a.config.SiteIconsDir(),
		Name:        filename,
		TempPattern: ".site-icon-*",
		MaxBytes:    maxSiteIconSize,
		Perm:        0o644,
	}); err != nil {
		return "", err
	}
	return "/site-icons/" + filename, nil
}

func readSiteIconFile(header *multipart.FileHeader) ([]byte, string, error) {
	if header == nil {
		return nil, "", fmt.Errorf("site icon file is required")
	}
	if header.Size > maxSiteIconSize {
		return nil, "", fmt.Errorf("site icon cannot exceed 2MB")
	}
	file, err := header.Open()
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSiteIconSize+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", fmt.Errorf("site icon file is empty")
	}
	if len(data) > maxSiteIconSize {
		return nil, "", fmt.Errorf("site icon cannot exceed 2MB")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp", "image/gif")
	if err != nil {
		return nil, "", fmt.Errorf("unsupported site icon file")
	}
	switch info.ContentType {
	case "image/jpeg":
		return data, ".jpg", nil
	case "image/gif":
		return data, ".gif", nil
	case "image/webp":
		return data, ".webp", nil
	case "image/png":
		return data, ".png", nil
	default:
		return nil, "", fmt.Errorf("site icon must be PNG, JPEG, WebP, or GIF")
	}
}

func (a *App) deleteLocalSiteIcon(iconURL string) {
	iconPath, ok := localUploadedFilePath(a.config.SiteIconsDir(), iconURL, "/site-icons/")
	if ok {
		_ = service.RemoveMediaFile(iconPath)
	}
}

func localUploadedFilePath(rootDir, fileURL, urlPrefix string) (string, bool) {
	cleanURL := strings.TrimSpace(fileURL)
	if !strings.HasPrefix(cleanURL, urlPrefix) {
		return "", false
	}
	rel := strings.TrimPrefix(path.Clean(cleanURL), urlPrefix)
	if rel == "." || rel == "" || strings.Contains(rel, "..") {
		return "", false
	}
	root, err := filepath.Abs(rootDir)
	if err != nil {
		return "", false
	}
	target, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", false
	}
	if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", false
	}
	return target, true
}

func (a *App) handleLoginPageImageFile(w http.ResponseWriter, r *http.Request) {
	a.serveUploadedRasterFile(w, r, a.config.LoginPageImagesDir(), "/login-page-images/")
}

func (a *App) handleSiteIconFile(w http.ResponseWriter, r *http.Request) {
	a.serveUploadedRasterFile(w, r, a.config.SiteIconsDir(), "/site-icons/")
}

func (a *App) serveUploadedRasterFile(w http.ResponseWriter, r *http.Request, rootDir, urlPrefix string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	filePath, ok := localUploadedFilePath(rootDir, r.URL.Path, urlPrefix)
	if !ok || strings.EqualFold(filepath.Ext(filePath), ".svg") {
		http.NotFound(w, r)
		return
	}
	if !service.IsRegularMediaFile(filePath) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeFile(w, r, filePath)
}

func (a *App) handlePermissionCatalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	util.WriteJSON(w, http.StatusOK, a.auth.PermissionCatalog())
}

func (a *App) handleLoginPageImageSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(maxLoginPageImageSize + (1 << 20)); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	currentImageURL := a.config.LoginPageImageURL()
	nextImageURL := strings.TrimSpace(r.FormValue("login_page_image_url"))
	uploadedImageURL := ""
	switch strings.ToLower(strings.TrimSpace(r.FormValue("login_page_image_action"))) {
	case "remove":
		nextImageURL = ""
	case "replace":
		fileHeader := firstMultipartFile(r.MultipartForm, "login_page_image_file")
		if fileHeader == nil {
			util.WriteError(w, http.StatusBadRequest, "login page image file is required")
			return
		}
		storedURL, err := a.storeLoginPageImage(fileHeader)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		nextImageURL = storedURL
		uploadedImageURL = storedURL
	}

	updated, err := a.config.Update(map[string]any{
		"login_page_image_url":        nextImageURL,
		"login_page_image_mode":       strings.TrimSpace(r.FormValue("login_page_image_mode")),
		"login_page_image_zoom":       strings.TrimSpace(r.FormValue("login_page_image_zoom")),
		"login_page_image_position_x": strings.TrimSpace(r.FormValue("login_page_image_position_x")),
		"login_page_image_position_y": strings.TrimSpace(r.FormValue("login_page_image_position_y")),
	})
	if err != nil {
		if uploadedImageURL != "" {
			a.deleteLocalLoginPageImage(uploadedImageURL)
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if currentImageURL != "" && currentImageURL != nextImageURL {
		a.deleteLocalLoginPageImage(currentImageURL)
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"config": updated})
}

func (a *App) storeLoginPageImage(header *multipart.FileHeader) (string, error) {
	data, ext, err := readLoginPageImageFile(header)
	if err != nil {
		return "", err
	}
	stem := safeUploadStem(header.Filename)
	if stem == "" {
		stem = "login-page"
	}
	filename := fmt.Sprintf("%d-%s%s", time.Now().UnixNano(), stem, ext)
	if _, err := service.StoreMediaFile(bytes.NewReader(data), service.MediaFileWrite{
		Directory:   a.config.LoginPageImagesDir(),
		Name:        filename,
		TempPattern: ".login-page-*",
		MaxBytes:    maxLoginPageImageSize,
		Perm:        0o644,
	}); err != nil {
		return "", err
	}
	return "/login-page-images/" + filename, nil
}

func readLoginPageImageFile(header *multipart.FileHeader) ([]byte, string, error) {
	if header == nil {
		return nil, "", fmt.Errorf("image file is required")
	}
	if header.Size > maxLoginPageImageSize {
		return nil, "", fmt.Errorf("login page image cannot exceed 10MB")
	}
	file, err := header.Open()
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxLoginPageImageSize+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", fmt.Errorf("image file is empty")
	}
	if len(data) > maxLoginPageImageSize {
		return nil, "", fmt.Errorf("login page image cannot exceed 10MB")
	}
	info, err := util.InspectRasterImage(data, "image/png", "image/jpeg", "image/webp", "image/gif")
	if err != nil {
		return nil, "", fmt.Errorf("unsupported image file")
	}
	switch info.ContentType {
	case "image/jpeg":
		return data, ".jpg", nil
	case "image/gif":
		return data, ".gif", nil
	case "image/webp":
		return data, ".webp", nil
	default:
		return data, ".png", nil
	}
}

func (a *App) deleteLocalLoginPageImage(imageURL string) {
	imagePath, ok := a.localLoginPageImagePath(imageURL)
	if ok {
		_ = service.RemoveMediaFile(imagePath)
	}
}

func (a *App) localLoginPageImagePath(imageURL string) (string, bool) {
	return localUploadedFilePath(a.config.LoginPageImagesDir(), imageURL, "/login-page-images/")
}

func firstMultipartFile(form *multipart.Form, key string) *multipart.FileHeader {
	if form == nil || len(form.File[key]) == 0 {
		return nil
	}
	return form.File[key][0]
}

func safeUploadStem(filename string) string {
	name := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	name = strings.ToLower(strings.TrimSpace(name))
	var builder strings.Builder
	for _, char := range name {
		switch {
		case char >= 'a' && char <= 'z':
			builder.WriteRune(char)
		case char >= '0' && char <= '9':
			builder.WriteRune(char)
		case char == '-' || char == '_':
			builder.WriteRune(char)
		case char == ' ' || char == '.':
			builder.WriteRune('-')
		}
	}
	return strings.Trim(builder.String(), "-_")
}
