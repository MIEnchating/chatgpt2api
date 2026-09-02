"use client";

import { create } from "zustand";
import { toast } from "sonner";

import {
  cleanupImageStorage,
  cleanupLogs,
  DEFAULT_IMAGE_MODELS,
  fetchLogGovernance,
  fetchImageStorageGovernance,
  fetchSettingsConfig,
  normalizeModelNames,
  updateLoginPageImageSettings,
  updateSiteIconSettings,
  updateSettingsConfig,
  type ImageStorageCleanupResult,
  type ImageStorageGovernanceSummary,
  type LogCleanupResult,
  type LogGovernanceSummary,
  type LogView,
  type LoginPageImageSettings,
  type SettingsConfig,
	type StorageSettingConfig,
} from "@/lib/api";
import { dispatchAppMetaUpdated } from "@/lib/app-meta";
import { invalidateStorageProviderCache } from "@/services/storage-provider";
import { normalizePromptMarketSources, type PromptMarketSourceConfig } from "@/app/image/banana-prompts";
import {
  LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM,
  normalizeLoginPageImageMode,
  normalizeLoginPageImageTransform,
  type LoginPageImageMode,
} from "@/lib/login-page-image-layout";
import {
  LOGIN_PAGE_IMAGE_CONFIG_FIELDS,
  mergeUnchangedConfigFields,
  SITE_ICON_CONFIG_FIELDS,
} from "./specialized-config-merge";

function normalizeDefaultLogView(value: unknown): LogView {
  if (value === "all" || value === "meaningful" || value === "business") {
    return value;
  }
  return "meaningful";
}

function normalizeLogCleanupHour(value: unknown) {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3;
}

function normalizeConfiguredModels(value: unknown, fallback: readonly string[]) {
  if (value === undefined || value === null) return [...fallback];
  return normalizeModelNames(value, []);
}

function databaseFieldsFromConfig(config: SettingsConfig) {
  return {
    driver: config.relay_database_driver === "sqlite" ? "sqlite" : config.relay_database_driver === "mysql" ? "mysql" : "postgres",
    host: String(config.relay_database_host || "").trim(),
    port: String(config.relay_database_port || "").trim(),
    name: String(config.relay_database_name || "").trim(),
    user: String(config.relay_database_user || "").trim(),
    password: String(config.relay_database_password || ""),
  } as const;
}

