import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createSettingsStore } from "../src/app/settings/store.ts";
import { ALL_MUTATIONS_SCOPE, ScopedMutationLifecycle } from "../src/lib/scoped-mutation-lifecycle.ts";
import { selectPersistedAssets, settleAssetOperations } from "../src/app/assets/asset-library.ts";
import { creationTaskImages, prependWorkflowTask, settleWorkflowTaskUnits } from "../src/app/workflows/workflow-task-runtime.ts";

// Execute actual handlers with controlled state and asynchronous I/O boundaries.
function handler(file, name, context) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name) expression = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Missing handler ${name}`);
  const compiled = ts.transpile(`const handler = ${expression.getText(source).replace(/^export\s+/, "")};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${compiled}\nreturn handler;`)(...Object.values(context));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test("model bulk selection preserves selections outside the current results", () => {
  let selected = new Set(["outside", "visible-a"]);
  const toggle = handler("settings/components/model-config-card.tsx", "toggleVisibleModels", {
    selectableModels: ["visible-a", "visible-b"],
    setSelectedModels: (update) => { selected = update(selected); },
  });
  toggle(true);
  assert.deepEqual([...selected], ["outside", "visible-a", "visible-b"]);
  toggle(false);
  assert.deepEqual([...selected], ["outside"]);
});

test("document imports enter plugin generation only after preliminary review and with the switch enabled", async () => {
  for (const [enabled, reviewPassed] of [[false, true], [true, true], [false, false], [true, false]]) {
    let reviewOpen, targets, returnToReview = false;
    let warnings;
    const contracts = [{ name: "First", models: ["video-one"] }, { name: "Second", models: ["video-two"] }];
    const context = {
      importSourceType: "url", importFile: null, importURLs: ["https://docs.example.com/video/create", "https://docs.example.com/video/query"], importModel: "test-model", importTokenName: "",
      importGeneratePlugin: enabled, sessionKey: "session-a", isCurrentSession: () => true,
      importControllerRef: { current: null }, importRunIDRef: { current: "" }, nanoid: () => "isolated-run",
      importVideoModelContract: async (input) => {
        assert.deepEqual(input.urls, ["https://docs.example.com/video/create", "https://docs.example.com/video/query"]);
        assert.equal(input.file, null);
        return { contracts, dry_run: contracts.map(contract => ({ contract: contract.name, passed: true, evidence_complete: true, review_passed: reviewPassed, review_issues: reviewPassed ? [] : ["Required prompt_expansion_mode cannot be mapped"], models_tested: contract.models.length, modes_tested: contract.models.length, checks: ["dry run passed"], missing_evidence: [] })), warnings: ["Check the provider address"] };
      },
      normalizeVideoModelContractCollections: (value) => structuredClone(value), cloneVideoModelContract: structuredClone,
      setImportError: () => {}, setImportStatus: () => {}, setImportDetails: () => {}, setImportStartedAt: () => {}, setImportEndedAt: () => {}, setIsImporting: () => {},
      setImportOpen: () => {}, setEditingItem: () => {}, setReadOnly: () => {}, setGeneratedContracts: () => {},
      setGeneratedWarnings: value => { warnings = value; }, setGeneratedPublishError: () => {}, setGeneratedEditingIndex: () => {},
      setGeneratedDryRun: () => {},
      setGeneratedReviewOpen: value => { reviewOpen = value; }, setPluginReturnToReview: value => { returnToReview = value; },
      setPluginTargets: value => { targets = value; }, toast: { error: message => assert.fail(message) },
    };
    context.acceptImportedContracts = handler("settings/components/video-model-contracts-card.tsx", "acceptImportedContracts", context);
    const run = handler("settings/components/video-model-contracts-card.tsx", "generateFromDocument", context);
    await run();
    const generatePlugin = enabled && reviewPassed;
    assert.equal(reviewOpen, !generatePlugin);
    assert.equal(returnToReview, generatePlugin);
    if (!reviewPassed) assert.ok(warnings.some(warning => warning.includes("prompt_expansion_mode")));
    if (generatePlugin) {
      assert.deepEqual(targets.map(target => target.contract), contracts);
      assert.notEqual(targets[0].contract, contracts[0]);
      assert.notEqual(targets[0].id, targets[1].id);
      assert.deepEqual(targets[0].warnings, ["Check the provider address"]);
    } else assert.equal(targets, undefined);
  }
});

test("video document import sends every URL in the same multipart request", async () => {
  const urls = ["https://docs.example.com/create", "https://docs.example.com/query", "https://other.example.com/download"];
  const result = { contracts: [{ name: "combined" }] };
  let requests = 0;
  const send = handler("../lib/api.ts", "importVideoModelContract", {
    FormData,
    httpRequestEventStream: async (path, options) => {
      requests++;
      assert.equal(path, "/api/admin/video-model-contracts/import");
      assert.deepEqual(options.body.getAll("url"), urls);
      assert.equal(options.body.get("source_type"), "url");
      assert.equal(options.body.get("model"), "test-model");
      options.onData(JSON.stringify({ stage: "completed", message: "done", result }));
    },
  });
  assert.deepEqual(await send({ runID: "isolated", sourceType: "url", urls: [...urls, "  "], generatePlugin: false, model: "test-model" }), result);
  assert.equal(requests, 1);
});

test("video document import rejects too many entry URLs before starting a task", async () => {
  const errors = [];
  const generate = handler("settings/components/video-model-contracts-card.tsx", "generateFromDocument", {
    importSourceType: "url", importURLs: Array.from({ length: 25 }, (_, index) => `https://docs.example.com/${index}`),
    sessionKey: "session-a", isCurrentSession: () => true, importControllerRef: { current: null },
    toast: { error: value => errors.push(value) },
  });
  await generate();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /24/);
});

