import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Normalize CRLF so the assertions behave the same on Windows checkouts.
const source = readFileSync(new URL("../src/components/channel-parameter-editor.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const helper = readFileSync(new URL("../src/lib/clipboard-text.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("copy instructions go through the shared clipboard helper", () => {
  // The helper wraps the async clipboard call, so a missing clipboard API surfaces as the failure toast.
  assert.match(source, /copyWithToast\(/);
  assert.match(source, /"已复制说明"/);
  assert.doesNotMatch(source, /navigator\.clipboard/);
});

test("shared clipboard helper reports failures through the failure toast", () => {
  assert.match(helper, /export async function copyClipboardText/);
  assert.match(helper, /toast\.error\(error\.message\)/);
});
