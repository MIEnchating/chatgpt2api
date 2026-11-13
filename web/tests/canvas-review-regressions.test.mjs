import { CanvasAgentSessionConflictError, forkCanvasAgentSessionConflicts, mergeCanvasDocuments, mergeCanvasHistory } from "../src/app/canvas/canvas-document-merge.ts";
import { canvasDocumentValuesEqual } from "../src/app/canvas/canvas-document-equality.ts";
import { canvasAgentHistoryChanges, canvasAgentHistoryReceipt, canvasAgentHistorySummaries } from "../src/app/canvas/agent/canvas-agent-history.ts";
import { resolveCanvasAgentMediaSettings } from "../src/app/canvas/agent/canvas-agent-media-settings.ts";
import { normalizeCanvasAgentConfig } from "../src/app/canvas/agent/canvas-agent-starter.ts";
import { summarizeCanvasAgentTask } from "../src/app/canvas/agent/canvas-agent-context.ts";
import { installVideoModelContracts } from "../src/lib/video-model-contracts.ts";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { canvasAgentStarterAttachment } from "../src/app/canvas/agent/canvas-agent-attachments.ts";
import { canvasAgentQuestionMediaChoice } from "../src/app/canvas/agent/canvas-agent-interaction.ts";
import { canvasScriptProductionNodes, canvasScriptShotPosition } from "../src/app/canvas/canvas-script-layout.ts";
import { isCanvasAgentSession, parseCanvasAgentSessions, syncCanvasAgentSessions } from "../src/app/canvas/agent/canvas-agent-sessions.ts";
import { mergeCanvasAgentMessageQueues } from "../src/app/canvas/agent/canvas-agent-message-queue.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { canvasAgentAttachmentURLs } from "../src/app/canvas/agent/canvas-agent-reference.ts";
import { canvasNodeSizeFromRatio } from "../src/app/canvas/canvas-node-geometry.ts";
import { applyCanvasVideoTaskProgressNodes, reconcilePersistedCanvasTaskNodes } from "../src/app/canvas/canvas-task-results.ts";
import { canvasTextGenerationPlan } from "../src/app/canvas/canvas-text-generation.ts";
import { canvasGenerationRecoveryTaskID, buildCanvasGenerationContext, canvasGenerationReferenceImageURLs, canvasGenerationNeedsRecovery, canvasVideoGenerationReferences, markCanvasGenerationRecoveryPending, PENDING_CANVAS_GENERATION_RECOVERY_ERROR } from "../src/app/canvas/canvas-generation-context.ts";
import { prepareImageEditReferences } from "../src/lib/image-edit-references.ts";
import { videoModelRequiresHTTPSReferences } from "../src/lib/video-model-capabilities.ts";
import { canvasHistoryKey, createCanvasHistorySnapshot, appendCanvasHistorySnapshot, canvasHistoryLeaseExpired, canvasHistoryStorageObjectIDs, canvasHistoryStorageObjectURLs, commitCanvasGenerationHistory } from "../src/app/canvas/canvas-history.ts";
import { canvasSaveRequired, flushCanvasSaves } from "../src/app/canvas/canvas-save.ts";
import { canCreateCanvasConnection } from "../src/app/canvas/canvas-connections.ts";
import { isPublicReferenceURL } from "../src/lib/public-reference-url.ts";
import { normalizeCanvasClipboard } from "../src/app/canvas/canvas-clipboard.ts";
import { expandCanvasGroupNodeIDs, findCanvasGroupDropTargetForNodes, findContainingCanvasGroupID, snapCanvasNodesIntoGroup } from "../src/app/canvas/canvas-groups.ts";
import { buildCanvasConnectionIndex, canvasConnectionIndexMatchesGeometry, updateCanvasConnectionGeometry } from "../src/app/canvas/canvas-viewport.ts";
import { createCanvasAlignmentContext, calculateCanvasAlignment } from "../src/app/canvas/canvas-alignment.ts";
import { expandCanvasBatchNodeIDs } from "../src/app/canvas/canvas-batches.ts";
import * as script from "../src/app/canvas/canvas-script.ts";
import { canvasRecoveryDraftScope, captureCanvasDraftChanges, recoverCanvasDraftDocument } from "../src/app/canvas/canvas-recovery-draft.ts";

// Execute the actual page handlers with controlled state and I/O dependencies.
function pageHandler(file, name, dependencies) {
  dependencies = {
    setCanvasSaveError() {}, setSavingCanvas() {}, checkpointCanvasDraft() {}, refreshCanvasDrafts() {},
    setRecoveryDrafts() {}, setRecoveryDialogOpen() {}, setDiscardRecoveryDraft() {}, setProcessingRecoveryDraft() {}, setRecoveryDraftError() {},
    recoveryDraftTimerRef: { current: null }, recoveryDraftWriterRef: { current: "" }, session: {}, canvasRecoveryDraftScope,
    ...dependencies,
  };
  dependencies = { canvasDocumentValuesEqual, canvasGenerationRecoveryTaskID, createCanvasHistorySnapshot, agentHistoryConflictRef: {current: null}, isCanvasAgentSession, CanvasAgentSessionConflictError, forkCanvasAgentSessionConflicts, setAgentHistoryConflict() {}, setAgentSyncError() {}, parseCanvasAgentSessions, canvasScriptShotPosition, canvasGenerationNeedsRecovery, canvasAgentHistoryChanges, canvasAgentHistoryReceipt, canvasAgentHistorySummaries, setAgentSessionSummaries() {}, persistGenerationCheckpoint: async () => {}, imageGenerationPreferences: { node_regenerate_behavior: "new-node", workbench: { video_generate_audio: false } }, ...dependencies };
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/app/canvas/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) declaration = node.initializer;
    if (ts.isJsxAttribute(node) && node.name.text === name && ts.isJsxExpression(node.initializer)) declaration = node.initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, `Missing handler ${name}`);
  const code = ts.transpileModule(`const handler = ${declaration.getText(source).replace(/^export\s+/, "")};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn handler;`)(...Object.values(dependencies));
}

test("canvas recovery stores only edited conversation bodies and preserves other server history", () => {
  const makeSession = id => ({
    id, title: id, createdAt: "now", updatedAt: "now", messages: [], protocolMessages: [],
    agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] },
  });
  const untouched = { ...makeSession("untouched"), messages: [{ id: "u", role: "user", text: "existing transcript" }] };
  const edited = makeSession("edited"), removed = makeSession("removed"), deferred = makeSession("deferred");
  const remote = {
    version: 1, id: "canvas", revision: 17, title: "Before", background: "dots", nodes: [{id:"node",title:"Before"}],
    connections: [], viewport: { zoom: 1, x: 0, y: 0 }, active_agent_session_id: "edited",
    agent_sessions: [untouched, edited, removed, deferred],
  };
  const changed = { ...edited, title: "Changed", messages: [{ id: "u", role: "user", text: "Unsaved chat" }] };
  const added = { ...makeSession("added"), codexThreadId: "existing-thread", codexServiceId: "service", messageQueue: { paused: false, messages: [] } };
  const current = { ...remote, nodes: [{id:"node",title:"After"}], agent_history_partial: true,
    agent_sessions: [structuredClone(untouched), changed, added], deleted_agent_session_ids: ["removed"],
    pending_agent_request: {prompt:"Do not replay",assets:[]}, agent_run: {status:"running"},
  };
  const changes = captureCanvasDraftChanges({...remote,agent_sessions:[untouched,edited,removed]}, current);
  assert.deepEqual(changes.sessions.map(session => session.id), ["edited", "added"]);
  assert.deepEqual(changes.deletedSessionIDs, ["removed"]);
  assert.equal("pending_agent_request" in changes.canvas, false);
  assert.equal("agent_run" in changes.canvas, false);
  const restored = recoverCanvasDraftDocument(remote, changes, false);
  assert.equal(restored.revision, 17);
  assert.equal(restored.nodes[0].title, "After");
  assert.deepEqual(restored.agent_sessions, [untouched, changed, deferred, added]);

  const newer = { ...remote, revision: 18, agent_run: {status:"running"}, pending_agent_request: current.pending_agent_request,
    agent_sessions: [untouched, { ...edited, title: "Other version" }, removed, deferred] };
  const copy = recoverCanvasDraftDocument(newer, changes, true);
  assert.equal(copy.title, "Before（恢复草稿）");
  assert.equal(copy.agent_run, undefined);
  assert.equal(copy.pending_agent_request, undefined);
  assert.equal(copy.agent_sessions[3].messageQueue.paused, true);
  assert.equal(copy.agent_sessions[3].codexThreadId, undefined);
  assert.equal(newer.agent_sessions[1].title, "Other version");
  assert.notEqual(canvasRecoveryDraftScope("a,b", "c"), canvasRecoveryDraftScope("a", "b,c"));
});

test("canvas reads forward cancellation without changing requested history scope", async () => {
  const requests = [];
  const fetch = pageHandler("../../services/api/canvas.ts", "fetchCanvasDocument", {
    URLSearchParams,
    httpRequest: async (path, options) => { requests.push({ path, options }); return { document: { id: "canvas" } }; },
  });
  const controller = new AbortController();
  await fetch("project", "active", ["older", "current"], controller.signal);
  const query = new URL(requests[0].path, "http://localhost").searchParams;
  assert.equal(query.get("project_id"), "project");
  assert.equal(query.get("history"), "active");
  assert.deepEqual(query.getAll("session_id"), ["older", "current"]);
  assert.equal(requests[0].options?.signal, controller.signal);
  const activate = pageHandler("../../services/api/canvas.ts", "updateCanvasProject", {
    httpRequest: async (path, options) => { requests.push({ path, options }); return { document: { id: "project" } }; },
  });
  await activate({ action: "activate", project_id: "project" }, "active", controller.signal);
  assert.equal(requests[1].path, "/api/canvas?history=active");
  assert.deepEqual(requests[1].options, { method: "POST", body: { action: "activate", project_id: "project" }, signal: controller.signal });
});

