package httpapi

import (
	"fmt"
	"net/http"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		util.WriteJSON(w, http.StatusOK, map[string]any{"config": a.settingsConfig(identity.Role == service.AuthRoleAdmin)})
	case http.MethodPost:
		a.settingsMu.Lock()
		defer a.settingsMu.Unlock()
		body, err := readJSONMap(r)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if identity.Role != service.AuthRoleAdmin {
			for key := range body {
				if key == "allow_user_custom_relay_config" {
					delete(body, key)
					continue
				}
				if key == "relay_parameter_translation" {
					util.WriteError(w, http.StatusForbidden, "仅管理员可以配置默认渠道参数转换")
					return
				}
				if strings.HasPrefix(key, "relay_database_") || isObjectStorageCredentialKey(key) {
					util.WriteError(w, http.StatusForbidden, "仅管理员可以配置数据库或存储凭据")
					return
				}
			}
		}
		var nextRelayTokenReader *service.NewAPITokenReader
		if relayDatabaseUpdateRequested(body) {
			databaseURL := a.config.RelayDatabaseConnectionURLWithUpdate(body)
			databaseType := a.config.RelayDatabaseType()
			if value, ok := body["relay_database_type"]; ok {
				databaseType = strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
			}
			nextRelayTokenReader, err = a.newRelayTokenReader(service.NewAPITokenReaderConfig{
				DatabaseURL: databaseURL, DatabaseType: databaseType,
			})
			if err != nil {
				util.WriteError(w, http.StatusBadRequest, fmt.Sprintf("数据库连接配置无效: %v", err))
				return
			}
			if err := nextRelayTokenReader.ValidateConnection(r.Context()); err != nil {
				_ = nextRelayTokenReader.Close()
				util.WriteError(w, http.StatusBadRequest, fmt.Sprintf("数据库连接失败: %v", err))
				return
			}
		}
		updated, err := a.config.Update(body)
		if err != nil {
			if nextRelayTokenReader != nil {
				_ = nextRelayTokenReader.Close()
			}
			util.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if nextRelayTokenReader != nil {
			a.swapRelayTokenReader(nextRelayTokenReader)
			nextRelayTokenReader = nil
		}
		if err := a.storageFiles.RefreshCapacityScheduler(a.ctx); err != nil {
			util.WriteError(w, http.StatusInternalServerError, "failed to refresh storage capacity scheduler")
			return
		}
		if identity.Role != service.AuthRoleAdmin {
			delete(updated, "relay_parameter_translation")
		}
		util.WriteJSON(w, http.StatusOK, map[string]any{"config": updated})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func relayDatabaseUpdateRequested(update map[string]any) bool {
	for _, key := range []string{
		"relay_database_type",
		"relay_database_url",
		"relay_database_driver",
		"relay_database_host",
		"relay_database_port",
		"relay_database_name",
		"relay_database_user",
		"relay_database_password",
	} {
		if _, ok := update[key]; ok {
			return true
		}
	}
	return false
}

func (a *App) acquireRelayTokenReader() (*service.NewAPITokenReader, func()) {
	if a == nil {
		return nil, func() {}
	}
	a.newAPIKeysMu.RLock()
	return a.newAPIKeys, a.newAPIKeysMu.RUnlock
}

func (a *App) swapRelayTokenReader(reader *service.NewAPITokenReader) {
	a.newAPIKeysMu.Lock()
	previous := a.newAPIKeys
	a.newAPIKeys = reader
	a.newAPIKeysMu.Unlock()
	if previous != nil && previous != reader {
		_ = previous.Close()
	}
}

func (a *App) closeRelayTokenReaders() {
	a.newAPIKeysMu.Lock()
	reader := a.newAPIKeys
	a.newAPIKeys = nil
	a.newAPIKeysMu.Unlock()
	if reader != nil {
		_ = reader.Close()
	}
}

func isObjectStorageCredentialKey(key string) bool {
	return key == "storage"
}

func (a *App) settingsConfig(includeDatabaseCredentials bool) map[string]any {
	config := a.config.Get()
	if !includeDatabaseCredentials {
		delete(config, "relay_parameter_translation")
		for key := range config {
			if strings.HasPrefix(key, "relay_database_") && key != "relay_database_configured" {
				delete(config, key)
			}
		}
	}
	return config
}

func (a *App) handleModelConfig(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	config := a.modelConfig()
	config["custom_relay_configurable"] = identity.Role == service.AuthRoleAdmin || a.config.AllowUserCustomRelayConfig()
	util.WriteJSON(w, http.StatusOK, map[string]any{"config": config})
}

func (a *App) handlePromptSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"sources": a.config.Get()["prompt_sources"],
	})
}

