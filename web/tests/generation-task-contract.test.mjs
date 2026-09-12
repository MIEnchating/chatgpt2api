import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableTaskPollError, normalizeGenerationProgress } from "../src/lib/generation-task-contract.ts";

test("retries transient task polling failures", () => {
  for (const status of [408, 425, 429, 500, 503, "503"]) {
    assert.equal(isRetryableTaskPollError({ status }), true, `status ${status}`);
  }
});

test("stops retrying definitive task polling failures", () => {
  for (const status of [400, 401, 404, 499]) {
    assert.equal(isRetryableTaskPollError({ status }), false, `status ${status}`);
  }
});

test("retries task polling failures without a usable status", () => {
  assert.equal(isRetryableTaskPollError(new Error("network unavailable")), true);
  assert.equal(isRetryableTaskPollError({ status: "unknown" }), true);
  assert.equal(isRetryableTaskPollError(null), true);
});


test("generation progress preserves zero and rejects missing or invalid values", () => {
  assert.equal(normalizeGenerationProgress(0), 0);
  assert.equal(normalizeGenerationProgress(9), 9);
  assert.equal(normalizeGenerationProgress(42.6), 43);
  assert.equal(normalizeGenerationProgress(-1), 0);
  assert.equal(normalizeGenerationProgress(150), 100);
  for (const value of [undefined, null, NaN, Infinity, "9%", "9"]) {
    assert.equal(normalizeGenerationProgress(value), undefined);
  }
});
