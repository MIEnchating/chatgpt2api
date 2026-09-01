import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8");

test("all completed canvas generation paths share cancellation-marker cleanup", () => {
  assert.match(
    source,
    /function completeActiveGeneration\(generation: CanvasActiveGeneration\) \{\s*generation\.taskIDs\.forEach\(\(taskID\) => cancelledTaskIDsRef\.current\.delete\(taskID\)\);\s*releaseActiveGeneration\(generation\);\s*\}/,
  );
  assert.equal((source.match(/completeActiveGeneration\(activeGeneration\);/g) || []).length, 5);
  assert.equal((source.match(/activeGeneration\.taskIDs\.forEach/g) || []).length, 0);
});
