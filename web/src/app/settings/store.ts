"use client";

import { create } from "zustand";
import { toast } from "sonner";

import {
  cleanupImageStorage,
  cleanupLogs,
  DEFAULT_CHAT_MODELS,
  DEFAULT_IMAGE_MODELS,
  fetchLogGovernance,
  fetchImageStorageGovernance,
  fetchSettingsConfig,
  normalizeModelNames,
  updateLoginPageImageSettings,
  updateSettingsConfig,
  type ImageStorageCleanupResult,
  type ImageStorageGovernanceSummary,
  type LogCleanupResult,
  type LogGovernanceSummary,
  type LoginPageImageSettings,
  type SettingsConfig,
} from "@/lib/api";
import { dispatchAppMetaUpdated } from "@/lib/app-meta";
import {
  LOGIN_PAGE_IMAGE_DEFAULT_TRANSFORM,
  normalizeLoginPageImageMode,
  normalizeLoginPageImageTransform,
  type LoginPageImageMode,
} from "@/lib/login-page-image-layout";

function normalizeConfig(config: SettingsConfig): SettingsConfig {
  const loginImageTransform = normalizeLoginPageImageTransform({
    zoom: Number(config.login_page_image_zoom),
    positionX: Number(config.login_page_image_position_x),
    positionY: Number(config.login_page_image_position_y),
  });
  return {
    ...config,
    refresh_account_interval_minute: Number(config.refresh_account_interval_minute || 5),
    image_task_timeout_seconds: Number(config.image_task_timeout_seconds || 300),
    image_stream_parameter_enabled: Boolean(config.image_stream_parameter_enabled),
    image_models: normalizeModelNames(config.image_models, DEFAULT_IMAGE_MODELS),
    chat_models: normalizeModelNames(config.chat_models, DEFAULT_CHAT_MODELS),
    default_image_model: String(config.default_image_model || DEFAULT_IMAGE_MODELS[0]),
    default_chat_model: String(config.default_chat_model || DEFAULT_CHAT_MODELS[0]),
    user_default_concurrent_limit: Number(config.user_default_concurrent_limit || 0),
    user_default_rpm_limit: Number(config.user_default_rpm_limit || 0),
    image_retention_days: Number(config.image_retention_days || 30),
    image_storage_limit_mb: Math.max(0, Number(config.image_storage_limit_mb) || 0),
    log_retention_days: Number(config.log_retention_days || 7),
    auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
    auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
    log_levels: Array.isArray(config.log_levels) ? config.log_levels : [],
    proxy: typeof config.proxy === "string" ? config.proxy : "",
    base_url: typeof config.base_url === "string" ? config.base_url : "",
    relay_base_url:
      typeof config.relay_base_url === "string" && config.relay_base_url.trim()
        ? config.relay_base_url
        : "http://newapi:3000",
    newapi_token_group:
      typeof config.newapi_token_group === "string" && config.newapi_token_group.trim()
        ? config.newapi_token_group
        : "codex",
    login_page_image_url: typeof config.login_page_image_url === "string" ? config.login_page_image_url : "",
    login_page_image_mode: normalizeLoginPageImageMode(config.login_page_image_mode),
    login_page_image_zoom: loginImageTransform.zoom,
    login_page_image_position_x: loginImageTransform.positionX,
    login_page_image_position_y: loginImageTransform.positionY,
  };
}

