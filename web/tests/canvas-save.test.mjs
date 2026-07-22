import assert from "node:assert/strict";
import test from "node:test";

import { canvasSaveRequired, flushCanvasSaves } from "../src/app/canvas/canvas-save.ts";

test("skips a full save when the server already has the latest change", () => {
  assert.equal(canvasSaveRequired(4, 4), false);
  assert.equal(canvasSaveRequired(4, 5), true);
});

test("flushes again when an edit happens during a save", async () => {
  let version = 1;
  let saves = 0;
  const result = await flushCanvasSaves({
    getProjectID: () => "project-1",
    getChangeVersion: () => version,
    save: async () => {
      saves += 1;
      if (saves === 1) version = 2;
      return true;
    },
  });

  assert.equal(result, true);
  assert.equal(saves, 2);
});

test("stops when the active project changes while saving", async () => {
  let projectID = "project-1";
  let saves = 0;
  const result = await flushCanvasSaves({
    getProjectID: () => projectID,
    getChangeVersion: () => 1,
    save: async () => {
      saves += 1;
      projectID = "project-2";
      return true;
    },
  });

  assert.equal(result, false);
  assert.equal(saves, 1);
});

test("does not continue after a failed save", async () => {
  let saves = 0;
  const result = await flushCanvasSaves({
    getProjectID: () => "project-1",
    getChangeVersion: () => 1,
    save: async () => {
      saves += 1;
      return false;
    },
  });

  assert.equal(result, false);
  assert.equal(saves, 1);
});
