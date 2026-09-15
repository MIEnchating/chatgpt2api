import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createSettingsStore } from "../src/app/settings/store.ts";
import { ALL_MUTATIONS_SCOPE, ScopedMutationLifecycle } from "../src/lib/scoped-mutation-lifecycle.ts";
import { settleAssetOperations } from "../src/app/assets/asset-library.ts";

// Execute actual handlers with controlled state and asynchronous I/O boundaries.
function handler(file, name, context) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Missing handler ${name}`);
  const compiled = ts.transpile(`const handler = ${expression.getText(source)};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${compiled}\nreturn handler;`)(...Object.values(context));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test("asset batches bound concurrency and preserve outcomes in input order", async () => {
  let active = 0, peak = 0;
  const items = Array.from({ length: 21 }, (_, index) => index);
  const results = await settleAssetOperations(items, async (item) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (item === 7) throw new Error("failed item");
    return item;
  }, new AbortController().signal);
  assert.equal(peak, 4);
  assert.equal(results[7].status, "rejected");
  assert.deepEqual(results.filter((result) => result.status === "fulfilled").map((result) => result.value), items.filter((item) => item !== 7));
});

test("asset visibility changes stop before the next account write after invalidation", async () => {
  const controller = new AbortController();
  const request = deferred();
  let writes = 0, feedback = 0;
  const pending = handler("assets/page.tsx", "updateSelectedVisibility", {
    bulkActionBusy: false, mutationControllerRef: { current: controller },
    visibilityManageableAssets: [{ managedPath: "managed", visibility: "private" }, { id: "custom", visibility: "private" }],
    settleAssetOperations, updateManagedImageVisibility: () => request.promise,
    upsertAsset: async () => { writes++; }, setBulkActionBusy: () => {},
    setManagedAssets: () => { feedback++; },
    toast: { success: () => { feedback++; }, error: () => { feedback++; } },
  })("public");
  controller.abort();
  request.resolve({});
  await pending;
  assert.equal(writes, 0);
  assert.equal(feedback, 0);
});

test("profile save responses preserve edits made during persistence", async () => {
  const preferences = { stream: false };
  let current = preferences;
  const request = deferred();
  const published = [];
  const pending = handler("profile/page.tsx", "save", {
    preferences, sessionKey: "session-a", saveVersionRef: { current: 0 }, currentSessionKeyRef: { current: "session-a" },
    setIsSaving: () => {}, setMessage: () => {}, relayTokenNames: {}, relayTokenPreferencesFromNames: () => ({}),
    selectedAudioVoice: "alloy", selectedAudioFormat: "mp3", selectedAudioSpeed: 1,
    updateImageGenerationPreferences: () => request.promise,
    setPreferences: (value) => { current = typeof value === "function" ? value(current) : value; },
    dispatchImageGenerationPreferencesChanged: (_key, value) => published.push(value),
  })();
  current = { stream: true };
  request.resolve({ preferences: { stream: false } });
  await pending;
  assert.equal(current.stream, true);
  assert.deepEqual(published, [{ stream: false }]);
});

test("personal storage saves preserve drafts for each provider independently", async () => {
  const s3 = { name: "old s3" }, webdav = { name: "old dav" };
  let currentS3 = s3, currentWebdav = webdav;
  const request = deferred();
  const pending = handler("profile/storage-provider-card.tsx", "save", {
    s3, webdav, setSaving: () => {}, updateUserStorageProviders: () => request.promise,
    defaultUserStorageProvider: () => ({}), defaultUserWebDAVStorageProvider: () => ({}),
    setS3: (value) => { currentS3 = typeof value === "function" ? value(currentS3) : value; },
    setWebDAV: (value) => { currentWebdav = typeof value === "function" ? value(currentWebdav) : value; },
    toast: { success: () => {}, error: (message) => { throw new Error(message); } },
  })();
  currentS3 = { name: "new draft" };
  request.resolve({ s3: { name: "saved s3" }, webdav: { name: "saved dav" } });
  await pending;
  assert.equal(currentS3.name, "new draft");
  assert.equal(currentWebdav.name, "saved dav");
});

test("custom relay deletion cannot update the next account token selection", async () => {
  const request = deferred();
  let active = true, callbacks = 0;
  const pending = handler("profile/page.tsx", "remove", {
    isSaving: false, isCurrentSession: () => active, confirmDelete: true, status: { id: "old-account-key" },
    setIsSaving: () => {}, deleteCustomRelayConfig: () => request.promise,
    onDeleted: () => { callbacks++; }, onOpenChange: () => { callbacks++; }, title: "text",
    toast: { success: () => { callbacks++; }, error: () => { callbacks++; } },
  })();
  active = false;
  request.resolve();
  await pending;
  assert.equal(callbacks, 0);
});

test("workflow history cleanup stops account writes after either asynchronous deletion stage", async () => {
  for (const stage of ["tasks", "references"]) {
    const request = deferred();
    let active = true, referenceDeletes = 0, assetDeletes = 0, feedback = 0;
    const completedTask = { id: "local", status: "success", backend_task_ids: ["remote"], references: [{ storageKey: "ref" }], images: [{ url: "/images/result.png" }] };
    const pending = handler("workflows/creative-workflow-workspace.tsx", "clearCompletedTaskHistory", {
      clearingTaskHistory: false, isCurrentWorkspace: () => active, tasks: [completedTask],
      taskWaitAbortControllerRef: { current: new AbortController() },
      deleteCreationTasks: () => stage === "tasks" ? request.promise : Promise.resolve({ active_ids: [] }),
      tasksRef: { current: [completedTask] }, updateTasks: () => {}, selectedTaskID: "", setSelectedTaskID: () => {},
      workflowReferenceCleanupKeys: () => ["ref"], ownedWorkflowTaskReferences: () => [],
      inFlightTaskCountsRef: { current: new Map() }, workflowReferencesRef: { current: [] }, agentReferencesRef: { current: [] },
      deleteStoredImages: () => { referenceDeletes++; return stage === "references" ? request.promise : Promise.resolve(); },
      session: {}, hasAPIPermission: () => true, getManagedImagePathFromUrl: (url) => url,
      deleteManagedImages: async () => { assetDeletes++; return { deleted: 1 }; },
      setClearingTaskHistory: () => {},
      toast: { success: () => { feedback++; }, error: () => { feedback++; } },
    })(true);
    await Promise.resolve();
    active = false;
    request.resolve({ active_ids: [] });
    assert.equal(await pending, false);
    assert.equal(referenceDeletes, stage === "references" ? 1 : 0);
    assert.equal(assetDeletes, 0);
    assert.equal(feedback, 0);
  }
});

test("workflow save completion cannot clean references from the next account", async () => {
  const request = deferred();
  let active = true, callbacks = 0;
  const workflow = { id: "draft", name: "Test", scope: "private", config: { prompt_template: "prompt" } };
  const pending = handler("workflows/creative-workflow-workspace.tsx", "persist", {
    isCurrentWorkspace: () => active, referenceUploadCountRef: { current: 0 }, workflowSaveBusyRef: { current: false },
    workspaceActiveRef: { current: true }, setWorkflowSaving: () => {}, agentDraft: workflow,
    normalizeWorkflow: (value) => value, models: {}, preferences: {}, saveWorkflow: () => request.promise,
    setItems: () => { callbacks++; }, replaceEditor: () => { callbacks++; },
    cleanupAgentReferences: () => { callbacks++; }, setAgentDraft: () => {}, setAgentWarnings: () => {},
    toast: { success: () => { callbacks++; }, error: () => { callbacks++; } },
  })(workflow);
  active = false;
  request.resolve(workflow);
  await pending;
  assert.equal(callbacks, 0);
});

function assetContext(onSave) {
  const messages = [];
  return {
    messages,
    context: {
      title: "updated", content: "new text", coverUrl: "", source: "", note: "",
      kind: "text", visibility: "private", mediaMetadata: {}, mediaStorageKey: "",
      asset: { id: "one", kind: "image", url: "/old.png", coverUrl: "/cover.png", source: "old", note: "old", storageKey: "old-storage", width: 100, height: 200, bytes: 999, mimeType: "image/png", durationMs: 4000 },
      onSave, isBlobURL: () => false, formControllerRef: { current: new AbortController() }, savePendingRef: { current: false }, setIsSaving: () => {},
      toast: { success: (message) => messages.push(["success", message]), error: (message) => messages.push(["error", message]) },
    },
  };
}

test("asset edits clear removed optional fields and obsolete media metadata", async () => {
  let saved;
  const fixture = assetContext(async (value) => { saved = value; });
  await handler("assets/asset-form.tsx", "submit", fixture.context)();
  for (const field of ["coverUrl", "source", "note", "url", "storageKey", "width", "height", "bytes", "mimeType", "durationMs"]) {
    assert.equal(saved[field], undefined, field);
  }
  assert.equal(saved.content, "new text");
});

test("asset save success waits for persistence and duplicate submissions are suppressed", async () => {
  const request = deferred();
  let saves = 0;
  const fixture = assetContext(() => { saves++; return request.promise; });
  const submit = handler("assets/asset-form.tsx", "submit", fixture.context);
  const pending = submit();
  assert.equal(fixture.messages.length, 0);
  await submit();
  assert.equal(saves, 1);
  request.resolve();
  await pending;
  assert.equal(fixture.messages.filter(([kind]) => kind === "success").length, 1);
});

test("failed asset persistence does not show success", async () => {
  const fixture = assetContext(() => Promise.reject(new Error("save failed")));
  await handler("assets/asset-form.tsx", "submit", fixture.context)();
  assert.deepEqual(fixture.messages, [["error", "save failed"]]);
});

test("model ordering updates the persisted global default for every model kind", async () => {
  for (const [kind, setter] of [["image", "setImageModels"], ["video", "setVideoModels"], ["text", "setTextModels"], ["audio", "setAudioModels"]]) {
    let saved;
    const store = createSettingsStore({ updateSettingsConfig: async (payload) => { saved = payload; return { config: payload }; }, fetchImageStorageGovernance: async () => ({ governance: {} }), dispatchAppMetaUpdated: () => {}, invalidateStorageProviderCache: () => {}, toastSuccess: () => {}, toastError: () => {} });
    store.getState().activateSession("session-a");
    store.setState({ config: { proxy: "", [`${kind}_models`]: ["old", "new"], [`default_${kind}_model`]: "old" } });
    store.getState()[setter]("new, old");
    await store.getState().saveConfig();
    assert.equal(saved[`default_${kind}_model`], "new", kind);
  }
});

test("storage measurement preserves concurrent changes and never resurrects deleted providers", async () => {
  for (const deleted of [false, true]) {
    const provider = { id: "provider-a", type: "s3", enabled: true, name: "original" };
    const setting = { providers: [provider], capacityLimitBytes: 1000 };
    let current = { activeSessionKey: "session-a", sessionGeneration: 1, config: { storage: setting } };
    const setStorage = (storage) => { current = { ...current, config: { storage } }; };
    const request = deferred();
    const context = {
      setting, setStorage, setMeasuringIndex: () => {}, setLocalUsage: () => {},
      useSettingsStore: { getState: () => ({ ...current, setStorage }) },
      measureAdminStorageProvider: () => request.promise,
      toast: { success: () => {}, error: (message) => { throw new Error(message); } },
    };
    context.updateSetting = handler("settings/components/storage-providers-card.tsx", "updateSetting", context);
    context.patchProvider = handler("settings/components/storage-providers-card.tsx", "patchProvider", context);
    const pending = handler("settings/components/storage-providers-card.tsx", "measure", context)(0);
    setStorage({ ...setting, capacityLimitBytes: 2000, providers: deleted ? [] : [provider, { id: "added", type: "webdav" }] });
    request.resolve({ result: { bytes: 42, checkedAt: "2026-01-01", overLimit: false } });
    await pending;
    assert.equal(current.config.storage.capacityLimitBytes, 2000);
    assert.equal(current.config.storage.providers.length, deleted ? 0 : 2);
    if (!deleted) assert.equal(current.config.storage.providers[0].capacityBytes, 42);
  }
});

test("malformed URL fragments do not crash settings or profile navigation", () => {
  const window = { location: { hash: "#%E0%A4%A" } };
  assert.equal(handler("settings/page.tsx", "sectionFromHash", { window, settingsItems: [{ id: "config" }] })(), "config");
  assert.equal(handler("profile/page.tsx", "profileSectionFromHash", { window })(), "account");
});

test("video contract bulk mutations stop when their authenticated session is invalidated", async () => {
  for (const name of ["deleteSelectedContracts", "updateSelectedContractsEnabled"]) {
    const lifecycle = new ScopedMutationLifecycle("session-a");
    const request = deferred();
    let calls = 0;
    const mutate = () => { calls++; return request.promise; };
    const context = {
      isBulkActionBusy: false, selectedItems: [{ id: "one", enabled: false }, { id: "two", enabled: false }],
      optimisticEnabledByID: new Map(), ALL_MUTATIONS_SCOPE, mutationTrackerRef: { current: lifecycle },
      beginMutation: (scope) => lifecycle.begin(scope),
      setIsBulkActionBusy: () => {}, setPendingIds: () => {}, setOptimisticEnabledByID: () => {},
      applyMutationResult: (ticket) => lifecycle.complete(ticket, true).current,
      rejectMutation: (ticket) => lifecycle.complete(ticket, false).current,
      deleteVideoModelContract: mutate, setVideoModelContractEnabled: mutate,
    };
    const pending = handler("settings/components/video-model-contracts-card.tsx", name, context)(true);
    lifecycle.deactivateSession("session-a");
    request.resolve({ items: [] });
    await pending;
    assert.equal(calls, 1, name);
  }
});

test("enabling a storage provider never mutates the previous settings snapshot", () => {
  const original = { id: "original", type: "webdav", enabled: true };
  const setting = { providers: [original, { id: "next", type: "s3", enabled: false }] };
  let updated;
  handler("settings/components/storage-providers-card.tsx", "patchProvider", {
    setting, updateSetting: (value) => { updated = value; },
  })(1, { enabled: true });
  assert.equal(original.enabled, true);
  assert.equal(updated.providers[0].enabled, false);
  assert.equal(updated.providers[1].enabled, true);
});

test("prompt saving stops before persistence when the session ends during asset lookup", async () => {
  const request = deferred();
  const controller = new AbortController();
  let writes = 0;
  const messages = [];
  const pending = handler("prompt-library/page.tsx", "savePrompt", {
    session: { key: "session-a" }, saveControllerRef: { current: controller },
    fetchMyAssets: () => request.promise, createMyAsset: (value) => value,
    upsertMyAsset: async () => { writes++; },
    toast: { success: (message) => messages.push(message), error: (message) => messages.push(message) },
  })({ title: "private prompt", prompt: "private content", referenceImageUrls: [], preview: "" });
  controller.abort();
  request.resolve([]);
  await pending;
  assert.equal(writes, 0);
  assert.deepEqual(messages, []);
});

test("asset file cleanup stops before further account requests after unmount", async () => {
  const request = deferred();
  const controller = new AbortController();
  let lookups = 0, deletes = 0;
  const cleanup = handler("assets/page.tsx", "createAssetStorageCleanup", {
    collectAssetStorageKeys: (_assets, keys = new Set()) => keys,
    fetchCanvasDocument: () => { lookups++; return request.promise; },
    deleteStoredImages: async () => { deletes++; }, deleteStoredMedia: async () => { deletes++; },
  })([], controller.signal);
  const pending = cleanup({ kind: "image", storageKey: "private-file" });
  controller.abort();
  request.resolve({ document: { id: "one" }, projects: [{ id: "two" }] });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(lookups, 1);
  assert.equal(deletes, 0);
});

test("capacity measurements from an old session never change the next session settings", async () => {
  const request = deferred();
  const provider = { id: "one", type: "s3", enabled: true };
  const setting = { providers: [provider] };
  let current = { activeSessionKey: "session-a", sessionGeneration: 1, config: { storage: setting } };
  let writes = 0;
  const pending = handler("settings/components/storage-providers-card.tsx", "measure", {
    setting, setMeasuringIndex: () => {}, setLocalUsage: () => { writes++; },
    useSettingsStore: { getState: () => ({ ...current, setStorage: () => { writes++; } }) },
    measureAdminStorageProvider: () => request.promise,
    toast: { success: () => { writes++; }, error: () => { writes++; } },
  })(0);
  current = { ...current, activeSessionKey: "session-b", sessionGeneration: 2 };
  request.resolve({ result: { bytes: 42 } });
  await pending;
  assert.equal(writes, 0);
});

test("account invalidation cancels management work before React cleanup", () => {
  const cases = [
    ["assets/page.tsx", "mutationControllerRef.current = controller", "mutationControllerRef"],
    ["prompt-library/page.tsx", "saveControllerRef.current = controller", "saveControllerRef"],
    ["settings/components/video-model-contracts-card.tsx", "mutationTrackerRef.current?.activateSession(sessionKey)", "mutationTrackerRef"],
    ["settings/page.tsx", "activateSession(sessionKey)", "settings"],
  ];
  for (const [file, marker, kind] of cases) {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let setup;
    function visit(node) {
      if (ts.isCallExpression(node) && ["useEffect", "useLayoutEffect"].includes(node.expression.getText(source)) && node.arguments[0]?.getText(source).includes(marker)) setup = node.arguments[0].getText(source);
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(setup, file);
    let cachedKey = "session-a";
    const listeners = new Map();
    const ref = { current: null };
    const lifecycle = new ScopedMutationLifecycle("session-a");
    const deactivated = [];
    const context = {
      session: { key: "session-a" }, sessionKey: "session-a", getCachedAuthSession: () => ({ key: cachedKey }), AUTH_SESSION_CHANGE_EVENT: "auth-change",
      window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
      mutationControllerRef: ref, saveControllerRef: ref,
      mountedRef: { current: false }, mutationTrackerRef: { current: lifecycle }, loadContracts: () => {},
      contractLoadVersionRef: { current: 0 }, contractLoadControllerRef: { current: null }, contractLoadResetRef: { current: false }, importControllerRef: { current: null },
      activateSession: () => {}, initialize: () => {}, deactivateSession: key => deactivated.push(key),
    };
    const code = ts.transpile(`const setup = ${setup};`, { target: ts.ScriptTarget.ES2022 });
    const cleanup = new Function(...Object.keys(context), `${code}\nreturn setup();`)(...Object.values(context));
    const ticket = lifecycle.begin("batch");
    cachedKey = "session-b";
    listeners.get("auth-change")?.();
    if (kind === "settings") assert.deepEqual(deactivated, ["session-a"], file);
    else if (kind === "mutationTrackerRef") assert.equal(lifecycle.isCurrent(ticket), false, file);
    else assert.equal(ref.current.signal.aborted, true, file);
    cleanup();
  }
});
