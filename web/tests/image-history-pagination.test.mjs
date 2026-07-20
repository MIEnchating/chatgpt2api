import test from "node:test";
import assert from "node:assert/strict";

import {
  buildImageConversationHistoryMergeBody,
  imageConversationHistoryGenerationAtLeast,
  imageConversationHistoryGenerationsMatch,
  imageConversationHistoryGenerationChanged,
  normalizeImageConversationHistoryGeneration,
  shouldFallbackToImageConversationHistoryDetail,
  shouldResetImageConversationHistoryCursor,
} from "../src/app/image/image-history-pagination.ts";

test("generation is sent in the merge body only after the server provides one", () => {
  const items = [{ id: "conversation-1" }];
  assert.deepEqual(buildImageConversationHistoryMergeBody(items), { items });
  assert.deepEqual(buildImageConversationHistoryMergeBody(items, null), { items });
  assert.deepEqual(buildImageConversationHistoryMergeBody(items, 12), {
    items,
    generation: 12,
  });
  assert.deepEqual(buildImageConversationHistoryMergeBody(items, " 13 "), {
    items,
    generation: " 13 ",
  });
});

test("history generations normalize and detect a cursor reset", () => {
  assert.equal(normalizeImageConversationHistoryGeneration(undefined), null);
  assert.equal(normalizeImageConversationHistoryGeneration(" 17 "), "17");
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

test("history generation lower-bound checks reject late or unknown snapshots", () => {
  assert.equal(imageConversationHistoryGenerationAtLeast("1", "2"), false);
  assert.equal(imageConversationHistoryGenerationAtLeast("2", "1"), true);
  assert.equal(imageConversationHistoryGenerationAtLeast(null, "1"), false);
  assert.equal(imageConversationHistoryGenerationAtLeast("1", null), true);
  assert.equal(imageConversationHistoryGenerationAtLeast("legacy-a", "legacy-a"), true);
  assert.equal(imageConversationHistoryGenerationAtLeast("legacy-b", "legacy-a"), false);
  assert.equal(imageConversationHistoryGenerationAtLeast("2", "legacy-a"), false);
});

test("transient detail failures do not make the UI fall back to another conversation", () => {
  assert.equal(shouldFallbackToImageConversationHistoryDetail(404), true);
  assert.equal(shouldFallbackToImageConversationHistoryDetail(410), true);
  assert.equal(shouldFallbackToImageConversationHistoryDetail(408), false);
  assert.equal(shouldFallbackToImageConversationHistoryDetail(503), false);
});