test("document import suppresses duplicate requests and ignores obsolete failures", async () => {
  const request = deferred();
  let active = true;
  let requests = 0;
  const feedback = [];
  const generate = handler("settings/components/video-model-contracts-card.tsx", "generateFromDocument", {
    importSourceType: "url", importURLs: ["https://docs.example.com/video"], importModel: "mock", importTokenName: "",
    sessionKey: "session-a", isCurrentSession: () => active, importControllerRef: { current: null },
    importRunIDRef: { current: "" }, nanoid: () => "run", importGeneratePlugin: false,
    setImportStartedAt: () => {}, setImportEndedAt: () => {}, setImportDetails: () => {}, setImportStatus: () => {},
    setIsImporting: (value) => feedback.push(value), setImportError: (value) => feedback.push(value),
    toast: { error: (value) => feedback.push(value) },
    importVideoModelContract: () => { requests++; return request.promise; },
  });
  const pending = generate();
  await generate();
  assert.equal(requests, 1);
  active = false;
  request.reject(new Error("obsolete error"));
  await pending;
  assert.deepEqual(feedback, ["", true]);
});

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
    assets: [{ id: "custom", visibility: "private" }], selectPersistedAssets,
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
  const preferences = { stream: false, workbench: { video_generate_audio: false } };
  let current = preferences;
  const request = deferred();
  const published = [];
  const pending = handler("profile/page.tsx", "save", {
    isLoading: false, loadError: "", isSaving: false,
    savedWorkbenchAudioRef: { current: false }, preferences, sessionKey: "session-a", saveVersionRef: { current: 0 }, currentSessionKeyRef: { current: "session-a" },
    setIsSaving: () => {}, setMessage: () => {}, relayTokenNames: {}, relayTokenPreferencesFromNames: () => ({}),
    selectedAudioVoice: "alloy", selectedAudioFormat: "mp3", selectedAudioSpeed: 1,
    updateImageGenerationPreferences: () => request.promise,
    setPreferences: (value) => { current = typeof value === "function" ? value(current) : value; },
    dispatchImageGenerationPreferencesChanged: (_key, value) => published.push(value),
  })();
  current = { stream: true };
  request.resolve({ preferences });
  await pending;
  assert.equal(current.stream, true);
  assert.deepEqual(published, [preferences]);
});

test("account balance shares a pending refresh and keeps the last successful balance after failure", async () => {
  const pending = deferred();
  const saved = { has_balance: true, quota: 123 };
  let reads = 0;
  const changes = [];
  const ref = { current: null };
  const loadBalance = handler("profile/page.tsx", "loadBalance", {
    balanceRequestRef: ref,
    session: { key: "account" }, getCachedAuthSession: () => ({ key: "account" }),
    fetchProfileBalance: () => ++reads === 1 ? Promise.resolve(saved) : pending.promise,
    setBalance: value => changes.push(["balance", value]), setBalanceError: value => changes.push(["error", value]),
    setIsLoadingBalance: () => {}, setRelayTokenAvailability: () => {},
    relayTokenAvailabilityFromBalance: () => ({ authoritative: true, names: [] }),
  });
  await loadBalance();
  assert.equal(loadBalance(), loadBalance());
  pending.reject(new Error("连接超时"));
  await ref.current;
  assert.equal(reads, 2);
  assert.deepEqual(changes.filter(([kind]) => kind === "balance"), [["balance", saved]]);
  assert.deepEqual(changes.at(-1), ["error", "连接超时"]);
  assert.equal(ref.current, null);
});

