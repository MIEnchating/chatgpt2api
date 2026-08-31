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
