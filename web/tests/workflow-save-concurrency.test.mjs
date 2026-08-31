import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspaceSource = readFileSync(
  new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(
  new URL("../src/services/api/workflows.ts", import.meta.url),
  "utf8",
);

test("workflow completion uses the dedicated last-run resource", () => {
  assert.match(
    apiSource,
    /`\/api\/workflows\/\$\{encodeURIComponent\(id\)\}\/last-run`[\s\S]*method: "PUT"[\s\S]*last_run_at: lastRunAt/,
  );
  assert.match(workspaceSource, /touchWorkflowLastRun\(workflow\.id, timestamp\)/);
  assert.doesNotMatch(workspaceSource, /saveWorkflow\((?:completed|updated)\)/);
});

test("workflow completion merges metadata into current state instead of a task snapshot", () => {
  assert.match(
    workspaceSource,
    /item\.id === workflow\.id \? mergeWorkflowRunMetadata\(item, metadata\) : item/,
  );
  assert.doesNotMatch(workspaceSource, /const completed = \{ \.\.\.workflow, last_run_at:/);
});
