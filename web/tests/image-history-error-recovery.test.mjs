import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { taskDataToStoredImage } from "../src/app/image/studio-task-results.ts";

const source = readFileSync(new URL("../src/app/image/page.tsx", import.meta.url), "utf8");

test("history deletion failures share a guarded authoritative reload", () => {
  const calls = source.match(/await restoreConversationHistoryWindow\(\)/g) || [];
  assert.equal(calls.length, 2);
  assert.match(source, /const restoreConversationHistoryWindow = async \(\) => \{/);
  assert.match(source, /catch \{\s*conversationRefreshNeededRef\.current = true;\s*\}/);
});

test("task result synchronization observes storage keys without duplicate missing-output branches", () => {
  const outputs = readFileSync(new URL("../src/app/image/studio-task-results.ts", import.meta.url), "utf8");
  const image = { id: "slot", taskId: "task", status: "loading" };
  const task = { id: "task", status: "success", data: [{ url: "/result.png" }] };
  const saved = taskDataToStoredImage(image, task);
  assert.equal(saved.status, "success");
  const updated = taskDataToStoredImage(saved, { ...task, data: [{ ...task.data[0], storageKey: "generated/result.png" }] });
  assert.equal(updated.storageKey, "generated/result.png");
  assert.equal(updated.url, saved.url);

  const missingOutputBranches = outputs.match(/error: `未返回第 \$\{dataIndex \+ 1\} 张图片数据`/g) || [];
  assert.equal(missingOutputBranches.length, 1);
});
