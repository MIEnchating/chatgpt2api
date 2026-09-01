import assert from "node:assert/strict";
import test from "node:test";

import { audioReferenceMetadataError } from "../src/lib/video-reference-validation.ts";

test("reference audio requires 2-15 seconds per file and 15 seconds in total", () => {
  assert.match(audioReferenceMetadataError({ durationMs: 1999, bytes: 1 }, 0), /2-15/);
  assert.match(audioReferenceMetadataError({ durationMs: 15001, bytes: 1 }, 0), /2-15/);
  assert.match(audioReferenceMetadataError({ durationMs: 6000, bytes: 1 }, 10000), /总时长/);
  assert.equal(audioReferenceMetadataError({ durationMs: 6000, bytes: 1 }, 9000), "");
});
