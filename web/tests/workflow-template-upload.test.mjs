import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { settleWorkflowReferenceUploads, workflowReferenceCleanupKeys } from "../src/app/workflows/workflow-reference-lifecycle.ts";

const source = ts.createSourceFile("workspace.tsx", readFileSync(new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function workspaceFunction(name, context) {
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, `Missing function: ${name}`);
  const compiled = ts.transpile(declaration, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${compiled}\nreturn ${name};`)(...Object.values(context));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function uploadContext() {
  let editing = { id: "workflow-a", scope: "private", template_references: [], series_config: {} };
  let sessionKey = "session-a";
  const uploaded = { url: "/api/files/template/content", storageKey: "server:template" };
  const deleted = [];
  const registrations = [];
  const messages = [];
  const controller = new AbortController();
  const context = {
    editing, sessionKey,
    getCachedAuthSession: () => ({ key: sessionKey }),
    workspaceActiveRef: { current: true },
    taskWaitAbortControllerRef: { current: controller },
    workflowReferenceUploadGenerationRef: { current: 0 },
    workflowEditorGenerationRef: { current: 0 },
    referenceUploadCountRef: { current: 0 },
    setReferenceBusy: () => {},
    setEditing: (update) => { editing = typeof update === "function" ? update(editing) : update; },
    uploadImage: async () => uploaded,
    createMyAsset: (value) => value,
    upsertAsset: async (value) => { registrations.push(value); return value; },
    deleteStoredImages: async (keys) => { deleted.push(...keys); },
    taskID: (prefix) => prefix,
    toast: { error: (message) => messages.push(message) },
    settleWorkflowReferenceUploads, workflowReferenceCleanupKeys,
  };
  return {
    context, controller, uploaded, deleted, registrations, messages,
    get editing() { return editing; },
    replaceEditor(id) {
      context.workflowEditorGenerationRef.current++;
      editing = { ...editing, id, template_references: [] };
    },
    changeSession() { sessionKey = "session-b"; controller.abort(); },
  };
}

const files = [{ name: "template.png", type: "image/png" }];

for (const nextID of ["workflow-b", "workflow-a"]) {
  test(`template uploads cannot attach to a reopened editor (${nextID})`, async () => {
    const state = uploadContext();
    const upload = deferred();
    state.context.uploadImage = () => upload.promise;
    const pending = workspaceFunction("addReferences", state.context)(files, "template");
    state.replaceEditor(nextID);
    upload.resolve(state.uploaded);
    await pending;
    assert.deepEqual(state.editing.template_references, []);
    assert.deepEqual(state.registrations, []);
    assert.deepEqual(state.deleted, ["server:template"]);
  });
}

test("registered templates remain in the library when the editor changes during registration", async () => {
  const state = uploadContext();
  const registration = deferred();
  state.context.upsertAsset = () => registration.promise;
  const pending = workspaceFunction("addReferences", state.context)(files, "template");
  await Promise.resolve();
  state.replaceEditor("workflow-b");
  registration.resolve({ ...state.uploaded, title: "template", visibility: "private" });
  await pending;
  assert.deepEqual(state.editing.template_references, []);
  assert.deepEqual(state.deleted, []);
});

test("failed template registration cannot delete files using a replacement session", async () => {
  const state = uploadContext();
  const registration = deferred();
  state.context.upsertAsset = () => registration.promise;
  const pending = workspaceFunction("addReferences", state.context)(files, "template");
  await Promise.resolve();
  state.changeSession();
  registration.reject(new DOMException("Session changed", "AbortError"));
  await pending;
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.messages, []);
});

test("current editor receives successfully uploaded templates", async () => {
  const state = uploadContext();
  await workspaceFunction("addReferences", state.context)(files, "template");
  assert.equal(state.editing.template_references.length, 1);
  assert.equal(state.editing.template_references[0].storageKey, "server:template");
  assert.deepEqual(state.deleted, []);
});

test("workflow cannot save before its template upload has finished", async () => {
  let saves = 0;
  const context = {
    referenceUploadCountRef: { current: 1 },
    isCurrentWorkspace: () => true,
    workflowSaveBusyRef: { current: false },
    workspaceActiveRef: { current: true },
    setWorkflowSaving: () => {},
    agentDraft: null,
    models: null,
    preferences: {},
    normalizeWorkflow: (value) => value,
    saveWorkflow: async (value) => { saves++; return value; },
    setItems: () => {},
    replaceEditor: () => {},
    toast: { error: () => {}, success: () => {} },
  };
  await workspaceFunction("persist", context)({
    name: "Template workflow", config: { prompt_template: "Draw" }, scope: "private", template_references: [],
  });
  assert.equal(saves, 0);
});