test("workspace effect cancels discarded reads and retains late-response and failure protection", async () => {
  const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("const loadWorkspace =")) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(effect);
  const code = ts.transpileModule(`const effect = ${effect.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  for (const projectID of [undefined, "project"]) for (const outcome of ["late", "abort", "success", "failure", "config-failure", "config-delay"]) {
    const calls = [], errors = [], applied = [], loading = [];
    let complete, completeConfig;
    const dependencies = {
      AbortController, session: { key: "isolated-account" }, projectID,
      batchAnimationTimersRef: { current: new Map() }, activeGenerationsRef: { current: new Map() },
      activateCanvasTaskQueueSession() {}, mountedRef: { current: true }, setLoadError: error => errors.push(error),
      fetchModelConfig: async () => {
        if (outcome === "config-failure") throw new Error("contracts failed");
        if (outcome === "config-delay") await new Promise(resolve => { completeConfig = resolve; });
      },
      fetchCanvasDocument: (...args) => {
        calls.push(args);
        return new Promise((resolve, reject) => {
          complete = outcome === "failure" ? () => reject(new Error("read failed")) : () => resolve({ document: { id: "project" }, active_project_id: "project" });
          if (outcome === "abort") args.at(-1)?.addEventListener("abort", () => reject(args.at(-1).reason), { once: true });
        });
      },
      updateCanvasProject: (...args) => dependencies.fetchCanvasDocument(...args),
      applyWorkspace: workspace => applied.push(workspace), setLoading: value => loading.push(value),
      saveTimerRef: { current: null }, persistCanvas() {}, checkpointCanvasDraft() {}, window: new EventTarget(), flushCanvasBeforeLeave() {},
      canvasOperationEpochRef: { current: 0 }, cancelCanvasMediaOperations() {}, generationEpochRef: { current: 0 },
      canvasDocumentEpochRef: { current: 0 },
      generationAbortControllerRef: { current: null }, canvasRecoveryAbortControllerRef: { current: null },
      switchRevealTimerRef: { current: null }, focusAnimationRef: { current: null }, clearCanvasTaskQueueForSession() {},
    };
    const run = new Function(...Object.keys(dependencies), `${code}\nreturn effect;`)(...Object.values(dependencies));
    const cleanup = run();
    assert.equal(calls.length, 1);
    if (projectID) assert.deepEqual(calls[0].slice(0, 2), [{ action: "activate", project_id: "project" }, "editor"]);
    else assert.deepEqual(calls[0].slice(0, 3), [undefined, "editor", []]);
    const signal = calls[0][projectID ? 2 : 3];
    assert.ok(signal instanceof AbortSignal, "the actual workspace read must be cancellable");
    if (outcome === "late" || outcome === "abort") {
      cleanup();
      assert.equal(signal.aborted, true);
      if (outcome === "late") complete();
      await flush();
      assert.deepEqual(applied, []);
      assert.deepEqual(errors, [""]);
      assert.deepEqual(loading, []);
    } else {
      complete();
      await flush();
      if (outcome === "config-delay") {
        assert.deepEqual(applied, [], "the document must wait for model contracts");
        assert.deepEqual(loading, []);
        completeConfig();
        await flush();
      }
      const success = outcome === "success" || outcome === "config-delay";
      assert.equal(applied.length, success ? 1 : 0);
      assert.deepEqual(errors, success ? [""] : ["", outcome === "config-failure" ? "contracts failed" : "read failed"]);
      assert.deepEqual(loading, [false]);
      cleanup();
      assert.equal(signal.aborted, true);
    }
  }
});

test("opening deferred history retries a stale revision and never replaces state with a missing or cancelled body", async () => {
  const history = { id: "saved", title: "Saved", createdAt: "now", updatedAt: "now", messages: [], protocolMessages: [], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } };
  for (const scenario of ["stale", "missing", "cancelled", "switched"]) {
    const controller = new AbortController();
    const documentRef = { current: { id: "project", revision: 4 } };
    const canvasDocumentEpochRef = { current: 7 };
    const local = { ...documentRef.current, nodes: [{ id: "pending-edit" }] };
    const base = { ...documentRef.current, nodes: [] };
    const errors = [], applied = [];
    let requests = 0;
    const load = pageHandler("page.tsx", "loadDeferredAgentHistory", {
      documentRef, canvasDocumentEpochRef, mountedRef: { current: true }, serverDocumentRef: { current: base },
      setAgentHistoryLoadError: value => errors.push(value), captureDocument: () => local,
      fetchCanvasDocument: async (project, scope, ids, signal) => {
        assert.deepEqual([project, scope, ids, signal], ["project", "active", [], controller.signal]);
        requests++;
        if (scenario === "cancelled") controller.abort();
        if (scenario === "switched") canvasDocumentEpochRef.current++;
        return { document: { id: "project", revision: scenario === "stale" && requests === 1 ? 3 : 4, active_agent_session_id: "saved", agent_session_summaries: [{ id: "saved" }], agent_sessions: scenario === "missing" ? [] : [history] } };
      },
      applyBackendAgentDocument: (...args) => applied.push(args),
    });
    await load(controller.signal);
    assert.equal(requests, scenario === "stale" ? 2 : 1);
    if (scenario === "stale") {
      assert.equal(applied[0][0].revision, 4);
      assert.deepEqual(applied[0][1], { base, local, hydrateHistory: true });
    } else assert.deepEqual(applied, []);
    assert.deepEqual(errors, scenario === "missing" ? ["", "当前对话正文缺失"] : [""]);
  }
});

test("loading malformed persisted sessions fails explicitly without silently dropping history", () => {
  const valid = { id: "retained", title: "保留记录", createdAt: "now", updatedAt: "now", messages: [{ id: "reply", role: "assistant", text: "完整旧记录", status: "success" }], protocolMessages: [], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } };
  const read = pageHandler("page.tsx", "storedCanvasAgentSessions", { isCanvasAgentSession, syncCanvasAgentSessions });
  const badNested = { ...valid, id: "broken", messages: [{ id: "bad", role: "assistant", text: "不能静默丢弃", trace: [{ id: "trace", type: "operation", kind: "read", status: "success", label: "读取", detail: {}, tool: { name: "get_node" } }] }] };
  for (const sessions of [[badNested], [valid, badNested], [valid, null], { unexpected: "object" }, [valid, { ...valid }], [{ ...valid, id: " " }]]) {
    const document = { nodes: [], agent_sessions: sessions };
    const before = structuredClone(document);
    assert.throws(() => read(document), /对话记录数据无效/);
    assert.deepEqual(document, before);
  }
  assert.equal(read({ nodes: [], agent_sessions: [valid] })[0].messages[0].text, "完整旧记录");
  assert.deepEqual(read({ nodes: [] }), []);
  assert.deepEqual(read({ nodes: [], agent_sessions: [] }), []);
});

test("a rejected workspace snapshot cannot replace the canvas or interrupt its active operations", () => {
  const changes = [];
  const serverDocumentRef = { current: { id: "retained", revision: 3 } };
  const apply = pageHandler("page.tsx", "applyDocument", {
    cloneDocument: structuredClone, serverDocumentRef,
    storedCanvasAgentSessions: () => { throw new Error("对话记录数据无效，原记录未被替换"); },
    setBackendAgentRun: () => changes.push("run"), loadedRef: { current: true },
    canvasOperationEpochRef: { current: 5 }, cancelCanvasMediaOperations: () => changes.push("operations"),
    setOpenScriptNodeID: () => changes.push("script"), canvasRecoveryAbortControllerRef: { current: { abort: () => changes.push("abort") } },
  });
  assert.throws(() => apply({ id: "incoming", revision: 4, nodes: [] }), /对话记录数据无效/);
  assert.deepEqual(serverDocumentRef.current, { id: "retained", revision: 3 });
  assert.deepEqual(changes, []);
});

test("invalid sessions produced by a snapshot merge are rejected before committing server state", () => {
  const current = { id: "retained", revision: 3, nodes: [], connections: [] };
  const documentRef = { current }, serverDocumentRef = { current: structuredClone(current) };
  const merged = { ...current, revision: 4, agent_sessions: [null] };
  const apply = pageHandler("page.tsx", "applyBackendAgentDocument", {
    mountedRef: { current: true }, documentRef, serverDocumentRef,
    storedCanvasAgentSessions: document => { if (document === merged) throw new Error("对话记录数据无效，原记录未被替换"); return []; },
    captureDocument: () => current, mergeCanvasDocuments: () => merged, cloneDocument: structuredClone,
    storedCanvasAgentConfig: () => assert.fail("invalid history reached state updates"),
  });
  assert.throws(() => apply({ ...current, revision: 4 }), /对话记录数据无效/);
  assert.equal(documentRef.current, current);
  assert.deepEqual(serverDocumentRef.current, current);
});

test("opening a canvas isolates editable history with only one complete transcript copy", () => {
  const snapshot = {
    id: "opening", revision: 7, title: "Saved canvas", nodes: [{ id: "node", type: "text", prompt: "Saved", x: 1, y: 2 }], connections: [],
    agent_sessions: [{ id: "s", title: "Saved conversation", createdAt: "now", updatedAt: "now", engine: "native",
      messages: [{ id: "a", role: "assistant", text: "Saved reply", status: "running", trace: [{ id: "op", type: "operation", kind: "read", label: "Read", detail: "Saved detail", status: "success" }], references: [{ id: "node", type: "text", title: "Reference", text: "Saved" }] }],
      protocolMessages: [{ role: "assistant", toolCalls: [{ id: "call", name: "get_node", arguments: { id: "node" } }] }],
      agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] },
    }], active_agent_session_id: "s", agent_session_summaries: [{ id: "s", content_hash: "saved" }],
  };
  const saved = structuredClone(snapshot);
  const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(snapshot);
  const documentRef = { current: { id: "previous" } }, serverDocumentRef = { current: null };
  let fullCopies = 0, serializedCharacters = 0;
  const copy = pageHandler("page.tsx", "cloneDocument", {
    JSON: { parse: JSON.parse, stringify(value) { const encoded = JSON.stringify(value); serializedCharacters += encoded.length; return encoded; } },
  });
  const deps = {
    documentRef, serverDocumentRef,
    cloneDocument: document => { if (document.agent_sessions?.length) fullCopies++; return copy(document); },
    structuredClone: document => { if (document.agent_sessions?.length) fullCopies++; return structuredClone(document); },
    canvasEmptyMediaNodeFrame: node => node, normalizeCanvasNodeTitle: node => node, normalizeCanvasVideoNode: node => node,
    storedCanvasAgentSessions: pageHandler("page.tsx", "storedCanvasAgentSessions", { syncCanvasAgentSessions }),
    loadedRef: { current: true }, canvasOperationEpochRef: { current: 0 }, canvasDocumentEpochRef: { current: 0 }, canvasRecoveryAbortControllerRef: { current: null },
    titleRef: { current: "" }, viewportRef: { current: {} }, backgroundRef: { current: "dots" }, showImageInfoRef: { current: false },
    DEFAULT_DOCUMENT: { viewport: { zoom: 1, x: 0, y: 0 } }, session: { key: "fixture" }, defaultCanvasModelsRef: { current: {} }, storedCanvasAgentConfig: () => null,
    hydrateCanvasStorageURLs: async () => {}, consumePendingAgentRequest: async () => {},
  };
  for (const name of ["setBackendAgentRun", "cancelCanvasMediaOperations", "setOpenScriptNodeID", "clearCanvasTaskQueueForCanvas", "replaceNodes", "replaceConnections", "setViewportState", "setTitle", "setBackground", "setShowImageInfo", "setAgentConfig", "setImageModel", "setTextModel", "setVideoModel", "setAgentSessions", "setActiveAgentSessionID", "setAgentOpen", "setAgentDisplayMode", "setInitialAgentRequest", "setSelectedNodeIDs", "setSelectedConnectionID", "setPanelNodeID", "setReferenceReturn", "setImagePromptDrafts", "setPreviewNodeID", "setNodeInfoID", "setContextMenu", "setPendingConnection", "setNodeCreateMenu", "setImageTool", "setImageToolBusy", "setMaskEditModel", "setUploadingNodeID"]) deps[name] = () => {};
  pageHandler("page.tsx", "applyDocument", deps)(snapshot, false);
  assert.equal(fullCopies, 1);
  assert.equal(serializedCharacters, 0, "opening a JSON workspace must not allocate a serialized copy of its complete history");
  const editable = documentRef.current;
  assert.equal(editable.agent_sessions[0].messages[0].status, "waiting");
  assert.equal(serverDocumentRef.current.agent_sessions[0].messages[0].status, "running");
  editable.nodes[0].prompt = "Local node";
  editable.agent_sessions[0].messages[0].text = "Local reply";
  editable.agent_sessions[0].messages[0].trace[0].detail = "Local detail";
  editable.agent_sessions[0].messages[0].references[0].text = "Local reference";
  editable.agent_sessions[0].protocolMessages[0].toolCalls[0].arguments.id = "local";
  editable.agent_sessions[0].agentState.approvedNodeIds.push("node");
  editable.agent_session_summaries[0].content_hash = "local";
  assert.deepEqual(serverDocumentRef.current, saved);
  assert.deepEqual(snapshot, saved);
});

test("the Agent panel accepts session snapshots only after document validation succeeds", () => {
  const session = { id: "session", title: "原对话", createdAt: "now", updatedAt: "now", messages: [{ id: "reply", role: "assistant", text: "保留原答复", status: "success" }], protocolMessages: [], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } };
  for (const invalid of ["session", "document"]) {
    const sessionsRef = { current: [session] };
    let published = 0;
    const accept = pageHandler("canvas-agent-panel.tsx", "acceptBackendSnapshot", {
      sessionsRef, mergeCanvasAgentMessageQueues, parseCanvasAgentSessions: value => {
        if (!Array.isArray(value) || !value.every(isCanvasAgentSession)) throw new Error("invalid session");
        return value;
      },
      onBackendDocument: () => { published++; if (invalid === "document") throw new Error("invalid document"); },
    });
    const incoming = invalid === "session" ? [null] : [{ ...session, messages: [] }];
    assert.throws(() => accept({ agent_sessions: incoming }), /invalid/);
    assert.deepEqual(sessionsRef.current, [session]);
    assert.equal(published, invalid === "session" ? 0 : 1);
  }
});

test("an unchanged snapshot revision still validates history before clearing a sync error", () => {
  const current = { id: "project", revision: 4, agent_run: { status: "running" } };
  const errors = [];
  const apply = pageHandler("page.tsx", "applyBackendAgentDocument", {
    mountedRef: { current: true }, documentRef: { current }, setAgentSyncError: error => errors.push(error),
    storedCanvasAgentSessions: () => { throw new Error("invalid history"); },
  });
  assert.throws(() => apply({ ...current, agent_sessions: [null] }), /invalid history/);
  assert.deepEqual(errors, []);
});

test("video generation stages protected hosted images even when their saved host is public", async () => {
  const fetched = [], uploaded = [];
  const prepare = pageHandler("page.tsx", "preparePublicVideoImageReference", {
    isPublicReferenceURL,
    isManagedImageURL: url => new URL(url, "https://canvas.example.com").pathname.startsWith("/images/"),
    fetchAuthenticatedImageBlob: async url => { fetched.push(url); return new Blob(["image"], { type: "image/png" }); },
    uploadVideoImageReference: async file => { uploaded.push(file); return { url: "/video-image-references/staged.png?signature=fixture" }; },
    File,
  });
  const protectedURL = "http://canvas.example.com/images/2026/frame.png";
  assert.equal(await prepare(protectedURL), "/video-image-references/staged.png?signature=fixture");
  assert.deepEqual(fetched, [protectedURL]);
  assert.equal(uploaded.length, 1);
  assert.equal(await prepare("https://external.example.com/frame.png"), "https://external.example.com/frame.png");
  assert.equal(uploaded.length, 1);
});

test("canvas task observation follows server completion rather than the default eight minute deadline", async () => {
  const controller = new AbortController();
  const progress = () => {};
  const completed = { id: "original-task", status: "success" };
  const wait = pageHandler("page.tsx", "waitForTask", {
    waitForCreationTask: async (id, options) => {
      assert.equal(id, "original-task");
      assert.equal(options.timeoutMs, null);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.onProgress, progress);
      return completed;
    },
  });
  assert.equal(await wait("original-task", progress, controller.signal), completed);
});

test("a history body arriving after leaving or switching the canvas never updates the old conversation", async () => {
  for (const departure of ["unmount", "switch away and back"]) {
    const mountedRef = { current: true }, canvasOperationEpochRef = { current: 1 }, documentRef = { current: { id: "canvas", revision: 4 } };
    let finishRead;
    const read = new Promise(resolve => { finishRead = resolve; });
    const load = pageHandler("page.tsx", "loadAgentHistorySession", {
      documentRef, canvasOperationEpochRef, mountedRef,
      saveChangeVersionRef: { current: 1 }, persistCanvas: async () => true,
      flushCanvasSaves, fetchCanvasAgentHistorySession: () => read,
      isCanvasAgentSession: () => assert.fail("a stale body reached validation"),
    });
    const pending = load("history");
    await new Promise(resolve => setImmediate(resolve));
    if (departure === "unmount") mountedRef.current = false;
    else canvasOperationEpochRef.current++;
    finishRead({ session: {} });
    await assert.rejects(pending, error => error.name === "AbortError");
  }
});

test("Space after script close pans instead of activating the restored node button", () => {
  class Target {
    constructor(matches) { this.matches = new Set(matches); }
    closest(selector) { return selector.split(",").some((part) => this.matches.has(part)) ? this : null; }
  }
  for (const matches of [["[data-canvas-node]", "[data-canvas-no-pan]"], ["[data-canvas-node-toolbar]", "[data-canvas-no-pan]"], ["[data-canvas-node-input-anchor]", "[data-canvas-no-pan]"], ["[data-canvas-parameter-panel]", "[role='dialog']", "[data-canvas-no-pan]"]]) {
    const spacePressedRef = { current: false };
    const consumed = [];
    const down = pageHandler("canvas-engine.tsx", "handleSpaceDown", { Element: Target, spacePressedRef, spaceConsumed: false, syncToolCursor() {} });
    down({ code: "Space", target: new Target(matches), preventDefault: () => consumed.push("default"), stopPropagation: () => consumed.push("propagation") });
    assert.equal(spacePressedRef.current, true);
    assert.deepEqual(consumed, ["default", "propagation"]);
  }
  for (const matches of [["input"], ["textarea"], ["[role='dialog']", "[data-canvas-node]"], ["[role='alertdialog']"], ["[role='menu']"], ["[data-slot='popover-content']"], ["[data-canvas-no-pan]"]]) {
    const spacePressedRef = { current: false };
    const down = pageHandler("canvas-engine.tsx", "handleSpaceDown", { Element: Target, spacePressedRef, spaceConsumed: false, syncToolCursor() {} });
    down({ code: "Space", target: new Target(matches), preventDefault: () => assert.fail("intercepted an editor or overlay"), stopPropagation() {} });
    assert.equal(spacePressedRef.current, false);
  }
  for (const modifier of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const spacePressedRef = { current: false };
    const down = pageHandler("canvas-engine.tsx", "handleSpaceDown", { Element: Target, spacePressedRef, spaceConsumed: false, syncToolCursor() {} });
    down({ code: "Space", ...modifier, target: new Target([]), preventDefault: () => assert.fail("intercepted IME or a modified shortcut"), stopPropagation() {} });
    assert.equal(spacePressedRef.current, false);
  }
});

test("canvas panning can start over node controls without activating or dragging them", () => {
  class Target {
    constructor(inNode) { this.inNode = inNode; }
    closest(selector) {
      return selector.includes("[data-canvas-no-pan]") || this.inNode && selector.includes("[data-canvas-node]") ? this : null;
    }
    contains() { return true; }
  }
  for (const mode of ["space", "hand", "middle"]) {
    for (const inNode of [true, false]) {
      const panRef = { current: { active: false } }, pointer = { current: null };
      let captured = 0, prevented = 0;
      const target = new Target(inNode);
      const handler = pageHandler("canvas-engine.tsx", "handlePointerDown", {
        Element: Target, HTMLElement: Target, document: { activeElement: null },
        interactionPointerRef: pointer, toolRef: { current: mode === "hand" ? "pan" : "select" }, spacePressedRef: { current: mode === "space" },
        viewportRef: { current: { x: 20, y: 30 } }, panRef, syncToolCursor() {},
      });
      handler({ target, currentTarget: { contains: () => true, setPointerCapture: () => captured++ }, isPrimary: true, pointerId: 4, button: mode === "middle" ? 1 : 0, clientX: 100, clientY: 200, preventDefault: () => prevented++, stopPropagation() {} });
      assert.equal(panRef.current.active, inNode, `${mode}: only node controls allow canvas panning`);
      assert.equal(captured, inNode ? 1 : 0);
      assert.equal(prevented, inNode ? 1 : 0);
      if (inNode) assert.deepEqual([pointer.current, panRef.current.initialX, panRef.current.initialY], [4, 20, 30]);
    }
  }
});

function scriptMediaGenerationHarness(type, separateImages = false) {
  const project = script.createScriptProject();
  project.confirmed = true;
  project.assets = ["hero", "prop"].map((id) => ({ id, kind: id === "hero" ? "character" : "prop", name: id, description: id, image_node_id: separateImages ? id : "reference" }));
  const shot = project.shots[1];
  Object.assign(shot, { description: "Second scene", asset_ids: ["prop"], dialogue: [{ id: "line", kind: "dialogue", asset_id: "hero", text: "Hello" }], image_prompt: "Image", video_prompt: "Video" });
  const source = { id: "script", type: "script", title: "Story", x: 0, y: 0, width: 500, height: 300, script_project: project };
  const nodesRef = { current: [source, ...[...new Set(project.assets.map((asset) => asset.image_node_id))].map((id) => ({ id, type: "image", url: `/${id}.png`, generation_status: "success" }))] };
  const connectionsRef = { current: [] };
  const errors = [], submissions = [];
  let sequence = 0;
  const dependencies = {
    ...script, nodesRef, connectionsRef, buildCanvasGenerationContext, canvasVideoGenerationReferences, canvasGenerationReferenceImageURLs,
    toast: { error: (message) => errors.push(message), info() {} },
    replaceNodes: (nodes) => { nodesRef.current = nodes; },
    replaceConnections: (edges) => { connectionsRef.current = edges; }, pushHistory() {},
    scriptNodeRunning: () => false, scriptMediaSubmissionsRef: { current: new Map() },
    imageModel: "image-model", imageModels: ["image-model"], videoModel: "video-model", videoModels: ["video-model"],
    nextTokenNameForModel: () => "token", tokenNameForModel: () => "token",
    validateCanvasAgentVideoSeconds: () => "", videoRequiresReferenceImage: () => true,
    supportsVideoMultimodalReferences: () => false, supportsVideoFrameReferences: () => true,
    canvasVideoParameters: (node) => ({ ...Object.fromEntries(Object.entries(node).filter(([key]) => key.startsWith("generation_video_"))), generation_video_model: node.generation_video_model || "", generation_video_size: node.generation_video_size || "16:9", generation_video_seconds: node.generation_video_seconds ?? 5, generation_video_reference_mode: node.generation_video_reference_mode || "first-frame", generation_video_reference_image_urls: node.generation_video_reference_image_urls || [] }),
    defaultCanvasImageParameters: () => ({}),
    supportsImageEditing: () => true, imageReferenceImageLimit: () => 1,
    documentRef: { current: { id: "project" } }, canvasOperationEpochRef: { current: 1 }, mountedRef: { current: true },
    CANVAS_NODE_DEFAULT_SIZE: { image: { width: 340, height: 340 }, video: { width: 420, height: 236 } },
    preferredCanvasImageParameters: () => ({ generation_model: "image-model" }),
    randomID: () => String(++sequence), createdAt: () => "now",
    canvasNodeSizeFromRatio,
    getCachedAuthSession: () => null,
    runGeneration: async (id, prompt) => { submissions.push(prompt === undefined ? id : { id, prompt }); },
  };
  dependencies.canvasImageParameters = pageHandler("page.tsx", "canvasImageParameters", dependencies);
  dependencies.buildVideoNode = pageHandler("page.tsx", "buildVideoNode", dependencies);
  dependencies.updateScriptProject = pageHandler("page.tsx", "updateScriptProject", dependencies);
  return { project, shot, source, nodesRef, connectionsRef, errors, submissions, dependencies, run: (shotIDs = [shot.id], regenerate = false) => pageHandler("page.tsx", "generateScriptMedia", dependencies)(source.id, type, shotIDs, regenerate) };
}

test("regenerating a script shot retains its model and media settings while keeping the old result", async () => {
  for (const type of ["image", "video"]) {
    const harness = scriptMediaGenerationHarness(type);
    const settings = type === "image"
      ? { generation_model: "original-image", generation_size: "9:16", generation_quality: "high" }
      : { generation_video_model: "original-video", generation_video_size: "9:16", generation_video_resolution: "768P", generation_video_audio: true, generation_video_watermark: false, generation_video_reference_mode: "reference", generation_video_parameters: { motion: "stable" } };
    const old = { id: "old-output", type, url: "/original", task_id: "original-task", generation_status: "success", ...settings };
    harness.dependencies[type === "image" ? "imageModels" : "videoModels"].push(type === "image" ? "original-image" : "original-video");
    harness.nodesRef.current.push(old);
    harness.shot[`${type}_node_id`] = old.id;
    await harness.run(undefined, true);
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.submissions.length, 1);
    const result = harness.nodesRef.current.find(node => node.id === harness.submissions[0]);
    for (const [key, value] of Object.entries(settings)) assert.deepEqual(result[key], value, `${type}: ${key}`);
    assert.notEqual(result.id, old.id);
    assert.ok(!result.task_id);
    assert.ok(!result.url);
    assert.equal(result.prompt, harness.shot[`${type}_prompt`]);
    assert.equal(harness.nodesRef.current.find(node => node.id === old.id), old);
  }
});

test("script regeneration validates the inherited model before changing bindings or submitting", async () => {
  for (const type of ["image", "video"]) {
    const harness = scriptMediaGenerationHarness(type);
    const old = { id: "old-output", type, url: "/original", task_id: "original-task", generation_status: "success", [type === "image" ? "generation_model" : "generation_video_model"]: "disabled-model" };
    harness.shot[`${type}_node_id`] = old.id;
    harness.nodesRef.current.push(old);
    await harness.run(undefined, true);
    assert.match(harness.errors.join(" "), /disabled-model.*未启用/);
    assert.deepEqual(harness.submissions, []);
    assert.equal(harness.nodesRef.current.length, 3);
    assert.equal(harness.source.script_project.shots[1][`${type}_node_id`], old.id);
  }
});

test("selected script revisions preserve each shot configuration and validate the whole batch before submitting", async () => {
  for (const disabled of [false, true]) {
    const harness = scriptMediaGenerationHarness("video");
    const selected = harness.project.shots;
    for (const [index, shot] of selected.entries()) {
      Object.assign(shot, { description: `Scene ${index}`, asset_ids: ["hero"], video_prompt: `Movement ${index}`, video_node_id: `old-${index}` });
      const model = `model-${index}`;
      if (!disabled || index === 0) harness.dependencies.videoModels.push(model);
      harness.nodesRef.current.push({ id: shot.video_node_id, type: "video", url: `/old-${index}.mp4`, generation_video_model: model, generation_video_audio: Boolean(index), generation_video_resolution: index ? "768P" : "480P" });
    }
    const before = structuredClone(harness.nodesRef.current);
    await harness.run(selected.map(shot => shot.id), true);
    if (disabled) {
      assert.match(harness.errors.join(" "), /model-1.*未启用/);
      assert.deepEqual(harness.nodesRef.current, before);
      assert.deepEqual(harness.submissions, []);
      continue;
    }
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.submissions.length, 2);
    for (const [index, id] of harness.submissions.entries()) {
      const node = harness.nodesRef.current.find(node => node.id === id);
      assert.equal(node.generation_video_model, `model-${index}`);
      assert.equal(node.generation_video_audio, Boolean(index));
      assert.equal(node.generation_video_resolution, index ? "768P" : "480P");
      assert.ok(harness.nodesRef.current.some(node => node.id === `old-${index}` && node.url));
    }
  }
});

test("regenerated script videos include the bound storyboard alongside material references", async () => {
  const harness = scriptMediaGenerationHarness("video");
  harness.dependencies.supportsVideoMultimodalReferences = () => true;
  harness.dependencies.videoMultimodalReferenceLimits = () => ({ image: 5 });
  harness.shot.image_node_id = "storyboard";
  harness.shot.video_node_id = "old-video";
  harness.nodesRef.current.push({ id: "storyboard", type: "image", url: "/storyboard.png", generation_status: "success" }, { id: "old-video", type: "video", url: "/original.mp4", generation_video_model: "video-model", generation_video_reference_mode: "reference" });
  await harness.run(undefined, true);
  assert.deepEqual(harness.errors, []);
  const output = harness.nodesRef.current.find(node => node.id === harness.submissions[0]);
  const context = buildCanvasGenerationContext(output.id, harness.nodesRef.current, harness.connectionsRef.current, output.prompt);
  assert.deepEqual(context.referenceImageURLs.sort(), ["/reference.png", "/storyboard.png"]);
});

test("script regeneration follows replaced reference slots without retaining the old images", async () => {
  const harness = scriptMediaGenerationHarness("video");
  harness.dependencies.supportsVideoMultimodalReferences = () => true;
  harness.dependencies.videoMultimodalReferenceLimits = () => ({ image: 3 });
  Object.assign(harness.shot, { image_node_id: "old-board", video_node_id: "old-video" });
  harness.nodesRef.current.push(
    { id: "old-board", type: "image", url: "/old-board.png" },
    { id: "new-board", type: "image", url: "/new-board.png" },
    { id: "new-material", type: "image", url: "/new-material.png" },
    { id: "old-video", type: "video", generation_video_model: "video-model", generation_video_reference_mode: "reference", generation_video_reference_image_urls: ["/old-board.png", "/reference.png", "/extra.png"] },
  );
  const previous = structuredClone(harness.nodesRef.current);
  harness.shot.image_node_id = "new-board";
  harness.project.assets.forEach(asset => { asset.image_node_id = "new-material"; });
  harness.nodesRef.current = script.reconcileScriptMediaDependencies(harness.nodesRef.current, previous);
  await harness.run(undefined, true);
  assert.deepEqual(harness.errors, []);
  const output = harness.nodesRef.current.find(node => node.id === harness.submissions[0]);
  const context = buildCanvasGenerationContext(output.id, harness.nodesRef.current, harness.connectionsRef.current, output.prompt);
  assert.deepEqual(canvasVideoGenerationReferences(context, output.generation_video_reference_image_urls, false).referenceImageURLs, ["/new-board.png", "/new-material.png", "/extra.png"]);
});

test("single-shot generation deduplicates shared material images and preserves the original shot number", async () => {
  for (const type of ["image", "video"]) {
    const harness = scriptMediaGenerationHarness(type);
    await harness.run();
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.submissions.length, 1);
    const output = harness.nodesRef.current.find((node) => node.id === harness.submissions[0]);
    assert.equal(output.title, "Story · 第 2 镜");
    assert.deepEqual(harness.connectionsRef.current.filter((edge) => edge.to_node_id === output.id).map((edge) => edge.from_node_id).sort(), ["reference", "script"]);
    const updated = harness.nodesRef.current.find((node) => node.id === "script").script_project;
    assert.equal(updated.shots.length, 2);
    assert.equal(updated.shots[1][`${type}_node_id`], output.id);
    assert.equal(updated.shots[0][`${type}_node_id`], undefined);
  }
});

test("distinct material images exceeding the model limit cannot create nodes or submit tasks", async () => {
  for (const type of ["image", "video"]) {
    const harness = scriptMediaGenerationHarness(type, true);
    await harness.run();
    assert.match(harness.errors.join(" "), /参考图上限/);
    assert.deepEqual(harness.submissions, []);
    assert.equal(harness.nodesRef.current.length, 3);
    assert.equal(harness.connectionsRef.current.length, 0);
  }
});

test("script image regeneration counts extra configured references before creating a replacement", async () => {
  const harness = scriptMediaGenerationHarness("image");
  harness.shot.image_node_id = "old-image";
  harness.nodesRef.current.push({ id: "old-image", type: "image", generation_model: "image-model", url: "/original.png", generation_reference_urls: ["/extra.png"] });
  const before = [...harness.nodesRef.current];
  await harness.run(undefined, true);
  assert.match(harness.errors.join(" "), /参考图上限/);
  assert.deepEqual(harness.submissions, []);
  assert.deepEqual(harness.nodesRef.current, before);
  assert.equal(harness.source.script_project.shots[1].image_node_id, "old-image");
});

test("single-shot generation reports missing prompts using the original shot number", async () => {
  const harness = scriptMediaGenerationHarness("video");
  harness.shot.video_prompt = "";
  await harness.run();
  assert.deepEqual(harness.errors, ["第 2 镜缺少视频提示词"]);
  assert.deepEqual(harness.submissions, []);
});

test("bound empty media nodes inherit the shot prompt before generation", async () => {
  for (const type of ["image", "video"]) {
    const harness = scriptMediaGenerationHarness(type);
    const field = `${type}_node_id`;
    const promptField = `${type}_prompt`;
    const output = { id: `bound-${type}`, type, prompt: "", generation_status: "idle" };
    harness.shot[field] = output.id;
    harness.nodesRef.current.push(output);
    harness.connectionsRef.current.push({ id: "ref", from_node_id: "reference", to_node_id: output.id });
    if (type === "video") {
      harness.connectionsRef.current.push({ id: "script-output", from_node_id: "script", to_node_id: output.id });
      output.generation_video_model = "video-model";
      output.generation_video_seconds = harness.shot.seconds;
    }
    const expectedPrompt = harness.shot[promptField];
    await harness.run();
    assert.deepEqual(harness.errors, []);
    assert.deepEqual(harness.submissions, [{ id: output.id, prompt: expectedPrompt }]);
  }
});

test("shared blank outputs generate once for matching shot prompts and reject conflicting prompts", async () => {
  const matching = scriptMediaGenerationHarness("image");
  const output = { id: "shared-output", type: "image", prompt: "", generation_status: "idle" };
  matching.shot.image_node_id = output.id;
  matching.project.shots[0].image_prompt = matching.shot.image_prompt;
  matching.project.shots[0].image_node_id = output.id;
  matching.nodesRef.current.push(output);
  await matching.run(matching.project.shots.map((shot) => shot.id));
  assert.deepEqual(matching.errors, []);
  assert.deepEqual(matching.submissions, [{ id: output.id, prompt: matching.shot.image_prompt }]);

  const conflicting = scriptMediaGenerationHarness("image");
  const shared = { id: "shared-output", type: "image", prompt: "", generation_status: "idle" };
  conflicting.shot.image_node_id = shared.id;
  conflicting.project.shots[0].image_prompt = "A different composition";
  conflicting.project.shots[0].image_node_id = shared.id;
  conflicting.nodesRef.current.push(shared);
  await conflicting.run(conflicting.project.shots.map((shot) => shot.id));
  assert.match(conflicting.errors.join(" "), /多个镜头.*提示词不一致/);
  assert.deepEqual(conflicting.submissions, []);
});

test("script video checks accept named first frames and configured reference images", async () => {
  for (const kind of ["first-frame", "configured", "first-and-last"]) {
    const harness = scriptMediaGenerationHarness("video");
    harness.shot.video_node_id = "existing-video";
    const video = { id: "existing-video", type: "video", prompt: "Video", generation_video_model: "video-model", generation_video_seconds: 5 };
    if (kind === "configured") video.generation_video_reference_image_urls = ["/configured.png"];
    else {
      video.generation_video_first_frame_node_id = "reference";
      harness.connectionsRef.current.push({ id: "first", from_node_id: "reference", to_node_id: video.id });
      if (kind === "first-and-last") {
        video.generation_video_last_frame_node_id = "last";
        harness.nodesRef.current.push({ id: "last", type: "image", url: "/last.png" });
        harness.connectionsRef.current.push({ id: "last", from_node_id: "last", to_node_id: video.id });
      }
    }
    harness.nodesRef.current.push(video);
    const initialNodeCount = harness.nodesRef.current.length;
    await harness.run();
    assert.deepEqual(harness.errors, [], kind);
    assert.deepEqual(harness.submissions, [video.id], kind);
    assert.equal(harness.nodesRef.current.length, initialNodeCount);
  }
});

test("script video checks reject excess configured images and a last frame without a required first frame", async () => {
  for (const kind of ["excess-images", "last-frame-only"]) {
    const harness = scriptMediaGenerationHarness("video");
    harness.shot.video_node_id = "existing-video";
    const video = { id: "existing-video", type: "video", prompt: "Video", generation_video_model: "video-model", generation_video_seconds: 5 };
    if (kind === "excess-images") video.generation_video_reference_image_urls = ["/first.png", "/second.png"];
    else {
      video.generation_video_last_frame_node_id = "reference";
      harness.connectionsRef.current.push({ id: "last", from_node_id: "reference", to_node_id: video.id });
    }
    harness.nodesRef.current.push(video);
    await harness.run();
    assert.match(harness.errors.join(" "), kind === "excess-images" ? /参考图上限/ : /需要参考图片/);
    assert.deepEqual(harness.submissions, []);
  }
});

function scriptTextGenerationHarness(kind) {
  const project = script.createScriptProject();
  project.confirmed = true;
  project.shots.forEach((shot, index) => Object.assign(shot, { description: `Scene ${index + 1}`, image_prompt: "Old image", video_prompt: "Old video" }));
  project.shots[0].video_node_id = "retained-video";
  const nodesRef = { current: [{ id: "script", type: "script", prompt: "Story", script_project: project }] };
  const connectionsRef = { current: [] };
  const errors = [], successes = [];
  let finishTask, notifyWaiting;
  const waiting = new Promise((resolve) => { notifyWaiting = resolve; });
  const active = new Map();
  const dependencies = {
    ...script, nodesRef, connectionsRef, buildCanvasGenerationContext,
    scriptNodeRunning: (id) => active.has(id),
    textModel: "text-model", textModels: ["text-model"], nextTokenNameForModel: () => "token",
    documentRef: { current: { id: "project" } }, canvasOperationEpochRef: { current: 1 }, mountedRef: { current: true },
    randomID: () => "request", canvasTextGenerationMessages: async () => [],
    registerActiveGeneration: (controller) => { active.set("script", controller); return controller; },
    completeActiveGeneration: () => { active.clear(); }, addActiveGenerationTask() {},
    replaceNodes: (nodes) => { nodesRef.current = nodes; }, replaceConnections: (edges) => { connectionsRef.current = edges; },
    pushHistory() {}, scheduleSave() {},
    createChatGenerationTask: async () => ({ id: "original-task" }),
    waitForTask: () => new Promise((resolve) => { finishTask = resolve; notifyWaiting(); }),
    toast: { error: (message) => errors.push(message), success: (message) => successes.push(message) },
  };
  dependencies.updateScriptProject = pageHandler("page.tsx", "updateScriptProject", dependencies);
  const run = pageHandler("page.tsx", "runScriptTextGeneration", dependencies);
  const output = kind === "script" ? JSON.stringify(project) : JSON.stringify({ shots: [{ id: project.shots[0].id, image_prompt: "New image", video_prompt: "New video" }] });
  return { project, nodesRef, errors, successes, waiting, dependencies,
    run: () => run("script", kind, kind === "prompts" ? [project.shots[0].id] : []),
    complete: () => finishTask({ status: "success", data: [{ text_response: output }] }),
  };
}

test("late script results cannot overwrite edits or restore removed media bindings", async () => {
  for (const kind of ["script", "prompts"]) {
    const harness = scriptTextGenerationHarness(kind);
    const pending = harness.run();
    await harness.waiting;
    const changed = structuredClone(harness.nodesRef.current[0].script_project);
    changed.shots[0].description = "Edited while the task was running";
    changed.shots[0].video_node_id = "";
    harness.nodesRef.current[0] = { ...harness.nodesRef.current[0], script_project: changed };
    harness.complete();
    await pending;
    assert.deepEqual(harness.nodesRef.current[0].script_project, changed);
    assert.match(harness.errors.join(" "), /脚本.*已变更/);
    assert.deepEqual(harness.successes, []);
    assert.equal(harness.nodesRef.current[0].generation_status, "error");
    assert.equal(harness.nodesRef.current[0].script_operation, undefined);
  }
});

test("unchanged scripts accept prompt results and retain unrelated prompts and media", async () => {
  const harness = scriptTextGenerationHarness("prompts");
  const pending = harness.run();
  await harness.waiting;
  harness.complete();
  await pending;
  const node = harness.nodesRef.current[0];
  assert.deepEqual(harness.errors, []);
  assert.equal(node.generation_status, "success");
  assert.equal(node.task_id, "original-task");
  assert.equal(node.script_project.shots[0].video_node_id, "retained-video");
  assert.equal(node.script_project.shots[0].video_prompt, "New video");
  assert.equal(node.script_project.shots[1].video_prompt, "Old video");
});

test("workspace edits check the current task state and resume after generation", async () => {
  const harness = scriptTextGenerationHarness("prompts");
  const edit = pageHandler("page.tsx", "editScriptProject", harness.dependencies);
  const changed = structuredClone(harness.project);
  changed.shots[0].description = "Updated scene";
  const pending = harness.run();
  await harness.waiting;
  edit("script", changed);
  assert.deepEqual(harness.nodesRef.current[0].script_project, harness.project);
  harness.complete();
  await pending;
  const updated = structuredClone(harness.nodesRef.current[0].script_project);
  updated.shots[0].description = "Updated scene";
  edit("script", updated);
  assert.equal(harness.nodesRef.current[0].script_project.shots[0].description, "Updated scene");
  assert.deepEqual(harness.errors, []);
});

test("script generation waits for connected reference uploads and active input tasks", async () => {
  const source = { id: "script", type: "script", script_project: script.createScriptProject() };
  const reference = { id: "reference", type: "image" };
  const nodesRef = { current: [source, reference, { id: "unrelated", type: "image", generation_status: "loading" }] };
  const connectionsRef = { current: [{ id: "input", from_node_id: reference.id, to_node_id: source.id }] };
  const active = new Set();
  const dependencies = { nodesRef, connectionsRef, scriptMediaSubmissionsRef: { current: new Map() }, nodeGenerationRunning: (id) => active.has(id) };
  dependencies.scriptRelatedNodeIDs = pageHandler("page.tsx", "scriptRelatedNodeIDs", dependencies);
  assert.deepEqual([...dependencies.scriptRelatedNodeIDs(source.id)].sort(), ["reference", "script"]);
  const running = (uploadingNodeID = "") => pageHandler("page.tsx", "scriptNodeRunning", { ...dependencies, uploadingNodeID })(source.id);
  assert.equal(running(), false);
  assert.equal(running(reference.id), true);
  reference.generation_status = "loading";
  assert.equal(running(), true);
  reference.generation_status = "success";
  active.add(reference.id);
  assert.equal(running(), true);
  active.clear();
  assert.equal(running(), false);
  const stopped = [];
  await pageHandler("page.tsx", "stopScriptTasks", {
    ...dependencies,
    documentRef: { current: { id: "project" } }, canvasOperationEpochRef: { current: 1 }, mountedRef: { current: true },
    activeGenerationsRef: { current: new Map() }, session: { key: "session" },
    stopGeneration: async (id) => { stopped.push(id); }, stopCreationTasks: async () => {},
    replaceNodes: (nodes) => { nodesRef.current = nodes; }, pushHistory() {},
    toast: { error: (message) => { throw new Error(message); } },
  })(source.id);
  assert.deepEqual(stopped.sort(), ["reference", "script"]);
  connectionsRef.current = [];
  assert.equal(running(reference.id), false);
});

test("late script reference uploads cannot change selection after leaving the canvas state", async () => {
  for (const change of ["project", "epoch", "unmount"]) {
    const nodesRef = { current: [{ id: "script", type: "script", x: 0, y: 0 }] };
    const documentRef = { current: { id: "project" } };
    const canvasOperationEpochRef = { current: 1 };
    const mountedRef = { current: true };
    const selections = [];
    let finishUpload;
    const upload = pageHandler("page.tsx", "uploadScriptReference", {
      nodesRef, documentRef, canvasOperationEpochRef, mountedRef,
      connectionsRef: { current: [] }, scriptNodeRunning: () => false, uploadingNodeID: "",
      randomID: () => "reference", createdAt: () => "now", CANVAS_NODE_DEFAULT_SIZE: { image: { width: 340, height: 340 } },
      replaceNodes: (nodes) => { nodesRef.current = nodes; }, connectNodes() {},
      uploadImageFile: () => new Promise((resolve) => { finishUpload = resolve; }),
      setSelectedNodeIDs: (ids) => selections.push([...ids]), setSelectedConnectionID: (id) => selections.push(id), setPanelNodeID: (id) => selections.push(id),
      toast: { error: (message) => { throw new Error(message); } },
    });
    const pending = upload("script", { type: "image/png", name: "reference.png" });
    if (change === "project") documentRef.current = { id: "other-project" };
    if (change === "epoch") canvasOperationEpochRef.current++;
    if (change === "unmount") mountedRef.current = false;
    finishUpload();
    await pending;
    assert.deepEqual(selections, [], change);
  }
});

function scriptRecoveryHarness(full = false) {
  const project = script.createScriptProject();
  project.assets = ["hero", "scene"].map((id) => ({ id, kind: id === "hero" ? "character" : "scene", name: id, description: id, image_node_id: `${id}-image` }));
  project.shots.forEach((shot) => { shot.description = "Scene"; });
  Object.assign(project.shots[0], { asset_ids: ["hero"], image_node_id: "output" });
  const source = { id: "script", type: "script", prompt: "Original story", script_project: project, script_operation: { kind: "script", shot_ids: [] }, task_id: "task", generation_status: "loading" };
  const nodesRef = { current: [source, ...["hero-image", "scene-image", "output"].map((id) => ({ id, type: "image" }))] };
  const initial = script.scriptAssetConnections("script", project, undefined, []);
  if (full) nodesRef.current.push(...Array.from({ length: 90 }, (_, index) => ({ id: `extra-${index}`, type: "image" })));
  const connectionsRef = { current: full ? [...initial, ...Array.from({ length: 2000 - initial.length }, (_, index) => ({ id: `edge-${index}`, from_node_id: `extra-${index % 40}`, to_node_id: `extra-${40 + Math.floor(index / 40)}` }))] : initial };
  const originalEdges = connectionsRef.current;
  const saves = [];
  const apply = pageHandler("page.tsx", "applyRecoveredCanvasTask", {
    nodesRef, connectionsRef, reconcilePersistedCanvasTaskNodes, scriptAssetConnections: script.scriptAssetConnections,
    isCurrentCanvasRecovery: () => true,
    replaceNodes: (nodes) => { nodesRef.current = nodes; },
    replaceConnections: (edges) => { connectionsRef.current = edges; },
    scheduleSave: () => { saves.push({ nodes: nodesRef.current, connections: connectionsRef.current }); },
  });
  const generated = structuredClone(project);
  generated.shots[0].asset_ids = full ? ["hero", "scene"] : ["scene"];
  const task = { id: "task", status: "success", data: [{ text_response: JSON.stringify(generated) }] };
  return { project, nodesRef, connectionsRef, originalEdges, saves, apply: () => apply(task, "project", 1, new AbortController().signal) };
}

test("recovered scripts synchronize changed material references before saving and apply once", () => {
  const harness = scriptRecoveryHarness();
  harness.apply();
  const node = harness.nodesRef.current[0];
  assert.equal(node.generation_status, "success");
  assert.equal(node.prompt, "Original story");
  assert.deepEqual(node.script_project.shots[0].asset_ids, ["scene"]);
  assert.equal(node.script_project.shots[0].image_outdated, true);
  const pairs = harness.connectionsRef.current.map((edge) => `${edge.from_node_id}>${edge.to_node_id}`);
  assert.deepEqual(pairs.sort(), ["hero-image>script", "scene-image>script", "script>output", "scene-image>output"].sort());
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].connections, harness.connectionsRef.current);
  const savedNodes = harness.nodesRef.current;
  const savedEdges = harness.connectionsRef.current;
  harness.apply();
  assert.equal(harness.nodesRef.current, savedNodes);
  assert.equal(harness.connectionsRef.current, savedEdges);
  assert.equal(harness.saves.length, 1);
});

test("recovered scripts preserve the original project and edges when the canvas is full", () => {
  const harness = scriptRecoveryHarness(true);
  harness.apply();
  const node = harness.nodesRef.current[0];
  assert.equal(node.generation_status, "error");
  assert.match(node.generation_error, /画布容量不足/);
  assert.equal(node.script_project, harness.project);
  assert.equal(node.script_operation, undefined);
  assert.equal(harness.connectionsRef.current, harness.originalEdges);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].nodes[0].generation_status, "error");
});

for (const file of ["canvas-agent-prompt-chip-input.tsx", "canvas-config-composer.tsx"]) {
  test(`${file} keeps IME composition separate from committed draft and mention selection`, () => {
    const composingRef = { current: false };
    let composing = false;
    let closed = 0;
    let synced = 0;
    const dependencies = {
      composingRef,
      setIsComposing: value => { composing = value; },
      closeMention: () => { closed++; },
      syncFromEditor: () => { synced++; },
    };
    pageHandler(file, "onCompositionStart", dependencies)();
    assert.equal(composingRef.current, true);
    assert.equal(composing, true);
    assert.equal(closed, 1);
    assert.equal(synced, 0, "unconfirmed candidates must not be committed");
    pageHandler(file, "onCompositionEnd", dependencies)();
    assert.equal(composingRef.current, false);
    assert.equal(composing, false);
    assert.equal(synced, 1, "commit or cancellation must synchronize the editor");
  });
}

test("Agent IME Enter never commits pending references or submits a message", () => {
  const composingRef = { current: false };
  let committed = 0;
  const sent = [];
  const handler = pageHandler("canvas-agent-prompt-chip-input.tsx", "onKeyDown", {
    composingRef,
    commitPendingReferences: () => { committed++; return { value: "去请问", referenceIDs: ["image-1"] }; },
    onSubmit: (...args) => sent.push(args),
    mention: null,
  });
  for (const signal of ["ref", "native", "keyCode"]) {
    composingRef.current = signal === "ref";
    handler({ key: "Enter", nativeEvent: { isComposing: signal === "native", keyCode: signal === "keyCode" ? 229 : 13 }, stopPropagation() {}, preventDefault() { assert.fail("IME candidate selection must retain native Enter"); } });
  }
  assert.equal(committed, 0);
  assert.deepEqual(sent, []);
  composingRef.current = false;
  let prevented = false;
  handler({ key: "Enter", nativeEvent: {}, stopPropagation() {}, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(committed, 1);
  assert.deepEqual(sent, [["去请问", ["image-1"]]]);
});

test("canvas shortcuts leave shared menus and project popovers in control of keyboard input", () => {
  for (const slot of ["dropdown-menu-content", "context-menu-content", "popover-content"]) {
    const keydown = pageHandler("page.tsx", "keydown", {
      window: { getSelection: () => ({ toString: () => "" }) },
      documentRef: { current: {} },
    });
    for (const command of [{ key: "Delete" }, { key: "v" }, { key: "a", ctrlKey: true }, { key: "0", ctrlKey: true }]) {
      keydown({
        ...command,
        target: { tagName: "DIV", closest: selector => selector.includes(`[data-slot='${slot}']`) ? {} : null },
        preventDefault() { assert.fail("Canvas shortcuts must not consume overlay input"); },
      });
    }
  }
});

test("creating the twenty-fifth Agent conversation preserves the existing history", () => {
  const sessions = Array.from({ length: 24 }, (_, i) => ({ id: `session-${i}`, messages: [{ id: `message-${i}`, role: "user", text: "saved history" }] }));
  const created = { id: "session-25", messages: [], protocolMessages: [] };
  let committed, activeID, view;
  const create = pageHandler("canvas-agent-panel.tsx", "newSession", {
    busy: false, abortRef: { current: null }, activeSession: sessions[0], sessionsRef: { current: sessions },
    draftAttachments: { clear() {} }, setInput() {}, setEditingUserMessageID() {}, setComposerReferenceNodeIDs() {}, setRemovedReferenceNodeIDs() {},
    createSession: () => created, agentMode: "native", setView: value => { view = value; },
    commit: (value, id) => { committed = value; activeID = id; },
  });
  create();
  assert.equal(committed.length, 25);
  assert.deepEqual(committed.slice(1), sessions);
  assert.equal(committed[0].id, created.id);
  assert.equal(activeID, created.id);
  assert.equal(view, "chat");
});

test("changing Agent engines updates only the active session and preserves its saved thread", () => {
  const sessions = [{ id: "native", engine: "native", agentState: {} }, { id: "codex", engine: "codex", codexThreadId: "thread", codexServiceId: "service", agentState: {} }];
  for (const blocked of ["busy", "controller", "question", "unchanged", "none"]) {
    let committed;
    const change = pageHandler("canvas-agent-panel.tsx", "changeAgentMode", {
      busy: blocked === "busy", abortRef: { current: blocked === "controller" ? new AbortController() : null },
      activeSession: { ...sessions[1], agentState: { pendingQuestion: blocked === "question" ? {} : undefined } },
      agentMode: "codex", sessionsRef: { current: sessions }, activeSessionIDRef: { current: "codex" },
      commit: value => { committed = value; },
    });
    change(blocked === "unchanged" ? "codex" : "native");
    if (blocked !== "none") { assert.equal(committed, undefined); continue; }
    assert.equal(committed[0], sessions[0]);
    assert.equal(committed[1].engine, "native");
    assert.equal(committed[1].codexThreadId, "thread");
    assert.equal(committed[1].codexServiceId, "service");
    assert.ok(committed[1].updatedAt);
  }
});

test("canvas zoom shortcuts preserve keyboard input in node editors", () => {
  const keydown = pageHandler("page.tsx", "keydown", {
    window: { getSelection: () => ({ toString: () => "" }) },
    documentRef: { current: {} },
    fitCanvasContent: () => assert.fail("Editing must not fit the canvas"),
    updateViewport: () => assert.fail("Editing must not zoom the canvas"),
  });
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "DIV"]) {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      for (const key of ["0", "+", "=", "-"]) {
        keydown({ key, [modifier]: true, target: { tagName, isContentEditable: tagName === "DIV", closest: () => null },
          preventDefault() { assert.fail("Editors must retain native keyboard behavior"); } });
      }
    }
  }
});

test("canvas copy shortcuts preserve selected chat text even when keyboard focus is on the page", () => {
  for (const modifier of ["ctrlKey", "metaKey"]) {
    let copiedNodes = 0;
    let selectedText = "Agent 中选中的文字";
    const keydown = pageHandler("page.tsx", "keydown", {
      window: { getSelection: () => ({ toString: () => selectedText }) },
      documentRef: { current: {} },
      copySelected: () => { copiedNodes++; },
    });
    const event = () => ({ key: "c", [modifier]: true, target: { tagName: "BODY", closest: () => null }, prevented: false, preventDefault() { this.prevented = true; } });
    const textCopy = event();
    keydown(textCopy);
    assert.equal(textCopy.prevented, false, "browser must copy the selected text");
    assert.equal(copiedNodes, 0, "selected canvas nodes must not override chat text");
    selectedText = "";
    const nodeCopy = event();
    keydown(nodeCopy);
    assert.equal(nodeCopy.prevented, true);
    assert.equal(copiedNodes, 1, "node copying must still work without a text selection");
  }
});

function textGenerationHarness(prompt = "", overrides = {}) {
  const nodesRef = { current: [{ id: "text", type: "text", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, prompt, composer_content: "Write a caption" }] };
  const connectionsRef = { current: [] };
  const documentRef = { current: { id: "project", nodes: nodesRef.current } };
  const canvasOperationEpochRef = { current: 1 };
  const historyRef = { current: [] };
  const errors = [];
  const commits = [];
  let controller;
  let pollStarted;
  let rejectPoll;
  let resolvePoll;
  const polling = new Promise((resolve) => { pollStarted = resolve; });
  const dependencies = {
    nodesRef, documentRef, canvasOperationEpochRef, historyRef, mountedRef: { current: true },
    connectionsRef, activeGenerationsRef: { current: new Map() },
    canvasTextGenerationPlan, buildCanvasGenerationContext, appendCanvasHistorySnapshot,
    textModel: "gpt-5", textModels: ["gpt-5"], nextTokenNameForModel: () => "text-key",
    randomID: () => "test-id", MAX_HISTORY: 50, cloneDocument: structuredClone,
    captureDocument: () => ({ ...documentRef.current, nodes: nodesRef.current }),
    CANVAS_NODE_DEFAULT_SIZE: { text: { width: 340, height: 240 } },
    registerActiveGeneration: (value) => { controller = value; return {}; },
    replaceNodes: (value) => { nodesRef.current = value; }, replaceConnections: (value) => { connectionsRef.current = value; },
    canvasTextGenerationMessages: async () => [], createChatGenerationTask: async () => ({ id: "server-task" }),
    addActiveGenerationTask: () => {}, completeActiveGeneration: () => {},
    waitForTask: async () => { pollStarted(); return new Promise((resolve, reject) => { resolvePoll = resolve; rejectPoll = reject; }); },
    commitGenerationHistory: (value) => commits.push(value),
    toast: { error: (message) => errors.push(message), success: () => {} },
    ...overrides,
  };
  return {
    run: pageHandler("page.tsx", "runTextGeneration", dependencies), nodesRef, connectionsRef, documentRef, canvasOperationEpochRef, errors, commits, polling,
    abort: () => { controller.abort(); rejectPoll(new DOMException("Aborted", "AbortError")); },
    complete: () => resolvePoll({ id: "server-task", status: "success", data: [{ text_response: "Caption" }] }),
  };
}

test("text regeneration keeps the node and connections even with the new-node preference", async () => {
  const harness = textGenerationHarness("Previous result");
  const pending = harness.run("text");
  await harness.polling;
  assert.deepEqual(harness.nodesRef.current.map((node) => node.id), ["text"]);
  assert.equal(harness.nodesRef.current[0].prompt, "Previous result");
  assert.deepEqual(harness.connectionsRef.current, []);
  harness.nodesRef.current[0].composer_content = "Draft for the next request";
  harness.complete();
  await pending;
  assert.deepEqual(harness.nodesRef.current.map((node) => node.id), ["text"]);
  assert.equal(harness.nodesRef.current[0].prompt, "Caption");
  assert.equal(harness.nodesRef.current[0].composer_content, "Draft for the next request");
  assert.deepEqual(harness.connectionsRef.current, []);
  assert.deepEqual(harness.errors, []);
});

test("canvas starts with its sidebar closed and restores an explicit desktop preference", () => {
  for (const wide of [false, true]) {
    for (const stored of [null, { open: true }, { open: false }]) {
      const result = pageHandler("page.tsx", "storedCanvasSidePanel", {
        DEFAULT_SIDE_PANEL: { open: false, width: 304, tab: "canvas" }, SIDE_PANEL_STORAGE_KEY: "panel",
        window: { matchMedia: () => ({ matches: wide }), localStorage: { getItem: () => JSON.stringify(stored) } },
      })();
      assert.equal(result.open, wide && stored?.open === true);
      assert.equal(result.width, 304);
    }
    const result = pageHandler("page.tsx", "storedCanvasSidePanel", {
      DEFAULT_SIDE_PANEL: { open: false, width: 304, tab: "canvas" }, SIDE_PANEL_STORAGE_KEY: "panel",
      window: { matchMedia: () => ({ matches: wide }), localStorage: { getItem: () => { throw new Error("Storage denied"); } } },
    })();
    assert.equal(result.open, false);
  }
});

test("stopping canvas text generation clears loading without a failure toast", async () => {
  const harness = textGenerationHarness();
  const pending = harness.run("text");
  await harness.polling;
  harness.abort();
  await pending;
  assert.equal(harness.nodesRef.current[0].generation_status, "idle");
  assert.deepEqual(harness.errors, []);
});

test("a late text generation cannot commit history after a canvas switch", async () => {
  const harness = textGenerationHarness();
  const pending = harness.run("text");
  await harness.polling;
  const newNode = { id: "text", type: "text", prompt: "New project content" };
  harness.documentRef.current = { id: "other-project", nodes: [newNode] };
  harness.nodesRef.current = [newNode];
  harness.canvasOperationEpochRef.current += 1;
  harness.complete();
  await pending;
  assert.equal(harness.nodesRef.current[0], newNode);
  assert.deepEqual(harness.commits, []);
});

for (const kind of ["audio", "video", "panorama"]) {
  for (const outcome of ["success", "failure", "observation-failure", "terminal-failure"]) {
    test(outcome === "observation-failure" ? `an accepted ${kind} remains recoverable when observation is denied` : outcome === "terminal-failure" ? `an actual failed ${kind} task is terminal and preserves its server ID` : `late ${kind} ${outcome} cannot change a canvas restored by undo`, async () => {
      const original = { id: "media", type: kind, x: 0, y: 0, width: 340, height: 240, prompt: "Generate media" };
      const nodesRef = { current: [original] };
      const documentRef = { current: { id: "project" } };
      const canvasOperationEpochRef = { current: 1 };
      const commits = [];
      let notifyPoll;
      let finishPoll;
      let rejectPoll;
      const polling = new Promise((resolve) => { notifyPoll = resolve; });
      const dependencies = {
        videoModelRequiresHTTPSReferences,
        markCanvasGenerationRecoveryPending,
        applyCanvasVideoTaskProgressNodes, prepareImageEditReferences,
        nodesRef, documentRef, canvasOperationEpochRef, mountedRef: { current: true },
        connectionsRef: { current: [] }, activeGenerationsRef: { current: new Map() }, historyRef: { current: [] },
        runningNodeID: "", session: { key: "session" }, getCachedAuthSession: () => ({ key: "session" }),
        buildCanvasGenerationContext, canvasGenerationReferenceImageURLs, appendCanvasHistorySnapshot, cloneDocument: structuredClone, captureDocument: () => ({ id: "project", nodes: nodesRef.current }), MAX_HISTORY: 50,
        randomID: () => "random", createdAt: () => "now", nextTokenNameForModel: () => "key", imageGenerationPreferences: {},
        audioModel: "audio-model", audioModels: ["audio-model"], imageModel: "image-model", imageModels: ["image-model"], videoModels: ["video-model"],
        canvasAgentAudioNodeParameters: () => ({}), canvasAudioSettings: () => ({}), canvasAudioGenerationReferences: () => [], canvasAudioProvider: () => "openai", buildCanvasAudioGenerationRequest: () => ({}), canvasAudioResponseFormat: () => "mp3",
        imageReferenceImageLimit: () => 4, buildPanoramaPrompt: (prompt) => prompt, imageConversationReferenceLimitMessage: () => "", canvasImageParameters: () => ({}), panoramaGenerationCount: () => 1, panoramaGenerationQuality: () => "medium",
        supportsStructuredImageParameters: () => false, supportsImageOutputControls: () => false, supportsImageStreaming: () => false,
        PANORAMA_NODE_SIZE: { width: 340, height: 170 }, PANORAMA_IMAGE_SIZE: "2:1", summarizeCanvasTaskResult: task => ({ images: task.status === "error" ? [] : [{ url: "/image.png" }], error: task.error }),
        canvasVideoParameters: () => ({ generation_video_model: "video-model", generation_video_reference_urls: [], generation_video_reference_image_urls: [], generation_video_reference_audio_urls: [], generation_video_size: "16:9" }),
        applyCameraPrompt: (prompt) => prompt, supportsVideoFrameReferences: () => false, canvasVideoGenerationReferences: () => ({ referenceImageURLs: [] }), supportsVideoMultimodalReferences: () => false,
        videoMultimodalReferenceLimits: () => ({ video: 0, audio: 0 }), videoRequiresReferenceImage: () => false, canvasNodeSizeFromRatio: () => null, normalizeVideoRequest: () => ({}),
        CANVAS_NODE_DEFAULT_SIZE: { video: { width: 340, height: 240 } },
        registerActiveGeneration: () => ({}), addActiveGenerationTask: () => {}, completeActiveGeneration: () => {},
        replaceNodes: (value) => { nodesRef.current = value; }, replaceConnections: () => {}, setPanelNodeID: () => {}, setSelectedNodeIDs: () => {}, setSelectedConnectionID: () => {},
        scheduleSave: () => commits.push("save"), commitGenerationHistory: () => commits.push("history"),
        createAudioGenerationTask: async () => ({ id: "task" }), createVideoGenerationTask: async () => ({ id: "task" }), createImageGenerationTask: async () => ({ id: "task" }),
        waitForTask: async () => { notifyPoll(); return new Promise((resolve, reject) => { finishPoll = resolve; rejectPoll = reject; }); },
        persistCreationTaskOutputs: async (task) => task,
        toast: { error: (message) => commits.push(message), success: (message) => commits.push(message) },
      };
      const name = `run${kind[0].toUpperCase()}${kind.slice(1)}Generation`;
      const pending = pageHandler("page.tsx", name, dependencies)("media");
      await polling;
      if (outcome === "observation-failure") {
        rejectPoll(Object.assign(new Error("Session denied"), { status: 401 }));
        await pending;
        assert.equal(nodesRef.current[0].task_id, "task");
        assert.equal(canvasGenerationNeedsRecovery(nodesRef.current[0]), true);
        assert.ok(!commits.includes("Session denied"));
        return;
      }
      if (outcome === "terminal-failure") {
        finishPoll({ id: "task", status: "error", error: "Provider rejected generation", data: [] });
        await pending;
        assert.equal(nodesRef.current[0].task_id, "task");
        assert.equal(nodesRef.current[0].generation_status, "error");
        assert.equal(canvasGenerationNeedsRecovery(nodesRef.current[0]), false);
        return;
      }
      const restored = { ...original, url: "/restored.png", generation_status: "success" };
      nodesRef.current = [restored];
      canvasOperationEpochRef.current += 1;
      if (outcome === "success") finishPoll({ id: "task", status: "success", data: [{ url: "/late-result", audio_url: "/late-result", video_url: "/late-result" }] });
      else rejectPoll(new Error("Old task failed"));
      await pending;
      assert.equal(nodesRef.current[0], restored);
      assert.deepEqual(commits, []);
    });
  }
}

for (const kind of ["audio", "video", "panorama", "image"]) {
  test(`a ${kind} awaiting recovery cannot submit another task from its node panel`, async () => {
    const errors = [];
    const dependencies = {
      documentRef: { current: { id: "project" } }, canvasOperationEpochRef: { current: 1 }, mountedRef: { current: true },
      nodesRef: { current: [{ id: "media", type: kind, task_id: "accepted-task", generation_status: "error", generation_error: PENDING_CANVAS_GENERATION_RECOVERY_ERROR }] },
      activeGenerationsRef: { current: new Map() }, runningNodeID: "",
      buildCanvasGenerationContext: () => assert.fail("must block a new generation before inspecting inputs"),
      canvasVideoParameters: () => assert.fail("must block a new video before inspecting parameters"),
      fetchCreationTasks: async () => ({ items: [], missing_ids: ["accepted-task"] }),
      canvasGenerationModel: () => assert.fail("must block a new image before selecting a model"),
      toast: { error: message => errors.push(message) },
    };
    const name = kind === "image" ? "runGeneration" : `run${kind[0].toUpperCase()}${kind.slice(1)}Generation`;
    await pageHandler("page.tsx", name, dependencies)("media");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /同步/);
  });
}

test("an asset awaiting recovery cannot replace its binding with another paid generation", async () => {
  let created = 0;
  const errors = [];
  const asset = { id: "home", image_node_id: "original-image" };
  const generate = pageHandler("page.tsx", "generateScriptAssets", {
    nodesRef: { current: [
      { id: "script", type: "script", script_project: { assets: [asset] } },
      { id: "original-image", type: "image", task_id: "accepted-task", generation_status: "error", generation_error: PENDING_CANVAS_GENERATION_RECOVERY_ERROR },
    ] },
    scriptNodeRunning: () => false, scriptAssetImage: script.scriptAssetImage,
    imageModel: "image-model", imageModels: ["image-model"], nextTokenNameForModel: () => "fixture",
    canvasImageParameters: () => ({}), createScriptAssetNodes: () => { created++; return []; },
    toast: { error: message => errors.push(message) },
  });
  await generate("script", { assetIDs: ["home"], parameters: {}, prompt: "A rainy room" });
  assert.equal(created, 0);
  assert.match(errors.join(" "), /同步/);
});

test("duplicating a batch preview detaches ownership from original children", () => {
  const source = { id: "root", type: "image", x: 0, y: 0, batch_child_ids: ["a", "b"], batch_primary_id: "a" };
  const nodesRef = { current: [source] };
  pageHandler("page.tsx", "duplicateNode", {
    nodesRef, randomID: () => "copy", canvasNodeFallbackTitle: () => "Image", createdAt: () => "now",
    replaceNodes: (value) => { nodesRef.current = value; },
    setSelectedNodeIDs: () => {}, setSelectedConnectionID: () => {}, setPanelNodeID: () => {}, pushHistory: () => {},
  })("root");
  assert.equal(nodesRef.current[1].batch_child_ids, undefined);
  assert.equal(nodesRef.current[1].batch_primary_id, undefined);
  assert.equal(nodesRef.current[0], source);
});

test("successful bulk canvas deletion closes its confirmation dialog", async () => {
  let dialog = { mode: "delete", count: 1 };
  await pageHandler("library-page.tsx", "confirmDeleteSelectedProjects", {
    projects: [{ id: "project", revision: 1 }], selectedProjectIDs: new Set(["project"]), busy: false,
    setBusy: () => {}, mutateCanvasProjectList: async () => ({ projects: [], active_project_id: "" }),
    setProjects: () => {}, setActiveProjectID: () => {}, setSelectedProjectIDs: () => {},
    setProjectDialog: (value) => { dialog = value; }, toast: { success: () => {}, error: (error) => { throw new Error(error); } },
  })();
  assert.equal(dialog, null);
});

test("partially failed canvas deletion removes successful items before a retry", async () => {
  let projects = [{ id: "first", revision: 1 }, { id: "second", revision: 1 }];
  let activeProjectID = "first";
  let selected = new Set(["first", "second"]);
  let dialog;
  await pageHandler("library-page.tsx", "confirmDeleteSelectedProjects", {
    projects, selectedProjectIDs: selected, busy: false, setBusy: () => {},
    mutateCanvasProjectList: async ({ project_id }) => {
      if (project_id === "second") throw new Error("Conflict");
      return { projects: [{ id: "second", revision: 1 }], active_project_id: "second" };
    },
    setProjects: (value) => { projects = value; },
    setActiveProjectID: (value) => { activeProjectID = value; },
    setSelectedProjectIDs: (update) => { selected = update(selected); },
    setProjectDialog: (value) => { dialog = value; }, toast: { error: () => {} },
  })();
  assert.deepEqual(projects.map((item) => item.id), ["second"]);
  assert.equal(activeProjectID, "second");
  assert.deepEqual([...selected], ["second"]);
  assert.deepEqual(dialog, { mode: "delete", count: 1 });
});

test("config mentions leave IME confirmation keys to the input method", () => {
  const composingRef = { current: false };
  let selectedCount = 0;
  const handleKeyDown = pageHandler("canvas-config-composer.tsx", "onKeyDown", {
    composingRef, mention: {}, candidates: [{}], activeIndex: 0,
    getContentEditableMentionKeyAction: () => ({ type: "select" }), insertReference: () => { selectedCount += 1; },
  });
  const event = { key: "Enter", stopPropagation: () => {}, preventDefault: () => {}, nativeEvent: {} };
  handleKeyDown({ ...event, nativeEvent: { isComposing: true } });
  handleKeyDown({ ...event, keyCode: 229 });
  composingRef.current = true;
  handleKeyDown(event);
  assert.equal(selectedCount, 0);
  composingRef.current = false;
  handleKeyDown(event);
  assert.equal(selectedCount, 1);
});

test("canvas agent connection actions enforce the same node rules as manual connections", async () => {
  for (const [source, target, allowed] of [["group", "image", false], ["text", "director", false], ["image", "director", true]]) {
    const connectionsRef = { current: [] };
    const run = pageHandler("page.tsx", "executeCanvasAgentAction", {
      documentRef: { current: {} }, connectionsRef,
      nodesRef: { current: [{ id: "source", type: source }, { id: "target", type: target }] },
      canCreateCanvasConnection, randomID: () => "connection",
      replaceConnections: (value) => { connectionsRef.current = value; }, pushHistory: () => {},
    });
    const result = await run({ name: "create_connection", arguments: { fromNodeId: "source", toNodeId: "target" } }, []);
    assert.equal(result.ok, allowed, `${source} -> ${target}`);
    assert.equal(connectionsRef.current.length, allowed ? 1 : 0);
  }
});

function panoramaGenerationHarness({ reference = false, fetchReference, poll } = {}) {
  let sequence = 0;
  let controller;
  const nodesRef = { current: [{ id: "panorama", type: "panorama", x: 0, y: 0, width: 340, height: 170, prompt: "Scene" }] };
  const errors = [];
  const dependencies = {
    nodesRef, documentRef: { current: { id: "project" } }, canvasOperationEpochRef: { current: 1 }, mountedRef: { current: true },
    connectionsRef: { current: [] }, activeGenerationsRef: { current: new Map() }, historyRef: { current: [] },
    session: { key: "session" }, getCachedAuthSession: () => ({ key: "session" }),
    canvasGenerationReferenceImageURLs,
    markCanvasGenerationRecoveryPending,
    buildCanvasGenerationContext: () => ({ prompt: "Scene", referenceImageURLs: reference ? ["/reference.png"] : [] }),
    imageModel: "model", imageModels: ["model"], imageGenerationPreferences: {}, nextTokenNameForModel: () => "key",
    imageReferenceImageLimit: () => 4, buildPanoramaPrompt: (text) => text, supportsImageEditing: () => true,
    imageConversationReferenceLimitMessage: () => "", canvasImageParameters: () => ({}), panoramaGenerationCount: () => 2,
    panoramaGenerationQuality: () => "medium", supportsStructuredImageParameters: () => false,
    supportsImageOutputControls: () => false, supportsImageStreaming: () => false,
    PANORAMA_NODE_SIZE: { width: 340, height: 170 }, PANORAMA_IMAGE_SIZE: "2:1",
    randomID: () => String(++sequence), createdAt: () => "now", MAX_HISTORY: 50,
    appendCanvasHistorySnapshot, cloneDocument: structuredClone, captureDocument: () => ({ id: "project", nodes: nodesRef.current }),
    registerActiveGeneration: (value) => { controller = value; return {}; }, addActiveGenerationTask: () => {}, completeActiveGeneration: () => {},
    replaceNodes: (value) => { nodesRef.current = value; }, replaceConnections: () => {},
    setSelectedNodeIDs: () => {}, setSelectedConnectionID: () => {}, setPanelNodeID: () => {}, commitGenerationHistory: () => {},
    prepareImageEditReferences: (urls, mode, signal) => prepareImageEditReferences(urls, mode, signal, fetchReference),
    createImageGenerationTask: async (id) => ({ id }), createImageEditTask: async (id) => ({ id }),
    waitForTask: poll || (async () => ({ data: [{ url: "/result.png" }] })), persistCreationTaskOutputs: async (task) => task,
    summarizeCanvasTaskResult: (task) => ({ images: task.data || [], error: task.error }),
    toast: { error: (message) => errors.push(message), success: () => {} },
  };
  return { run: () => pageHandler("page.tsx", "runPanoramaGeneration", dependencies)("panorama"), nodesRef, errors, abort: () => controller.abort() };
}

test("a panorama batch adopts a completed image when its first output fails", async () => {
  let count = 0;
  const harness = panoramaGenerationHarness({ poll: async () => ++count === 1 ? { error: "Failed", data: [] } : { data: [{ url: "/second.png" }] } });
  await harness.run();
  const root = harness.nodesRef.current.find((node) => node.id === "panorama");
  assert.equal(root.generation_status, "success");
  assert.equal(root.url, "/second.png");
  assert.equal(harness.nodesRef.current.find((node) => node.id === root.batch_primary_id).url, root.url);
  assert.equal(harness.nodesRef.current.some((node) => node.generation_status === "loading"), false);
});

for (const completed of [false, true]) {
  test(`a panorama batch preserves interrupted observation alongside ${completed ? "a completed" : "a failed"} sibling`, async () => {
    let count = 0;
    const harness = panoramaGenerationHarness({ poll: async () => {
      if (++count === 1) throw new Error("Observation unavailable");
      return completed ? { data: [{ url: "/second.png" }] } : { error: "Provider failed", data: [] };
    } });
    await harness.run();
    const root = harness.nodesRef.current.find(node => node.id === "panorama");
    const child = harness.nodesRef.current.find(node => node.batch_root_id === "panorama" && canvasGenerationNeedsRecovery(node));
    assert.ok(child, "the accepted child must remain recoverable");
    assert.equal(child.generation_error, PENDING_CANVAS_GENERATION_RECOVERY_ERROR);
    if (completed) {
      assert.equal(root.url, "/second.png");
      assert.equal(root.generation_status, "success");
      assert.deepEqual(harness.errors, []);
    } else {
      assert.equal(root.task_id, child.task_id);
      assert.equal(canvasGenerationNeedsRecovery(root), true);
      assert.ok(!harness.errors.includes("全部全景图任务生成失败"));
    }
  });
}

for (const cancelled of [false, true]) {
  test(`panorama reference ${cancelled ? "cancellation" : "failure"} settles every placeholder`, async () => {
    let notifyStarted;
    let rejectReference;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const harness = panoramaGenerationHarness({ reference: true, fetchReference: () => {
      notifyStarted();
      return new Promise((_resolve, reject) => { rejectReference = reject; });
    } });
    const pending = harness.run();
    await started;
    if (cancelled) harness.abort();
    rejectReference(cancelled ? new DOMException("Aborted", "AbortError") : new Error("Missing reference"));
    await pending;
    assert.equal(harness.nodesRef.current.length, 3);
    assert.ok(harness.nodesRef.current.every((node) => node.generation_status === (cancelled ? "idle" : "error")));
    assert.equal(harness.errors.length, cancelled ? 0 : 1);
  });
}

test("canvas node scroll regions keep ordinary wheel input while modified wheel still zooms", () => {
  class Target {
    constructor(region) { this.region = region; }
    closest(selector) { return selector.includes(this.region) || selector.includes("[data-canvas-node]") ? this : null; }
  }
  for (const region of [".scroll-area-viewport", "[data-scrollable]", "[data-canvas-no-zoom]"]) {
    const viewportRef = { current: { x: 0, y: 0, zoom: 1 } };
    let prevented = 0, frames = 0;
    const wheel = pageHandler("canvas-engine.tsx", "handleWheel", {
      Element: Target, container: { getBoundingClientRect: () => ({ left: 0, top: 0, height: 800 }) },
      viewportRef, zoomCanvasViewport: (viewport) => ({ ...viewport, zoom: viewport.zoom + 1 }),
      wheelFrame: null, requestAnimationFrame: () => { frames++; return 1; },
    });
    const event = { target: new Target(region), clientX: 100, clientY: 100, deltaY: 100, deltaMode: 0,
      preventDefault() { prevented++; }, stopPropagation() {} };
    wheel(event);
    assert.equal(prevented, 0, region);
    assert.equal(frames, 0, region);
    assert.equal(viewportRef.current.zoom, 1, region);
    wheel({ ...event, ctrlKey: true });
    assert.equal(prevented, 1, region);
    assert.equal(frames, 1, region);
    assert.equal(viewportRef.current.zoom, 2, region);
  }
});

test("canvas click jitter leaves both node positions and viewport unchanged", () => {
  for (const kind of ["drag", "pan"]) {
    const handler = pageHandler("canvas-engine.tsx", "handleMove", {
      interactionPointerRef: { current: 7 },
      panRef: { current: { active: kind === "pan", startX: 100, startY: 100, moved: false } },
      dragRef: { current: { active: kind === "drag", startX: 100, startY: 100, moved: false } },
      scheduleFrame: () => assert.fail("Movement below the drag threshold must not mutate state"),
    });
    handler({ pointerId: 7, clientX: 102, clientY: 101 });
  }
});

test("a second pointer cannot move or finish the active canvas gesture", () => {
  for (const name of ["handleMove", "handleUp"]) {
    const interactionPointerRef = { current: 7 };
    const handler = pageHandler("canvas-engine.tsx", name, { interactionPointerRef });
    handler({ pointerId: 8, type: "pointerup", clientX: 400, clientY: 400 });
    assert.equal(interactionPointerRef.current, 7);
  }
});

function canvasGestureFrames() {
  const scheduled = new Map();
  let sequence = 0;
  const frameRef = { current: null };
  const cancelPendingFrame = pageHandler("canvas-engine.tsx", "cancelPendingFrame", {
    frameRef, cancelAnimationFrame: id => scheduled.delete(id),
  });
  const scheduleFrame = pageHandler("canvas-engine.tsx", "scheduleFrame", {
    frameRef, cancelPendingFrame,
    requestAnimationFrame: callback => { const id = ++sequence; scheduled.set(id, callback); return id; },
  });
  return { scheduled, scheduleFrame };
}

test("canvas connection drag batches hit testing to the latest animation frame", () => {
  const { scheduled, scheduleFrame } = canvasGestureFrames();
  const hits = [];
  const targets = [];
  const handler = pageHandler("canvas-engine.tsx", "handleMove", {
    interactionPointerRef: { current: 7 },
    panRef: { current: { active: false } },
    dragRef: { current: { active: false } },
    resizeRef: { current: { active: false } },
    connectionRef: { current: { nodeID: "from", handleType: "source" } },
    selectionRef: { current: null },
    scheduleFrame,
    applyConnectionDrag: (x, y) => hits.push([x, y]),
    applySelectionDrag: () => assert.fail("Connection movement must not update selection"),
  });
  for (let x = 0; x < 20; x++) handler({ pointerId: 7, clientX: x, clientY: x + 1 });
  assert.equal(hits.length, 0, "pointer events must not perform hit testing synchronously");
  assert.equal(scheduled.size, 1, "only one animation callback may remain pending");
  scheduled.values().next().value();
  assert.deepEqual(hits, [[19, 20]], "the next frame must use the latest pointer coordinates");
});

test("canvas selection drag batches geometry scans to the latest animation frame", () => {
  const { scheduled, scheduleFrame } = canvasGestureFrames();
  const scans = [];
  const handler = pageHandler("canvas-engine.tsx", "handleMove", {
    interactionPointerRef: { current: 7 },
    panRef: { current: { active: false } },
    dragRef: { current: { active: false } },
    resizeRef: { current: { active: false } },
    connectionRef: { current: null },
    selectionRef: { current: { start: { x: 0, y: 0 }, current: { x: 0, y: 0 }, initialIDs: new Set(), additive: false } },
    scheduleFrame,
    applyConnectionDrag: () => assert.fail("Selection movement must not hit connection targets"),
    applySelectionDrag: (x, y) => scans.push([x, y]),
  });
  for (let x = 0; x < 20; x++) handler({ pointerId: 7, clientX: x, clientY: x + 1 });
  assert.equal(scans.length, 0, "pointer events must not scan canvas nodes synchronously");
  assert.equal(scheduled.size, 1, "only one animation callback may remain pending");
  scheduled.values().next().value();
  assert.deepEqual(scans, [[19, 20]], "the next frame must use the latest pointer coordinates");
});

function canvasNodeDragHarness(initial, current, movingIDs = new Set(["a"]), visibleIDs = new Set(current.map(node => node.id))) {
  const connections = [{ from_node_id: "a", to_node_id: "b" }];
  const nodesRef = { current };
  const connectionIndex = buildCanvasConnectionIndex(connections, new Map(current.map(node => [node.id, node])));
  const targets = [];
  const guides = [];
  let alignmentBuilds = 0;
  const dependencies = {
    connections, nodesRef, connectionIndexRef: { current: connectionIndex },
    connectionNodeIDsRef: { current: visibleIDs },
    dragRef: { current: { active: true, moved: true, clickedNodeID: "a", startX: 0, startY: 0, initial: initial.filter(node => movingIDs.has(node.id)), movingIDs, nodesSnapshot: initial } },
    viewportRef: { current: { x: 0, y: 0, zoom: 1 } }, alignmentRef: { current: createCanvasAlignmentContext(initial, movingIDs) }, snapToGrid: false,
    calculateCanvasAlignment, createCanvasAlignmentContext: (...args) => { alignmentBuilds++; return createCanvasAlignmentContext(...args); },
    updateCanvasConnectionGeometry, findCanvasGroupDropTargetForNodes, findContainingCanvasGroupID, snapCanvasNodesIntoGroup,
    setAlignmentGuides: value => guides.push(value), setDropTargetGroupID: id => targets.push(id),
    onNodesChange: nodes => { nodesRef.current = nodes; },
    interactionPointerRef: { current: 7 }, panRef: { current: { active: false } },
    resizeRef: { current: { active: false } }, connectionRef: { current: null }, selectionRef: { current: null },
    cancelPendingFrame() {}, onNodesCommit() {}, syncToolCursor() {},
  };
  dependencies.draggedNodesAt = pageHandler("canvas-engine.tsx", "draggedNodesAt", dependencies);
  dependencies.updateDraggedConnectionIndex = pageHandler("canvas-engine.tsx", "updateDraggedConnectionIndex", dependencies);
  return {
    nodesRef, connectionIndex, targets, guides,
    get alignmentBuilds() { return alignmentBuilds; },
    move: pageHandler("canvas-engine.tsx", "applyNodeDrag", dependencies),
    release: (x, y) => pageHandler("canvas-engine.tsx", "handleUp", dependencies)({ pointerId: 7, type: "pointerup", clientX: x, clientY: y }),
  };
}

test("drag alignment refreshes media dimensions and reuses targets on subsequent movement", () => {
  const initial = [
    { id: "a", type: "image", x: 0, y: 0, width: 100, height: 100 },
    { id: "target", type: "image", x: 500, y: 300, width: 100, height: 100 },
  ];
  const current = initial.map(node => node.id === "a" ? { ...node, width: 200 } : node);
  const harness = canvasNodeDragHarness(initial, current);
  harness.move(294, 70);
  assert.equal(harness.nodesRef.current[0].x, 300);
  assert.equal(harness.guides.at(-1).vertical, 500);
  assert.equal(harness.alignmentBuilds, 1);
  harness.move(295, 80);
  assert.equal(harness.nodesRef.current[0].x, 300, "alignment bounds must remain anchored to the original coordinates");
  assert.equal(harness.alignmentBuilds, 1, "ordinary movement must reuse the sorted targets");
});

test("drag alignment uses current targets after nodes move, appear or disappear", () => {
  const a = { id: "a", type: "image", x: 0, y: 0, width: 100, height: 100 };
  const target = { id: "target", type: "image", x: 500, y: 300, width: 100, height: 100 };
  for (const [initial, current, pointerX, expectedX, guide] of [
    [[a, target], [a, { ...target, x: 750 }], 644, 650, 750],
    [[a, target], [a], 394, 394, undefined],
    [[a], [a, target], 394, 400, 500],
  ]) {
    const harness = canvasNodeDragHarness(initial, current);
    harness.move(pointerX, 70);
    assert.equal(harness.nodesRef.current[0].x, expectedX);
    assert.equal(harness.guides.at(-1).vertical, guide);
  }
});

test("dragging uses current media dimensions for connection culling and group hit testing", () => {
  const initial = [
    { id: "a", type: "image", x: 0, y: 0, width: 100, height: 100 },
    { id: "b", type: "image", x: 700, y: 0, width: 100, height: 100 },
    { id: "group", type: "group", x: 450, y: 0, width: 200, height: 300 },
  ];
  const current = initial.map(node => node.id === "a" ? { ...node, width: 400, height: 200, title: "loaded media" } : node);
  for (const finish of ["move", "release"]) {
    const harness = canvasNodeDragHarness(initial, current);
    harness[finish](300, 0);
    assert.equal(harness.nodesRef.current[0].width, 400);
    assert.equal(harness.nodesRef.current[0].title, "loaded media");
    if (finish === "move") {
      assert.equal(harness.targets.at(-1), "group", "group hit testing must use the current node center");
      const geometry = new Map(harness.nodesRef.current.map(node => [node.id, node]));
      assert.equal(canvasConnectionIndexMatchesGeometry(harness.connectionIndex, geometry), true);
      assert.deepEqual(harness.connectionIndex.bounds, buildCanvasConnectionIndex(harness.connectionIndex.connections, geometry).bounds);
    } else {
      assert.equal(harness.nodesRef.current[0].group_id, "group");
    }
  }
});

test("dragging never restores a deleted selected node in the connection index", () => {
  const initial = ["a", "b"].map((id, index) => ({ id, type: "image", x: index * 500, y: 0, width: 100, height: 100 }));
  const harness = canvasNodeDragHarness(initial, initial.slice(0, 1), new Set(["a", "b"]));
  harness.move(100, 0);
  assert.equal(harness.connectionIndex.geometryByNode.has("b"), false);
  assert.equal(harness.connectionIndex.bounds[0], undefined);
  assert.equal(canvasConnectionIndexMatchesGeometry(harness.connectionIndex, new Map(harness.nodesRef.current.map(node => [node.id, node]))), true);
});

test("releasing a drag uses current groups after a group is removed, moved or added", () => {
  const node = { id: "a", type: "image", x: 0, y: 0, width: 100, height: 100 };
  const group = { id: "group", type: "group", x: 300, y: 0, width: 300, height: 300 };
  for (const [initial, current, expected] of [
    [[node, group], [node], undefined],
    [[node, group], [node, { ...group, x: 1000 }], undefined],
    [[node], [node, group], group.id],
    [[node, { ...group, x: 1000 }], [node, group], group.id],
  ]) {
    const harness = canvasNodeDragHarness(initial, current);
    harness.move(300, 0);
    assert.equal(harness.targets.at(-1), expected || "");
    harness.release(300, 0);
    assert.equal(harness.nodesRef.current[0].group_id, expected);
    if (!expected) assert.equal(harness.nodesRef.current[0].x, 300, "removed or distant groups must not pull the node back");
  }
});

test("current group hit testing excludes hidden groups and never nests dragged groups", () => {
  const nodes = [
    { id: "a", type: "image", x: 0, y: 0, width: 100, height: 100 },
    { id: "group", type: "group", x: 300, y: 0, width: 300, height: 300 },
  ];
  const hidden = canvasNodeDragHarness(nodes, nodes, new Set(["a"]), new Set(["a"]));
  hidden.move(300, 0);
  assert.equal(hidden.targets.at(-1), "");
  hidden.release(300, 0);
  assert.equal(hidden.nodesRef.current[0].group_id, undefined);
  const withMember = [{ ...nodes[0], x: 350, group_id: "group" }, nodes[1]];
  const moved = canvasNodeDragHarness(withMember, withMember, new Set(["a", "group"]));
  moved.move(300, 0);
  assert.equal(moved.targets.at(-1), "");
  moved.release(300, 0);
  assert.equal(moved.nodesRef.current[1].x, 600, "group translation must be applied only once");
  assert.equal(moved.nodesRef.current[0].group_id, "group", "members stay inside the translated group");
});

test("resizing never restores a deleted node in the connection index", () => {
  const start = { id: "a", type: "text", x: 0, y: 0, width: 300, height: 200 };
  const remaining = [{ id: "b", type: "text", x: 700, y: 0, width: 300, height: 200 }];
  const connections = [{ from_node_id: "a", to_node_id: "b" }];
  const index = buildCanvasConnectionIndex(connections, new Map(remaining.map(node => [node.id, node])));
  let result;
  const resize = pageHandler("canvas-engine.tsx", "applyNodeResize", {
    resizeRef: { current: { active: true, corner: "bottom-right", node: start } }, nodesRef: { current: remaining },
    screenToWorld: (x, y) => ({ x, y }),
    updateDraggedConnectionIndex: (geometry, snapshot) => updateCanvasConnectionGeometry(index, geometry, snapshot),
    onNodesChange: nodes => { result = nodes; },
  });
  resize(500, 500);
  assert.equal(index.geometryByNode.has("a"), false);
  assert.equal(index.bounds[0], undefined);
  assert.deepEqual(result, remaining);
});

test("cancelling a pan persists the last rendered viewport without using cancellation coordinates", () => {
  const saved = [];
  const viewport = { x: 80, y: 40, zoom: 1 };
  const interactionPointerRef = { current: 7 };
  const handler = pageHandler("canvas-engine.tsx", "handleUp", {
    interactionPointerRef, viewportRef: { current: viewport },
    panRef: { current: { active: true, moved: true, startX: 100, startY: 100 } },
    dragRef: { current: { active: false } }, resizeRef: { current: { active: false } },
    selectionRef: { current: null }, connectionRef: { current: null },
    syncToolCursor: () => {}, cancelPendingFrame: () => {},
    onViewportChange: (...args) => saved.push(args),
  });
  handler({ pointerId: 7, type: "pointercancel", clientX: 0, clientY: 0 });
  assert.deepEqual(saved, [[viewport, true]]);
  assert.equal(interactionPointerRef.current, null);
});

test("cancelling a canvas connection drag never creates an edge", () => {
  const created = [];
  const connectionRef = { current: { nodeID: "from", handleType: "source" } };
  const handler = pageHandler("canvas-engine.tsx", "handleUp", {
    interactionPointerRef: { current: 7 },
    panRef: { current: { active: false } }, dragRef: { current: { active: false } }, resizeRef: { current: { active: false } },
    selectionRef: { current: null }, connectionRef, syncToolCursor: () => {}, cancelPendingFrame: () => {},
    screenToWorld: () => assert.fail("Cancellation coordinates must not be used for hit testing"), connectionTargetAt: () => assert.fail("Cancellation must not resolve a target"),
    connectionFor: () => ({ sourceID: "from", targetID: "to" }), setConnectionTargetID: () => {}, setConnecting: () => {},
    onConnect: (...args) => created.push(args),
  });
  handler({ pointerId: 7, type: "pointercancel", clientX: 100, clientY: 100 });
  assert.deepEqual(created, []);
  assert.equal(connectionRef.current, null);
});

for (const cancelled of [false, true]) {
  test(`selection ${cancelled ? "cancellation discards" : "release applies"} the pending pointer position`, () => {
    const selected = [];
    let pending = true;
    const selectionRef = { current: { start: { x: 0, y: 0 }, current: { x: 10, y: 10 } } };
    const interactionPointerRef = { current: 7 };
    pageHandler("canvas-engine.tsx", "handleUp", {
      interactionPointerRef, selectionRef,
      panRef: { current: { active: false } }, dragRef: { current: { active: false } }, resizeRef: { current: { active: false } },
      connectionRef: { current: null }, syncToolCursor: () => {},
      cancelPendingFrame: () => { pending = false; },
      applySelectionDrag: (x, y) => { assert.equal(pending, false); selected.push([x, y]); },
      setSelectionBox: value => assert.equal(value, null),
    })({ pointerId: 7, type: cancelled ? "pointercancel" : "pointerup", clientX: 40, clientY: 50 });
    assert.deepEqual(selected, cancelled ? [] : [[40, 50]]);
    assert.equal(pending, false);
    assert.equal(selectionRef.current, null);
    assert.equal(interactionPointerRef.current, null);
  });
}

test("canvas project dialog ignores resubmission while a mutation is pending", () => {
  let submissions = 0;
  pageHandler("canvas-project-dialog.tsx", "submit", { busy: true, editable: true, draft: "Project", onConfirm: () => { submissions += 1; } })();
  assert.equal(submissions, 0);
});

test("copying one child of a group produces a pasteable detached node", async () => {
  const child = { id: "child", type: "text", group_id: "group", x: 10, y: 10, width: 340, height: 240, scale_x: 1, scale_y: 1 };
  const clipboardRef = { current: null };
  await pageHandler("page.tsx", "copySelected", {
    nodesRef: { current: [{ ...child, id: "group", type: "group", group_id: undefined }, child] },
    connectionsRef: { current: [] }, selectedNodeIDs: new Set(["child"]), clipboardRef,
    expandCanvasBatchNodeIDs, expandCanvasGroupNodeIDs,
    copyClipboardText: async () => {}, toast: { success: () => {} },
  })();
  assert.equal(clipboardRef.current.nodes.length, 1);
  assert.equal(clipboardRef.current.nodes[0].group_id, undefined);
  assert.ok(normalizeCanvasClipboard(clipboardRef.current));
  assert.equal(child.group_id, "group");
});

test("initial Agent requests remain durable until submission and assets remain attachments", async () => {
  const original = { id: "original", type: "text", prompt: "Before request" };
  const request = { prompt: "Use this asset", assets: [{ nodeId: "asset", payload: { kind: "text", title: "Brief", content: "Asset" }, reference: { id: "asset", label: "文本1" } }] };
  const nodesRef = { current: [original] };
  const documentRef = { current: { id: "project", pending_agent_request: request } };
  const canvasOperationEpochRef = { current: 1 };
  const initialRequests = [];
  const run = pageHandler("page.tsx", "consumePendingAgentRequest", {
    nodesRef, documentRef, mountedRef: { current: true }, canvasOperationEpochRef,
    canvasAgentStarterAttachment, DEFAULT_AGENT_PANEL: {}, scheduleSave: () => {},
    setAgentOpen: () => {}, setInitialAgentRequest: (value) => initialRequests.push(value),
  });
  await run(request, "project", 1);
  await run(request, "project", 1);
  assert.deepEqual(nodesRef.current, [original]);
  assert.equal(documentRef.current.pending_agent_request, request);
  assert.equal(initialRequests[0].references[0].source, "attachment");
  assert.equal(initialRequests[0].references[0].text, "Asset");
  assert.equal(initialRequests[0].references[0].id, initialRequests[1].references[0].id);
  const consume = pageHandler("page.tsx", "onInitialRequestConsumed", { documentRef, renderedCanvasID: "project", setInitialAgentRequest: () => {}, scheduleSave: () => {} });
  consume();
  assert.equal(documentRef.current.pending_agent_request, undefined);
});

test("typing a node title keeps the insertion caret after the initial selection", () => {
  const file = "canvas-engine.tsx";
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/app/canvas/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("titleInputRef.current?.select()")) effect = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(effect);
  const code = ts.transpileModule(effect.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const render = new Function("useEffect", "editingTitle", "finishTitleEditing", "titleInputRef", "window", code);
  let previousDependencies;
  let selections = 0;
  const useEffect = (callback, dependencies) => {
    if (!previousDependencies || dependencies.some((value, index) => value !== previousDependencies[index])) callback();
    previousDependencies = dependencies;
  };
  const input = { current: { focus: () => {}, select: () => { selections += 1; } } };
  const window = { addEventListener: () => {}, removeEventListener: () => {} };
  render(useEffect, true, () => {}, input, window);
  for (const _character of "Updated title") render(useEffect, true, () => {}, input, window);
  assert.equal(selections, 1);
});

test("Agent recovery waits for active submissions and streamed results without generating again", async () => {
  for (const status of ["loading", "success"]) {
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const node = { id: "saved-node", type: "image", generation_status: status, url: status === "success" ? "/streamed.png" : "", task_id: "local-submitting-task" };
    const nodesRef = { current: [node] };
    const run = pageHandler("page.tsx", "executeCanvasAgentAction", {
      nodesRef, connectionsRef: { current: [] }, documentRef: { current: { agent_config: { autoGenerateMedia: true } } },
      activeGenerationsRef: { current: new Map([[node.id, { settled, submittedTaskIDs: new Set() }]]) },
      normalizeCanvasAgentConfig, summarizeCanvasAgentTask,
      runGeneration: () => { throw new Error("must not generate again"); },
      recoverCanvasTasks: () => { throw new Error("must not query a client task before submission completes"); },
    });
    let completed = false;
    const pending = run({ name: "generate_node", arguments: { nodeId: node.id } }, []).then((result) => { completed = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(completed, false);
    nodesRef.current = [{ ...node, task_id: "confirmed-task", url: "/result.png", generation_status: "success" }];
    settle();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.taskId, "confirmed-task");
    assert.equal(result.status, "success");
  }
});

test("generation confirmation preserves custom approval instead of forcing deferral", () => {
  for (const [answer, expected] of [["确认生成这三张白底图", "generate"], ["稍后再生成，先整理文案", "defer"], ["先修改一下构图", undefined]]) {
    let submitted;
    const choose = pageHandler("canvas-agent-panel.tsx", "chooseMediaGeneration", {
      activeSession: { messages: [{ id: "user", role: "user", references: [] }, { id: "assistant", role: "assistant" }] },
      canvasAgentQuestionMediaChoice,
      retryMessage: () => { throw new Error("custom answers must retain their text"); },
      submit: (...args) => { submitted = args; },
    });
    choose(answer);
    assert.equal(submitted[0], answer);
    assert.equal(submitted[3].mediaGenerationChoice, expected);
  }
});

test("generation choices report acceptance so rejected answers remain editable", () => {
  for (const accepted of [true, false]) {
    const choose = pageHandler("canvas-agent-panel.tsx", "chooseMediaGeneration", {
      activeSession: { messages: [{ id: "user", role: "user" }, { id: "assistant", role: "assistant" }] },
      canvasAgentQuestionMediaChoice,
      retryMessage: () => accepted,
      submit: () => accepted ? "started" : "missing-model",
    });
    for (const answer of ["立即生成", "暂不生成，继续规划", "确认生成这三张白底图"]) assert.equal(choose(answer), accepted);
  }
});

test("Agent node references reveal the canvas on narrow screens without closing desktop panels", () => {
  for (const [width, visibleWidth, closes] of [[320, 0, true], [390, 390, true], [1200, 780, false]]) {
    const focused = [];
    let closed = false;
    const focus = pageHandler("page.tsx", "focusAgentCanvasNode", {
      agentAreaRef: { current: { clientWidth: width, clientHeight: 900 } },
      agentOpen: true, canvasSize: { width: visibleWidth, height: 900 }, CANVAS_AGENT_WIDTH: 420,
      closeAgentPanel: () => { closed = true; },
      focusCanvasNode: (...args) => focused.push(args),
    });
    focus("result");
    assert.equal(closed, closes);
    assert.deepEqual(focused, closes ? [["result", { width, height: 900 }]] : [["result"]]);
  }
});

test("Agent generation choice overrides manual mode without changing global configuration", async () => {
  for (const autoGenerateMedia of [false, true]) {
    for (const generateMedia of [false, true]) {
      const node = { id: "saved-node", type: "image", prompt: "保留提示词", generation_status: "idle" };
      const nodesRef = { current: [node] };
      const documentRef = { current: { agent_config: { autoGenerateMedia } } };
      let submitted = 0;
      const run = pageHandler("page.tsx", "executeCanvasAgentAction", {
        nodesRef, connectionsRef: { current: [] }, documentRef,
        activeGenerationsRef: { current: new Map() }, normalizeCanvasAgentConfig, summarizeCanvasAgentTask,
        runGeneration: async (_id, _prompt, _retry, options) => {
          submitted++;
          nodesRef.current = [{ ...node, generation_status: "success", url: "/generated.png", task_id: "generated-task" }];
          options.onSubmitted("generated-task");
        },
      });
      const result = await run({ name: "generate_node", arguments: { nodeId: node.id } }, [], { generateMedia });
      assert.equal(result.ok, true);
      assert.equal(result.submitted, generateMedia);
      assert.equal(submitted, generateMedia ? 1 : 0);
      assert.equal(documentRef.current.agent_config.autoGenerateMedia, autoGenerateMedia);
      assert.equal(nodesRef.current.length, 1);
      assert.equal(nodesRef.current[0].prompt, node.prompt);
    }
  }
});

test("Agent generation respects manual mode and reports the actual submitted task state", async () => {
  installVideoModelContracts(structuredClone(contractDocument.contracts));
  for (const name of ["generate_image", "edit_image", "generate_video", "generate_audio"]) {
    for (const [configuredSize, requestedSize, aspect] of name === "generate_video" ? [["16:9", "9:16", 9 / 16], ["9:16", "1:1", 1], ["9:16", "16:9", 16 / 9]] : [[undefined, undefined, undefined]]) {
      for (const autoGenerateMedia of [false, true]) {
        for (const waitForMedia of [undefined, false]) {
          let finishGeneration;
          const generationCompletion = new Promise((resolve) => { finishGeneration = resolve; });
          const source = { id: "reference", type: "image", url: "/reference.png" };
          const nodesRef = { current: [source] }, connectionsRef = { current: [] };
          let submitted = 0, history = 0;
          const dependencies = {
            nodesRef, connectionsRef, documentRef: { current: { agent_config: { autoGenerateMedia } } }, selectedNodeIDsRef: { current: new Set() },
            normalizeCanvasAgentConfig, summarizeCanvasAgentTask, activeGenerationsRef: { current: new Map() },
            imageModel: "image-model", videoModel: "seedance2.0-A", audioModel: "audio-model",
            imageModels: ["image-model"], videoModels: ["seedance2.0-A"], audioModels: ["audio-model"],
            nextTokenNameForModel: () => autoGenerateMedia ? "key" : "",
            resolvedAgentConfig: { autoGenerateMedia, videoSize: configuredSize }, canvasNodeSizeFromRatio, canvasVideoParameters: () => ({ generation_video_size: "16:9" }), imageGenerationPreferences: { canvas_default_image_count: 1 },
            resolveCanvasAgentMediaSettings, canvasAgentAttachmentURLs, canvasAgentSourceNodeIDs: () => ["reference"], canvasAgentMediaLayoutSources: (_kind, _nodes, sources) => sources,
            canvasAgentNodePosition: (size) => ({ x: 100, y: 200 - size.height / 2 }), canvasCenterPosition: () => ({ x: 0, y: 0 }),
            canvasNodeFallbackTitle: (kind) => kind, randomID: () => "generated", createdAt: () => "now",
            CANVAS_NODE_DEFAULT_SIZE: { image: { width: 300, height: 300 }, video: { width: 400, height: 225 }, audio: { width: 320, height: 100 } },
            getCanvasAgentContext: () => ({ generation: { videoSeconds: 8, videoGenerateAudio: false } }),
            validateCanvasAgentVideoSeconds: () => "", canvasAgentVideoSupportsAudio: () => true,
            preferredCanvasImageParameters: () => ({}), canvasAgentAudioNodeParameters: () => ({}),
            buildVideoNode: (fields, point) => ({ id: "generated-video", type: "video", ...fields, ...point }),
            replaceNodes: (nodes) => { nodesRef.current = nodes; }, replaceConnections: (edges) => { connectionsRef.current = edges; },
            setSelectedNodeIDs: () => {}, setSelectedConnectionID: () => {}, pushHistory: () => { history += 1; },
            runGeneration: async (id, _prompt, _retry, options) => {
              submitted += 1;
              nodesRef.current = nodesRef.current.map((node) => node.id === id ? { ...node, task_id: "confirmed-task", generation_status: "loading" } : node);
              options.onSubmitted?.("confirmed-task");
              if (waitForMedia === false) await generationCompletion;
              nodesRef.current = nodesRef.current.map((node) => node.id === id ? { ...node, url: "/generated.png", generation_status: "success" } : node);
            },
          };
          const run = pageHandler("page.tsx", "executeCanvasAgentAction", dependencies);
          const result = await run({ name, arguments: { prompt: "保留参考细节", title: "成品", size: requestedSize || "1:1", count: 1, seconds: 8, generateAudio: false } }, [], { waitForMedia });
          finishGeneration();
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(result.submitted, autoGenerateMedia);
          assert.equal(result.status, autoGenerateMedia ? waitForMedia === false ? "loading" : "success" : "idle");
          if (autoGenerateMedia && waitForMedia === false) assert.equal(result.taskId, "confirmed-task");
          assert.equal(submitted, autoGenerateMedia ? 1 : 0);
          assert.equal(nodesRef.current.length, 2);
          assert.equal(nodesRef.current[1].prompt, "保留参考细节");
          if (name === "generate_video") {
            const node = nodesRef.current[1];
            assert.ok(Math.abs(node.width / node.height - aspect) < 0.0001);
            assert.equal(node.generation_video_size, requestedSize || configuredSize || "16:9");
            assert.equal(node.y, 200 - node.height / 2);
          }
          assert.equal(connectionsRef.current.length, 1);
          assert.equal(connectionsRef.current[0].from_node_id, "reference");
          assert.equal(history, 1);
        }
      }
    }
  }
});

function canvasHistoryLeaseHarness({ expired = false, expiresDuringSave = false, serverAcceptsLease = true, dirty = true, textOnlyHistory = false } = {}) {
  let now = Date.parse("2026-09-15T12:00:00Z");
  const until = new Date(now + (expired ? -1000 : 60_000)).toISOString();
  const documentRef = { current: {
    id: "project", revision: 1, title: "Current canvas", connections: [],
    nodes: [{ id: "current", type: "text", prompt: "Keep current content" }],
    retained_storage_object_ids: ["undo-file", "redo-file", "generation-file"],
    retained_storage_object_urls: ["https://media.example/undo.png", "https://media.example/redo.png", "https://media.example/generation.png"],
    retained_storage_objects_until: until,
  } };
  const historicalDocument = (name) => ({
    id: "project", nodes: [textOnlyHistory
      ? { id: name, type: "text", prompt: `Example server:${name}-file and https://media.example/${name}.png` }
      : { id: name, type: "image", storage_key: `server:${name}-file`, url: `https://media.example/${name}.png` }], connections: [],
  });
  const historyRef = { current: [historicalDocument("undo"), structuredClone(documentRef.current)] };
  const redoRef = { current: [historicalDocument("redo")] };
  const generationHistoryBaseRef = { current: [historicalDocument("generation")] };
  const originalHistory = { history: historyRef.current, redo: redoRef.current, generation: generationHistoryBaseRef.current };
  const requests = [], stateAtSave = [], timers = new Map();
  const saveChangeVersionRef = { current: dirty ? 2 : 1 }, persistedChangeVersionRef = { current: 1 };
  let timerID = 0, historyVersion = 0, fits = 0, persist;
  const dependencies = {
    documentRef, historyRef, redoRef, generationHistoryBaseRef, saveChangeVersionRef, persistedChangeVersionRef,
    serverDocumentRef: { current: structuredClone(documentRef.current) }, mergeCanvasDocuments,
    titleRef: { current: documentRef.current.title }, setTitle: () => {},
    replaceNodes: (nodes) => { documentRef.current.nodes = nodes; }, replaceConnections: (connections) => { documentRef.current.connections = connections; },
    storedCanvasAgentSessions: (document) => document.agent_sessions || [], setAgentSessions: () => {}, setActiveAgentSessionID: () => {}, setBackendAgentRun: () => {},
    fitCanvasContent: () => { fits += 1; },
    storedCanvasAgentConfig: () => null, setAgentConfig: () => {},
    defaultCanvasModelsRef: { current: { imageModel: "", textModel: "", videoModel: "" } },
    setImageModel: () => {}, setTextModel: () => {}, setVideoModel: () => {},
    loadedRef: { current: true }, mountedRef: { current: true }, canvasDocumentEpochRef: { current: 0 },
    saveTimerRef: { current: null }, saveRequestVersionRef: { current: 0 }, saveQueueRef: { current: Promise.resolve() },
    canvasSaveRequired, canvasHistoryStorageObjectIDs, canvasHistoryStorageObjectURLs,
    canvasHistoryLeaseExpired: (document) => canvasHistoryLeaseExpired(document, now),
    captureDocument: () => ({ ...documentRef.current }), cloneDocument: structuredClone,
    setHistoryVersion: (update) => { historyVersion = update(historyVersion); },
    setProjects: (update) => update([{ id: "project" }]),
    window: { setTimeout: (callback) => { timers.set(++timerID, callback); return timerID; }, clearTimeout: (id) => timers.delete(id) },
    saveCanvasDocument: async (payload) => {
      requests.push(structuredClone(payload));
      stateAtSave.push(structuredClone({ history: historyRef.current, redo: redoRef.current, generation: generationHistoryBaseRef.current }));
      if (expiresDuringSave) now += 120_000;
      return { document: {
        ...payload, revision: 2, updated_at: "2026-09-15T12:00:01Z",
        retained_storage_object_ids: serverAcceptsLease ? payload.retained_storage_object_ids : [],
        retained_storage_object_urls: serverAcceptsLease ? payload.retained_storage_object_urls : [],
        retained_storage_objects_until: serverAcceptsLease && (payload.retained_storage_object_ids.length || payload.retained_storage_object_urls.length) ? until : undefined,
      } };
    },
    canvasErrorMessage: (error) => error.message,
    toast: { error: (message) => assert.fail(message) },
  };
  const scheduleSave = pageHandler("page.tsx", "scheduleSave", { ...dependencies, persistCanvas: () => persist() });
  const expire = pageHandler("page.tsx", "expireCanvasHistoryLease", { ...dependencies, scheduleSave });
  const applyBackendDocument = pageHandler("page.tsx", "applyBackendAgentDocument", dependencies);
  persist = pageHandler("page.tsx", "persistCanvas", { ...dependencies, expireCanvasHistoryLease: expire, applyBackendAgentDocument: applyBackendDocument });
  const commit = pageHandler("page.tsx", "commitGenerationHistory", { ...dependencies, expireCanvasHistoryLease: expire, scheduleSave, commitCanvasGenerationHistory, MAX_HISTORY: 50 });
  return { persist, expire, commit, applyBackendDocument, fitCount: () => fits, documentRef, historyRef, redoRef, generationHistoryBaseRef, originalHistory, requests, stateAtSave, timers, saveChangeVersionRef, persistedChangeVersionRef, advanceTime: (milliseconds) => { now += milliseconds; }, historyVersion: () => historyVersion };
}

