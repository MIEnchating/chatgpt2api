import assert from "node:assert/strict";
import test from "node:test";

import { audioReferenceMetadataError, videoReferenceMetadataError } from "../src/lib/video-reference-validation.ts";

test("reference audio requires 2-15 seconds per file and 15 seconds in total", () => {
  assert.match(audioReferenceMetadataError({ durationMs: 1999, bytes: 1 }, 0), /2-15/);
  assert.match(audioReferenceMetadataError({ durationMs: 15001, bytes: 1 }, 0), /2-15/);
  assert.match(audioReferenceMetadataError({ durationMs: 6000, bytes: 1 }, 10000), /总时长/);
  assert.equal(audioReferenceMetadataError({ durationMs: 6000, bytes: 1 }, 9000), "");
});

test("generic reference videos retain the reference project's metadata limits", () => {
  const valid = { durationMs: 6000, width: 1280, height: 720, bytes: 1 };
  assert.equal(videoReferenceMetadataError(valid, 9000), "");
  assert.match(videoReferenceMetadataError({ ...valid, durationMs: 16000 }, 0), /2-15/);
  assert.match(videoReferenceMetadataError(valid, 10000), /总时长/);
  assert.match(videoReferenceMetadataError({ ...valid, width: 200 }, 0), /300-6000/);
});
