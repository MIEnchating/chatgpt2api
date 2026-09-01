import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/app/image/page.tsx", import.meta.url), "utf8");

test("history deletion failures share a guarded authoritative reload", () => {
  const calls = source.match(/await restoreConversationHistoryWindow\(\)/g) || [];
  assert.equal(calls.length, 2);
  assert.match(source, /const restoreConversationHistoryWindow = async \(\) => \{/);
  assert.match(source, /catch \{\s*conversationRefreshNeededRef\.current = true;\s*\}/);
});

test("task result synchronization observes storage keys without duplicate missing-output branches", () => {
  const storedImageFields = source.match(/const STORED_IMAGE_FIELDS:[\s\S]*?= \[([\s\S]*?)\];/)?.[1] || "";
  assert.match(storedImageFields, /"storageKey"/);

  const missingOutputBranches = source.match(/error: `未返回第 \$\{dataIndex \+ 1\} 张图片数据`/g) || [];
  assert.equal(missingOutputBranches.length, 1);
});