test("newly completed agent arrangement fits the canvas once and later progress preserves the viewport", () => {
  const harness = canvasHistoryLeaseHarness();
  const document = structuredClone(harness.documentRef.current);
  document.revision = 2;
  document.agent_sessions = [{id:"session",messages:[{id:"assistant",trace:[{id:"arrange",type:"operation",status:"running",tool:{name:"arrange_nodes"}}]}]}];
  harness.applyBackendDocument(document);
  assert.equal(harness.fitCount(),0);
  document.revision = 3;
  document.agent_sessions[0].messages[0].trace[0].status = "success";
  harness.applyBackendDocument(document);
  assert.equal(harness.fitCount(),1);
  document.revision = 4;
  document.title = "Later progress";
  harness.applyBackendDocument(document);
  assert.equal(harness.fitCount(),1);
  document.revision = 5;
  document.agent_sessions[0].messages[0].trace.push({id:"arrange-again",type:"operation",status:"success",tool:{name:"arrange_nodes"}});
  harness.applyBackendDocument(document);
  assert.equal(harness.fitCount(),2);
  document.revision = 6;
  harness.applyBackendDocument(document);
  assert.equal(harness.fitCount(),2);
});

test("saving an expired canvas history lease removes old undo, redo, and generation files before sending", async () => {
  const harness = canvasHistoryLeaseHarness({ expired: true, dirty: false });
  assert.equal(await harness.persist(), true);
  assert.equal(harness.requests.length, 1, "expiry must save even when the canvas was otherwise clean");
  assert.deepEqual(harness.requests[0].retained_storage_object_ids, []);
  assert.deepEqual(harness.requests[0].retained_storage_object_urls, []);
  assert.equal(harness.requests[0].retained_storage_objects_until, undefined);
  assert.deepEqual(harness.stateAtSave[0].history.map((snapshot) => snapshot.nodes.map((node) => node.id)), [["current"]]);
  assert.deepEqual(harness.stateAtSave[0].redo, []);
  assert.equal(harness.stateAtSave[0].generation, null);
  assert.equal(harness.historyRef.current.length, 1);
  assert.equal(harness.documentRef.current.nodes[0].prompt, "Keep current content");
  assert.equal(harness.historyVersion(), 1);
  assert.equal(harness.persistedChangeVersionRef.current, harness.saveChangeVersionRef.current);
  assert.equal(harness.timers.size, 0);
});