type SettingsStore = {
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

  initialize: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  setRefreshAccountIntervalMinute: (value: string) => void;
  setImageTaskTimeoutSeconds: (value: string) => void;
  setImageStreamParameterEnabled: (value: boolean) => void;
  setImageModels: (value: string) => void;
  setChatModels: (value: string) => void;
  setUserDefaultConcurrentLimit: (value: string) => void;
  setUserDefaultRpmLimit: (value: string) => void;
  setImageRetentionDays: (value: string) => void;
  setImageStorageLimitMb: (value: string) => void;
  setLogRetentionDays: (value: string) => void;
  setAutoRemoveInvalidAccounts: (value: boolean) => void;
  setAutoRemoveRateLimitedAccounts: (value: boolean) => void;
  setLogLevel: (level: string, enabled: boolean) => void;
  setProxy: (value: string) => void;
  setBaseUrl: (value: string) => void;
  setRelayBaseUrl: (value: string) => void;
  setNewAPITokenGroup: (value: string) => void;
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

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  config: null,
  isLoadingConfig: true,
  isSavingConfig: false,
  logGovernance: null,
  lastLogCleanup: null,
  isLoadingLogGovernance: true,
  isCleaningLogs: false,
  imageStorageGovernance: null,
  lastImageStorageCleanup: null,
  isLoadingImageStorageGovernance: true,
  isCleaningImageStorage: false,

  initialize: async () => {
    await Promise.allSettled([get().loadConfig(), get().loadLogGovernance(), get().loadImageStorageGovernance()]);
  },

  loadConfig: async () => {
    set({ isLoadingConfig: true });
    try {
      const data = await fetchSettingsConfig();
      set({
        config: normalizeConfig(data.config),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载系统配置失败");
    } finally {
      set({ isLoadingConfig: false });
    }
  },

  saveConfig: async () => {
    const { config } = get();
    if (!config) {
      return;
    }

    set({ isSavingConfig: true });
    try {
      const payload: SettingsConfig = {
        ...config,
        refresh_account_interval_minute: Math.max(1, Number(config.refresh_account_interval_minute) || 1),
        image_task_timeout_seconds: Math.min(3600, Math.max(30, Number(config.image_task_timeout_seconds) || 300)),
        image_stream_parameter_enabled: Boolean(config.image_stream_parameter_enabled),
        image_models: normalizeModelNames(config.image_models, DEFAULT_IMAGE_MODELS),
        chat_models: normalizeModelNames(config.chat_models, DEFAULT_CHAT_MODELS),
        user_default_concurrent_limit: Math.max(0, Number(config.user_default_concurrent_limit) || 0),
        user_default_rpm_limit: Math.max(0, Number(config.user_default_rpm_limit) || 0),
        image_retention_days: Math.max(1, Number(config.image_retention_days) || 30),
        image_storage_limit_mb: Math.max(0, Number(config.image_storage_limit_mb) || 0),
        log_retention_days: Math.min(3650, Math.max(1, Number(config.log_retention_days) || 7)),
        auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
        auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
        proxy: config.proxy.trim(),
        base_url: String(config.base_url || "").trim(),
        relay_base_url: String(config.relay_base_url || "").trim(),
        newapi_token_group: String(config.newapi_token_group || "codex").trim(),
      };

      const data = await updateSettingsConfig(payload);
      set({
        config: normalizeConfig(data.config),
      });
      toast.success("配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存系统配置失败");
    } finally {
      set({ isSavingConfig: false });
    }
  },

  setRefreshAccountIntervalMinute: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          refresh_account_interval_minute: value,
        },
      };
    });
  },

  setImageRetentionDays: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_retention_days: value } } : {});
  },

  setImageStorageLimitMb: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_storage_limit_mb: value } } : {});
  },

  setLogRetentionDays: (value) => {
    set((state) => state.config ? { config: { ...state.config, log_retention_days: value } } : {});
  },

  setImageTaskTimeoutSeconds: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_task_timeout_seconds: value } } : {});
  },

  setImageStreamParameterEnabled: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_stream_parameter_enabled: value } } : {});
  },

  setImageModels: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_models: value } } : {});
  },

  setChatModels: (value) => {
    set((state) => state.config ? { config: { ...state.config, chat_models: value } } : {});
  },

  setUserDefaultConcurrentLimit: (value) => {
    set((state) => state.config ? { config: { ...state.config, user_default_concurrent_limit: value } } : {});
  },

  setUserDefaultRpmLimit: (value) => {
    set((state) => state.config ? { config: { ...state.config, user_default_rpm_limit: value } } : {});
  },

  setAutoRemoveInvalidAccounts: (value) => {
    set((state) => state.config ? { config: { ...state.config, auto_remove_invalid_accounts: value } } : {});
  },

  setAutoRemoveRateLimitedAccounts: (value) => {
    set((state) => state.config ? { config: { ...state.config, auto_remove_rate_limited_accounts: value } } : {});
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

  setNewAPITokenGroup: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          newapi_token_group: value,
        },
      };
    });
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
    const { config } = get();
    if (!config) {
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

    set({ isSavingConfig: true });
    try {
      const data = await updateLoginPageImageSettings(settings, { action, file });
      const nextConfig = normalizeConfig(data.config);
      set({ config: nextConfig });
      dispatchAppMetaUpdated({
        app_title: "chatgpt2api",
        project_name: "chatgpt2api",
        login_page_image_url: String(nextConfig.login_page_image_url || ""),
        login_page_image_mode: normalizeLoginPageImageMode(nextConfig.login_page_image_mode),
        login_page_image_zoom: Number(nextConfig.login_page_image_zoom),
        login_page_image_position_x: Number(nextConfig.login_page_image_position_x),
        login_page_image_position_y: Number(nextConfig.login_page_image_position_y),
      });
      toast.success("登录页图片已保存");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存登录页图片失败");
      return false;
    } finally {
      set({ isSavingConfig: false });
    }
  },

  loadLogGovernance: async (silent = false) => {
    if (!silent) set({ isLoadingLogGovernance: true });
    try {
      const data = await fetchLogGovernance();
      set({ logGovernance: data.governance });
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载日志治理数据失败");
    } finally {
      if (!silent) set({ isLoadingLogGovernance: false });
    }
  },

  cleanupLogsByRetention: async () => {
    const { config } = get();
    if (!config) {
      return;
    }
    const retentionDays = Math.min(3650, Math.max(1, Number(config.log_retention_days) || 7));
    set({ isCleaningLogs: true });
    try {
      const data = await cleanupLogs(retentionDays);
      set({
        lastLogCleanup: data.cleanup,
        logGovernance: data.governance,
      });
      toast.success(`已清理 ${data.cleanup.deleted} 条历史日志`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清理日志失败");
    } finally {
      set({ isCleaningLogs: false });
    }
  },

  loadImageStorageGovernance: async (silent = false) => {
    if (!silent) set({ isLoadingImageStorageGovernance: true });
    try {
      const data = await fetchImageStorageGovernance();
      set({ imageStorageGovernance: data.governance });
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载图片存储数据失败");
    } finally {
      if (!silent) set({ isLoadingImageStorageGovernance: false });
    }
  },

  cleanupImageStorageByRetention: async () => {
    const { config } = get();
    if (!config) return;
    const retentionDays = Math.max(1, Number(config.image_retention_days) || 30);
    set({ isCleaningImageStorage: true });
    try {
      const data = await cleanupImageStorage({ action: "retention", retention_days: retentionDays });
      set({ lastImageStorageCleanup: data.cleanup, imageStorageGovernance: data.governance });
      toast.success(`已清理 ${data.cleanup.deleted_images} 张过期图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清理图片失败");
    } finally {
      set({ isCleaningImageStorage: false });
    }
  },

  cleanupImageStorageByQuota: async (includePublic = false) => {
    const { config } = get();
    if (!config) return;
    const maxMb = Math.max(0, Number(config.image_storage_limit_mb) || 0);
    if (maxMb <= 0) {
      toast.error("请先设置图片容量上限");
      return;
    }
    set({ isCleaningImageStorage: true });
    try {
      const data = await cleanupImageStorage({ action: "quota", max_mb: maxMb, include_public: includePublic });
      set({ lastImageStorageCleanup: data.cleanup, imageStorageGovernance: data.governance });
      toast.success(`已按容量清理 ${data.cleanup.deleted_images} 张图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "按容量清理图片失败");
    } finally {
      set({ isCleaningImageStorage: false });
    }
  },

  cleanupImageThumbnails: async () => {
    set({ isCleaningImageStorage: true });
    try {
      const data = await cleanupImageStorage({ action: "thumbnails" });
      set({ lastImageStorageCleanup: data.cleanup, imageStorageGovernance: data.governance });
      toast.success(`已清理 ${data.cleanup.deleted_thumbnails} 个缩略图缓存`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清理缩略图失败");
    } finally {
      set({ isCleaningImageStorage: false });
    }
  },
}));
