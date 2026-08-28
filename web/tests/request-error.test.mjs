import assert from "node:assert/strict";
import test from "node:test";

import { extractRequestErrorMessage } from "../src/lib/request-error.ts";

test("unwraps provider validation detail nested inside a message string", () => {
  const message = JSON.stringify({
    detail: "3 validation errors for MiniMaxH3Request\nratio\nInput should be 'auto'",
  });
  assert.equal(
    extractRequestErrorMessage(message),
    "3 validation errors for MiniMaxH3Request\nratio\nInput should be 'auto'",
  );
});

test("extracts errors from object and list response shapes", () => {
  assert.equal(extractRequestErrorMessage({ error: { message: "provider unavailable" } }), "provider unavailable");
  assert.equal(extractRequestErrorMessage({ detail: [{ message: "field is required" }] }), "field is required");
  assert.equal(extractRequestErrorMessage("plain upstream error"), "plain upstream error");
});
