import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { canvasTextGenerationPlan } from "../src/app/canvas/canvas-text-generation.ts";
import { buildCanvasGenerationContext } from "../src/app/canvas/canvas-generation-context.ts";
import { appendCanvasHistorySnapshot } from "../src/app/canvas/canvas-history.ts";

// Execute the actual page handlers with controlled state and I/O dependencies.
function pageHandler(file, name, dependencies) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/app/canvas/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (ts.isJsxAttribute(node) && node.name.text === name && ts.isJsxExpression(node.initializer)) declaration = node.initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, `Missing handler ${name}`);
  const code = ts.transpileModule(`const handler = ${declaration.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn handler;`)(...Object.values(dependencies));
}

function textGenerationHarness() {
  const nodesRef = { current: [{ id: "text", type: "text", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, composer_content: "Write a caption" }] };
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
    connectionsRef: { current: [] }, activeGenerationsRef: { current: new Map() },
    canvasTextGenerationPlan, buildCanvasGenerationContext, appendCanvasHistorySnapshot,
    textModel: "gpt-5", textModels: ["gpt-5"], tokenNameForModel: () => "text-key",
    randomID: () => "test-id", MAX_HISTORY: 50, cloneDocument: structuredClone,
    captureDocument: () => ({ ...documentRef.current, nodes: nodesRef.current }),
    CANVAS_NODE_DEFAULT_SIZE: { text: { width: 340, height: 240 } },
    registerActiveGeneration: (value) => { controller = value; return {}; },
    replaceNodes: (value) => { nodesRef.current = value; }, replaceConnections: () => {},
    canvasTextGenerationMessages: async () => [], createChatGenerationTask: async () => ({ id: "server-task" }),
    addActiveGenerationTask: () => {}, completeActiveGeneration: () => {},
    waitForTask: async () => { pollStarted(); return new Promise((resolve, reject) => { resolvePoll = resolve; rejectPoll = reject; }); },
    commitGenerationHistory: (value) => commits.push(value),
    toast: { error: (message) => errors.push(message), success: () => {} },
  };
  return {
    run: pageHandler("page.tsx", "runTextGeneration", dependencies), nodesRef, documentRef, canvasOperationEpochRef, errors, commits, polling,
    abort: () => { controller.abort(); rejectPoll(new DOMException("Aborted", "AbortError")); },
    complete: () => resolvePoll({ id: "server-task", status: "success", data: [{ text_response: "Caption" }] }),
  };
}

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
        nodesRef, documentRef, canvasOperationEpochRef, mountedRef: { current: true },
        connectionsRef: { current: [] }, activeGenerationsRef: { current: new Map() }, historyRef: { current: [] },
        runningNodeID: "", session: { key: "session" }, getCachedAuthSession: () => ({ key: "session" }),
        buildCanvasGenerationContext, appendCanvasHistorySnapshot, cloneDocument: structuredClone, captureDocument: () => ({ id: "project", nodes: nodesRef.current }), MAX_HISTORY: 50,
        randomID: () => "random", createdAt: () => "now", tokenNameForModel: () => "key", imageGenerationPreferences: {},
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
