import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  freezeWorkflowReferences,
  ownedWorkflowTaskReferences,
  settleWorkflowReferenceUploads,
  workflowReferenceCleanupKeys,
} from "../src/app/workflows/workflow-reference-lifecycle.ts";
import { prependWorkflowTask } from "../src/app/workflows/workflow-task-runtime.ts";

const workspaceSource = readFileSync(
  new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url),
  "utf8",
);

test("workflow reference cleanup removes only unowned temporary objects", () => {
  const discarded = [
    { url: "/files/a", storageKey: "server:a", temporary: true },
    { url: "/files/a-copy", storageKey: "server:a", temporary: true },
    { url: "/files/b", storageKey: "server:b", temporary: true },
    { url: "/files/c", storageKey: "server:c", temporary: true },
    { url: "/assets/library", storageKey: "server:library", temporary: false },
  ];
  const retained = [
    { url: "/task/reference", storageKey: "server:b", temporary: true },
    { url: "/files/c", temporary: true },
  ];

  assert.deepEqual(workflowReferenceCleanupKeys(discarded, retained), ["server:a"]);
});

test("workflow reference uploads settle every file and preserve successful results", async () => {
  let resolveLate;
  const late = new Promise((resolve) => { resolveLate = resolve; });
  const pending = settleWorkflowReferenceUploads([
    Promise.reject(new Error("first upload failed")),
    late,
  ]);
  let finished = false;
  void pending.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);

  resolveLate({ storageKey: "server:success" });
  const result = await pending;
  assert.deepEqual(result.uploaded, [{ storageKey: "server:success" }]);
  assert.equal(result.errors.length, 1);
  assert.match(String(result.errors[0]), /first upload failed/);
});

test("workflow series references stay frozen across later chunks", () => {
  const selected = [
    { url: "/files/series", storageKey: "server:series", temporary: true },
  ];
  const frozen = freezeWorkflowReferences(selected);

  selected[0].url = "/files/replaced";
  selected.splice(0, selected.length);
  const firstChunk = freezeWorkflowReferences(frozen);
  const laterChunk = freezeWorkflowReferences(frozen);

  assert.deepEqual(firstChunk, [
    { url: "/files/series", storageKey: "server:series", temporary: true },
  ]);
  assert.deepEqual(laterChunk, firstChunk);
  assert.notStrictEqual(frozen[0], firstChunk[0]);
  assert.notStrictEqual(firstChunk[0], laterChunk[0]);
});

test("workflow task references are owned only while submitting or after backend acceptance", () => {
  const local = {
    id: "local",
    references: [{ url: "/files/local", storageKey: "server:local", temporary: true }],
    backend_task_ids: [],
  };
  const accepted = {
    id: "accepted",
    references: [{ url: "/files/accepted", storageKey: "server:accepted", temporary: true }],
    backend_task_ids: ["backend-1"],
  };

  assert.deepEqual(
    ownedWorkflowTaskReferences([local, accepted], new Set(["local"])),
    [...local.references, ...accepted.references],
  );
  assert.deepEqual(
    ownedWorkflowTaskReferences([local, accepted], new Set()),
    accepted.references,
  );

  const retainedDuringUnknownPost = ownedWorkflowTaskReferences(
    [local],
    new Set(["local"]),
  );
  assert.deepEqual(
    workflowReferenceCleanupKeys(local.references, retainedDuringUnknownPost),
    [],
  );
});

test("workflow task ownership can be registered synchronously without duplicates", () => {
  const existing = { id: "existing" };
  const created = { id: "created" };

  const next = prependWorkflowTask([existing], created);
  assert.deepEqual(next.map((task) => task.id), ["created", "existing"]);
  assert.deepEqual(prependWorkflowTask(next, created).map((task) => task.id), ["created", "existing"]);
  assert.match(workspaceSource, /beginWorkflowTaskSubmission\(localTaskID\);\s*updateTasks\(\(current\) => prependWorkflowTask\(current, taskSnapshot\)\)/);
  assert.match(workspaceSource, /finally \{\s*finishWorkflowTaskSubmission\(localTaskID, taskReferences\)/);
  assert.match(workspaceSource, /backend_task_ids: Array\.from\(new Set\(\[\.\.\.task\.backend_task_ids, submitted\.id\]\)\)/);
  assert.match(workspaceSource, /const inFlightTaskCounts = inFlightTaskCountsRef\.current;[\s\S]*?const retained = ownedWorkflowTaskReferences\(\s*tasksRef\.current,\s*new Set\(inFlightTaskCounts\.keys\(\)\),\s*\)/);
  assert.match(workspaceSource, /const taskReferences = freezeWorkflowReferences\(\s*seriesRun\?\.references \|\| workflowReferencesRef\.current,\s*\)/);
  assert.match(workspaceSource, /const seriesRun: WorkflowSeriesRun = \{[\s\S]*?references: freezeWorkflowReferences\(workflowReferencesRef\.current\),[\s\S]*?\};\s*beginWorkflowTaskSubmission\(seriesRun\.id\);/);
  assert.match(workspaceSource, /finally \{\s*finishWorkflowTaskSubmission\(seriesRun\.id, seriesRun\.references\);\s*\}/);
  assert.match(workspaceSource, /workflowReferencesRef\.current = next;\s*setReferences\(next\)/);
  assert.match(workspaceSource, /agentReferencesRef\.current = next;\s*setAgentReferences\(next\)/);
  assert.doesNotMatch(workspaceSource, /workflowReferencesRef\.current = references/);
  assert.doesNotMatch(workspaceSource, /agentReferencesRef\.current = agentReferences/);
  assert.match(workspaceSource, /const discarded = workflowReferencesRef\.current;\s*updateWorkflowReferences\(\(\) => \[\]\);\s*cleanupDiscardedWorkflowReferences\(discarded\)/);
  assert.match(workspaceSource, /item\.id === id \? \{ \.\.\.item, references: \[\] \} : item[\s\S]*cleanupDiscardedWorkflowReferences\(taskReferences\)/);
  assert.match(workspaceSource, /const referenceKeys = workflowReferenceCleanupKeys\([\s\S]*removableTasks\.flatMap\([\s\S]*workflowReferencesRef\.current,[\s\S]*agentReferencesRef\.current/);
  assert.match(workspaceSource, /await deleteStoredImages\(referenceKeys\)/);
});
