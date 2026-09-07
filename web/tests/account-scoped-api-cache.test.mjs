import assert from "node:assert/strict";
import { afterAll, mock, test } from "bun:test";

const originalWindow = globalThis.window;
let preferenceRequests = 0;
const modelRequests = [];

globalThis.window = new EventTarget();
mock.module("@/lib/request", () => ({
  httpRequest: async (path) => {
    if (path === "/api/model-config") {
      return new Promise((resolve) => modelRequests.push(resolve));
    }
    assert.equal(path, "/api/profile/image-generation-preferences");
    preferenceRequests += 1;
    return {
      preferences: {
        default_image_model: `account-${preferenceRequests}`,
      },
    };
  },
}));

const api = await import("../src/lib/api.ts?account-cache-session-event");
const { AUTH_SESSION_CHANGE_EVENT } = await import("../src/lib/auth-session.ts");
const { activeVideoModelContracts, installVideoModelContracts } = await import("../src/lib/video-model-contracts.ts");
const originalContracts = activeVideoModelContracts();

afterAll(() => {
  mock.restore();
  installVideoModelContracts(originalContracts);
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test("a previous account model response cannot replace the current contract registry", async () => {
  const oldRequest = api.fetchModelConfig();
  globalThis.window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  const currentRequest = api.fetchModelConfig();
  modelRequests[1]({ config: { video_model_contracts: [{ name: "current", models: ["current-video"], priority: 0 }] } });
  await currentRequest;
  modelRequests[0]({ config: { video_model_contracts: [{ name: "old", models: ["old-video"], priority: 0 }] } });
  await oldRequest;
  assert.deepEqual(activeVideoModelContracts().map((contract) => contract.name), ["current"]);
});

test("auth session changes invalidate account-scoped API caches", async () => {
  const first = await api.fetchImageGenerationPreferences();
  const cached = await api.fetchImageGenerationPreferences();

  assert.equal(first.preferences.default_image_model, "account-1");
  assert.equal(cached.preferences.default_image_model, "account-1");
  assert.equal(preferenceRequests, 1);

  globalThis.window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  const refreshed = await api.fetchImageGenerationPreferences();

  assert.equal(refreshed.preferences.default_image_model, "account-2");
  assert.equal(preferenceRequests, 2);
});