test("a lease that expires while saving clears history when the server refuses renewal", async () => {
  const harness = canvasHistoryLeaseHarness({ serverAcceptsLease: false, expiresDuringSave: true });
  assert.equal(await harness.persist(), true);
  assert.deepEqual(harness.requests[0].retained_storage_object_ids, ["generation-file", "redo-file", "undo-file"]);
  assert.equal(harness.requests[0].retained_storage_object_urls.length, 3);
  assert.equal(harness.stateAtSave[0].history.length, 2);
  assert.deepEqual(harness.historyRef.current.map((snapshot) => snapshot.nodes.map((node) => node.id)), [["current"]]);
  assert.deepEqual(harness.redoRef.current, []);
  assert.equal(harness.generationHistoryBaseRef.current, null);
  assert.deepEqual(harness.documentRef.current.retained_storage_object_ids, []);
  assert.deepEqual(harness.documentRef.current.retained_storage_object_urls, []);
  assert.equal(harness.documentRef.current.retained_storage_objects_until, undefined);
  assert.equal(harness.historyVersion(), 1);
});

test("a valid accepted canvas file lease preserves undo, redo, and generation history", async () => {
  const harness = canvasHistoryLeaseHarness();
  assert.equal(harness.expire(), false);
  assert.equal(await harness.persist(), true);
  assert.equal(harness.historyRef.current, harness.originalHistory.history);
  assert.equal(harness.redoRef.current, harness.originalHistory.redo);
  assert.equal(harness.generationHistoryBaseRef.current, harness.originalHistory.generation);
  assert.deepEqual(harness.requests[0].retained_storage_object_ids, ["generation-file", "redo-file", "undo-file"]);
  assert.deepEqual(harness.requests[0].retained_storage_object_urls, ["https://media.example/generation.png", "https://media.example/redo.png", "https://media.example/undo.png"]);
  assert.equal(harness.documentRef.current.retained_storage_objects_until, "2026-09-15T12:01:00.000Z");
  assert.equal(harness.historyVersion(), 0);
  assert.equal(harness.timers.size, 0);
});

