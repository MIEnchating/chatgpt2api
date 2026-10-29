import { mergeCanvasDocuments } from "../src/app/canvas/canvas-document-merge.ts";
import { resolveCanvasAgentMediaSettings } from "../src/app/canvas/agent/canvas-agent-media-settings.ts";
import { normalizeCanvasAgentConfig } from "../src/app/canvas/agent/canvas-agent-starter.ts";
import { summarizeCanvasAgentTask } from "../src/app/canvas/agent/canvas-agent-context.ts";
import { installVideoModelContracts } from "../src/lib/video-model-contracts.ts";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { canvasAgentStarterAttachment } from "../src/app/canvas/agent/canvas-agent-attachments.ts";
import { canvasAgentQuestionMediaChoice } from "../src/app/canvas/agent/canvas-agent-interaction.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { canvasAgentAttachmentURLs } from "../src/app/canvas/agent/canvas-agent-reference.ts";
import { canvasNodeSizeFromRatio } from "../src/app/canvas/canvas-node-geometry.ts";
import { applyCanvasVideoTaskProgressNodes } from "../src/app/canvas/canvas-task-results.ts";
import { canvasTextGenerationPlan } from "../src/app/canvas/canvas-text-generation.ts";
import { buildCanvasGenerationContext, canvasGenerationReferenceImageURLs, canvasGenerationNeedsRecovery } from "../src/app/canvas/canvas-generation-context.ts";
import { prepareImageEditReferences } from "../src/lib/image-edit-references.ts";
import { appendCanvasHistorySnapshot, canvasHistoryLeaseExpired, canvasHistoryStorageObjectIDs, canvasHistoryStorageObjectURLs, commitCanvasGenerationHistory } from "../src/app/canvas/canvas-history.ts";
import { canvasSaveRequired, flushCanvasSaves } from "../src/app/canvas/canvas-save.ts";
import { canCreateCanvasConnection } from "../src/app/canvas/canvas-connections.ts";
import { normalizeCanvasClipboard } from "../src/app/canvas/canvas-clipboard.ts";
import { expandCanvasGroupNodeIDs } from "../src/app/canvas/canvas-groups.ts";
import { expandCanvasBatchNodeIDs } from "../src/app/canvas/canvas-batches.ts";

// Execute the actual page handlers with controlled state and I/O dependencies.
function pageHandler(file, name, dependencies) {
  dependencies = { canvasGenerationNeedsRecovery, persistGenerationCheckpoint: async () => {}, imageGenerationPreferences: { node_regenerate_behavior: "new-node", workbench: { video_generate_audio: false } }, ...dependencies };
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
  for (const outcome of ["success", "failure"]) {
    test(`late ${kind} ${outcome} cannot change a canvas restored by undo`, async () => {
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
        PANORAMA_NODE_SIZE: { width: 340, height: 170 }, PANORAMA_IMAGE_SIZE: "2:1", summarizeCanvasTaskResult: () => ({ images: [{ url: "/image.png" }] }),
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
    setBusy: () => {}, updateCanvasProject: async () => {}, fetchCanvasDocument: async () => ({ projects: [] }),
    setProjects: () => {}, setActiveProjectID: () => {}, setSelectedProjectIDs: () => {},
    setProjectDialog: (value) => { dialog = value; }, toast: { success: () => {}, error: (error) => { throw new Error(error); } },
  })();
  assert.equal(dialog, null);
});

test("partially failed canvas deletion removes successful items before a retry", async () => {
  let projects = [{ id: "first", revision: 1 }, { id: "second", revision: 1 }];
  let selected = new Set(["first", "second"]);
  let dialog;
  await pageHandler("library-page.tsx", "confirmDeleteSelectedProjects", {
    projects, selectedProjectIDs: selected, busy: false, setBusy: () => {},
    updateCanvasProject: async ({ project_id }) => { if (project_id === "second") throw new Error("Conflict"); },
    setProjects: (update) => { projects = update(projects); },
    setSelectedProjectIDs: (update) => { selected = update(selected); },
    setProjectDialog: (value) => { dialog = value; }, toast: { error: () => {} },
  })();
  assert.deepEqual(projects.map((item) => item.id), ["second"]);
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

test("cancelling a canvas connection drag never creates an edge", () => {
  const created = [];
  const connectionRef = { current: { nodeID: "from", handleType: "source" } };
  const handler = pageHandler("canvas-engine.tsx", "handleUp", {
    panRef: { current: { active: false } }, dragRef: { current: { active: false } }, resizeRef: { current: { active: false } },
    selectionRef: { current: null }, connectionRef, syncToolCursor: () => {},
    screenToWorld: (x, y) => ({ x, y }), connectionTargetAt: () => ({ nodeID: "to", isNearNode: true }),
    connectionFor: () => ({ sourceID: "from", targetID: "to" }), setConnectionTargetID: () => {}, setConnecting: () => {},
    onConnect: (...args) => created.push(args),
  });
  handler({ type: "pointercancel", clientX: 100, clientY: 100 });
  assert.deepEqual(created, []);
  assert.equal(connectionRef.current, null);
});

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
  let timerID = 0, historyVersion = 0, persist;
  const dependencies = {
    documentRef, historyRef, redoRef, generationHistoryBaseRef, saveChangeVersionRef, persistedChangeVersionRef,
    serverDocumentRef: { current: structuredClone(documentRef.current) }, mergeCanvasDocuments,
    titleRef: { current: documentRef.current.title }, setTitle: () => {},
    replaceNodes: (nodes) => { documentRef.current.nodes = nodes; }, replaceConnections: (connections) => { documentRef.current.connections = connections; },
    storedCanvasAgentSessions: () => [], setAgentSessions: () => {}, setActiveAgentSessionID: () => {}, setBackendAgentRun: () => {},
    loadedRef: { current: true }, mountedRef: { current: true },
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
  persist = pageHandler("page.tsx", "persistCanvas", { ...dependencies, expireCanvasHistoryLease: expire, applyBackendAgentDocument: pageHandler("page.tsx", "applyBackendAgentDocument", dependencies) });
  const commit = pageHandler("page.tsx", "commitGenerationHistory", { ...dependencies, expireCanvasHistoryLease: expire, scheduleSave, commitCanvasGenerationHistory, MAX_HISTORY: 50 });
  return { persist, expire, commit, documentRef, historyRef, redoRef, generationHistoryBaseRef, originalHistory, requests, stateAtSave, timers, saveChangeVersionRef, persistedChangeVersionRef, advanceTime: (milliseconds) => { now += milliseconds; }, historyVersion: () => historyVersion };
}

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