test("profile cannot save before preferences and model configuration have loaded", async () => {
  for (const state of [{ isLoading: true, loadError: "" }, { isLoading: false, loadError: "unavailable" }]) {
    await handler("profile/page.tsx", "save", {
      ...state, isSaving: false, saveVersionRef: { current: 0 },
      setIsSaving: () => assert.fail("A failed or pending read must block saving"),
    })();
  }
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

test("model keyboard moves preserve all models and stop at the list boundaries", () => {
  const move = handler("settings/components/model-config-card.tsx", "moveModel", {});
  const models = Object.freeze(["first", "second", "third"]);
  assert.deepEqual(move(models, 1, -1), ["second", "first", "third"]);
  assert.deepEqual(move(models, 1, 1), ["first", "third", "second"]);
  assert.deepEqual(move(models, 0, -1), [...models]);
  assert.deepEqual(move(models, 2, 1), [...models]);
  assert.deepEqual(move([], 0, -1), []);
});

test("pin toggles retain the reordered navigation and persist it for the current account", () => {
  const writes = [];
  const context = {
    scope: "account-a",
    pinnedPaths: ["/logs", "/users", "/rbac"],
    setPinnedPaths: (next) => { context.pinnedPaths = next; },
    writeNavigationPins: (scope, next) => { writes.push({ scope, next }); },
  };
  const file = "../components/top-nav.tsx";
  context.reorderPins = handler(file, "reorderPins", context);
  context.reorderPins(["/rbac", "/logs", "/users"]);
  assert.deepEqual(context.pinnedPaths, ["/rbac", "/logs", "/users"]);
  handler(file, "togglePin", context)("/logs");
  assert.deepEqual(context.pinnedPaths, ["/rbac", "/users"]);
  handler(file, "togglePin", context)("/logs");
  assert.deepEqual(context.pinnedPaths, ["/logs", "/rbac", "/users"]);
  assert.deepEqual(writes, [
    { scope: "account-a", next: ["/rbac", "/logs", "/users"] },
    { scope: "account-a", next: ["/rbac", "/users"] },
    { scope: "account-a", next: ["/logs", "/rbac", "/users"] },
  ]);
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
      clearingTaskHistory: false, isCurrentWorkspace: () => active,
      taskWaitAbortControllerRef: { current: new AbortController() },
      clearWorkflowTaskHistory: () => stage === "tasks" ? request.promise : Promise.resolve({ deleted_batch_ids: ["local"], result_urls: ["/images/result.png"] }),
      tasksRef: { current: [completedTask] }, updateTasks: () => {}, selectedTaskID: "", setSelectedHistoryTask: () => {},
      workflowReferenceCleanupKeys: () => ["ref"], ownedTaskReferences: () => [], setTaskHistoryPage: () => {},
      inFlightTaskCountsRef: { current: new Map() }, workflowReferencesRef: { current: [] }, agentReferencesRef: { current: [] },
      deleteStoredImages: () => { referenceDeletes++; return stage === "references" ? request.promise : Promise.resolve(); },
      session: {}, hasAPIPermission: () => true, getManagedImagePathFromUrl: (url) => url,
      deleteManagedImages: async () => { assetDeletes++; return { deleted: 1 }; },
      setClearingTaskHistory: () => {},
      toast: { success: () => { feedback++; }, error: () => { feedback++; } },
    })(true);
    await new Promise(resolve => setImmediate(resolve));
    active = false;
    request.resolve({ deleted_batch_ids: ["local"] });
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
    workflowEditorGenerationRef: { current: 0 }, setWorkflowSaveError: () => {},
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

test("workflow saves update the library without closing or showing errors in a different editor", async () => {
  for (const succeeded of [true, false]) {
    const request = deferred();
    const generation = { current: 1 };
    const events = [];
    const workflow = { id: "first", name: "First", scope: "private", config: { prompt_template: "prompt" } };
    const persist = handler("workflows/creative-workflow-workspace.tsx", "persist", {
      isCurrentWorkspace: () => true, referenceUploadCountRef: { current: 0 }, workflowSaveBusyRef: { current: false },
      workflowEditorGenerationRef: generation, setWorkflowSaveError: (value) => events.push(["error", value]),
      workspaceActiveRef: { current: true }, setWorkflowSaving: () => {}, agentDraft: null,
      normalizeWorkflow: (value) => value, models: {}, preferences: {}, saveWorkflow: () => request.promise,
      setItems: (update) => events.push(["library", update([])]), replaceEditor: () => events.push(["close"]),
      toast: { success: () => events.push(["toast"]) },
    });
    const pending = persist(workflow);
    generation.current += 1;
    if (succeeded) request.resolve(workflow);
    else request.reject(new Error("save failed"));
    await pending;
    assert.deepEqual(events, succeeded ? [["error", ""], ["library", [workflow]]] : [["error", ""]]);
  }
});

test("workflow image batches retain successful results and attribute failures to their own units", async () => {
  const controller = new AbortController();
  const submitted = [];
  const settled = [];
  let tasks = [];
  const workflow = { id: "workflow", name: "Workflow", config: {}, template_references: [] };
  const execute = handler("workflows/creative-workflow-workspace.tsx", "executeImageTask", {
    workspaceActiveRef: { current: true }, getCachedAuthSession: () => ({ key: "session" }), sessionKey: "session",
    taskWaitAbortControllerRef: { current: controller }, resolveWorkflowRuntime: () => ({ model: "model", count: 3, timeout: 30 }),
    models: { image_models: ["model"] }, preferences: {}, isWorkflowModelConfigured: () => true,
    nextTokenNameForModel: () => "", taskID: () => "batch", workflowReferencesRef: { current: [] },
    freezeWorkflowReferences: (value) => value, imageReferenceImageLimit: () => 8,
    composeWorkflowReferencePrompt: (prompt) => prompt, values: {}, beginWorkflowTaskSubmission: () => {},
    updateTasks: (update) => { tasks = update(tasks); }, prependWorkflowTask, creationTaskImages, settleWorkflowTaskUnits,
    createImageGenerationTask: async (id) => { submitted.push(id); return { id }; },
    waitForOwnedTask: async (id) => {
      if (id === "batch-2") throw new Error("quota reached");
      return { data: id === "batch-1" ? [{ url: "/images/success.png" }] : [] };
    },
    isWorkflowPollAbort: (error) => error instanceof DOMException && error.name === "AbortError",
    finishWorkflowTaskSubmission: (id) => settled.push(id),
    markWorkflowRunCompleted: () => assert.fail("partial image batches are not marked complete"),
  });
  await assert.rejects(execute(workflow, "Prompt"), /quota reached\n接口没有返回图片/);
  assert.deepEqual(submitted, ["batch-1", "batch-2", "batch-3"]);
  assert.deepEqual(settled, ["batch"]);
  assert.deepEqual(tasks[0].completed_units, [1, 2, 3]);
  assert.deepEqual(tasks[0].unit_errors, { 2: "quota reached", 3: "接口没有返回图片" });
  assert.deepEqual(tasks[0].image_urls, ["/images/success.png"]);
  assert.equal(tasks[0].status, "failed");
});

function assetContext(onSave) {
  const messages = [];
  return {
    messages,
    context: {
      title: "updated", content: "new text", coverUrl: "", source: "", note: "",
      kind: "text", visibility: "private", mediaMetadata: {}, mediaStorageKey: "",
      asset: { id: "one", kind: "image", url: "/old.png", coverUrl: "/cover.png", source: "old", note: "old", storageKey: "old-storage", width: 100, height: 200, bytes: 999, mimeType: "image/png", durationMs: 4000 },
      onSave, onClose: () => {}, isBlobURL: () => false, formControllerRef: { current: new AbortController() }, savePendingRef: { current: false }, setIsSaving: () => {},
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
  assert.equal(handler("settings/page.tsx", "settingsSectionFromHash", {})(window.location.hash, [{ id: "config" }]), "config");
  assert.equal(handler("profile/page.tsx", "profileSectionFromHash", {})(window.location.hash), "account");
});

test("video contract bulk mutations stop when their authenticated session is invalidated", async () => {
  for (const name of ["deleteSelectedContracts", "updateSelectedContractsEnabled"]) {
    const lifecycle = new ScopedMutationLifecycle("session-a");
    const request = deferred();
    let calls = 0;
    const mutate = () => { calls++; return request.promise; };
    const context = {
      bulkActionBusyRef: { current: false }, setBulkDeleteFailures() {},
      selectedItems: [{ id: "one", enabled: false }, { id: "two", enabled: false }],
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

test("partial video contract deletion keeps the confirmation and retries only failures", async () => {
  const entries = [{ id: "one", contract: { name: "First" } }, { id: "two", contract: { name: "Second" } }];
  const firstRequest = deferred();
  const lifecycle = new ScopedMutationLifecycle("session-a");
  const calls = [];
  let items = entries, failures = [], pending = new Set(), open = true;
  const context = {
    bulkActionBusyRef: { current: false },
    setBulkDeleteFailures: (next) => { failures = next; },
    selectedItems: entries, ALL_MUTATIONS_SCOPE, mutationTrackerRef: { current: lifecycle },
    beginMutation: (scope) => lifecycle.begin(scope),
    applyMutationResult: (ticket, next) => { items = next; return lifecycle.complete(ticket, true).current; },
    rejectMutation: (ticket) => lifecycle.complete(ticket, false).current,
    setIsBulkActionBusy() {},
    setPendingIds: (update) => { pending = update(pending); },
    setSelectedContractIds: (ids) => { context.selectedItems = items.filter(({ id }) => ids.has(id)); },
    setBulkDeleteOpen: (next) => { open = next; },
    loadContracts() {}, toast: { success() {} },
    deleteVideoModelContract: async (id) => {
      calls.push(id);
      if (id === "one") return firstRequest.promise;
      if (calls.length === 2) throw new Error("文件正在使用");
      return { items: [] };
    },
  };
  const removeSelected = () => handler("settings/components/video-model-contracts-card.tsx", "deleteSelectedContracts", context)();
  const running = removeSelected();
  await removeSelected();
  assert.deepEqual(calls, ["one"]);
  firstRequest.resolve({ items: [entries[1]] });
  await running;
  assert.deepEqual(items, [entries[1]]);
  assert.deepEqual(failures, [{ id: "two", name: "Second", message: "文件正在使用" }]);
  assert.equal(open, true);
  assert.equal(pending.size, 0);
  await removeSelected();
  assert.deepEqual(calls, ["one", "two", "two"]);
  assert.equal(open, false);
  assert.deepEqual(items, []);
});

test("video contract publication uses one write request and leaves failed edits ready for retry", async () => {
  const request = deferred();
  const draft = { name: "Draft" };
  const lifecycle = new ScopedMutationLifecycle("session-a");
  const calls = [];
  let action, error = "", closed = false;
  const context = {
    editorActionRef: { current: false }, readOnly: false, editor: null, editingItem: { id: "contract" },
    currentSessionKeyRef: { current: "session-a" }, currentDraftRef: { current: draft }, draft,
    isCurrentSession: () => true, setEditorAction: value => { action = value; }, setEditorError: value => { error = value; },
    mutationFromDraft: (value) => value, validateVideoModelContract: () => assert.fail("Publish validates in the write endpoint"),
    beginMutation: (scope) => lifecycle.begin(scope), rejectMutation: (ticket) => lifecycle.complete(ticket, false).current,
    applyMutationResult: (ticket) => lifecycle.complete(ticket, true).current,
    publishVideoModelContract: (id, payload) => {
      calls.push([id, payload]);
      return calls.length === 1 ? request.promise : Promise.resolve({ item: { id, revision: 3 }, items: [] });
    },
    setDialogOpen: (open) => { closed = !open; }, generatedEditingIndex: null, toast: { success() {} },
  };
  const submit = handler("settings/components/video-model-contracts-card.tsx", "submitContract", context);
  const publishing = submit("publish");
  assert.equal(action, "publish");
  await submit("publish");
  assert.deepEqual(calls, [["contract", draft]]);
  request.reject(new Error("模型冲突"));
  await publishing;
  assert.equal(action, null);
  assert.equal(error, "模型冲突");
  assert.equal(closed, false);
  await submit("publish");
  assert.deepEqual(calls, [["contract", draft], ["contract", draft]]);
  assert.equal(closed, true);
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
      activateSession: () => {}, loadConfig: () => {}, deactivateSession: key => deactivated.push(key),
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

test("workflow editors use addressable pages for existing workflows and new templates", () => {
  const selected = [];
  const routes = [];
  const resolved = [];
  const pendingEditorNavigationRef = { current: null };
  const context = {
    items: [{ id: "existing" }], searchParams: new URLSearchParams("filter=brand"),
    editorRouteKey: ":single_image", pendingEditorNavigationRef,
    workflowEditorGenerationRef: { current: 0 }, setResolvedEditorRoute: key => resolved.push(key), setWorkflowSaveError: () => {},
    setEditing: value => selected.push(value),
    setSearchParams: (params, options) => routes.push([new URLSearchParams(params), options]),
  };
  const open = handler("workflows/creative-workflow-workspace.tsx", "replaceEditor", context);
  open({ id: "existing", mode: "single_image" });
  assert.equal(routes[0][0].get("editor"), "existing");
  assert.equal(routes[0][0].get("filter"), "brand");
  assert.equal(routes[0][1].replace, false);
  assert.deepEqual(pendingEditorNavigationRef.current, { from: ":single_image", to: "existing:single_image" });
  open({ id: "", mode: "multi_image_series" }, "product_detail");
  assert.equal(routes[1][0].get("editor"), "new");
  assert.equal(routes[1][0].get("template"), "product_detail");
  assert.equal(resolved[1], "new:product_detail");
  assert.deepEqual(pendingEditorNavigationRef.current, { from: ":single_image", to: "new:product_detail" });
  open(null);
  assert.equal(routes[2][0].has("editor"), false);
  assert.equal(routes[2][0].has("template"), false);
  assert.equal(routes[2][1].replace, true);
  assert.equal(selected[2], null);
  assert.equal(context.workflowEditorGenerationRef.current, 3);
});

test("workflow editor keeps an applied Agent draft while the URL catches up", () => {
  const pendingEditorNavigationRef = { current: { from: ":single_image", to: "new:single_image" } };
  const workflowEditorGenerationRef = { current: 1 };
  const replacements = [];
  const context = {
    pendingEditorNavigationRef, workflowEditorGenerationRef,
    resolvedEditorRoute: "new:single_image", loading: false,
    setResolvedEditorRoute: (route) => replacements.push(route),
    setWorkflowSaveError: (error) => replacements.push(error),
    setEditing: (draft) => replacements.push(draft),
  };
  const resolve = (editorRouteKey, editorRoute) => handler("workflows/creative-workflow-workspace.tsx", "resolveEditorRoute", {
    ...context, editorRouteKey, editorRoute,
  })();
  resolve(":single_image", "");
  assert.ok(pendingEditorNavigationRef.current);
  resolve("new:single_image", "new");
  assert.equal(pendingEditorNavigationRef.current, null);
  assert.equal(workflowEditorGenerationRef.current, 1);
  assert.deepEqual(replacements, []);
  resolve(":single_image", "");
  assert.deepEqual(replacements, [":single_image", "", null]);
  assert.equal(workflowEditorGenerationRef.current, 2);
});

test("asset editor returns to its library only after a successful save in the same session", async () => {
  for (const outcome of ["success", "failure", "aborted"]) {
    const request = deferred();
    const fixture = assetContext(() => request.promise);
    let closed = 0;
    fixture.context.onClose = () => closed++;
    const pending = handler("assets/asset-form.tsx", "submit", fixture.context)();
    assert.equal(closed, 0);
    if (outcome === "failure") request.reject(new Error("save failed"));
    else {
      if (outcome === "aborted") fixture.context.formControllerRef.current.abort();
      request.resolve();
    }
    await pending;
    assert.equal(closed, outcome === "success" ? 1 : 0);
    assert.equal(fixture.messages.filter(([kind]) => kind === "success").length, outcome === "success" ? 1 : 0);
  }
});

test("role selection preserves the current draft until a dirty switch is confirmed", () => {
  const role = { id: "next", name: "Next role" };
  for (const dirty of [true, false]) {
    const applied = [], pending = [];
    const select = handler("rbac/page.tsx", "requestRoleSelection", {
      selectedRoleId: "current", isDirty: dirty,
      setPendingRole: value => pending.push(value),
      applySelectedRole: value => applied.push(value),
    });
    select({ id: "current" });
    assert.deepEqual(applied, []);
    assert.deepEqual(pending, []);
    select(role);
    assert.deepEqual(applied, dirty ? [] : [role]);
    assert.deepEqual(pending, dirty ? [role] : []);
  }
});
