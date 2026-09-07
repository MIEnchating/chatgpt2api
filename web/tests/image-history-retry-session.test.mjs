import assert from "node:assert/strict";
import { test, spyOn } from "bun:test";
import * as historyAPI from "../src/services/api/image-conversations.ts";
import { clearVerifiedAuthSession, setVerifiedAuthSession } from "../src/lib/session.ts";

test("a history retry after account switch must not send the previous account snapshot", async () => {
  const originalWindow = globalThis.window;
  const originalTimeout = globalThis.setTimeout;
  globalThis.window = new EventTarget();
  const history = await import("../src/store/image-conversations.ts?retry-session-review");
  let resumeRetry;
  let retryStarted;
  const waiting = new Promise((resolve) => { retryStarted = resolve; });
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 500) return originalTimeout(callback, delay, ...args);
    resumeRetry = () => callback(...args);
    retryStarted();
    return 0;
  };
  const requests = [];
  const merge = spyOn(historyAPI, "mergeImageConversationHistory").mockImplementation(async (items) => {
    requests.push(items);
    if (requests.length === 1) throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    return { accepted: true, id: items[0].id, revision: items[0].revision };
  });
  const session = (key) => ({
    key, role: "user", subjectId: key, name: key, provider: "local",
    creationConcurrentLimit: 1, creationRpmLimit: 1, menuPaths: [], apiPermissions: [], menus: [],
  });
  try {
    await setVerifiedAuthSession(session("previous-account"));
    const save = history.saveImageConversationCoalesced({
      id: "previous-private-conversation", revision: 1, title: "Private draft",
      createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", turns: [],
    });
    const rejected = assert.rejects(save, (error) => error.code === "IMAGE_CONVERSATION_SCOPE_CHANGED");
    await waiting;
    await setVerifiedAuthSession(session("current-account"));
    resumeRetry();
    await rejected;
    assert.equal(requests.length, 1, "old account data was retried using the new session");
  } finally {
    await clearVerifiedAuthSession();
    merge.mockRestore();
    globalThis.setTimeout = originalTimeout;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
