import { expect, test } from "bun:test";
import { createSettingsStore } from "../src/app/settings/store.ts";

test("default key categories retain a shared group and explicitly persist clears", async () => {
  let saved;
  const store = createSettingsStore({
    updateSettingsConfig: async (payload) => { saved = payload; return { config: payload }; },
    fetchImageStorageGovernance: async () => ({ governance: {} }),
    dispatchAppMetaUpdated: () => {}, invalidateStorageProviderCache: () => {},
    toastSuccess: () => {}, toastError: (message) => { throw new Error(message); },
  });
  store.getState().activateSession("admin");
  store.setState({ config: { proxy: "" } });
  const kinds = ["text", "image", "video", "audio"];
  for (const kind of kinds) store.getState().setRelayCreationGroup(kind, "shared");
  await store.getState().saveConfig();
  for (const kind of kinds) expect(saved[`relay_${kind}_group`]).toBe("shared");
  store.getState().setRelayCreationGroup("text", "");
  await store.getState().saveConfig();
  expect(saved.relay_text_group).toBe("");
  expect(saved.relay_image_group).toBe("shared");
  for (const kind of kinds) store.getState().setRelayCreationGroup(kind, "");
  await store.getState().saveConfig();
  for (const kind of kinds) {
    expect(saved[`relay_${kind}_group`]).toBe("");
    expect(store.getState().config[`relay_${kind}_group`]).toBe("");
  }
});
