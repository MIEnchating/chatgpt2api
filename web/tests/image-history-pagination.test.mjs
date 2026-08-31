import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildImageConversationHistoryMergeBody,
  imageConversationHistoryGenerationAtLeast,
  imageConversationHistoryGenerationsMatch,
  imageConversationHistoryGenerationChanged,
  normalizeImageConversationHistoryGeneration,
  shouldFallbackToImageConversationHistoryDetail,
  shouldResetImageConversationHistoryCursor,
} from "../src/lib/image-conversation-history.ts";

const pageSource = await readFile(new URL("../src/app/image/page.tsx", import.meta.url), "utf8");

test("history merge body contains only conversation items", () => {
  const items = [{ id: "conversation-1" }];
  assert.deepEqual(buildImageConversationHistoryMergeBody(items), { items });
});

test("history generations normalize and detect a cursor reset", () => {
  assert.equal(normalizeImageConversationHistoryGeneration(undefined), null);
  assert.equal(normalizeImageConversationHistoryGeneration(" 17 "), "17");
  assert.equal(normalizeImageConversationHistoryGeneration("opaque"), null);
  assert.equal(imageConversationHistoryGenerationChanged(null, "17"), false);
  assert.equal(imageConversationHistoryGenerationChanged("17", "18"), true);
  assert.equal(imageConversationHistoryGenerationChanged("18", "17"), false);
  assert.equal(imageConversationHistoryGenerationChanged("17", "17"), false);
  assert.equal(shouldResetImageConversationHistoryCursor(409), true);
  assert.equal(shouldResetImageConversationHistoryCursor(503), false);
  assert.equal(imageConversationHistoryGenerationsMatch("17", "17"), true);
  assert.equal(imageConversationHistoryGenerationsMatch("17", "18"), false);
  assert.equal(imageConversationHistoryGenerationsMatch("17", null), true);
});

test("history generation lower-bound checks reject late snapshots", () => {
  assert.equal(imageConversationHistoryGenerationAtLeast("1", "2"), false);
  assert.equal(imageConversationHistoryGenerationAtLeast("2", "1"), true);
  assert.equal(imageConversationHistoryGenerationAtLeast(null, "1"), false);
  assert.equal(imageConversationHistoryGenerationAtLeast("1", null), true);
  assert.equal(imageConversationHistoryGenerationAtLeast("opaque", "1"), false);
});

test("transient detail failures do not make the UI fall back to another conversation", () => {
  assert.equal(shouldFallbackToImageConversationHistoryDetail(404), true);
  assert.equal(shouldFallbackToImageConversationHistoryDetail(410), true);
  assert.equal(shouldFallbackToImageConversationHistoryDetail(408), false);
  assert.equal(shouldFallbackToImageConversationHistoryDetail(503), false);
});

test("history recovery reconciles locally failed media whose server task was still active", () => {
  assert.match(pageSource, /image\.status === "error" &&\s*image\.taskId &&\s*\(image\.taskStatus === "queued" \|\| image\.taskStatus === "running"\)/);
  assert.match(pageSource, /const persistedTasks = await Promise\.all\(taskList\.items\.map\(\(task\) => persistCreationTaskOutputs\(task, \{\s*assetContext: assetContextByTaskID\.get\(task\.id\)/);
});
