import assert from "node:assert/strict";
import { test, spyOn } from "bun:test";
import * as historyAPI from "../src/services/api/image-conversations.ts";
import { clearVerifiedAuthSession, setVerifiedAuthSession } from "../src/lib/session.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const clearAll of [false, true]) {
  test(`history ${clearAll ? "clear" : "delete"} settles saves queued while deletion is pending`, async () => {
    const originalWindow = globalThis.window;
    globalThis.window = new EventTarget();
    const history = await import(`../src/store/image-conversations.ts?delete-race-${clearAll}`);
    const started = deferred();
    const deletion = deferred();
    const remove = spyOn(historyAPI, clearAll ? "clearImageConversationHistory" : "deleteImageConversationHistoryItem")
      .mockImplementation(() => { started.resolve(); return deletion.promise; });
    const merge = spyOn(historyAPI, "mergeImageConversationHistory").mockImplementation(async (items) => ({
      accepted: true, id: items[0].id, revision: items[0].revision,
    }));
    try {
      await setVerifiedAuthSession({
        key: "delete-race", role: "user", subjectId: "delete-race", name: "Test", provider: "local",
        creationConcurrentLimit: 1, creationRpmLimit: 1, menuPaths: [], apiPermissions: [], menus: [],
      });
      const removal = clearAll ? history.clearImageConversations() : history.deleteImageConversation("target");
      await started.promise;
      const snapshot = { id: "target", revision: 1, title: "Test", createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z", turns: [] };
      const first = history.saveImageConversationCoalesced(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = history.saveImageConversationCoalesced({ ...snapshot, revision: 2 });
      const outcome = second.then(() => "resolved", (error) => error.status);
      await new Promise((resolve) => setTimeout(resolve, 0));
      deletion.resolve({ removed: true, generation: "2" });
      await removal;
      await first;
      const timeout = deferred();
      const timer = setTimeout(() => timeout.resolve("pending"), 100);
      try { assert.equal(await Promise.race([outcome, timeout.promise]), 410); }
      finally { clearTimeout(timer); }
    } finally {
      await clearVerifiedAuthSession();
      remove.mockRestore();
      merge.mockRestore();
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    }
  });
}
