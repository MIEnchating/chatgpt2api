import assert from "node:assert/strict";
import test from "node:test";

import { formatCanvasVideoTime } from "../src/app/canvas/canvas-video-time.ts";

test("canvas video preview formats time like the reference player", () => {
  assert.equal(formatCanvasVideoTime(Number.NaN), "0:00");
  assert.equal(formatCanvasVideoTime(0), "0:00");
  assert.equal(formatCanvasVideoTime(65.9), "1:05");
  assert.equal(formatCanvasVideoTime(3_661), "1:01:01");
});