function normalizeConfig(config: SettingsConfig): SettingsConfig {
  const loginImageTransform = normalizeLoginPageImageTransform({
    zoom: Number(config.login_page_image_zoom),
    positionX: Number(config.login_page_image_position_x),
    positionY: Number(config.login_page_image_position_y),
  });
  const appTitle = typeof config.app_title === "string" && config.app_title.trim() ? config.app_title.trim() : "云棉";
  const projectName = typeof config.project_name === "string" && config.project_name.trim() ? config.project_name.trim() : appTitle;
  const relayDatabaseFields = databaseFieldsFromConfig(config);
  const videoModels = normalizeConfiguredModels(config.video_models, []);
  const defaultVideoModel = videoModels.includes(String(config.default_video_model || "").trim())
    ? String(config.default_video_model).trim()
    : videoModels[0] || "";
  return {
    ...config,
    app_title: appTitle,
    project_name: projectName,
    site_icon_url: typeof config.site_icon_url === "string" ? config.site_icon_url.trim() : "",
    image_task_timeout_seconds: Number(config.image_task_timeout_seconds || 300),
    image_models: normalizeConfiguredModels(config.image_models, DEFAULT_IMAGE_MODELS),
    default_image_model: String(config.default_image_model || DEFAULT_IMAGE_MODELS[0]),
    video_models: videoModels,
    default_video_model: defaultVideoModel,
    text_models: normalizeConfiguredModels(config.text_models, ["gpt-5.5", "gpt-5.4"]),
    default_text_model: String(config.default_text_model || config.text_models?.[0] || "gpt-5.5"),
    audio_models: normalizeConfiguredModels(config.audio_models, ["gpt-4o-mini-tts"]),
    default_audio_model: String(config.default_audio_model || config.audio_models?.[0] || "gpt-4o-mini-tts"),
    user_default_concurrent_limit: Number(config.user_default_concurrent_limit || 0),
    user_default_rpm_limit: Number(config.user_default_rpm_limit || 0),
    allow_user_custom_relay_config: config.allow_user_custom_relay_config === true,
    image_retention_days: Number(config.image_retention_days || 30),
    image_storage_limit_mb: Math.max(0, Number(config.image_storage_limit_mb) || 0),
    storage: normalizeStorageSetting(config.storage),
    log_retention_days: Number(config.log_retention_days || 7),
    log_cleanup_schedule_enabled: config.log_cleanup_schedule_enabled === true,
    log_cleanup_hour: normalizeLogCleanupHour(config.log_cleanup_hour),
    default_log_view: normalizeDefaultLogView(config.default_log_view),
    log_levels: Array.isArray(config.log_levels) ? config.log_levels : [],
    proxy: typeof config.proxy === "string" ? config.proxy : "",
    base_url:
      typeof config.base_url === "string" ? config.base_url.trim() : "",
    relay_base_url:
      typeof config.relay_base_url === "string" && config.relay_base_url.trim()
        ? config.relay_base_url
        : "https://www.yunmian.tech",
    relay_database_url: "",
    relay_database_type: config.relay_database_type === "sub2api" ? "sub2api" : "newapi",
    relay_database_driver: relayDatabaseFields.driver,
    relay_database_host: relayDatabaseFields.host,
    relay_database_port: relayDatabaseFields.port,
    relay_database_name: relayDatabaseFields.name,
    relay_database_user: relayDatabaseFields.user,
    relay_database_password: relayDatabaseFields.password,
    login_page_image_url: typeof config.login_page_image_url === "string" ? config.login_page_image_url : "",
    login_page_image_mode: normalizeLoginPageImageMode(config.login_page_image_mode),
    login_page_image_zoom: loginImageTransform.zoom,
    login_page_image_position_x: loginImageTransform.positionX,
    login_page_image_position_y: loginImageTransform.positionY,
    prompt_sources: normalizePromptMarketSources(config.prompt_sources),
  };
}

function normalizeStorageSetting(value: SettingsConfig["storage"]): StorageSettingConfig {
	return {
		mode: value?.mode === "server_external" || value?.mode === "server_user_or_local" ? value.mode : "server_local",
		allowUserProvider: value?.allowUserProvider === true,
		allowUserGlobalProvider: value?.allowUserGlobalProvider !== false,
		providers: Array.isArray(value?.providers) ? value.providers.map((provider, index) => ({
			id: provider.id || `storage-${index + 1}`,
			name: String(provider.name || "").trim(),
			type: provider.type === "webdav" ? "webdav" : "s3",
			endpoint: String(provider.endpoint || "").trim(),
			region: String(provider.region || "auto").trim() || "auto",
			bucket: String(provider.bucket || "").trim(),
			accessKeyId: String(provider.accessKeyId || ""),
			secretAccessKey: "",
			publicBaseUrl: String(provider.publicBaseUrl || "").trim(),
			pathPrefix: String(provider.pathPrefix || "assets").trim() || "assets",
			username: String(provider.username || ""),
			password: "",
			weight: Math.max(1, Number(provider.weight) || 1),
			enabled: provider.enabled === true,
			ownerUserId: String(provider.ownerUserId || ""),
			capacityBytes: Math.max(0, Number(provider.capacityBytes) || 0),
			capacityCheckedAt: String(provider.capacityCheckedAt || ""),
			capacityExceeded: provider.capacityExceeded === true,
		})) : [],
		capacityCheck: { enabled: value?.capacityCheck?.enabled === true, cron: value?.capacityCheck?.cron || "0 */6 * * *" },
		capacityLimitBytes: Math.max(1, Number(value?.capacityLimitBytes) || 9 * 1024 ** 3),
		localCapacityLimitBytes: Math.max(0, Number(value?.localCapacityLimitBytes) || 0),
	};
}