test("filtering nonexistent file references does not discard unexpired text history", async () => {
  const harness = canvasHistoryLeaseHarness({ serverAcceptsLease: false, textOnlyHistory: true });
  assert.equal(await harness.persist(), true);
  assert.deepEqual(harness.requests[0].retained_storage_object_ids, ["generation-file", "redo-file", "undo-file"]);
  assert.equal(harness.documentRef.current.retained_storage_objects_until, undefined);
  assert.deepEqual(harness.documentRef.current.retained_storage_object_ids, []);
  assert.deepEqual(harness.documentRef.current.retained_storage_object_urls, []);
  assert.equal(harness.historyRef.current, harness.originalHistory.history);
  assert.equal(harness.redoRef.current, harness.originalHistory.redo);
  assert.equal(harness.generationHistoryBaseRef.current, harness.originalHistory.generation);
  assert.equal(harness.historyVersion(), 0);
});

for (const tracked of [false, true]) {
  for (const expiryTrigger of ["visibility", "completion", "save response"]) {
    test(`a delayed ${tracked ? "tracked" : "parallel"} generation cannot restore history expired by ${expiryTrigger}`, async () => {
      const harness = canvasHistoryLeaseHarness({ serverAcceptsLease: false, expiresDuringSave: expiryTrigger === "save response" });
      const capturedBase = harness.historyRef.current;
      harness.generationHistoryBaseRef.current = tracked ? capturedBase : null;
      let finish;
      const pending = new Promise((resolve) => { finish = resolve; }).then(() => harness.commit(capturedBase));
      if (expiryTrigger === "save response") await harness.persist();
      else {
        harness.advanceTime(24 * 60 * 60 * 1000);
        if (expiryTrigger === "visibility") assert.equal(harness.expire(), true);
      }
      harness.documentRef.current = { ...harness.documentRef.current, nodes: [{ id: "completed", type: "text", prompt: "Generated result" }] };
      finish();
      await pending;
      assert.deepEqual(canvasHistoryStorageObjectIDs(harness.historyRef.current), []);
      assert.deepEqual(canvasHistoryStorageObjectURLs(harness.historyRef.current), []);
      assert.equal(harness.historyRef.current.at(-1).nodes[0].prompt, "Generated result");
      assert.equal(harness.generationHistoryBaseRef.current, null);
      await harness.persist();
      assert.deepEqual(harness.requests.at(-1).retained_storage_object_ids, []);
      assert.deepEqual(harness.requests.at(-1).retained_storage_object_urls, []);
    });
  }
}

