import assert from "node:assert/strict";
import test from "node:test";

import { canAccessPath, getDefaultRouteForSession } from "../src/lib/auth-session.ts";

function session(menuPaths) {
  return {
    key: "test",
    role: "user",
    subjectId: "user:test",
    name: "Test",
    creationConcurrentLimit: 1,
    creationRpmLimit: 1,
    menuPaths,
    apiPermissions: [],
    menus: [],
  };
}

test("new creative library menu paths are independently accessible", () => {
  assert.equal(canAccessPath(session(["/assets"]), "/assets"), true);
  assert.equal(canAccessPath(session(["/prompt-library"]), "/prompt-library"), true);
  assert.equal(canAccessPath(session(["/prompt-library"]), "/assets"), false);
});

test("unknown menu paths do not grant access to current libraries", () => {
  const unknown = session(["/unknown"]);
  assert.equal(canAccessPath(unknown, "/assets"), false);
  assert.equal(canAccessPath(unknown, "/prompt-library"), false);
  assert.equal(getDefaultRouteForSession(unknown), "/profile");
});

test("studio is the default creation route and accepts legacy image permissions", () => {
  const legacy = session(["/image"]);
  assert.equal(canAccessPath(legacy, "/studio"), true);
  assert.equal(canAccessPath(session(["/studio"]), "/image"), true);
  assert.equal(getDefaultRouteForSession(legacy), "/studio");
  assert.equal(getDefaultRouteForSession({ ...legacy, role: "admin" }), "/studio");
});
