import { expect, test } from "bun:test";
import { createSettingsStore } from "../src/app/settings/store.ts";

test("default key categories retain a shared group and explicitly persist clears", async () => {
  let saved;
  const store = createSettingsStore({
    updateSettingsConfig: async (payload) => { saved = payload; return { config: { ...payload, relay_database_password_configured: false } }; },
    fetchImageStorageGovernance: async () => ({ governance: {} }),
    dispatchAppMetaUpdated: () => {}, invalidateStorageProviderCache: () => {},
    toastSuccess: () => {}, toastError: (message) => { throw new Error(message); },
  });
  store.getState().activateSession("admin");
  store.setState({ config: { proxy: "", relay_database_password_configured: false } });
  const kinds = ["text", "image", "video", "audio"];
  for (const kind of kinds) store.getState().setRelayCreationGroup(kind, ["shared", "another"]);
  await store.getState().saveConfig();
  for (const kind of kinds) expect(saved[`relay_${kind}_group`]).toEqual(["shared", "another"]);
  store.getState().setRelayCreationGroup("text", []);
  await store.getState().saveConfig();
  expect(saved.relay_text_group).toEqual([]);
  expect(saved.relay_image_group).toEqual(["shared", "another"]);
  for (const kind of kinds) store.getState().setRelayCreationGroup(kind, []);
  await store.getState().saveConfig();
  for (const kind of kinds) {
    expect(saved[`relay_${kind}_group`]).toEqual([]);
    expect(store.getState().config[`relay_${kind}_group`]).toEqual([]);
  }
});

test("delegated settings saves omit administrator-only fields", async () => {
  let saved;
  const store = createSettingsStore({
    updateSettingsConfig: async (payload) => { saved = payload; return { config: payload }; },
    fetchImageStorageGovernance: async () => ({ governance: {} }),
    dispatchAppMetaUpdated: () => {}, invalidateStorageProviderCache: () => {},
    toastSuccess: () => {}, toastError: (message) => { throw new Error(message); },
  });
  store.getState().activateSession("operator");
  store.setState({ config: { proxy: "", relay_text_group: ["private"], relay_parameter_translation: "private", storage: {}, allow_user_custom_relay_config: true } });
  await store.getState().saveConfig();
  for (const key of ["relay_text_group", "relay_image_group", "relay_video_group", "relay_audio_group", "relay_parameter_translation", "storage", "allow_user_custom_relay_config"]) {
    expect(saved).not.toHaveProperty(key);
  }
});
