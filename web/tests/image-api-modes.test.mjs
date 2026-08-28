import assert from "node:assert/strict";
import test from "node:test";

import {
  composeImageGenerationPrompt,
  imageWorkbenchTaskDispatches,
  normalizedImagePartialImages,
  normalizedImageWorkbenchCount,
} from "../src/lib/image-api-contract.ts";

test("image prompt composition follows the reference system and Codex order", () => {
  assert.equal(
    composeImageGenerationPrompt("draw", "visual system", true),
    "Use the following text as the complete prompt. Do not rewrite it:\nvisual system\n\ndraw",
  );
  assert.equal(composeImageGenerationPrompt("draw", " visual system ", false), "visual system\n\ndraw");
  assert.equal(composeImageGenerationPrompt("draw", "", false), "draw");
});

test("image partial image normalization preserves the reference 0-3 contract", () => {
  assert.equal(normalizedImagePartialImages(0), 0);
  assert.equal(normalizedImagePartialImages(1), 1);
  assert.equal(normalizedImagePartialImages(3), 3);
  assert.equal(normalizedImagePartialImages(2.9), 2);
  assert.equal(normalizedImagePartialImages(-1), 1);
  assert.equal(normalizedImagePartialImages(4), 3);
  assert.equal(normalizedImagePartialImages(Number.NaN), 1);
  assert.equal(normalizedImagePartialImages(undefined), 1);
});

test("image workbench creates one independent count=1 task per requested image", () => {
  assert.equal(normalizedImageWorkbenchCount(0), 1);
  assert.equal(normalizedImageWorkbenchCount(2.9), 2);
  assert.equal(normalizedImageWorkbenchCount(10), 10);
  assert.equal(normalizedImageWorkbenchCount(11), 10);
  assert.deepEqual(
    imageWorkbenchTaskDispatches(["task-0", "task-1", "task-2"]),
    [
      { taskId: "task-0", count: 1 },
      { taskId: "task-1", count: 1 },
      { taskId: "task-2", count: 1 },
    ],
  );
});