test("valid parallel generation history keeps its undo snapshots and another active generation baseline", () => {
  const harness = canvasHistoryLeaseHarness();
  const capturedBase = harness.historyRef.current;
  const activeBase = [...capturedBase];
  harness.generationHistoryBaseRef.current = activeBase;
  harness.historyRef.current = [...capturedBase, { ...harness.documentRef.current, title: "Temporary result" }];
  harness.documentRef.current = { ...harness.documentRef.current, title: "Completed result" };
  harness.commit(capturedBase);
  assert.equal(harness.historyRef.current[0], capturedBase[0]);
  assert.equal(harness.historyRef.current.at(-1).title, "Completed result");
  assert.deepEqual(canvasHistoryStorageObjectURLs(harness.historyRef.current), ["https://media.example/undo.png"]);
  assert.equal(harness.generationHistoryBaseRef.current, activeBase);
});

test("an expired generation completion preserves a newer generation baseline", () => {
  const harness = canvasHistoryLeaseHarness();
  const expiredBase = harness.historyRef.current;
  harness.advanceTime(24 * 60 * 60 * 1000);
  harness.expire();
  const activeBase = harness.historyRef.current;
  harness.generationHistoryBaseRef.current = activeBase;
  harness.documentRef.current = { ...harness.documentRef.current, title: "Late completion" };
  harness.commit(expiredBase);
  assert.equal(harness.generationHistoryBaseRef.current, activeBase);
  assert.deepEqual(canvasHistoryStorageObjectURLs(harness.historyRef.current), []);
});

test("desktop leave synchronously registers a save promise and waits for edits arriving during save", async () => {
  const saveChangeVersionRef = { current: 1 };
  let finishFirstSave, saves = 0;
  const firstSave = new Promise((resolve) => { finishFirstSave = resolve; });
  const handle = pageHandler("page.tsx", "flushCanvasBeforeLeave", {
    flushCanvasSaves, saveChangeVersionRef, documentRef: { current: { id: "project" } },
    persistCanvas: async () => { saves += 1; return saves === 1 ? firstSave : true; },
  });
  const pending = [];
  handle({ detail: pending });
  assert.equal(pending.length, 1);
  assert.ok(pending[0] instanceof Promise);
  saveChangeVersionRef.current += 1;
  finishFirstSave(true);
  await Promise.all(pending);
  assert.equal(saves, 2);
});

test("desktop leave rejects failed canvas saves and ignores unrelated events", async () => {
  let saves = 0;
  const handle = pageHandler("page.tsx", "flushCanvasBeforeLeave", {
    flushCanvasSaves, saveChangeVersionRef: { current: 1 }, documentRef: { current: { id: "project" } },
    persistCanvas: async () => { saves += 1; return false; },
  });
  handle({});
  handle({ detail: {} });
  assert.equal(saves, 0);
  const pending = [];
  handle({ detail: pending });
  assert.equal(pending.length, 1);
  await assert.rejects(pending[0], /画布保存失败/);
  assert.equal(saves, 1);
});

test("generation checkpoint waits for its snapshot without waiting for later edits", async () => {
  let finishSave;
  let saves = 0;
  let version = 0;
  const documentRef = { current: { id: "project" } };
  const handler = pageHandler("page.tsx", "persistGenerationCheckpoint", {
    documentRef,
    scheduleSave: () => { version++; },
    persistCanvas: () => { saves++; return new Promise((resolve) => { finishSave = resolve; }); },
  });
  const pending = handler();
  assert.equal(version, 1);
  version++;
  finishSave(true);
  await pending;
  assert.equal(saves, 1);
});

test("generation checkpoint rejects a failed save or a changed canvas", async () => {
  const documentRef = { current: { id: "project" } };
  const handler = pageHandler("page.tsx", "persistGenerationCheckpoint", {
    documentRef,
    scheduleSave: () => {},
    persistCanvas: async () => false,
  });
  await assert.rejects(handler(), /执行记录保存失败/);
  const switched = pageHandler("page.tsx", "persistGenerationCheckpoint", {
    documentRef,
    scheduleSave: () => {},
    persistCanvas: async () => { documentRef.current.id = "other"; return true; },
  });
  await assert.rejects(switched(), /执行记录保存失败/);
});

test("blank video nodes use the effective model ratio before generation", () => {
  for (const [ratio, aspect] of [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["720x1280", 9 / 16]]) {
    const build = pageHandler("page.tsx", "buildVideoNode", {
      canvasVideoParameters: (parent) => ({ generation_video_model: parent.generation_video_model, generation_video_size: ratio }),
      canvasNodeSizeFromRatio, CANVAS_NODE_DEFAULT_SIZE: { video: { width: 420, height: 236 } },
      videoModel: "model", randomID: () => "video", createdAt: () => "now",
    });
    const node = build({ prompt: "draft" }, { x: 10, y: 20 });
    assert.equal(node.generation_video_size, ratio);
    assert.ok(Math.abs(node.width / node.height - aspect) < 0.0001);
    assert.equal(node.x, 10);
    assert.equal(node.y, 20);
  }
});

test("chat task HTTP bodies preserve explicit streaming choices for both protocols", async () => {
  const requests = [];
  const create = pageHandler("../../lib/api.ts", "createChatGenerationTask", {
    creationTaskRequestAuth: () => ({}), httpRequest: async (path, request) => { requests.push({ path, ...request }); return { id: "task" }; },
  });
  for (const apiMode of ["chat", "responses"]) {
    for (const stream of [undefined, false, true]) {
      await create({ clientTaskId: "task", prompt: "hello", apiMode, stream });
      const request = requests.at(-1);
      assert.equal(request.path, "/api/creation-tasks/chat-completions");
      assert.equal(request.body.api_mode, apiMode);
      assert.equal(request.body.stream, stream);
      assert.equal(Object.hasOwn(request.body, "stream"), stream !== undefined);
    }
  }
});

test("Agent prompt references preserve @ as part of the atomic serialized token", () => {
  const escapeRegExp = pageHandler("canvas-agent-prompt-chip-input.tsx", "escapeRegExp", {});
  const parse = pageHandler("canvas-agent-prompt-chip-input.tsx", "parsePromptTokens", { escapeRegExp });
  const labels = ["图片1", "图片10", "视频2", "素材(1)"];
  const value = "参考 @图片10\n图片1 与 @视频2 @图片100 @未知 @素材(1)";
  const tokens = parse(value, labels);
  assert.deepEqual(tokens.filter((token) => token.type === "reference"), [
    { type: "reference", label: "图片10", value: "@图片10" },
    { type: "reference", label: "图片1", value: "图片1" },
    { type: "reference", label: "视频2", value: "@视频2" },
    { type: "reference", label: "素材(1)", value: "@素材(1)" },
  ]);
  assert.equal(tokens.map((token) => token.value).join(""), value);
  assert.deepEqual(parse("@图片10", ["图片1"]), [{ type: "text", value: "@图片10" }]);
});


test("manual video creation centers the actual frame at the requested position", () => {
  for (const ratio of ["16:9", "9:16", "1:1"]) {
    let point;
    const dimensions = { width: 420, height: 236 };
    const create = pageHandler("page.tsx", "createCanvasNode", {
      CANVAS_NODE_DEFAULT_SIZE: { video: dimensions }, videoModel: "video-model", canvasNodeSizeFromRatio,
      canvasVideoParameters: () => ({ generation_video_size: ratio }),
      addBlankVideoNodeAt: (value) => { point = value; }, placement: () => ({ x: 40, y: 50 }),
    });
    create("video", { x: 100, y: 200 });
    const size = canvasNodeSizeFromRatio(ratio, dimensions.width, dimensions.height);
    assert.equal(point.x + size.width / 2, 100);
    assert.equal(point.y + size.height / 2, 200);
    create("video");
    assert.deepEqual(point, { x: 40, y: 50 });
  }
});

test("text generation persists the original node and task ID before submitting", async () => {
  let saved;
  const harness = textGenerationHarness("", {
    persistGenerationCheckpoint: async () => { saved = structuredClone(harness.nodesRef.current); },
    createChatGenerationTask: async (request) => {
      assert.equal(saved.length, 1);
      assert.equal(saved[0].generation_status, "loading");
      assert.equal(saved[0].task_id, request.clientTaskId);
      return { id: request.clientTaskId };
    },
  });
  const pending = harness.run("text");
  await harness.polling;
  harness.complete();
  await pending;
  assert.deepEqual(harness.errors, []);
});

test("a failed generation checkpoint cannot submit a text task", async () => {
  let submissions = 0;
  const harness = textGenerationHarness("", {
    persistGenerationCheckpoint: async () => { throw new Error("保存失败"); },
    createChatGenerationTask: async () => { submissions++; return { id: "unexpected" }; },
  });
  await harness.run("text");
  assert.equal(submissions, 0);
  assert.equal(harness.nodesRef.current[0].generation_status, "error");
  assert.match(harness.errors.join(" "), /保存失败/);
});

test("refresh recovery observes a late submission instead of replacing its task", async () => {
  const progress = [];
  const pending = [];
  const errors = [];
  const recover = pageHandler("page.tsx", "recoverCanvasTasks", {
    fetchCreationTasks: async () => ({ items: [], missing_ids: ["original-task"] }),
    isCurrentCanvasRecovery: () => true,
    waitForCreationTask: async (id, options) => {
      assert.equal(id, "original-task");
      options.onProgress({ id, status: "running" });
      return { id, status: "success", data: [{ text_response: "Recovered" }] };
    },
    persistCreationTaskOutputs: async (task) => task,
    applyRecoveredCanvasTask: (task) => { progress.push(task); return { terminal: task.status === "success" }; },
    markCanvasTaskRecoveryPending: (id) => pending.push(id),
    markCanvasTaskRecoveryError: (...args) => errors.push(args),
  });
  await recover("project", 1, ["original-task"], "session", new AbortController().signal);
  assert.deepEqual(progress.map((task) => task.status), ["running", "success"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(pending, []);
});

test("denied observation preserves the original task for recovery instead of declaring generation failure", async () => {
  for (const stage of ["snapshot", "stream"]) {
    const pending = [], failures = [];
    const denied = Object.assign(new Error("Session unavailable"), { status: 401 });
    const recover = pageHandler("page.tsx", "recoverCanvasTasks", {
      fetchCreationTasks: async () => {
        if (stage === "snapshot") throw denied;
        return { items: [{ id: "paid-task", status: "running" }] };
      },
      isRetryableTaskPollError: () => false,
      CreationTaskTimeoutError: class extends Error {},
      isCurrentCanvasRecovery: () => true,
      applyRecoveredCanvasTask: () => ({ terminal: false }),
      waitForCreationTask: async () => { throw denied; },
      markCanvasTaskRecoveryPending: id => pending.push(id),
      markCanvasTaskRecoveryError: id => failures.push(id),
    });
    await recover("project", 1, ["paid-task"], "session", new AbortController().signal);
    assert.deepEqual(pending, ["paid-task"]);
    assert.deepEqual(failures, []);
  }
});

test("regenerating a shot pending task recovery never creates another paid task", async () => {
  const harness = scriptMediaGenerationHarness("video");
  const node = { id: "pending-video", type: "video", task_id: "paid-task", generation_status: "error", generation_error: "暂时无法同步后台任务，重新进入画布后将继续恢复。" };
  harness.shot.video_node_id = node.id;
  harness.nodesRef.current.push(node);
  await harness.run(undefined, true);
  assert.deepEqual(harness.submissions, []);
  assert.match(harness.errors.join(" "), /已有任务.*同步/);
  assert.equal(harness.nodesRef.current.length, 3);
});

test("scoped canvas fitting excludes remote historical media and preserves authored content", () => {
  const nodes = [
    { id: "script", x: 0, y: 0, width: 550, height: 600 },
    { id: "current", x: 700, y: 0, width: 480, height: 600 },
    { id: "historical", x: 90000, y: 90000, width: 480, height: 600 },
  ];
  const original = structuredClone(nodes), updates = [], cancelled = [];
  const focusAnimationRef = { current: 42 };
  const fit = pageHandler("page.tsx", "fitCanvasContent", {
    nodesRef: { current: nodes }, visibleCanvasNodes: value => value,
    canvasSize: { width: 390, height: 844 }, CANVAS_MIN_ZOOM: .05,
    focusAnimationRef, window: { cancelAnimationFrame: id => cancelled.push(id) },
    resetViewport: () => assert.fail("nonempty content must not reset"),
    updateViewport: (...args) => updates.push(args),
  });
  fit(nodes.slice(0, 2), { width: 1440, height: 1000 });
  const [viewport, save] = updates[0];
  assert.ok(viewport.zoom > .9);
  assert.ok(viewport.x >= 0);
  assert.equal(save, true);
  assert.deepEqual(cancelled, [42]);
  assert.equal(focusAnimationRef.current, null);
  assert.deepEqual(nodes, original);
  fit();
  assert.equal(updates[1][0].zoom, .05);
});

test("focusing a current shot inside a collapsed batch reveals the original node without replacing its media", () => {
  const child = { id: "current-shot", type: "image", batch_root_id: "batch", x: 100, y: 160, width: 360, height: 640, url: "/current.png" };
  const nodes = [{ id: "batch", type: "image", batch_expanded: false, batch_child_ids: [child.id] }, child, { id: "history", url: "/old.png" }];
  const original = structuredClone(nodes), nodesRef = { current: nodes }, selections = [], viewports = [];
  const focus = pageHandler("page.tsx", "focusCanvasNode", {
    nodesRef, canvasSize: { width: 390, height: 844 }, CANVAS_MIN_ZOOM: .05,
    replaceNodes: value => { nodesRef.current = value; },
    selectionChanged: value => selections.push([...value]),
    animateCanvasViewport: value => viewports.push(value),
  });
  focus(child.id);
  assert.equal(nodesRef.current[0].batch_expanded, true);
  assert.deepEqual(nodesRef.current.slice(1), original.slice(1));
  assert.deepEqual(selections, [[child.id]]);
  assert.ok(viewports[0].zoom > .5, "the phone must focus the actual shot at a readable size");
  const after = nodesRef.current;
  focus(child.id);
  assert.equal(nodesRef.current, after, "an already expanded batch must not be rewritten");
  focus("missing");
  assert.equal(viewports.length, 2);
});

test("script production navigation follows current bindings and visible batch roots without selecting historical versions", () => {
  const scriptNode = { id: "script", script_project: {
    assets: [{ image_node_id: "asset" }, { image_node_id: "missing" }],
    shots: [{ image_node_id: "image", video_node_id: "video" }, { image_node_id: "image", video_node_id: "batch-child" }],
    merged_video_node_id: "movie",
  } };
  const nodes = [scriptNode, { id: "asset" }, { id: "image" }, { id: "video" }, { id: "movie" },
    { id: "old-image" }, { id: "old-video" }, { id: "old-movie" }, { id: "unrelated" },
    { id: "batch-child", batch_root_id: "batch" }, { id: "batch", batch_expanded: false },
  ];
  const before = structuredClone(nodes);
  assert.deepEqual(canvasScriptProductionNodes(scriptNode, nodes).map(node => node.id), ["script", "asset", "image", "video", "batch", "movie"]);
  assert.deepEqual(nodes, before);
  const expanded = nodes.map(node => node.id === "batch" ? { ...node, batch_expanded: true } : node);
  assert.deepEqual(canvasScriptProductionNodes(scriptNode, expanded).map(node => node.id), ["script", "asset", "image", "video", "batch-child", "movie"]);
  const replacement = { ...scriptNode, script_project: { ...scriptNode.script_project, shots: [{ image_node_id: "old-image", video_node_id: "old-video" }] } };
  assert.deepEqual(canvasScriptProductionNodes(replacement, nodes).map(node => node.id), ["script", "asset", "old-image", "old-video", "movie"]);
});

test("script production navigation closes a covering mobile Agent and preserves desktop panels and canvas data", () => {
  for (const [width, visibleWidth, closes] of [[320, 0, true], [390, 390, true], [1200, 780, false]]) {
    const scriptNode = { id: "script", script_project: { assets: [], shots: [{ video_node_id: "current" }] } };
    const nodes = [scriptNode, { id: "current" }, { id: "history" }];
    const before = structuredClone(nodes), fits = [], selection = [], modal = [];
    let closed = false;
    const focus = pageHandler("page.tsx", "focusScriptProduction", {
      nodesRef: { current: nodes }, canvasScriptProductionNodes,
      agentAreaRef: { current: { clientWidth: width, clientHeight: 900 } },
      agentOpen: true, canvasSize: { width: visibleWidth, height: 900 }, CANVAS_AGENT_WIDTH: 420,
      closeAgentPanel: () => { closed = true; },
      setOpenScriptNodeID: value => modal.push(value),
      selectionChanged: ids => selection.push([...ids]),
      fitCanvasContent: (...args) => fits.push(args),
    });
    focus("missing");assert.equal(fits.length, 0);
    focus("script");assert.equal(closed, closes);
    assert.deepEqual(fits, closes ? [[[scriptNode, nodes[1]], { width, height: 900 }]] : [[[scriptNode, nodes[1]]]]);
    assert.deepEqual(selection, [["script"]]);assert.deepEqual(modal, [""]);
    assert.deepEqual(nodes, before);
  }
});

test("batch shot creation reserves each new media rectangle before placing the next shot", async () => {
  for (const type of ["image", "video"]) {
    const harness = scriptMediaGenerationHarness(type);
    const first = harness.project.shots[0];
    Object.assign(first, { ...structuredClone(harness.shot), id: first.id });
    harness.nodesRef.current.push({ id: "blocking-history", type, x: 620, y: 0, width: 1000, height: 1800 });
    if (type === "video") {
      const build = pageHandler("page.tsx", "buildVideoNode", harness.dependencies);
      harness.dependencies.buildVideoNode = (...args) => ({ ...build(...args), width: 420, height: 746 });
    }
    await harness.run([first.id, harness.shot.id]);
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.submissions.length, 2);
    const outputs = harness.submissions.map(id => harness.nodesRef.current.find(node => node.id === id));
    for (const output of outputs) {
      const overlapping = harness.nodesRef.current.filter(node => node.id !== output.id && node.type !== "group" && output.x < node.x + node.width + 24 && output.x + output.width + 24 > node.x && output.y < node.y + node.height + 24 && output.y + output.height + 24 > node.y);
      assert.deepEqual(overlapping.map(node => node.id), [], `${type}: generated node overlaps another node`);
    }
    assert.deepEqual(outputs.map(node => node.title), ["Story · 第 1 镜", "Story · 第 2 镜"]);
  }
});

test("opening an internally merged movie preserves its original media attributes without supplier-generation defaults", () => {
  const movie = { id: "movie", type: "video", generation_model: "local-video-merge", generation_video_model: "local-video-merge", url: "/movie.mp4", media_metadata: { duration_ms: 60000, width: 768, height: 1376, has_audio: true } };
  const normalize = pageHandler("page.tsx", "normalizeCanvasVideoNode", { canvasVideoParameters: () => assert.fail("A merged file has no supplier-generation parameters to normalize") });
  assert.equal(normalize(movie), movie);
  const text = { id: "text", type: "text" };assert.equal(normalize(text), text);
  const video = { id: "video", type: "video", generation_video_model: "minimax-H3-super" };
  const normalVideo = pageHandler("page.tsx", "normalizeCanvasVideoNode", { canvasVideoParameters: () => ({generation_video_model:"minimax-H3-super",generation_video_audio:true}) });
  assert.equal(normalVideo(video).generation_video_audio,true);
});

function scriptTextSynthesisHarness() {
  const project=script.createScriptProject();project.shots=project.shots.slice(0,1);project.shots[0].description='主角在门外停下';
  const source={id:'script',type:'script',prompt:'雨夜，无字幕。全片服装一致。',script_project:project};
  const nodesRef={current:[source]},connectionsRef={current:[]},errors=[],requests=[],writes=[];
  let finish;
  const completed=new Promise(resolve=>{finish=resolve;});
  const dependencies={...script,nodesRef,connectionsRef,buildCanvasGenerationContext,
    scriptNodeRunning:()=>false,textModel:'text-model',textModels:['text-model'],nextTokenNameForModel:()=> 'fixture-token',
    documentRef:{current:{id:'project'}},canvasOperationEpochRef:{current:1},mountedRef:{current:true},
    registerActiveGeneration:()=>({}),replaceNodes:nodes=>{nodesRef.current=nodes;},randomID:()=> 'request',
    canvasTextGenerationMessages:async instruction=>[{role:'user',content:instruction}],
    createChatGenerationTask:async request=>{requests.push(request);return{id:'task'};},
    addActiveGenerationTask(){},scheduleSave(){},waitForTask:()=>completed,completeActiveGeneration(){},
    updateScriptProject:(_id,project)=>{writes.push(project);return true;},pushHistory(){},
    toast:{error:value=>errors.push(value),success(){}},
  };
  const run=pageHandler('page.tsx','runScriptTextGeneration',dependencies);
  const resolve=()=>finish({status:'success',data:[{text_response:JSON.stringify({shots:[{id:project.shots[0].id,image_prompt:'新分镜',video_prompt:'新视频'}]})}]});
  return {source,project,nodesRef,connectionsRef,errors,requests,writes,run:()=>run(source.id,'prompts',[project.shots[0].id]),resolve};
}

test('smart script synthesis includes the effective story requirements in the actual text request',async()=>{
 const h=scriptTextSynthesisHarness();const pending=h.run();await new Promise(resolve=>setImmediate(resolve));h.resolve();await pending;
 assert.equal(h.requests.length,1);assert.ok(h.requests[0].prompt.includes(h.source.prompt));assert.equal(h.writes.length,1);assert.deepEqual(h.errors,[]);
});

test('script synthesis cannot apply prompts after the story or connected requirements change',async()=>{
 for(const change of ['story','upstream']){
  const h=scriptTextSynthesisHarness();
  if(change==='upstream'){
   h.nodesRef.current.push({id:'requirement',type:'text',prompt:'原始要求'});
   h.connectionsRef.current.push({id:'input',from_node_id:'requirement',to_node_id:'script'});
  }
  const pending=h.run();await new Promise(resolve=>setImmediate(resolve));
  if(change==='story')h.nodesRef.current=h.nodesRef.current.map(n=>n.id==='script'?{...n,prompt:'白昼，改为另一场景'}:n);
  else h.nodesRef.current=h.nodesRef.current.map(n=>n.id==='requirement'?{...n,prompt:'新上游要求：不得使用旧剧情'}:n);
  h.resolve();await pending;assert.equal(h.writes.length,0);assert.match(h.errors.join(' '),/输入|故事|变更/);
 }
});

test('smart synthesis maps only attached images to asset IDs and excludes old output URLs and review records',async()=>{
 const h=scriptTextSynthesisHarness();
 h.project.assets=[
  {id:'hero',kind:'character',name:'主角',description:'雨衣',image_node_id:'hero-image'},
  {id:'unready',kind:'prop',name:'未生成道具',description:'茶杯',image_node_id:'missing-image'},
  {id:'scene',kind:'scene',name:'雨夜走廊',description:'夜景',image_node_id:'scene-image'},
 ];
 h.nodesRef.current.push({id:'hero-image',type:'image',url:'/hero.png'},{id:'scene-image',type:'image',url:'/scene.png'});
 Object.assign(h.project.shots[0],{image_node_id:'old-board',video_node_id:'old-video',image_prompt:'旧分镜提示词',video_prompt:'旧视频提示词',quality_review:{media_url:'/private-output.mp4',continuity:'unchecked',dialogue:'unchecked',speaker:'unchecked',lip_sync:'unchecked',notes:'旧成片评价'}});
 const promptMessages=[];
 // Inspect the same image collection supplied to the actual text request.
 const original=pageHandler('page.tsx','runScriptTextGeneration',{
  ...script,nodesRef:h.nodesRef,connectionsRef:h.connectionsRef,buildCanvasGenerationContext,
  scriptNodeRunning:()=>false,textModel:'text-model',textModels:['text-model'],nextTokenNameForModel:()=> 'fixture-token',
  documentRef:{current:{id:'project'}},canvasOperationEpochRef:{current:1},mountedRef:{current:true},registerActiveGeneration:()=>({}),
  replaceNodes:nodes=>{h.nodesRef.current=nodes;},randomID:()=> 'request',
  canvasTextGenerationMessages:async(prompt,urls)=>{promptMessages.push({prompt,urls});return[];},
  createChatGenerationTask:async()=>({id:'task'}),addActiveGenerationTask(){},scheduleSave(){},
  waitForTask:async()=>({status:'success',data:[{text_response:JSON.stringify({shots:[{id:h.project.shots[0].id,image_prompt:'新分镜',video_prompt:'新视频'}]})}]}),
  completeActiveGeneration(){},updateScriptProject:()=>true,pushHistory(){},toast:{error:e=>assert.fail(e),success(){}},
 });
 await original('script','prompts',[h.project.shots[0].id]);
 assert.equal(promptMessages.length,1);const {prompt,urls}=promptMessages[0];
 assert.deepEqual(urls,['/hero.png','/scene.png']);
 const data=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
 assert.deepEqual(data.reference_assets,['hero','scene']);assert.equal(data.story,h.source.prompt);
 assert.equal(data.assets.length,3);assert.equal(data.shots.length,1);
 assert.ok(!prompt.includes('/private-output.mp4'));assert.ok(!prompt.includes('旧成片评价'));assert.ok(!prompt.includes('old-board'));assert.ok(!prompt.includes('旧视频提示词'));
});

test('multimodal text synthesis embeds authenticated managed images even when their stored host is public',async()=>{
 const fetched=[];const signal=new AbortController().signal;
 class Reader{readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;this.onload();}).catch(error=>this.onerror(error));}}
 const convert=pageHandler('page.tsx','canvasReferenceDataURL',{
  isPublicReferenceURL,isManagedImageURL:url=>new URL(url,'https://canvas.example.com').pathname.startsWith('/images/'),
  fetchAuthenticatedImageBlob:async(url,receivedSignal)=>{fetched.push(url);assert.equal(receivedSignal,signal);return new Blob(['fixture-image'],{type:'image/png'});},FileReader:Reader,
 });
 const managed='http://canvas.example.com:8002/images/fixture.png';
 const converted=await convert(managed,signal);assert.equal(converted,'data:image/png;base64,Zml4dHVyZS1pbWFnZQ==');assert.deepEqual(fetched,[managed]);
 assert.equal(await convert('https://external.example.com/frame.png',signal),'https://external.example.com/frame.png');assert.equal(fetched.length,1);
});