type SettingsSessionData = {
  activeSessionKey: string | null;
  sessionGeneration: number;
  config: SettingsConfig | null;
  isLoadingConfig: boolean;
  isSavingConfig: boolean;
  logGovernance: LogGovernanceSummary | null;
  lastLogCleanup: LogCleanupResult | null;
  isLoadingLogGovernance: boolean;
  isCleaningLogs: boolean;
  imageStorageGovernance: ImageStorageGovernanceSummary | null;
  lastImageStorageCleanup: ImageStorageCleanupResult | null;
  isLoadingImageStorageGovernance: boolean;
  isCleaningImageStorage: boolean;
};

type SettingsStore = SettingsSessionData & {
  activateSession: (sessionKey: string) => void;
  deactivateSession: (sessionKey: string) => void;

  initialize: (sessionKey: string) => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  setImageTaskTimeoutSeconds: (value: string) => void;
  setImageModels: (value: string) => void;
  setVideoModels: (value: string) => void;
  setTextModels: (value: string) => void;
  setAudioModels: (value: string) => void;
  setUserDefaultConcurrentLimit: (value: string) => void;
  setUserDefaultRpmLimit: (value: string) => void;
  setAllowUserCustomRelayConfig: (value: boolean) => void;
  setImageRetentionDays: (value: string) => void;
  setImageStorageLimitMb: (value: string) => void;
	setStorage: (value: NonNullable<SettingsConfig["storage"]>) => void;
  setLogRetentionDays: (value: string) => void;
  setLogCleanupScheduleEnabled: (value: boolean) => void;
  setLogCleanupHour: (value: number) => void;
  setDefaultLogView: (value: LogView) => void;
  setLogLevel: (level: string, enabled: boolean) => void;
  setProxy: (value: string) => void;
  setBaseUrl: (value: string) => void;
  setRelayBaseUrl: (value: string) => void;
  setRelayDatabaseType: (value: "newapi" | "sub2api") => void;
  setRelayDatabaseDriver: (value: "sqlite" | "postgres" | "mysql") => void;
  setRelayDatabaseField: (field: "host" | "port" | "name" | "user" | "password", value: string) => void;
  setAppTitle: (value: string) => void;
  setPromptSources: (value: PromptMarketSourceConfig[]) => void;
  saveSiteIcon: (options: { file?: File | null; action: "keep" | "replace" | "remove" }) => Promise<boolean>;
  setLoginPageImageUrl: (value: string) => void;
  setLoginPageImageMode: (value: LoginPageImageMode) => void;
  setLoginPageImageTransform: (transform: { zoom: number; positionX: number; positionY: number }) => void;
  restoreDefaultLoginPageImage: () => void;
  saveLoginPageImage: (options: { file?: File | null; action: "keep" | "replace" | "remove" }) => Promise<boolean>;
  loadLogGovernance: (silent?: boolean) => Promise<void>;
  cleanupLogsByRetention: () => Promise<void>;
  loadImageStorageGovernance: (silent?: boolean) => Promise<void>;
  cleanupImageStorageByRetention: () => Promise<void>;
  cleanupImageStorageByQuota: (includePublic?: boolean) => Promise<void>;
  cleanupImageThumbnails: () => Promise<void>;
};

type SettingsSessionToken = {
  sessionKey: string;
  generation: number;
};

const CLEARED_SETTINGS_SESSION_DATA = {
  config: null,
  isLoadingConfig: false,
  isSavingConfig: false,
  logGovernance: null,
  lastLogCleanup: null,
  isLoadingLogGovernance: false,
  isCleaningLogs: false,
  imageStorageGovernance: null,
  lastImageStorageCleanup: null,
  isLoadingImageStorageGovernance: false,
  isCleaningImageStorage: false,
} satisfies Omit<SettingsSessionData, "activeSessionKey" | "sessionGeneration">;

