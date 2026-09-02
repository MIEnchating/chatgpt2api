import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { createSettingsStore } from "../src/app/settings/store.ts";

const settingsPageSource = await readFile(
  new URL("../src/app/settings/page.tsx", import.meta.url),
  "utf8",
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function config(title) {
  return {
    proxy: "",
    app_title: title,
    project_name: title,
    image_models: ["gpt-image-1"],
    default_image_model: "gpt-image-1",
    video_models: [],
    text_models: ["gpt-5.5"],
    default_text_model: "gpt-5.5",
    audio_models: ["gpt-4o-mini-tts"],
    default_audio_model: "gpt-4o-mini-tts",
    image_retention_days: 30,
    image_storage_limit_mb: 1024,
    log_retention_days: 7,
    log_levels: [],
  };
}

function sessionData(state) {
  return {
    activeSessionKey: state.activeSessionKey,
    config: state.config,
    isLoadingConfig: state.isLoadingConfig,
    isSavingConfig: state.isSavingConfig,
    logGovernance: state.logGovernance,
    lastLogCleanup: state.lastLogCleanup,
    isLoadingLogGovernance: state.isLoadingLogGovernance,
    isCleaningLogs: state.isCleaningLogs,
    imageStorageGovernance: state.imageStorageGovernance,
    lastImageStorageCleanup: state.lastImageStorageCleanup,
    isLoadingImageStorageGovernance: state.isLoadingImageStorageGovernance,
    isCleaningImageStorage: state.isCleaningImageStorage,
  };
}

const clearedSessionData = {
  activeSessionKey: null,
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
};

describe("settings store session isolation", () => {
  test("explicit empty model lists clear stale defaults after loading", async () => {
    const store = createSettingsStore({
      fetchSettingsConfig: async () => ({
        config: {
          ...config("Empty models"),
          image_models: [],
          default_image_model: "stale-image-model",
          video_models: [],
          default_video_model: "stale-video-model",
          text_models: [],
          default_text_model: "stale-text-model",
          audio_models: [],
          default_audio_model: "stale-audio-model",
        },
      }),
    });

    store.getState().activateSession("session-a");
    await store.getState().loadConfig();

    expect(store.getState().config).toMatchObject({
      image_models: [],
      default_image_model: "",
      video_models: [],
      default_video_model: "",
      text_models: [],
      default_text_model: "",
      audio_models: [],
      default_audio_model: "",
    });
  });

  test("saving keeps every default inside its normalized model list", async () => {
    let savedConfig;
    const store = createSettingsStore({
      updateSettingsConfig: async (payload) => {
        savedConfig = payload;
        return { config: payload };
      },
      fetchImageStorageGovernance: async () => ({ governance: {} }),
    });

    store.getState().activateSession("session-a");
    store.setState({
      config: {
        ...config("Changed models"),
        image_models: "image-current, image-current",
        default_image_model: "image-deleted",
        video_models: "",
        default_video_model: "video-deleted",
        text_models: ["text-current"],
        default_text_model: "text-current",
        audio_models: [],
        default_audio_model: "audio-deleted",
      },
    });

    await store.getState().saveConfig();

    expect(savedConfig).toMatchObject({
      image_models: ["image-current"],
      default_image_model: "image-current",
      video_models: [],
      default_video_model: "",
      text_models: ["text-current"],
      default_text_model: "text-current",
      audio_models: [],
      default_audio_model: "",
    });
  });

  test("an A response completing after B cannot overwrite B or emit feedback", async () => {
    const aRequest = deferred();
    const bRequest = deferred();
    const requests = [aRequest, bRequest];
    const errors = [];
    const store = createSettingsStore({
      fetchSettingsConfig: () => requests.shift().promise,
      toastError: (message) => errors.push(message),
    });

    store.getState().activateSession("session-a");
    const aLoad = store.getState().loadConfig();
    expect(store.getState().isLoadingConfig).toBe(true);

    store.getState().activateSession("session-b");
    expect(sessionData(store.getState())).toEqual({
      ...clearedSessionData,
      activeSessionKey: "session-b",
    });
    const bLoad = store.getState().loadConfig();

    bRequest.resolve({ config: config("Account B") });
    await bLoad;
    expect(store.getState().config.app_title).toBe("Account B");

    aRequest.resolve({ config: config("Account A") });
    await aLoad;
    expect(store.getState().activeSessionKey).toBe("session-b");
    expect(store.getState().config.app_title).toBe("Account B");
    expect(errors).toEqual([]);
  });

  test("unmount invalidates delayed work even when the same session key mounts again", async () => {
    const firstRequest = deferred();
    const remountRequest = deferred();
    const requests = [firstRequest, remountRequest];
    const errors = [];
    const store = createSettingsStore({
      fetchSettingsConfig: () => requests.shift().promise,
      toastError: (message) => errors.push(message),
    });

    store.getState().activateSession("session-a");
    const firstLoad = store.getState().loadConfig();
    const firstGeneration = store.getState().sessionGeneration;
    store.getState().deactivateSession("session-a");

    expect(sessionData(store.getState())).toEqual(clearedSessionData);
    expect(store.getState().sessionGeneration).toBeGreaterThan(firstGeneration);

    store.getState().activateSession("session-a");
    const remountLoad = store.getState().loadConfig();
    remountRequest.resolve({ config: config("Fresh mount") });
    await remountLoad;

    firstRequest.reject(new Error("stale request failed"));
    await firstLoad;
    expect(store.getState().config.app_title).toBe("Fresh mount");
    expect(store.getState().isLoadingConfig).toBe(false);
    expect(errors).toEqual([]);
  });

  test("a stale save has no UI, app metadata, cache, or follow-up request side effects", async () => {
    const updateRequest = deferred();
    const successes = [];
    const errors = [];
    const appMetaUpdates = [];
    let cacheInvalidations = 0;
    let governanceLoads = 0;
    const store = createSettingsStore({
      updateSettingsConfig: () => updateRequest.promise,
      fetchImageStorageGovernance: async () => {
        governanceLoads += 1;
        return { governance: { total_bytes: 10 } };
      },
      dispatchAppMetaUpdated: (metadata) => appMetaUpdates.push(metadata),
      invalidateStorageProviderCache: () => {
        cacheInvalidations += 1;
      },
      toastError: (message) => errors.push(message),
      toastSuccess: (message) => successes.push(message),
    });

    store.getState().activateSession("session-a");
    store.setState({ config: config("Account A draft") });
    const save = store.getState().saveConfig();
    expect(store.getState().isSavingConfig).toBe(true);

    store.getState().activateSession("session-b");
    store.setState({ config: config("Account B draft") });
    updateRequest.resolve({ config: config("Account A saved") });
    await save;

    expect(store.getState().activeSessionKey).toBe("session-b");
    expect(store.getState().config.app_title).toBe("Account B draft");
    expect(store.getState().isSavingConfig).toBe(false);
    expect(governanceLoads).toBe(0);
    expect(cacheInvalidations).toBe(0);
    expect(appMetaUpdates).toEqual([]);
    expect(successes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a cleanup finishing after a session switch cannot publish its result", async () => {
    const cleanupRequest = deferred();
    const successes = [];
    const errors = [];
    const store = createSettingsStore({
      cleanupLogs: () => cleanupRequest.promise,
      toastError: (message) => errors.push(message),
      toastSuccess: (message) => successes.push(message),
    });

    store.getState().activateSession("session-a");
    store.setState({ config: config("Account A") });
    const cleanup = store.getState().cleanupLogsByRetention();
    expect(store.getState().isCleaningLogs).toBe(true);

    store.getState().activateSession("session-b");
    store.setState({ config: config("Account B") });
    cleanupRequest.resolve({
      cleanup: { retention_days: 7, cutoff_date: "2026-08-26", deleted: 12, remaining: 3 },
      governance: { total: 3 },
    });
    await cleanup;

    expect(store.getState().config.app_title).toBe("Account B");
    expect(store.getState().lastLogCleanup).toBeNull();
    expect(store.getState().logGovernance).toBeNull();
    expect(store.getState().isCleaningLogs).toBe(false);
    expect(successes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the page activates before mounting cards and clears the store on unmount", () => {
    expect(settingsPageSource).toContain("useLayoutEffect(() => {");
    expect(settingsPageSource).toContain("activateSession(sessionKey);");
    expect(settingsPageSource).toContain("void initialize(sessionKey);");
    expect(settingsPageSource).toContain("return () => deactivateSession(sessionKey);");
    expect(settingsPageSource).toContain("return activeSessionKey === sessionKey ? children : null;");
    expect(settingsPageSource).toContain("<AdminSettingsPageContent key={session.key} session={session} />");
  });
});
