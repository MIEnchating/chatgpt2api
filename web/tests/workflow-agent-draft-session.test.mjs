import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runCurrentWorkflowAgentDraft } from "../src/app/workflows/workflow-agent-draft-lifecycle.ts";

const workspaceSource = readFileSync(
  new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url),
  "utf8",
);
const workflowAPISource = readFileSync(
  new URL("../src/services/api/workflows.ts", import.meta.url),
  "utf8",
);
const imageStorageSource = readFileSync(
  new URL("../src/services/image-storage.ts", import.meta.url),
  "utf8",
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function runScope(controller, sessionState, requestSessionKey) {
  return () => (
    sessionState.active
    && sessionState.key === requestSessionKey
    && !controller.signal.aborted
  );
}

test("a reference finishing after session A changes to B cannot start the Agent POST", async () => {
  const referenceRead = deferred();
  const controller = new AbortController();
  const sessionState = { active: true, key: "session-a" };
  const postCalls = [];
  const commits = [];
  const feedback = [];

  const pending = runCurrentWorkflowAgentDraft({
    signal: controller.signal,
    isCurrent: runScope(controller, sessionState, "session-a"),
    prepareReferences: () => referenceRead.promise,
    submit: async (references) => {
      postCalls.push(references);
      return { draft: {} };
    },
    commit: (response) => {
      commits.push(response);
      feedback.push("Agent draft created");
    },
  });

  sessionState.key = "session-b";
  controller.abort();
  referenceRead.resolve(["data:image/png;base64,old-session"]);

  assert.equal(await pending, false);
  assert.deepEqual(postCalls, []);
  assert.deepEqual(commits, []);
  assert.deepEqual(feedback, []);
});

test("an Agent POST resolving after session A changes to B cannot commit state or toast", async () => {
  const postResponse = deferred();
  const postStarted = deferred();
  const controller = new AbortController();
  const sessionState = { active: true, key: "session-a" };
  const commits = [];
  const feedback = [];

  const pending = runCurrentWorkflowAgentDraft({
    signal: controller.signal,
    isCurrent: runScope(controller, sessionState, "session-a"),
    prepareReferences: async () => [],
    submit: (_references, signal) => {
      assert.equal(signal, controller.signal);
      postStarted.resolve();
      return postResponse.promise;
    },
    commit: (response) => {
      commits.push(response);
      feedback.push("Agent draft created");
    },
  });

  await postStarted.promise;
  sessionState.key = "session-b";
  controller.abort();
  postResponse.resolve({ draft: { name: "stale account A draft" } });

  assert.equal(await pending, false);
  assert.deepEqual(commits, []);
  assert.deepEqual(feedback, []);
});

test("the workflow Agent path captures the credential scope and carries one signal end to end", () => {
  assert.match(workspaceSource, /const requestSessionKey = session\.key/);
  assert.match(
    workspaceSource,
    /workspaceActiveRef\.current[\s\S]*currentSessionKeyRef\.current === requestSessionKey[\s\S]*getCachedAuthSession\(\)\?\.key === requestSessionKey/,
  );
  assert.match(workspaceSource, /workflowImageDataURLs\(agentReferences, signal\)/);
  assert.match(workspaceSource, /draftWorkflowWithAgent\([\s\S]*\}, \{ signal \}\)/);
  assert.match(workspaceSource, /agentDraftAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(workspaceSource, /\}, \[sessionKey\]\)/);
  assert.match(workflowAPISource, /signal: options\.signal/);
  assert.match(imageStorageSource, /imageToDataURL\([\s\S]*signal: AbortSignal[\s\S]*fetch\(source, \{ credentials: "include", signal \}\)/);
});
