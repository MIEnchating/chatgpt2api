import assert from "node:assert/strict";
import { afterAll, mock, test } from "bun:test";

const originalWindow = globalThis.window;
let preferenceRequests = 0;

globalThis.window = new EventTarget();
mock.module("@/lib/request", () => ({
  httpRequest: async (path) => {
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

afterAll(() => {
  mock.restore();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
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
