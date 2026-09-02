import assert from "node:assert/strict";
import test from "node:test";

import { rejectRequestError } from "../src/lib/request-response-error.ts";

function unauthorizedError(redirectOnUnauthorized = true) {
  return {
    config: { redirectOnUnauthorized },
    message: "Request failed with status code 401",
    response: {
      status: 401,
      data: { error: { message: "登录状态已失效", code: "unauthorized", type: "authentication_error" } },
    },
  };
}

test("unauthorized redirects reject so caller cleanup can settle", async () => {
  const calls = [];
  let finallyCalled = false;
  const pending = rejectRequestError(unauthorizedError(), {
    pathname: "/assets",
    clearImageCache: () => calls.push("clear"),
    replace: (path) => calls.push(`replace:${path}`),
  }).finally(() => {
    finallyCalled = true;
  });

  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "登录状态已失效");
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthorized");
    assert.equal(error.errorType, "authentication_error");
    return true;
  });
  assert.equal(finallyCalled, true);
  assert.deepEqual(calls, ["clear", "replace:/login"]);
});

test("unauthorized requests with redirects disabled still reject without navigating", async () => {
  const calls = [];
  await assert.rejects(rejectRequestError(unauthorizedError(false), {
    pathname: "/assets",
    clearImageCache: () => calls.push("clear"),
    replace: (path) => calls.push(`replace:${path}`),
  }), (error) => error.status === 401);
  assert.deepEqual(calls, []);
});
