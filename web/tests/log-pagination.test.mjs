import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  logCursorForPage,
  recordLogPageCursor,
  resetLogCursorStack,
} from "../src/app/logs/log-pagination.ts";

const logsSource = readFileSync(
  new URL("../src/app/logs/page.tsx", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);

test("log cursor stack records next pages and truncates stale branches", () => {
  let cursors = resetLogCursorStack();
  assert.deepEqual(cursors, [""]);
  assert.equal(logCursorForPage(cursors, 1), "");
  assert.equal(logCursorForPage(cursors, 2), null);

  cursors = recordLogPageCursor(cursors, 1, "snapshot-1", "cursor-2", true);
  cursors = recordLogPageCursor(cursors, 2, "snapshot-1", "cursor-3", true);
  assert.deepEqual(cursors, ["snapshot-1", "cursor-2", "cursor-3"]);
  assert.equal(logCursorForPage(cursors, 3), "cursor-3");

  cursors = recordLogPageCursor(cursors, 1, "snapshot-2", "fresh-cursor-2", true);
  assert.deepEqual(cursors, ["snapshot-2", "fresh-cursor-2"]);
  cursors = recordLogPageCursor(cursors, 2, "snapshot-2", "", false);
  assert.deepEqual(cursors, ["snapshot-2", "fresh-cursor-2"]);
});

test("logs request real server pages and reset cursor state at query boundaries", () => {
  assert.match(logsSource, /logCursorStackRef = useRef<string\[\]>\(resetLogCursorStack\(\)\)/);
  assert.match(logsSource, /loadFirstLogPage\(query, pageSize\)/);
  assert.match(logsSource, /if \(options\.reset\) \{[\s\S]{0,220}logCursorStackRef\.current = resetLogCursorStack\(\)[\s\S]{0,220}setItems\(\[\]\)[\s\S]{0,220}setHasMore\(false\)/);
  assert.match(logsSource, /pageSize: options\.pageSize/);
  assert.match(logsSource, /currentRows = items;/);
  assert.doesNotMatch(logsSource, /items\.slice\(/);
  assert.match(logsSource, /本页错误/);
  assert.match(apiSource, /params\.set\("page_size", String\(options\.pageSize\)\)/);
  assert.match(apiSource, /params\.set\("cursor", options\.cursor\.trim\(\)\)/);
  assert.match(apiSource, /has_more: data\.has_more === true && nextCursor !== ""/);
  assert.match(apiSource, /snapshot_cursor: snapshotCursor/);
});