function sessionToken(state: SettingsSessionData): SettingsSessionToken | null {
  return state.activeSessionKey
    ? { sessionKey: state.activeSessionKey, generation: state.sessionGeneration }
    : null;
}

function isCurrentSession(state: SettingsSessionData, token: SettingsSessionToken) {
  return state.activeSessionKey === token.sessionKey && state.sessionGeneration === token.generation;
}

type SettingsStoreDependencies = {
  cleanupImageStorage: typeof cleanupImageStorage;
  cleanupLogs: typeof cleanupLogs;
  fetchImageStorageGovernance: typeof fetchImageStorageGovernance;
  fetchLogGovernance: typeof fetchLogGovernance;
  fetchSettingsConfig: typeof fetchSettingsConfig;
  updateLoginPageImageSettings: typeof updateLoginPageImageSettings;
  updateSettingsConfig: typeof updateSettingsConfig;
  updateSiteIconSettings: typeof updateSiteIconSettings;
  dispatchAppMetaUpdated: typeof dispatchAppMetaUpdated;
  invalidateStorageProviderCache: typeof invalidateStorageProviderCache;
  toastError: (message: string) => void;
  toastSuccess: (message: string) => void;
};

const DEFAULT_SETTINGS_STORE_DEPENDENCIES: SettingsStoreDependencies = {
  cleanupImageStorage,
  cleanupLogs,
  fetchImageStorageGovernance,
  fetchLogGovernance,
  fetchSettingsConfig,
  updateLoginPageImageSettings,
  updateSettingsConfig,
  updateSiteIconSettings,
  dispatchAppMetaUpdated,
  invalidateStorageProviderCache,
  toastError: (message) => {
    toast.error(message);
  },
  toastSuccess: (message) => {
    toast.success(message);
  },
};

