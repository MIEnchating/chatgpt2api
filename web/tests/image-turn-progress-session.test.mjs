import assert from "node:assert/strict";
import { afterAll, test } from "bun:test";

const originalWindow = globalThis.window;
globalThis.window = new EventTarget();

const imageTurnProgress = await import("../src/store/image-turn-progress.ts?auth-session-reset");
const { AUTH_SESSION_CHANGE_EVENT } = await import("../src/lib/auth-session.ts");

afterAll(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test("auth session changes clear image turn progress and notify subscribers", () => {
  imageTurnProgress.setImageTurnProgress("conversation-1", "turn-1", {
    message: "Generating",
    startedAt: 123,
  });

  let notifications = 0;
  const unsubscribe = imageTurnProgress.subscribeImageTurnProgress(() => {
    notifications += 1;
  });

  globalThis.window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));

  assert.deepEqual(imageTurnProgress.getImageTurnProgressSnapshot(), {});
  assert.equal(notifications, 1);
  unsubscribe();
});
