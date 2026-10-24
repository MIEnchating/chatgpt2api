import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8");

test("workflow task streaming has one owner and stops with the workspace", () => {
  assert.match(source, /waitForCreationTask\(id, \{ signal, timeoutMs:/);
  assert.match(source, /watchCreationTasks\(/);
  assert.match(source, /filter\(\(id\) => !directTaskPollIDSet\.has\(id\)\)/);
  assert.match(source, /return waitForOwnedTask\(submitted\.id, runtime\.timeout\)/);
  assert.match(source, /workflowImageFiles\(taskReferences, taskController\.signal\)/);
  assert.match(source, /requestOptions: \{ signal: taskController\.signal \}/);
  assert.match(source, /return \(\) => \{ controller\.abort\(\); unsubscribe\(\); clearTimeout\(recoveryTimer\); \}/);
  assert.doesNotMatch(source, /setInterval\(\(\) => void poll\(\), 1200\)/);
});