export function createSettingsStore(
  dependencyOverrides: Partial<SettingsStoreDependencies> = {},
) {
  const dependencies = {
    ...DEFAULT_SETTINGS_STORE_DEPENDENCIES,
    ...dependencyOverrides,
  };

  return create<SettingsStore>((set, get) => {
  const setForSession = (
    token: SettingsSessionToken,
    update: Partial<SettingsStore> | ((state: SettingsStore) => Partial<SettingsStore>),
  ) => {
    set((state) => {
      if (!isCurrentSession(state, token)) {
        return {};
      }
      return typeof update === "function" ? update(state) : update;
    });
  };

  const getSessionToken = () => sessionToken(get());
  const sessionIsCurrent = (token: SettingsSessionToken) => isCurrentSession(get(), token);

  return {
  activeSessionKey: null,
  sessionGeneration: 0,
  ...CLEARED_SETTINGS_SESSION_DATA,

  activateSession: (sessionKey) => {
    if (!sessionKey) {
      return;
    }
    set((state) => {
      if (state.activeSessionKey === sessionKey) {
        return {};
      }
      return {
        ...CLEARED_SETTINGS_SESSION_DATA,
        activeSessionKey: sessionKey,
        sessionGeneration: state.sessionGeneration + 1,
      };
    });
  },

  deactivateSession: (sessionKey) => {
    set((state) => {
      if (state.activeSessionKey !== sessionKey) {
        return {};
      }
      return {
        ...CLEARED_SETTINGS_SESSION_DATA,
        activeSessionKey: null,
        sessionGeneration: state.sessionGeneration + 1,
      };
    });
  },

  initialize: async (sessionKey) => {
    if (get().activeSessionKey !== sessionKey) {
      return;
    }
    await Promise.allSettled([get().loadConfig(), get().loadLogGovernance(), get().loadImageStorageGovernance()]);
  },

  loadConfig: async () => {
    const token = getSessionToken();
    if (!token) {
      return;
    }
    setForSession(token, { isLoadingConfig: true });
    try {
      const data = await dependencies.fetchSettingsConfig();
      setForSession(token, {
        config: normalizeConfig(data.config),
      });
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "加载系统配置失败");
      }
    } finally {
      setForSession(token, { isLoadingConfig: false });
    }
  },

  saveConfig: async () => {
    const token = getSessionToken();
    const { config } = get();
    if (!token || !config) {
      return;
    }
    const canConfigureRelayDatabase = typeof config.relay_database_password_configured === "boolean";

    setForSession(token, { isSavingConfig: true });
    try {
      const payload: SettingsConfig = {
        ...config,
        image_task_timeout_seconds: Math.min(3600, Math.max(30, Number(config.image_task_timeout_seconds) || 300)),
        image_models: normalizeConfiguredModels(config.image_models, DEFAULT_IMAGE_MODELS),
        video_models: normalizeConfiguredModels(config.video_models, []),
        text_models: normalizeConfiguredModels(config.text_models, ["gpt-5.5", "gpt-5.4"]),
        audio_models: normalizeConfiguredModels(config.audio_models, ["gpt-4o-mini-tts"]),
        user_default_concurrent_limit: Math.max(0, Number(config.user_default_concurrent_limit) || 0),
        user_default_rpm_limit: Math.max(0, Number(config.user_default_rpm_limit) || 0),
        allow_user_custom_relay_config: config.allow_user_custom_relay_config === true,
        image_retention_days: Math.max(1, Number(config.image_retention_days) || 30),
        image_storage_limit_mb: Math.max(0, Number(config.image_storage_limit_mb) || 0),
        storage: config.storage,
        log_retention_days: Math.min(3650, Math.max(1, Number(config.log_retention_days) || 7)),
        log_cleanup_schedule_enabled: config.log_cleanup_schedule_enabled === true,
        log_cleanup_hour: normalizeLogCleanupHour(config.log_cleanup_hour),
        default_log_view: normalizeDefaultLogView(config.default_log_view),
        proxy: config.proxy.trim(),
        base_url: String(config.base_url || "").trim(),
        app_title: String(config.app_title || "云棉").trim() || "云棉",
        project_name: String(config.app_title || "云棉").trim() || "云棉",
        relay_base_url: String(config.relay_base_url || "").trim(),
        relay_database_type: config.relay_database_type === "sub2api" ? "sub2api" : "newapi",
        relay_database_driver: config.relay_database_driver === "sqlite" ? "sqlite" : config.relay_database_driver === "mysql" ? "mysql" : "postgres",
        relay_database_host: String(config.relay_database_host || "").trim(),
        relay_database_port: String(config.relay_database_port || "").trim(),
        relay_database_name: String(config.relay_database_name || "").trim(),
        relay_database_user: String(config.relay_database_user || "").trim(),
      };
      delete payload.chat_models;
      delete payload.default_chat_model;
      delete payload.relay_database_url;
      delete payload.relay_database_configured;
      delete payload.relay_database_password_configured;
      if (String(config.relay_database_password || "") === "") {
        delete payload.relay_database_password;
      } else {
        payload.relay_database_password = String(config.relay_database_password);
      }
      if (!canConfigureRelayDatabase) {
        delete payload.relay_database_type;
        delete payload.relay_database_driver;
        delete payload.relay_database_host;
        delete payload.relay_database_port;
        delete payload.relay_database_name;
        delete payload.relay_database_user;
        delete payload.relay_database_password;
      }

      const data = await dependencies.updateSettingsConfig(payload);
      if (!sessionIsCurrent(token)) {
        return;
      }
      dependencies.invalidateStorageProviderCache();
      setForSession(token, (state) => ({
        config: state.config === config ? normalizeConfig(data.config) : state.config,
      }));
      if (!sessionIsCurrent(token)) {
        return;
      }
      dependencies.dispatchAppMetaUpdated({
        app_title: String(data.config.app_title || "云棉"),
        project_name: String(data.config.project_name || data.config.app_title || "云棉"),
      });
      if (!sessionIsCurrent(token)) {
        return;
      }
      await get().loadImageStorageGovernance(true);
      if (sessionIsCurrent(token)) {
        dependencies.toastSuccess("配置已保存");
      }
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "保存系统配置失败");
      }
    } finally {
      setForSession(token, { isSavingConfig: false });
    }
  },

  setImageRetentionDays: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_retention_days: value } } : {});
  },

  setImageStorageLimitMb: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_storage_limit_mb: value } } : {});
  },

	setStorage: (value) => {
		set((state) => state.config ? { config: { ...state.config, storage: value } } : {});
	},

  setLogRetentionDays: (value) => {
    set((state) => state.config ? { config: { ...state.config, log_retention_days: value } } : {});
  },

  setLogCleanupScheduleEnabled: (value) => {
    set((state) => state.config ? { config: { ...state.config, log_cleanup_schedule_enabled: value } } : {});
  },

  setLogCleanupHour: (value) => {
    set((state) => state.config ? { config: { ...state.config, log_cleanup_hour: normalizeLogCleanupHour(value) } } : {});
  },

  setDefaultLogView: (value) => {
    set((state) => state.config ? { config: { ...state.config, default_log_view: normalizeDefaultLogView(value) } } : {});
  },

  setImageTaskTimeoutSeconds: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_task_timeout_seconds: value } } : {});
  },

  setImageModels: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_models: value } } : {});
  },

  setVideoModels: (value) => {
    set((state) => state.config ? { config: { ...state.config, video_models: value } } : {});
  },

  setTextModels: (value) => {
    set((state) => state.config ? { config: { ...state.config, text_models: value } } : {});
  },

  setAudioModels: (value) => {
    set((state) => state.config ? { config: { ...state.config, audio_models: value } } : {});
  },

  setUserDefaultConcurrentLimit: (value) => {
    set((state) => state.config ? { config: { ...state.config, user_default_concurrent_limit: value } } : {});
  },

  setUserDefaultRpmLimit: (value) => {
    set((state) => state.config ? { config: { ...state.config, user_default_rpm_limit: value } } : {});
  },

  setAllowUserCustomRelayConfig: (value) => {
    set((state) => state.config ? { config: { ...state.config, allow_user_custom_relay_config: value } } : {});
  },

  setLogLevel: (level, enabled) => {
    set((state) => {
      if (!state.config) return {};
      const levels = new Set(state.config.log_levels || []);
      if (enabled) levels.add(level);
      else levels.delete(level);
      return { config: { ...state.config, log_levels: Array.from(levels) } };
    });
  },

  setProxy: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          proxy: value,
        },
      };
    });
  },

  setBaseUrl: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          base_url: value,
        },
      };
    });
  },

  setRelayBaseUrl: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          relay_base_url: value,
        },
      };
    });
  },

  setRelayDatabaseType: (value) => {
    set((state) => state.config ? { config: { ...state.config, relay_database_type: value } } : {});
  },

  setRelayDatabaseDriver: (value) => {
    set((state) => state.config ? { config: { ...state.config, relay_database_driver: value } } : {});
  },

  setRelayDatabaseField: (field, value) => {
    set((state) => state.config ? { config: { ...state.config, [`relay_database_${field}`]: value } } : {});
  },

  setAppTitle: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          app_title: value,
          project_name: value,
        },
      };
    });
  },
  setPromptSources: (value) => {
    set((state) => state.config ? { config: { ...state.config, prompt_sources: normalizePromptMarketSources(value) } } : {});
  },

  saveSiteIcon: async ({ file, action }) => {
    const token = getSessionToken();
    const { config } = get();
    if (!token || !config) {
      return false;
    }

    setForSession(token, { isSavingConfig: true });
    try {
      const data = await dependencies.updateSiteIconSettings({ action, file });
      if (!sessionIsCurrent(token)) {
        return false;
      }
      const nextConfig = normalizeConfig(data.config);
      setForSession(token, (state) => ({
        config: mergeUnchangedConfigFields(state.config, config, nextConfig, SITE_ICON_CONFIG_FIELDS),
      }));
      if (!sessionIsCurrent(token)) {
        return false;
      }
      dependencies.dispatchAppMetaUpdated({
        site_icon_url: String(nextConfig.site_icon_url || ""),
      });
      if (sessionIsCurrent(token)) {
        dependencies.toastSuccess(action === "remove" ? "已恢复默认网站图标" : "网站图标已保存");
      }
      return true;
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "保存网站图标失败");
      }
      return false;
    } finally {
      setForSession(token, { isSavingConfig: false });
    }
  },

  setLoginPageImageUrl: (value) => {
    set((state) => state.config ? { config: { ...state.config, login_page_image_url: value } } : {});
  },

  setLoginPageImageMode: (value) => {
    set((state) => state.config ? { config: { ...state.config, login_page_image_mode: value } } : {});
  },

  setLoginPageImageTransform: (transform) => {
    const normalized = normalizeLoginPageImageTransform(transform);
    set((state) => state.config ? {
      config: {
        ...state.config,
        login_page_image_zoom: normalized.zoom,
        login_page_image_position_x: normalized.positionX,
        login_page_image_position_y: normalized.positionY,
      },
    } : {});
  },

  restoreDefaultLoginPageImage: () => {
    set((state) => state.config ? {
      config: {
        ...state.config,
        login_page_image_url: "",
        login_page_image_zoom: LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM.zoom,
        login_page_image_position_x: LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM.positionX,
        login_page_image_position_y: LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM.positionY,
      },
    } : {});
  },

  saveLoginPageImage: async ({ file, action }) => {
    const token = getSessionToken();
    const { config } = get();
    if (!token || !config) {
      return false;
    }
    const transform = normalizeLoginPageImageTransform({
      zoom: Number(config.login_page_image_zoom),
      positionX: Number(config.login_page_image_position_x),
      positionY: Number(config.login_page_image_position_y),
    });
    const settings: LoginPageImageSettings = {
      login_page_image_url: String(config.login_page_image_url || "").trim(),
      login_page_image_mode: normalizeLoginPageImageMode(config.login_page_image_mode),
      login_page_image_zoom: transform.zoom,
      login_page_image_position_x: transform.positionX,
      login_page_image_position_y: transform.positionY,
    };

    setForSession(token, { isSavingConfig: true });
    try {
      const data = await dependencies.updateLoginPageImageSettings(settings, { action, file });
      if (!sessionIsCurrent(token)) {
        return false;
      }
      const nextConfig = normalizeConfig(data.config);
      setForSession(token, (state) => ({
        config: mergeUnchangedConfigFields(state.config, config, nextConfig, LOGIN_PAGE_IMAGE_CONFIG_FIELDS),
      }));
      if (!sessionIsCurrent(token)) {
        return false;
      }
      dependencies.dispatchAppMetaUpdated({
        login_page_image_url: String(nextConfig.login_page_image_url || ""),
        login_page_image_mode: normalizeLoginPageImageMode(nextConfig.login_page_image_mode),
        login_page_image_zoom: Number(nextConfig.login_page_image_zoom),
        login_page_image_position_x: Number(nextConfig.login_page_image_position_x),
        login_page_image_position_y: Number(nextConfig.login_page_image_position_y),
      });
      if (sessionIsCurrent(token)) {
        dependencies.toastSuccess("登录页图片已保存");
      }
      return true;
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "保存登录页图片失败");
      }
      return false;
    } finally {
      setForSession(token, { isSavingConfig: false });
    }
  },

  loadLogGovernance: async (silent = false) => {
    const token = getSessionToken();
    if (!token) {
      return;
    }
    if (!silent) setForSession(token, { isLoadingLogGovernance: true });
    try {
      const data = await dependencies.fetchLogGovernance();
      setForSession(token, { logGovernance: data.governance });
    } catch (error) {
      if (!silent && sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "加载日志治理数据失败");
      }
    } finally {
      if (!silent) setForSession(token, { isLoadingLogGovernance: false });
    }
  },

  cleanupLogsByRetention: async () => {
    const token = getSessionToken();
    const { config } = get();
    if (!token || !config) {
      return;
    }
    const retentionDays = Math.min(3650, Math.max(1, Number(config.log_retention_days) || 7));
    setForSession(token, { isCleaningLogs: true });
    try {
      const data = await dependencies.cleanupLogs(retentionDays);
      setForSession(token, {
        lastLogCleanup: data.cleanup,
        logGovernance: data.governance,
      });
      if (sessionIsCurrent(token)) {
        dependencies.toastSuccess(`已清理 ${data.cleanup.deleted} 条历史日志`);
      }
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "清理日志失败");
      }
    } finally {
      setForSession(token, { isCleaningLogs: false });
    }
  },

  loadImageStorageGovernance: async (silent = false) => {
    const token = getSessionToken();
    if (!token) {
      return;
    }
    if (!silent) setForSession(token, { isLoadingImageStorageGovernance: true });
    try {
      const data = await dependencies.fetchImageStorageGovernance();
      setForSession(token, { imageStorageGovernance: data.governance });
    } catch (error) {
      if (!silent && sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "加载媒体存储数据失败");
      }
    } finally {
      if (!silent) setForSession(token, { isLoadingImageStorageGovernance: false });
    }
  },

  cleanupImageStorageByRetention: async () => {
    const token = getSessionToken();
    const { config } = get();
    if (!token || !config) return;
    const retentionDays = Math.max(1, Number(config.image_retention_days) || 30);
    setForSession(token, { isCleaningImageStorage: true });
    try {
      const data = await dependencies.cleanupImageStorage({ action: "retention", retention_days: retentionDays });
      setForSession(token, { lastImageStorageCleanup: data.cleanup, imageStorageGovernance: data.governance });
      if (sessionIsCurrent(token)) {
        dependencies.toastSuccess(`已清理 ${data.cleanup.deleted_images + data.cleanup.deleted_conversation_assets} 张过期图片`);
      }
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "清理图片失败");
      }
    } finally {
      setForSession(token, { isCleaningImageStorage: false });
    }
  },

  cleanupImageStorageByQuota: async (includePublic = false) => {
    const token = getSessionToken();
    const { config } = get();
    if (!token || !config) return;
    const maxMb = Math.max(0, Number(config.image_storage_limit_mb) || 0);
    if (maxMb <= 0) {
      dependencies.toastError("请先设置图片容量上限");
      return;
    }
    setForSession(token, { isCleaningImageStorage: true });
    try {
      const data = await dependencies.cleanupImageStorage({ action: "quota", max_mb: maxMb, include_public: includePublic });
      setForSession(token, { lastImageStorageCleanup: data.cleanup, imageStorageGovernance: data.governance });
      if (sessionIsCurrent(token)) {
        dependencies.toastSuccess(`已按容量清理 ${data.cleanup.deleted_images + data.cleanup.deleted_conversation_assets} 张图片`);
      }
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "按容量清理图片失败");
      }
    } finally {
      setForSession(token, { isCleaningImageStorage: false });
    }
  },

  cleanupImageThumbnails: async () => {
    const token = getSessionToken();
    if (!token) {
      return;
    }
    setForSession(token, { isCleaningImageStorage: true });
    try {
      const data = await dependencies.cleanupImageStorage({ action: "thumbnails" });
      setForSession(token, { lastImageStorageCleanup: data.cleanup, imageStorageGovernance: data.governance });
      if (sessionIsCurrent(token)) {
        dependencies.toastSuccess(`已清理 ${data.cleanup.deleted_thumbnails} 个缩略图缓存`);
      }
    } catch (error) {
      if (sessionIsCurrent(token)) {
        dependencies.toastError(error instanceof Error ? error.message : "清理缩略图失败");
      }
    } finally {
      setForSession(token, { isCleaningImageStorage: false });
    }
  },
    };
  });
}

export const useSettingsStore = createSettingsStore();