function concurrentHistoryHarness(overrides = {}) {
 const state = {phase: 'intake', approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: []};
 const session = {id: 's', title: 'Conversation', createdAt: 'now', updatedAt: 'now', messages: [{id: 'u', role: 'user', text: 'base'}], protocolMessages: [{role: 'user', messageID: 'u', content: 'base'}], agentState: state};
 const base = {id: 'project', revision: 1, title: 'Canvas', nodes: [], connections: [], agent_history_partial: true, agent_session_summaries: [{id: 's', title: 'Conversation', message_count: 1, content_hash: 'base'}], agent_sessions: [session], active_agent_session_id: 's'};
 const documentRef = {current: structuredClone(base)}, serverDocumentRef = {current: structuredClone(base)};
 const remote = structuredClone(base); remote.revision = 2; remote.agent_session_summaries[0].content_hash = 'remote';
 remote.agent_sessions[0].messages.push({id: 'remote', role: 'assistant', text: 'Remote reply'});
 remote.agent_sessions[0].protocolMessages.push({role: 'assistant', content: 'Remote reply'});
 const requests = [], conflicts = [], notices = [], busy = [];
 const deps = {
  agentHistoryConflictRef: {current: null}, documentRef, serverDocumentRef, mountedRef: {current: true}, loadedRef: {current: true}, canvasOperationEpochRef: {current: 1}, canvasDocumentEpochRef: {current: 1},
  saveTimerRef: {current: null}, saveChangeVersionRef: {current: 2}, persistedChangeVersionRef: {current: 1}, saveRequestVersionRef: {current: 0}, saveQueueRef: {current: Promise.resolve()},
  historyRef: {current: [structuredClone(base)]}, redoRef: {current: []}, generationHistoryBaseRef: {current: null},
  captureDocument: () => structuredClone(documentRef.current), cloneDocument: structuredClone,
  canvasSaveRequired, canvasHistoryStorageObjectIDs, canvasHistoryStorageObjectURLs, canvasHistoryLeaseExpired: () => false, expireCanvasHistoryLease() {},
  mergeCanvasDocuments, mergeCanvasHistory: (_b, _l, snapshot) => snapshot, storedCanvasAgentSessions: doc => parseCanvasAgentSessions(doc.agent_sessions),
  titleRef: {current: 'Canvas'}, setTitle() {}, replaceNodes() {}, replaceConnections() {}, setAgentSessions() {}, setActiveAgentSessionID() {}, setBackendAgentRun() {},
  storedCanvasAgentConfig: () => null, defaultCanvasModelsRef: {current: {}}, setAgentConfig() {}, setImageModel() {}, setTextModel() {}, setVideoModel() {}, fitCanvasContent() {},
  setAgentHistoryConflict: error => conflicts.push(error), setAgentOpen() {}, setProjects() {}, setHistoryVersion() {},
  setResolvingAgentHistory: value => busy.push(value), window: {clearTimeout() {}},
  canvasErrorMessage: error => error.message, toast: {error: msg => notices.push(['error', msg]), success: msg => notices.push(['success', msg])},
  randomID: () => 'local-branch',
  fetchCanvasDocument: async () => ({document: structuredClone(remote)}),
  saveCanvasDocument: async payload => {
   requests.push(structuredClone(payload));
   if (payload.revision < remote.revision) throw Object.assign(new Error('version conflict'), {status: 409});
   return {document: {...structuredClone(payload), revision: remote.revision + 1}};
  },
  ...overrides,
 };
 const apply = pageHandler('page.tsx', 'applyBackendAgentDocument', deps);
 const persist = () => pageHandler('page.tsx', 'persistCanvas', {...deps, applyBackendAgentDocument: apply})();
 const resolve = () => pageHandler('page.tsx', 'resolveAgentHistoryConflict', {...deps, agentHistoryConflict: conflicts.at(-1), resolvingAgentHistory: false, applyBackendAgentDocument: apply, persistCanvas: persist, scheduleSave: () => {deps.saveChangeVersionRef.current++;}})();
 return {base, remote, documentRef, serverDocumentRef, requests, conflicts, notices, busy, deps, apply, persist, resolve};
}

test('a conflicting save keeps both versions untouched until the user preserves a separate conversation', async () => {
 const h = concurrentHistoryHarness();
 h.documentRef.current.agent_sessions[0].messages.push({id: 'local', role: 'user', text: 'Local request'});
 const local = structuredClone(h.documentRef.current);
 assert.equal(await h.persist(), false);
 assert.equal(h.requests.length, 1, 'only the initial outdated PUT is sent; no destructive rebased PUT follows');
 assert.deepEqual(h.documentRef.current, local);
 assert.deepEqual(h.serverDocumentRef.current, h.base);
 assert.equal(h.conflicts.at(-1).name, 'CanvasAgentSessionConflictError');
 await h.resolve();
 assert.equal(h.conflicts.at(-1), null);
 assert.equal(h.documentRef.current.active_agent_session_id, 'local-branch');
 assert.equal(h.documentRef.current.agent_sessions.length, 2);
 assert.deepEqual(h.documentRef.current.agent_sessions.find(s => s.id === 's'), h.remote.agent_sessions[0]);
 assert.deepEqual(h.documentRef.current.agent_sessions.find(s => s.id === 'local-branch').messages, local.agent_sessions[0].messages);
 assert.equal(h.requests.length, 2);
 assert.deepEqual(h.requests[1].agent_sessions.map(s => s.id), ['local-branch'], 'unchanged remote conversation is not resubmitted');
 assert.equal(h.notices.at(-1)[0], 'success');
 assert.deepEqual(h.busy, [true, false]);
});

test('acknowledging our own save preserves later compression and edits without declaring a concurrent conflict', async () => {
 const h = concurrentHistoryHarness();
 let acknowledge, sent;
 h.deps.saveCanvasDocument = payload => {sent = structuredClone(payload); return new Promise(resolve => {acknowledge = () => resolve({document: {...sent, revision: 2}});});};
 h.documentRef.current.agent_sessions[0].messages.push({id: 'local', role: 'user', text: 'Local request'});
 const saving = h.persist();
 while (!acknowledge) await Promise.resolve();
 h.documentRef.current.agent_sessions[0].protocolMessages = [];
 h.documentRef.current.agent_sessions[0].contextCheckpoint = 'Compressed after submission';
 h.documentRef.current.agent_sessions[0].messages[0].text = 'edited while saving';
 const latest = structuredClone(h.documentRef.current.agent_sessions);
 acknowledge();
 assert.equal(await saving, true);
 assert.deepEqual(h.documentRef.current.agent_sessions, latest);
 assert.equal(h.conflicts.length, 0);
 assert.deepEqual(h.serverDocumentRef.current.agent_sessions, sent.agent_sessions);
});

test('body-free save receipts retain clean cached baselines across repeated geometry saves', async () => {
 const h = concurrentHistoryHarness();
 h.deps.captureDocument = () => ({ ...h.documentRef.current });
 const protocol = h.documentRef.current.agent_sessions[0].protocolMessages;
 h.deps.saveCanvasDocument = async payload => {
  h.requests.push(structuredClone(payload));
  return { document: { ...structuredClone(payload), revision: payload.revision + 1, agent_sessions: [] } };
 };
 for (let index = 0; index < 2; index++) {
  h.documentRef.current.title = `Canvas ${index}`;
  h.deps.saveChangeVersionRef.current++;
  assert.equal(await h.persist(), true);
  assert.deepEqual(h.requests[index].agent_sessions, []);
  assert.deepEqual(h.documentRef.current.agent_sessions, h.base.agent_sessions);
  assert.deepEqual(h.serverDocumentRef.current.agent_sessions, h.base.agent_sessions);
  assert.equal(h.documentRef.current.agent_sessions[0].protocolMessages, protocol);
 }
});

test('acknowledged metadata reuses isolated baseline fields and copies new conversation content', async () => {
 const h = concurrentHistoryHarness({ cloneDocument: pageHandler('page.tsx', 'cloneDocument', {}) });
 const original = structuredClone(h.base);
 const saved = h.serverDocumentRef.current.agent_sessions[0];
 const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
 freeze(h.serverDocumentRef.current);
 h.deps.saveCanvasDocument = async payload => {
  h.requests.push(structuredClone(payload));
  return { document: { ...structuredClone(payload), revision: payload.revision + 1 } };
 };
 for (const [key, value] of [['title', 'Renamed conversation'], ['engine', 'codex'], ['engine', 'native']]) {
  h.documentRef.current.agent_sessions[0][key] = value;
  h.deps.saveChangeVersionRef.current++;
  assert.equal(await h.persist(), true);
  const acknowledged = h.serverDocumentRef.current.agent_sessions[0];
  assert.equal(acknowledged[key], value);
  assert.equal(acknowledged.messages, saved.messages, 'metadata acknowledgement must not copy the complete saved transcript');
  assert.equal(acknowledged.protocolMessages, saved.protocolMessages);
  assert.equal(acknowledged.agentState, saved.agentState);
  assert.notEqual(acknowledged.messages, h.documentRef.current.agent_sessions[0].messages, 'the saved baseline stays isolated from editor mutations');
  freeze(h.serverDocumentRef.current);
 }
 assert.deepEqual(saved, original.agent_sessions[0]);
 const incoming = structuredClone(h.serverDocumentRef.current);
 incoming.revision++;
 incoming.agent_sessions[0].messages.push({ id: 'new-remote', role: 'assistant', text: 'New remote reply' });
 incoming.agent_sessions[0].protocolMessages.push({ role: 'assistant', content: 'New remote reply' });
 h.apply = pageHandler('page.tsx', 'applyBackendAgentDocument', h.deps);
 h.apply(incoming);
 const baseline = structuredClone(h.serverDocumentRef.current);
 assert.notEqual(h.serverDocumentRef.current.agent_sessions[0].messages, incoming.agent_sessions[0].messages);
 assert.notEqual(h.serverDocumentRef.current.agent_sessions[0].messages, saved.messages);
 incoming.agent_sessions[0].messages.at(-1).text = 'Changed transport object';
 h.documentRef.current.agent_sessions[0].messages[0].text = 'Later local edit';
 h.documentRef.current.agent_sessions[0].protocolMessages[0].content = 'Later local protocol';
 assert.deepEqual(h.serverDocumentRef.current, baseline);
 assert.deepEqual(saved, original.agent_sessions[0]);
});

test('baseline copies retain JSON semantics, session removals and unknown nested field isolation', () => {
 const copy = pageHandler('page.tsx', 'cloneDocument', {});
 const h = concurrentHistoryHarness(), before = structuredClone(h.base);
 Object.defineProperty(before.agent_sessions[0], '__proto__', { value: { retainedJSONField: true }, enumerable: true });
 before.agent_sessions[0].futureData = { retained: { value: 'same' }, removed: true };
 before.agent_sessions[0].contextCheckpoint = 'old';
 before.agent_sessions.push({ ...structuredClone(before.agent_sessions[0]), id: 'removed' });
 const incoming = structuredClone(before);
 incoming.agent_sessions.pop();
 delete incoming.agent_sessions[0].contextCheckpoint;
 incoming.agent_sessions[0].futureData = { retained: { value: 'new' } };
 incoming.agent_sessions[0].optionalFutureField = undefined;
 incoming.agent_sessions.push({ ...structuredClone(incoming.agent_sessions[0]), id: 'new' });
 const expected = JSON.parse(JSON.stringify(incoming));
 const result = copy(incoming, before);
 assert.deepEqual(result, expected);
 assert.equal(result.agent_sessions[0].messages, before.agent_sessions[0].messages);
 assert.notEqual(result.agent_sessions[0].futureData, incoming.agent_sessions[0].futureData);
 assert.notEqual(result.agent_sessions[1].messages, incoming.agent_sessions[1].messages);
 incoming.agent_sessions[0].futureData.retained.value = 'modified';
 incoming.agent_sessions[1].messages[0].text = 'modified';
 incoming.nodes.push({ id: 'later', type: 'text' });
 assert.deepEqual(result, expected);
 assert.equal(before.agent_sessions[0].futureData.retained.value, 'same');
});

test('snapshots without completed arrangements do not rescan cached conversations for viewport changes', () => {
 for (const trace of [undefined, [{ id: 'read', type: 'operation', kind: 'read', label: 'Read', detail: '', status: 'success', tool: { name: 'get_canvas_summary' } }],
  ...['running', 'error', 'waiting', 'changed'].map(status => [{ id: 'arrange', type: 'operation', kind: 'edit', label: 'Arrange', detail: '', status, tool: { name: 'arrange_nodes' } }])]) {
  for (const partial of [true, false]) {
   const h = concurrentHistoryHarness();
   for (const document of [h.base, h.documentRef.current, h.serverDocumentRef.current]) {
    document.agent_sessions[0].messages[0].trace = [{ id: 'previous-arrange', type: 'operation', kind: 'edit', label: 'Arrange', detail: '', status: 'success', tool: { name: 'arrange_nodes' } }];
   }
   let cachedReads = 0, fits = 0;
   const read = pageHandler('page.tsx', 'storedCanvasAgentSessions', { syncCanvasAgentSessions });
   const apply = pageHandler('page.tsx', 'applyBackendAgentDocument', { ...h.deps,
    storedCanvasAgentSessions: document => { if (document === h.serverDocumentRef.current) cachedReads++; return read(document, false); },
    fitCanvasContent: () => { fits++; },
   });
   const incoming = { ...structuredClone(h.base), revision: 2, agent_sessions: partial ? [] : [{ ...structuredClone(h.base.agent_sessions[0]), messages: [{ id: 'reply', role: 'assistant', text: 'Latest reply', status: 'success', ...(trace ? { trace } : {}) }] }] };
   apply(incoming);
   assert.equal(cachedReads, 0, 'no successful arrangement means the saved transcript is irrelevant to viewport changes');
   assert.equal(fits, 0);
   assert.deepEqual(h.documentRef.current.agent_sessions, partial ? h.base.agent_sessions : incoming.agent_sessions);
   assert.deepEqual(h.serverDocumentRef.current.agent_sessions, partial ? h.base.agent_sessions : incoming.agent_sessions);
  }
 }
});

test('queued engine changes rebase against our acknowledged save without a false conversation conflict', async () => {
 const h = concurrentHistoryHarness();
 let acknowledge;
 h.deps.saveCanvasDocument = payload => {
  h.requests.push(structuredClone(payload));
  const response = {document: {...structuredClone(payload), revision: payload.revision + 1}};
  return h.requests.length === 1 ? new Promise(resolve => { acknowledge = () => resolve(response); }) : Promise.resolve(response);
 };
 h.documentRef.current.agent_sessions[0].engine = 'codex';
 const first = h.persist();
 while (!acknowledge) await Promise.resolve();
 h.documentRef.current.agent_sessions[0].engine = 'native';
 h.deps.saveChangeVersionRef.current++;
 const second = h.persist();
 acknowledge();
 assert.deepEqual(await Promise.all([first, second]), [true, true]);
 assert.deepEqual(h.requests.map(request => request.agent_session_updates[0].changes.engine), ['codex', 'native']);
 assert.ok(h.requests.every(request => request.agent_sessions.length === 0));
 assert.equal(h.documentRef.current.agent_sessions[0].engine, 'native');
 assert.equal(h.serverDocumentRef.current.agent_sessions[0].engine, 'native');
 assert.deepEqual(h.documentRef.current.agent_sessions[0].messages, h.base.agent_sessions[0].messages);
 assert.deepEqual(h.documentRef.current.agent_sessions[0].protocolMessages, h.base.agent_sessions[0].protocolMessages);
 assert.equal(h.deps.persistedChangeVersionRef.current, h.deps.saveChangeVersionRef.current);
 assert.deepEqual(h.conflicts, []);
 assert.deepEqual(h.notices, []);
});

test('queued conversation edits still reject a different client changing the same session', async () => {
 const h = concurrentHistoryHarness();
 let releaseQueue;
 h.deps.saveQueueRef.current = new Promise(resolve => { releaseQueue = resolve; });
 h.documentRef.current.agent_sessions[0].engine = 'codex';
 const saving = h.persist();
 releaseQueue();
 assert.equal(await saving, false);
 assert.equal(h.requests.length, 1);
 assert.equal(h.conflicts.at(-1).name, 'CanvasAgentSessionConflictError');
 assert.deepEqual(h.serverDocumentRef.current, h.base);
 assert.equal(h.documentRef.current.agent_sessions[0].engine, 'codex');
 assert.deepEqual(h.remote.agent_sessions[0].messages.map(message => message.id), ['u', 'remote']);
});

test('undo during a pending engine save preserves the acknowledged conversation baseline', async () => {
 const h = concurrentHistoryHarness();
 let acknowledge, server = structuredClone(h.base);
 h.deps.fetchCanvasDocument = async () => ({document: structuredClone(server)});
 h.deps.saveCanvasDocument = payload => {
  h.requests.push(structuredClone(payload));
  if (payload.revision !== server.revision) return Promise.reject(Object.assign(new Error('version conflict'), {status: 409}));
  const response = {document: {...structuredClone(payload), revision: payload.revision + 1}};
  server = structuredClone(response.document);
  return h.requests.length === 1 ? new Promise(resolve => { acknowledge = () => resolve(response); }) : Promise.resolve(response);
 };
 h.documentRef.current.agent_sessions[0].engine = 'codex';
 const first = h.persist();
 while (!acknowledge) await Promise.resolve();
 h.deps.canvasOperationEpochRef.current++;
 h.documentRef.current.title = 'Undo restored title';
 h.documentRef.current.agent_sessions[0].engine = 'native';
 h.deps.saveChangeVersionRef.current++;
 const second = h.persist();
 acknowledge();
 assert.deepEqual(await Promise.all([first, second]), [true, true]);
 assert.equal(h.serverDocumentRef.current.agent_sessions[0].engine, 'native');
 assert.equal(h.serverDocumentRef.current.title, 'Undo restored title');
 assert.deepEqual(h.conflicts, []);
});

test('body-free save receipts do not acknowledge edits made after submission', async () => {
 const h = concurrentHistoryHarness();
 let acknowledge;
 h.deps.saveCanvasDocument = payload => {
  h.requests.push(structuredClone(payload));
  return new Promise(resolve => { acknowledge = () => resolve({ document: { ...structuredClone(payload), revision: 2, agent_sessions: [] } }); });
 };
 const saving = h.persist();
 while (!acknowledge) await Promise.resolve();
 h.documentRef.current.agent_sessions[0].messages.push({ id: 'later', role: 'user', text: 'Not yet saved' });
 h.documentRef.current.agent_sessions[0].protocolMessages.push({ role: 'user', messageID: 'later', content: 'Not yet saved' });
 const latest = structuredClone(h.documentRef.current.agent_sessions);
 acknowledge();
 assert.equal(await saving, true);
 assert.deepEqual(h.documentRef.current.agent_sessions, latest);
 assert.deepEqual(h.serverDocumentRef.current.agent_sessions, h.base.agent_sessions);
 assert.deepEqual(canvasAgentHistoryChanges(h.documentRef.current, h.serverDocumentRef.current).agent_sessions, latest);
});

test('loading a history session isolates its saved baseline from the editable conversation', async () => {
 const h = concurrentHistoryHarness();
 const load = pageHandler('page.tsx', 'loadAgentHistorySession', {
  ...h.deps, nodesRef: { current: [] }, flushCanvasSaves: async () => true,
  persistCanvas: h.persist, syncCanvasAgentSessions,
  fetchCanvasAgentHistorySession: async () => ({ session: structuredClone(h.base.agent_sessions[0]) }),
 });
 const loaded = await load('s');
 const savedBaseline = structuredClone(h.serverDocumentRef.current.agent_sessions);
 assert.deepEqual(canvasAgentHistoryChanges({ ...h.documentRef.current, agent_sessions: [loaded] }, h.serverDocumentRef.current).agent_sessions, []);
 loaded.messages[0].text = 'Edited after opening history';
 loaded.protocolMessages[0].content = 'Edited after opening history';
 assert.deepEqual(h.serverDocumentRef.current.agent_sessions, savedBaseline);
 assert.equal(savedBaseline[0].messages[0].text, 'base');
 assert.deepEqual(canvasAgentHistoryChanges({ ...h.documentRef.current, agent_sessions: [loaded] }, h.serverDocumentRef.current).agent_sessions, [loaded]);
});

test('loading a history session forwards cancellation to the body request', async () => {
 const h = concurrentHistoryHarness();
 const load = pageHandler('page.tsx', 'loadAgentHistorySession', {
  ...h.deps, nodesRef: { current: [] }, flushCanvasSaves: async () => true,
  persistCanvas: h.persist, syncCanvasAgentSessions,
  fetchCanvasAgentHistorySession: async (_projectID, _sessionID, _revision, signal) => {
   signal?.throwIfAborted();
   await new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
   });
   return { session: structuredClone(h.base.agent_sessions[0]) };
  },
 });
 const controller = new AbortController();
 const pending = load('s', controller.signal);
 controller.abort();
 await assert.rejects(pending, error => error?.name === 'AbortError');
});