func (a *App) modelConfig() map[string]any {
	imageModels := a.configuredImageModels()
	videoModels := a.configuredVideoModels()
	videoContracts := protocol.ActiveVideoContracts()
	textModels := append([]string(nil), a.config.TextModels()...)
	audioModels := append([]string(nil), a.config.AudioModels()...)
	return map[string]any{
		"image_models":            imageModels,
		"image_model_definitions": a.config.ImageModelDefinitions(),
		"model_capabilities":      a.config.ModelCapabilities(),
		"default_image_model":     defaultConfiguredImageModel(imageModels),
		"video_models":            videoModels,
		"default_video_model":     defaultConfiguredVideoModel(videoModels, videoContracts),
		"video_model_contracts":   videoContracts,
		"text_models":             textModels,
		"default_text_model":      firstString(textModels, ""),
		"audio_models":            audioModels,
		"default_audio_model":     firstString(audioModels, ""),
		"relay_base_url":          a.relayBaseURL(),
	}
}

func (a *App) configuredVideoModels() []string {
	return append([]string(nil), a.config.VideoModels()...)
}

func (a *App) configuredImageModels() []string {
	if a != nil && a.config != nil {
		return append([]string(nil), a.config.ImageModels()...)
	}
	return []string{}
}

func (a *App) configuredChatModels() []string {
	if a != nil && a.config != nil {
		return append([]string(nil), a.config.ChatModels()...)
	}
	return []string{}
}

func (a *App) defaultImageModel() string {
	if a != nil && a.config != nil {
		return defaultConfiguredImageModel(a.config.ImageModels())
	}
	return ""
}

func (a *App) defaultChatModel() string {
	if a != nil && a.config != nil {
		return a.config.DefaultChatModel()
	}
	return ""
}

func defaultConfiguredImageModel(models []string) string {
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model != "" && !strings.EqualFold(model, util.ImageModelAuto) {
			return model
		}
	}
	return ""
}

func defaultConfiguredVideoModel(models []string, contracts []protocol.VideoModelContract) string {
	for _, model := range models {
		model = strings.TrimSpace(model)
		for _, contract := range contracts {
			if protocol.VideoContractMatchesModel(contract, model) {
				return model
			}
		}
	}
	return ""
}

func (a *App) applyDefaultImageModel(body map[string]any) string {
	model := util.Clean(body["model"])
	if model == "" || strings.EqualFold(model, util.ImageModelAuto) {
		model = a.defaultImageModel()
		body["model"] = model
	}
	a.attachImageModelDefinition(body)
	return model
}

func (a *App) handleAppMeta(w http.ResponseWriter, r *http.Request) {
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"app_title":                   a.config.AppTitle(),
		"project_name":                a.config.ProjectName(),
		"site_icon_url":               a.config.SiteIconURL(),
		"login_page_image_url":        a.config.LoginPageImageURL(),
		"login_page_image_mode":       a.config.LoginPageImageMode(),
		"login_page_image_zoom":       a.config.LoginPageImageZoom(),
		"login_page_image_position_x": a.config.LoginPageImagePositionX(),
		"login_page_image_position_y": a.config.LoginPageImagePositionY(),
	})
}
