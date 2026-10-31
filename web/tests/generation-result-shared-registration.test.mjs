import assert from "node:assert/strict";
import test from "node:test";
import { spyOn } from "bun:test";
import * as myAssets from "../src/lib/my-assets.ts";

import { ensureGeneratedMediaAsset } from "../src/services/generation-result-storage.ts";
import { setVerifiedAuthSession } from "../src/lib/session.ts";

async function activateSession(key) {
  await setVerifiedAuthSession({
    key, role: "user", subjectId: `subject:${key}`, username: key, name: key,
    provider: "test", menuPaths: [], apiPermissions: [], menus: [],
  });
}

function videoFixture(id) {
  const task = {
    id, status: "success", mode: "video", model: "test-video", visibility: "private",
    created_at: "2026-10-30T10:00:00Z", updated_at: "2026-10-30T10:01:00Z",
  };
  const item = {
    type: "video", video_url: `/api/files/${id}/content`, storageKey: `server:${id}`,
    mime_type: "video/mp4", bytes: 4096,
  };
  return { task, item };
}

test("a waiter retries when the shared registration was aborted by another caller", async () => {
  await activateSession("session-shared-registration");
  const { task, item } = videoFixture("shared-registration-abort");
  let calls = 0;
  const upsert = spyOn(myAssets, "upsertMyAsset").mockImplementation((asset, signal) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(asset);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  try {
    const initiator = new AbortController();
    const options = { expectedSessionKey: "session-shared-registration" };
    const first = ensureGeneratedMediaAsset(task, item, 0, { ...options, signal: initiator.signal });
    const second = ensureGeneratedMediaAsset(task, item, 0, options);
    await Promise.resolve();
    initiator.abort();
    await assert.rejects(first, (error) => error.name === "AbortError");
    await second;
    assert.equal(calls, 2);
  } finally {
    upsert.mockRestore();
  }
});

test("a non-abort registration failure still reaches every caller without a retry", async () => {
  await activateSession("session-shared-registration-failure");
  const { task, item } = videoFixture("shared-registration-failure");
  const failure = new Error("material storage unavailable");
  const upsert = spyOn(myAssets, "upsertMyAsset").mockRejectedValue(failure);
  try {
    const options = { expectedSessionKey: "session-shared-registration-failure" };
    const first = ensureGeneratedMediaAsset(task, item, 0, options);
    const second = ensureGeneratedMediaAsset(task, item, 0, options);
    await assert.rejects(first, (error) => error === failure);
    await assert.rejects(second, (error) => error === failure);
    assert.equal(upsert.mock.calls.length, 1);
  } finally {
    upsert.mockRestore();
  }
});
