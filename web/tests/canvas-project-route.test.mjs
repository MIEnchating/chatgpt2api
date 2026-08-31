import assert from "node:assert/strict";
import test from "node:test";

import { canvasProjectIDFromRoute, canvasProjectPath } from "../src/lib/canvas-project-route.ts";

test("canvas project URLs omit the storage ID prefix", () => {
  assert.equal(canvasProjectPath("canvas-0626bfdc6e10c39c5bbbefba"), "/canvas/0626bfdc6e10c39c5bbbefba");
});

test("canvas routes restore the storage ID prefix", () => {
  assert.equal(canvasProjectIDFromRoute("0626bfdc6e10c39c5bbbefba"), "canvas-0626bfdc6e10c39c5bbbefba");
  assert.equal(canvasProjectIDFromRoute(), undefined);
});

test("canvas project URLs reject IDs outside the current format", () => {
  assert.throws(() => canvasProjectPath("0626bfdc6e10c39c5bbbefba"), /格式无效/);
});