test('a late conflict-resolution read cannot alter the next canvas or display a success notice', async () => {
 const h = concurrentHistoryHarness();
 h.conflicts.push(new CanvasAgentSessionConflictError(['s'], h.remote));
 let complete;
 h.deps.fetchCanvasDocument = () => new Promise(resolve => {complete = () => resolve({document: h.remote});});
 const resolving = h.resolve();
 while (!complete) await Promise.resolve();
 h.documentRef.current = {...h.base, id: 'other-project'};
 h.deps.canvasOperationEpochRef.current++;
 complete(); await resolving;
 assert.equal(h.documentRef.current.id, 'other-project');
 assert.equal(h.requests.length, 0);
 assert.equal(h.notices.length, 0);
});

test('a successful rebased save receipt cannot put the old local transcript back over remote additions', async () => {
 const h = concurrentHistoryHarness();
 h.documentRef.current.agent_sessions[0].title = 'Local rename';
 assert.equal(await h.persist(), true);
 assert.equal(h.requests.length, 2);
 assert.equal(h.documentRef.current.agent_sessions[0].title, 'Local rename');
 assert.deepEqual(h.documentRef.current.agent_sessions[0].messages, h.remote.agent_sessions[0].messages);
 assert.deepEqual(h.documentRef.current.agent_sessions[0].protocolMessages, h.remote.agent_sessions[0].protocolMessages);
 assert.equal(h.conflicts.length, 0);
});

test('queued saves refresh the current snapshot while preserving immutable server baselines', async () => {
 const h = concurrentHistoryHarness();
 const freeze = value => {
  if (value && typeof value === 'object') {
   Object.values(value).forEach(freeze);
   Object.freeze(value);
  }
  return value;
 };
 const original = freeze(h.serverDocumentRef.current);
 let releaseQueue;
 h.deps.saveQueueRef.current = new Promise(resolve => {releaseQueue = resolve;});
 h.documentRef.current.agent_sessions[0].title = 'First local title';
 const first = h.persist();
 h.apply(freeze(structuredClone(h.remote)));
 const progressed = freeze(h.serverDocumentRef.current);
 h.documentRef.current.agent_sessions = h.documentRef.current.agent_sessions.map(session => ({...session, title: 'Latest local title'}));
 h.deps.saveChangeVersionRef.current++;
 const second = h.persist();
 releaseQueue();
 assert.deepEqual(await Promise.all([first, second]), [true, true]);
 assert.equal(h.requests.length, 2);
 assert.equal(h.requests[0].agent_session_updates[0].changes.title, 'Latest local title');
 assert.deepEqual(h.requests[0].agent_sessions, []);
 assert.deepEqual(h.requests[1].agent_sessions, [], 'the latest conversation was already acknowledged by the first queued save');
 assert.deepEqual(h.serverDocumentRef.current.agent_sessions[0].messages, h.remote.agent_sessions[0].messages);
 assert.deepEqual(h.serverDocumentRef.current.agent_sessions[0].protocolMessages, h.remote.agent_sessions[0].protocolMessages);
 assert.equal(h.documentRef.current.agent_sessions[0].title, 'Latest local title');
 assert.deepEqual(original, h.base);
 assert.equal(progressed.agent_sessions[0].title, 'Conversation');
 assert.deepEqual(progressed.agent_sessions[0].messages, h.remote.agent_sessions[0].messages);
 assert.equal(h.conflicts.length, 0);
});

test('a queued save uses its original project baseline after another project opens', async () => {
 const h = concurrentHistoryHarness();
 let releaseQueue;
 h.deps.saveQueueRef.current = new Promise(resolve => {releaseQueue = resolve;});
 h.documentRef.current.agent_sessions[0].title = 'Saved before leaving';
 const original = structuredClone(h.serverDocumentRef.current);
 const saved = [];
 h.deps.saveCanvasDocument = async payload => {
  saved.push(structuredClone(payload));
  return {document: {...structuredClone(payload), revision: 2}};
 };
 const saving = h.persist();
 const next = {...structuredClone(h.base), id: 'other-project', title: 'Other canvas'};
 h.documentRef.current = next;
 h.serverDocumentRef.current = structuredClone(next);
 releaseQueue();
 assert.equal(await saving, true);
 assert.equal(saved.length, 1);
 assert.equal(saved[0].id, original.id);
 assert.equal(saved[0].agent_session_updates[0].changes.title, 'Saved before leaving');
 assert.deepEqual(saved[0].agent_sessions, []);
 assert.deepEqual(h.documentRef.current, next);
 assert.deepEqual(h.serverDocumentRef.current, next);
});

test('a queued save cannot acknowledge or replace a reopened instance of the same project', async () => {
 const h = concurrentHistoryHarness();
 let releaseQueue;
 h.deps.saveQueueRef.current = new Promise(resolve => { releaseQueue = resolve; });
 h.documentRef.current.agent_sessions[0].engine = 'codex';
 h.deps.saveCanvasDocument = async payload => {
  h.requests.push(structuredClone(payload));
  return {document: {...structuredClone(payload), revision: payload.revision + 1}};
 };
 const saving = h.persist();
 h.deps.canvasDocumentEpochRef.current++;
 const reopened = structuredClone(h.base);
 reopened.agent_sessions[0].messages.push({id: 'new-instance', role: 'user', text: 'New page edit'});
 h.documentRef.current = reopened;
 h.serverDocumentRef.current = structuredClone(h.base);
 const baseline = structuredClone(h.serverDocumentRef.current);
 const persistedVersion = h.deps.persistedChangeVersionRef.current;
 releaseQueue();
 assert.equal(await saving, true);
 assert.equal(h.requests[0].agent_session_updates[0].changes.engine, 'codex');
 assert.deepEqual(h.requests[0].agent_sessions, []);
 assert.deepEqual(h.documentRef.current, reopened);
 assert.deepEqual(h.serverDocumentRef.current, baseline);
 assert.equal(h.deps.persistedChangeVersionRef.current, persistedVersion);
 assert.deepEqual(h.conflicts, []);
});

test('a generation checkpoint preserves the conversation-conflict cause so it is not reported as a model failure', async () => {
 const remote = {id: 'project', nodes: [], connections: []};
 const conflict = new CanvasAgentSessionConflictError(['s'], remote);
 const checkpoint = pageHandler('page.tsx', 'persistGenerationCheckpoint', {
  scheduleSave() {}, documentRef: {current: {id: 'project'}}, persistCanvas: async () => false,
  agentHistoryConflictRef: {current: conflict},
 });
 await assert.rejects(checkpoint(), error => error === conflict);
});

test('node history commits retain independent geometry without copying the conversation', () => {
 const message = {id: 'u', role: 'user', text: 'Complete long history'};
 Object.defineProperty(message, 'toJSON', {value() {throw new Error('Geometry history must not serialize chat');}});
 const canvas = {id: 'project', title: 'Canvas', background: 'dots', nodes: [{id: 'n', x: 10, prompt: 'original'}], connections: [], agent_sessions: [{id: 's', messages: [message]}]};
 const historyRef = {current: []}, redoRef = {current: [{nodes: []}]};
 let saves = 0;
 const commit = pageHandler('page.tsx', 'pushHistory', {
  captureDocument: () => canvas, cloneDocument: value => JSON.parse(JSON.stringify(value)),
  generationHistoryBaseRef: {current: null}, historyRef, redoRef, canvasHistoryKey, appendCanvasHistorySnapshot,
  DEFAULT_DOCUMENT: {...canvas, nodes: []}, MAX_HISTORY: 50, setHistoryVersion() {}, scheduleSave: () => saves++,
 });
 commit();
 assert.equal(saves, 1);
 assert.equal(historyRef.current.length, 1);
 assert.equal('agent_sessions' in historyRef.current[0], false);
 canvas.nodes[0].prompt = 'edited later';
 assert.equal(historyRef.current[0].nodes[0].prompt, 'original');
 assert.deepEqual(redoRef.current, []);
});

test('server progress rebases every shared undo snapshot and removes an unset image-info preference', () => {
 const h = concurrentHistoryHarness();
 h.deps.mergeCanvasHistory = mergeCanvasHistory;
 const apply = pageHandler('page.tsx', 'applyBackendAgentDocument', h.deps);
 const run = {id: 'run', sessionId: 's', assistantId: 'a', status: 'running'};
 h.serverDocumentRef.current.agent_run = run; h.serverDocumentRef.current.show_image_info = true;
 h.documentRef.current.agent_run = run; h.documentRef.current.show_image_info = true;
 const snapshot = createCanvasHistorySnapshot(h.documentRef.current);
 h.deps.historyRef.current = [snapshot]; h.deps.redoRef.current = [snapshot]; h.deps.generationHistoryBaseRef.current = [snapshot];
 const remote = {...structuredClone(h.documentRef.current), revision: 3}; delete remote.show_image_info;
 apply(remote);
 assert.equal(h.deps.historyRef.current[0], snapshot, 'in-flight generation baselines keep their snapshot identity');
 assert.equal(h.deps.redoRef.current[0], snapshot);
 assert.equal(h.deps.generationHistoryBaseRef.current[0], snapshot);
 assert.equal(snapshot.show_image_info, undefined, 'undo must not revive a preference removed by server progress');
 assert.equal('agent_sessions' in snapshot, false);
 assert.equal('agent_run' in snapshot, false);
});

test("canvas recovery claims only failed recoverable video tasks and fences old SSE snapshots", async () => {
 for(const status of ["error","cancelled"]) {
  let claims=0,waits=0;
  const progress=[];
  const controller=new AbortController();
  const recover=pageHandler("page.tsx","recoverCanvasTasks",{
   fetchCreationTasks:async()=>({items:[{id:"original-video",mode:"video",status,can_recover_video:true,revision:2}]}),
   recoverVideoTask:async(id,options)=>{claims++;assert.equal(id,"original-video");assert.equal(options.signal,controller.signal);return {id,mode:"video",status:"queued",revision:3};},
   isCurrentCanvasRecovery:()=>true,
   persistCreationTaskOutputs:async task=>task,
   applyRecoveredCanvasTask:task=>{progress.push(task.status);return {terminal:["success","error","cancelled"].includes(task.status)};},
   waitForCreationTask:async(id,options)=>{waits++;assert.equal(id,"original-video");assert.equal(options.minRevision,3);options.onProgress({id,status:"running",revision:4});return {id,status:"success",revision:5};},
   markCanvasTaskRecoveryPending:()=>assert.fail("unexpected pending state"),
  });
  await recover("project",1,["original-video"],"session",controller.signal);
  assert.equal(claims,status==="error"?1:0);
  assert.equal(waits,status==="error"?1:0);
  assert.deepEqual(progress,status==="error"?["queued","running","success"]:["cancelled"]);
 }
});

test("manual pending-node retry synchronizes every media kind without generation", async () => {
 for(const type of ["image","video","audio","text"]) {
  const controller={current:null};const observed=[];
  const retry=pageHandler("page.tsx","retryCanvasNode",{
   nodesRef:{current:[{id:"pending",type,task_id:"original",generation_status:"error",generation_error:PENDING_CANVAS_GENERATION_RECOVERY_ERROR}]},
   activeGenerationsRef:{current:new Map()},canvasRecoveryAbortControllerRef:controller,
   documentRef:{current:{id:"project"}},canvasOperationEpochRef:{current:1},session:{key:"session"},
   recoverCanvasTasks:async(...args)=>observed.push(args),runGeneration:()=>assert.fail("must not generate a replacement"),
  });
  await retry("pending");
  assert.equal(observed.length,1);assert.deepEqual(observed[0].slice(0,4),["project",1,["original"],"session"]);
 }
});

test("unsaved canvas edits remain visible after failure and clear only after the latest revision saves", async () => {
  const errors = [], saving = [];
  const h = concurrentHistoryHarness({
    setCanvasSaveError: value => errors.push(value), setSavingCanvas: value => saving.push(value),
    saveCanvasDocument: async () => { throw new Error("Injected database unavailable"); },
  });
  h.documentRef.current.title = "Unsaved title";
  const local = structuredClone(h.documentRef.current);
  assert.equal(await h.persist(), false);
  assert.deepEqual(h.documentRef.current, local);
  assert.equal(h.deps.persistedChangeVersionRef.current, 1);
  assert.equal(errors.at(-1), "Injected database unavailable");
  assert.deepEqual(saving, [true, false]);
  h.deps.saveCanvasDocument = async payload => {
    h.deps.saveChangeVersionRef.current++;
    return { document: { ...payload, revision: payload.revision + 1 } };
  };
  assert.equal(await h.persist(), true);
  assert.equal(errors.at(-1), "Injected database unavailable", "an accepted old save must not clear the latest unsaved failure");
  h.deps.saveCanvasDocument = async payload => ({ document: { ...payload, revision: payload.revision + 1 } });
  assert.equal(await h.persist(), true);
  assert.equal(errors.at(-1), "");
  assert.equal(h.deps.persistedChangeVersionRef.current, h.deps.saveChangeVersionRef.current);
});

test("late canvas save failures cannot publish warnings into another document", async () => {
  for (const detached of ["project", "epoch", "unmounted"]) {
    const errors = [], saving = [];
    let reject;
    const h = concurrentHistoryHarness({
      setCanvasSaveError: value => errors.push(value), setSavingCanvas: value => saving.push(value),
      saveCanvasDocument: () => new Promise((_resolve, fail) => { reject = fail; }),
    });
    const pending = h.persist();
    while (!reject) await Promise.resolve();
    if (detached === "project") h.documentRef.current = { ...h.documentRef.current, id: "other" };
    if (detached === "epoch") h.deps.canvasDocumentEpochRef.current++;
    if (detached === "unmounted") h.deps.mountedRef.current = false;
    reject(new Error("Previous document failed"));
    assert.equal(await pending, false);
    assert.deepEqual(errors, []);
    assert.deepEqual(saving, [true]);
    assert.deepEqual(h.notices, []);
  }
});

test("browser unload protects pending edits and failed saves without blocking a clean canvas", () => {
  const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "protectUnsavedCanvas") handler = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler, "workspace lifecycle needs a beforeunload handler for unsaved edits");
  const loadedRef = { current: false }, persistedChangeVersionRef = { current: 1 }, saveChangeVersionRef = { current: 2 };
  const code = ts.transpileModule(`const handler = ${handler.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const protect = new Function("loadedRef", "persistedChangeVersionRef", "saveChangeVersionRef", "canvasSaveRequired", `${code}\nreturn handler;`)(loadedRef, persistedChangeVersionRef, saveChangeVersionRef, canvasSaveRequired);
  const event = () => ({ prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } });
  let current = event(); protect(current); assert.equal(current.prevented, false);
  loadedRef.current = true;
  current = event(); protect(current); assert.equal(current.prevented, true); assert.equal(current.returnValue, "");
  persistedChangeVersionRef.current = 2;
  current = event(); protect(current); assert.equal(current.prevented, false);
  saveChangeVersionRef.current = 3;
  current = event(); protect(current); assert.equal(current.prevented, true);
});

test("blocked canvas navigation waits for the latest saved edit and rejects stale outcomes", async () => {
  for (const scenario of ["saved", "failed", "superseded", "reopened", "changed-after-flush"]) {
    const calls = [];
    const controller = new AbortController();
    const documentRef = { current: { id: "project" } }, canvasDocumentEpochRef = { current: 1 };
    const saveChangeVersionRef = { current: 1 }, persistedChangeVersionRef = { current: 0 };
    let completeSave;
    const run = pageHandler("page.tsx", "flushBlockedCanvasNavigation", {
      documentRef, canvasDocumentEpochRef, saveChangeVersionRef, persistedChangeVersionRef,
      mountedRef: { current: true }, canvasSaveRequired,
      flushCanvasSaves: async options => {
        const saved = await flushCanvasSaves(options);
        if (scenario === "changed-after-flush") saveChangeVersionRef.current++;
        return saved;
      },
      persistCanvas: () => {
        const version = saveChangeVersionRef.current;
        calls.push(`save ${version}`);
        if (version === 1) return new Promise(resolve => { completeSave = saved => {
          if (saved) persistedChangeVersionRef.current = version;
          resolve(saved);
        }; });
        persistedChangeVersionRef.current = version;
        return Promise.resolve(true);
      },
      toast: { error: error => assert.fail(error) },
    });
    const pending = run({ state: "blocked", proceed: () => calls.push("leave"), reset: () => calls.push("stay") }, controller.signal);
    assert.deepEqual(calls, ["save 1"]);
    if (scenario === "saved") saveChangeVersionRef.current++;
    if (scenario === "superseded") controller.abort();
    if (scenario === "reopened") canvasDocumentEpochRef.current++;
    completeSave(scenario !== "failed");
    await pending;
    const expected = scenario === "saved" ? ["save 1", "save 2", "leave"] : scenario === "superseded" ? ["save 1"] : ["save 1", "stay"];
    assert.deepEqual(calls, expected);
  }
});


test("renaming a canvas preserves edits and newer saves made while the project request is pending", async () => {
  for (const acknowledged of [false, true]) {
    const h = concurrentHistoryHarness();
    h.documentRef.current.nodes = [{id: "n", type: "text", title: "Original node"}];
    h.serverDocumentRef.current.nodes = structuredClone(h.documentRef.current.nodes);
    const response = {document: {...structuredClone(h.documentRef.current), title: "Renamed canvas", revision: 2}, projects: [{id: "project", title: "Renamed canvas"}]};
    let respond;
    const resets = [], projectLists = [], navigations = [];
    const rename = pageHandler("page.tsx", "runProject", {
      ...h.deps, flushCanvasSaves: async () => true, persistCanvas: h.persist,
      enqueueWorkspaceMutation: operation => operation(),
      updateCanvasProject: () => new Promise(resolve => {respond = () => resolve(response);}),
      applyWorkspace: workspace => {resets.push(workspace); h.documentRef.current = structuredClone(workspace.document);},
      applyBackendAgentDocument: h.apply, setProjects: value => projectLists.push(value),
      setProjectMenuOpen() {}, navigate: path => navigations.push(path),
    });
    const pending = rename({action: "rename", project_id: "project", title: "Renamed canvas"});
    while (!respond) await Promise.resolve();
    h.documentRef.current.nodes[0].title = "Edited during rename";
    h.documentRef.current.agent_sessions[0].messages.push({id: "new", role: "user", text: "New conversation edit"});
    h.deps.saveChangeVersionRef.current++;
    if (acknowledged) {
      const saved = {...structuredClone(h.documentRef.current), title: "Renamed canvas", revision: 3};
      h.apply(saved);
      h.deps.persistedChangeVersionRef.current = h.deps.saveChangeVersionRef.current;
    }
    const expectedSessions = structuredClone(h.documentRef.current.agent_sessions);
    const expectedHistory = structuredClone(h.deps.historyRef.current);
    const changeVersion = h.deps.saveChangeVersionRef.current;
    respond();
    await pending;
    assert.equal(h.documentRef.current.nodes[0].title, "Edited during rename");
    assert.deepEqual(h.documentRef.current.agent_sessions, expectedSessions);
    assert.equal(h.documentRef.current.title, "Renamed canvas");
    assert.equal(h.documentRef.current.revision, acknowledged ? 3 : 2);
    assert.equal(h.deps.saveChangeVersionRef.current, changeVersion);
    assert.deepEqual(h.deps.historyRef.current, expectedHistory);
    assert.deepEqual(resets, [], "renaming the current project must not reopen its old snapshot");
    assert.deepEqual(projectLists, [response.projects]);
    assert.deepEqual(navigations, []);
  }
});

test("project responses arriving after unmount or reopening a canvas cannot overwrite the current workspace", async () => {
  for (const detached of ["project", "epoch", "unmounted"]) {
    const h = concurrentHistoryHarness();
    let respond;
    const applied = [], projectLists = [];
    const rename = pageHandler("page.tsx", "runProject", {
      ...h.deps, flushCanvasSaves: async () => true, persistCanvas: h.persist,
      enqueueWorkspaceMutation: operation => operation(),
      updateCanvasProject: () => new Promise(resolve => {respond = resolve;}),
      applyWorkspace: value => applied.push(value), applyBackendAgentDocument: value => applied.push(value),
      setProjects: value => projectLists.push(value), setProjectMenuOpen() {},
    });
    const pending = rename({action: "rename", project_id: "project", title: "Renamed canvas"});
    while (!respond) await Promise.resolve();
    if (detached === "project") h.documentRef.current.id = "other";
    if (detached === "epoch") h.deps.canvasDocumentEpochRef.current++;
    if (detached === "unmounted") h.deps.mountedRef.current = false;
    respond({document: {...structuredClone(h.base), title: "Renamed canvas", revision: 2}, projects: []});
    await pending;
    assert.deepEqual(applied, []);
    assert.deepEqual(projectLists, []);
  }
});


test("project operations do not submit after their queued save belongs to a discarded document", async () => {
  for (const stage of ["queued", "saving"]) {
    const h = concurrentHistoryHarness();
    let proceed;
    const gate = new Promise(resolve => {proceed = resolve;});
    let submissions = 0;
    const rename = pageHandler("page.tsx", "runProject", {
      ...h.deps, persistCanvas: h.persist,
      enqueueWorkspaceMutation: async operation => {if (stage === "queued") await gate; return operation();},
      flushCanvasSaves: async () => {if (stage === "saving") await gate; return true;},
      updateCanvasProject: () => {submissions++; assert.fail("discarded project must not submit");},
    });
    const pending = rename({action: "rename", project_id: "project", title: "Renamed canvas"});
    h.deps.canvasDocumentEpochRef.current++;
    proceed();
    await pending;
    assert.equal(submissions, 0);
  }
});

test("archive import saves the source and opens the imported project URL only for the current editor", async () => {
  for (const stage of ["current", "parsing", "saving", "importing"]) {
    const h = concurrentHistoryHarness();
    const calls = [];
    const imported = { id: "imported", title: "Archive", agent_sessions: [{ id: "retained" }] };
    const discard = at => { if (stage === at) h.deps.canvasDocumentEpochRef.current++; };
    const run = pageHandler("page.tsx", "importProjectArchive", {
      ...h.deps, persistCanvas: h.persist, enqueueWorkspaceMutation: operation => operation(),
      readCanvasProjectArchive: async () => { discard("parsing"); return [imported]; },
      interruptGenerationForProjectChange() {}, cancelCanvasMediaOperations() {},
      flushCanvasSaves: async () => { calls.push("save"); discard("saving"); return true; },
      importCanvasProject: async document => {
        calls.push("import");
        assert.deepEqual(document.agent_sessions, imported.agent_sessions);
        discard("importing");
        return { document: imported };
      },
      DEFAULT_DOCUMENT: { viewport: { x: 0, y: 0, zoom: 1 } },
      applyWorkspace: () => assert.fail("the old route must not display the imported document"),
      setProjectMenuOpen() {}, canvasProjectPath: id => "/canvas/" + id,
      navigate: path => calls.push(path), toast: { success: () => calls.push("success"), error: error => assert.fail(error) },
    });
    await run({ target: { files: [{ name: "archive.zip" }], value: "archive.zip" } });
    if (stage === "current") assert.deepEqual(calls, ["save", "import", "/canvas/imported", "success"]);
    if (stage === "parsing") assert.deepEqual(calls, []);
    if (stage === "saving") assert.deepEqual(calls, ["save"]);
    if (stage === "importing") assert.deepEqual(calls, ["save", "import"]);
  }
});

test("create, activate and delete navigate after saving, with activation loaded by the destination", async () => {
  for (const [input, saved] of [
    [{action: "create", title: "New"}, true],
    [{action: "activate", project_id: "other"}, true],
    [{action: "activate", project_id: "other"}, false],
    [{action: "delete", project_id: "project"}, true],
  ]) {
    const h = concurrentHistoryHarness();
    const phases = [], calls = [], applied = [], navigations = [];
    const target = {document: {...structuredClone(h.base), id: "other"}, active_project_id: "other", projects: []};
    const run = pageHandler("page.tsx", "runProject", {
      ...h.deps, persistCanvas: h.persist,
      enqueueWorkspaceMutation: operation => operation(),
      flushCanvasSaves: async () => {calls.push("save"); return saved;},
      interruptGenerationForProjectChange() {}, cancelCanvasMediaOperations() {},
      switchRevealTimerRef: {current: null}, setSwitchLabel() {}, setSwitchPhase: value => phases.push(value),
      setProjectMenuOpen() {},
      window: {clearTimeout() {}, setTimeout: callback => {callback(); return 1;}},
      updateCanvasProject: async request => {calls.push(request); return target;},
      applyWorkspace: workspace => {applied.push(workspace); h.documentRef.current = structuredClone(workspace.document); h.deps.canvasDocumentEpochRef.current++;},
      applyBackendAgentDocument: () => assert.fail("an explicit switch must apply its target workspace"),
      canvasProjectPath: id => "/canvas/" + id, navigate: path => navigations.push(path),
    });
    await run(input);
    assert.equal(calls[0], "save");
    if (input.action === "activate") {
      assert.deepEqual(calls, ["save"]);
      assert.deepEqual(applied, []);
    } else {
      assert.deepEqual(calls, ["save", input.action === "delete" ? {...input, revision: 1} : input]);
      assert.deepEqual(applied, [target]);
    }
    assert.deepEqual(navigations, saved ? ["/canvas/other"] : []);
    assert.deepEqual(phases, ["switching", "revealing", null]);
  }
});
