import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as imageOptions from "../src/lib/image-options.ts";
import { isRetryableTaskPollError } from "../src/lib/generation-task-contract.ts";
import { imageTurnUsesReferenceImages } from "../src/lib/image-turn-validation.ts";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import aigasapiDocument from "../../integrations/newapi/aigasapi/contract.json" with { type: "json" };
import { activeVideoModelContracts, installVideoModelContracts, videoModelContract } from "../src/lib/video-model-contracts.ts";
import { normalizeVideoRequest, videoReferenceCombinationError } from "../src/lib/video-request-normalizer.ts";
import { videoModelRequiresHTTPSReferences, videoWorkbenchDisplaySeconds } from "../src/lib/video-model-capabilities.ts";
import { isPublicHTTPSReferenceURL } from "../src/lib/public-reference-url.ts";
import { canRecoverVideoTask } from "../src/lib/video-task-error.ts";
import { videoTurnFieldsFromNormalizedRequest } from "../src/app/image/video-task-state.ts";
import { imageConversationHasActiveTurn, canDispatchImageTurn, canStartImageConversationQueueRunner } from "../src/lib/image-task-state.ts";
import { DEFAULT_PROMPT_MARKET_SOURCES, normalizePromptMarketSources } from "../src/app/image/banana-prompts.ts";

const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../src/app/image/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const submission = ts.transpileModule(
  readFileSync(new URL("../src/app/image/studio-task-submission.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function studioSubmitter(api, timer = callback => callback()) {
  const exports = {};
  new Function("require", "exports", "setTimeout", submission)(name => {
    if (name === "@/lib/api") return api;
    if (name === "@/lib/image-turn-validation") return { imageTurnUsesReferenceImages };
    if (name === "@/lib/generation-task-contract") return { isRetryableTaskPollError };
    throw new Error(`Unexpected import: ${name}`);
  }, exports, timer);
  return exports;
}

function studioSubmissionOptions(turn) {
  return {
    turn: { prompt: "fixture", model: "fixture-model", images: [], ...turn },
    image: { referenceFiles: [], quality: "auto", stream: false, partialImages: 0 },
    videoReferenceURLs: [],
    requestOptions: { redirectOnUnauthorized: false },
    assertDispatchAllowed: () => {},
    isSessionCurrent: () => true,
  };
}

// Execute source functions with deferred API boundaries to exercise races.
function extract(name, context, sourceFile = source) {
  context = { videoModelRequiresHTTPSReferences, videoWorkbenchDisplaySeconds, isPublicHTTPSReferenceURL, ...context };
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(sourceFile);
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name) {
      const value = node.initializer;
      expression = ts.isCallExpression(value) && ["useCallback", "useMemo"].includes(value.expression.getText(sourceFile))
        ? value.arguments[0].getText(sourceFile) : value.getText(sourceFile);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(expression, `Missing function ${name}`);
  const code = ts.transpile(`const handler = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${code}\nreturn handler;`)(...Object.values(context));
}

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
}

for (const name of ["buildReferenceImagesFromUrls", "buildReferenceImageFromStoredImage", "ensureReferenceImageAsset"]) {
  test(`${name} stops before upload when the session expires during download`, async () => {
    const download = deferred();
    let current = true;
    let uploads = 0;
    const guard = () => { if (!current) throw new DOMException("Session changed", "AbortError"); };
    const fn = extract(name, {
      fetchImageAsFile: () => download.promise, dataUrlToFile: () => download.promise,
      buildReferenceFileName: () => "ref.png", imageMimeTypeForOutputFormat: () => "image/png",
      isImageConversationAssetURL: () => false,
      uploadReferenceFiles: async () => { uploads++; return [{}]; },
    });
    const pending = name === "buildReferenceImagesFromUrls"
      ? fn(["https://example.test/ref.png"], "reference", guard)
      : name === "buildReferenceImageFromStoredImage"
        ? fn({ url: "https://example.test/ref.png" }, "ref.png", guard)
        : fn({ dataUrl: "https://example.test/ref.png", name: "ref.png" }, "conversation", guard);
    current = false;
    download.resolve({});
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(uploads, 0);
  });
}

test("queue recovery waits for model contracts before touching active tasks", async () => {
  const runners = new Set();
  const queue = extract("runConversationQueue", {
    imageModelConfigReady: false,
    pageSessionEpochRef: { current: 0 },
    session: { key: "a" },
    pageActiveRef: { current: true },
    activeConversationQueueIdsRef: { current: runners },
    canStartImageConversationQueueRunner: () => assert.fail("Queue started before model contracts loaded"),
    conversationsRef: { get current() { return assert.fail("Active tasks read before model contracts loaded"); } },
  });
  await queue("conversation");
  assert.equal(runners.size, 0);
});

test("history recovery stops between saves after an account change", async () => {
  const saved = [];
  const firstSave = deferred();
  const active = { current: true };
  const revision = { current: 0 };
  const done = deferred();
  const recover = extract("recoverLoadedItems", {
    cancelled: false, pageActiveRef: active, session: { key: "a" },
    getCachedAuthSession: () => ({ key: active.current ? "a" : "b" }),
    creationTaskRequestOptions: {}, conversationMutationRevisionRef: revision,
    recoverConversationHistory: async () => ({ items: [{ id: "a" }, { id: "b" }], saves: [{ id: "a" }, { id: "b" }] }),
    saveImageConversation: async item => { saved.push(item.id); done.resolve(); await firstSave.promise; },
    discardFailedImageConversationSave: () => assert.fail("Unexpected rollback"),
    conversationsRef: { current: [] }, setConversations: () => assert.fail("Stale history applied"),
    toast: { error: () => {} },
  });
  recover([]);
  await done.promise;
  active.current = false;
  firstSave.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved, ["a"]);
});

test("a video submission cancelled in flight runs compensation", async () => {
  let allowed = true;
  const response = deferred();
  const cancellations = [];
  const { createStudioTaskSubmitter, ImageTaskDispatchAbortedError } = studioSubmitter({
    createVideoGenerationTask: () => response.promise,
    cancelCreationTask: async id => cancellations.push(id),
  });
  const submit = createStudioTaskSubmitter({
    ...studioSubmissionOptions({ mode: "video" }),
    assertDispatchAllowed: () => { if (!allowed) throw new ImageTaskDispatchAbortedError(); },
  });
  const pending = submit([{ taskId: "task", count: 1 }]);
  allowed = false;
  response.resolve({ id: "task" });
  await assert.rejects(pending, ImageTaskDispatchAbortedError);
  assert.deepEqual(cancellations, ["task", "task"]);
});

test("video queue does not upload a reference downloaded by an expired session", async () => {
  const download = deferred();
  const downloading = deferred();
  const active = { current: true };
  const epoch = { current: 0 };
  let uploads = 0;
  class Aborted extends Error {}
  const turn = { id: "turn", mode: "video", status: "queued", referenceImages: [{ dataUrl: "/assets/ref.png" }], images: [{ status: "loading", taskId: "task" }] };
  const queue = extract("runConversationQueue", {
    imageModelConfigReady: true, pageActiveRef: active, pageSessionEpochRef: epoch, session: { key: "a" },
    activeConversationQueueIdsRef: { current: new Set() }, conversationsRef: { current: [{ id: "conversation", turns: [turn] }] },
    cancelledTurnIdsRef: { current: new Set() }, deletedConversationIdsRef: { current: new Set() },
    canDispatchImageTurn, canStartImageConversationQueueRunner, imageTurnProgressKey: () => "turn-key",
    imageTurnStartedAtTimestamp: () => 0, updateTurnProgress: () => {}, usesReferenceImages: () => false,
    videoReferenceCombinationError: () => "", ImageTaskDispatchAbortedError: Aborted,
    dataUrlToFile: () => { downloading.resolve(); return download.promise; },
    uploadVideoMultimodalImages: async () => { uploads++; return [{ dataUrl: "https://example.test/uploaded" }]; },
    getCachedAuthSession: () => ({ key: active.current ? "a" : "b" }),
    absoluteReferenceURL: value => value, isPublicReferenceURL: () => false,
  });
  const pending = queue("conversation");
  await downloading.promise;
  active.current = false;
  epoch.current++;
  download.resolve({});
  await pending;
  assert.equal(uploads, 0);
});

test("video queue forwards public reference URLs without downloading them", async () => {
  const active = { current: true };
  const epoch = { current: 0 };
  let prepared = false;
  let downloads = 0;
  class Aborted extends Error {}
  const turn = { id: "turn", mode: "video", status: "queued", referenceImages: [{ dataUrl: "https://example.test/ref.png" }], images: [{ status: "loading", taskId: "task" }] };
  const queue = extract("runConversationQueue", {
    imageModelConfigReady: true, pageActiveRef: active, pageSessionEpochRef: epoch, session: { key: "a" },
    activeConversationQueueIdsRef: { current: new Set() }, conversationsRef: { current: [{ id: "conversation", turns: [turn] }] },
    cancelledTurnIdsRef: { current: new Set() }, deletedConversationIdsRef: { current: new Set() },
    canDispatchImageTurn, canStartImageConversationQueueRunner, imageTurnProgressKey: () => "turn-key",
    imageTurnStartedAtTimestamp: () => 0, updateTurnProgress: () => {}, usesReferenceImages: () => false,
    videoReferenceCombinationError: () => "", ImageTaskDispatchAbortedError: Aborted,
    dataUrlToFile: () => { downloads++; throw new Error("Cross-origin download blocked"); },
    uploadVideoMultimodalImages: () => assert.fail("Public references must not be uploaded again"),
    getCachedAuthSession: () => ({ key: "a" }), absoluteReferenceURL: value => value,
    isPublicReferenceURL: () => true, videoReferenceImageLimit: () => 9,
    restoreImageSizeSelection: () => ({}),
    buildEffectiveImageSizeRequest: () => { prepared = true; active.current = false; epoch.current++; throw new Aborted(); },
    formatCreationTaskError: String, toast: { error: () => {} }, updateConversation: async () => {},
    flushImageConversationSaves: async () => {}, reportHistorySyncError: () => {}, clearTurnProgress: () => {},
  });
  await queue("conversation");
  assert.equal(prepared, true);
  assert.equal(downloads, 0);
});

const videoSubmitContext = {
  selectedConversationId: null, isLoadingHistory: false, historyError: "",
  isSubmitDispatchingRef: { current: false }, referenceUploadPendingCountRef: { current: 0 },
  videoFrameUploadsRef: { current: new Map() }, videoReferenceUploadPendingCountRef: { current: 0 }, audioReferenceUploadPendingCountRef: { current: 0 },
  composerMode: "video", smartContextEnabled: false, imagePrompt: "Animate this", videoFirstFrameURL: "", videoLastFrameURL: "",
  referenceImages: [], videoReferenceImageURLs: [], videoReferenceVideoURLs: [], videoReferenceAudioURLs: [],
  videoSize: "16:9", videoResolution: "768p", videoGenerateAudio: false, videoWatermark: false, videoParameters: {},
  absoluteReferenceURL: value => value, cleanReferenceURLs: values => values, requireRelayToken: () => true,
  videoRequiresReferenceImage: () => false, videoRequiresReferenceVideo: () => false, videoRequiresReferenceAudio: () => false,
  videoRequiresMultimodalReferenceMode: () => false, supportsVideoMultimodalReferences: () => false,
  videoWorkbenchReferenceLimitError: () => "", imageConversationReferenceLimitMessage: () => "", videoReferenceImageLimit: () => 1,
  normalizeVideoRequest,
};

test("video submit reports validation errors without rejecting the event handler", async () => {
  const errors = [];
  const submit = extract("handleSubmit", {
    ...videoSubmitContext, videoModel: "missing-contract", videoModelOptions: [{ value: "missing-contract" }], videoSeconds: "4",
    videoReferenceCombinationError, toast: { error: message => errors.push(message) },
  });
  await submit();
  assert.deepEqual(errors, ["视频模型 missing-contract 未配置启用的视频模型契约"]);
});

test("video submit validates and normalizes the displayed duration for a stale draft", async () => {
  const previous = activeVideoModelContracts();
  installVideoModelContracts(aigasapiDocument.contracts.map(item => item.contract));
  try {
    const model = "video-minimax-h3-768p";
    const errors = [];
    let seconds;
    const submit = extract("handleSubmit", {
      ...videoSubmitContext, videoModel: model, videoModelOptions: [{ value: model }], videoSeconds: "4",
      videoReferenceCombinationError,
      normalizeVideoRequest(input) {
        seconds = normalizeVideoRequest(input).seconds;
        throw new Error("stop after normalization");
      },
      toast: { error: message => errors.push(message) },
    });
    await submit();
    assert.equal(seconds, 5);
    assert.deepEqual(errors, ["stop after normalization"]);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("canvas prompt loading preserves explicitly disabled built-in sources", async () => {
  const canvasSource = ts.createSourceFile("side-panel.tsx", readFileSync(new URL("../src/app/canvas/canvas-side-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const configured = DEFAULT_PROMPT_MARKET_SOURCES.map(item => ({ ...item, enabled: false }));
  const load = extract("loadSidePanelPrompts", {
    sidePanelPromptCache: new Map(), cachedSidePanelPrompts: () => null, sidePanelPromptRequests: new Map(),
    fetchPromptSourcesConfig: async () => ({ sources: configured }), normalizePromptMarketSources,
    fetchPromptMarketPrompts: async (_signal, received) => {
      assert.deepEqual(received, configured);
      assert.equal(normalizePromptMarketSources(received).some(item => item.enabled), false);
      return { prompts: [], failedSources: [] };
    },
    preparePromptMarketEntries: items => items, cacheSidePanelPrompts: () => {},
  }, canvasSource);
  assert.deepEqual(await load("session"), { prompts: [], failedSources: [], categories: [] });
});

for (const stage of ["configuration", "prompts"]) {
  test(`closing the prompt market prevents late ${stage} from changing state`, async () => {
    const marketSource = ts.createSourceFile("market.tsx", readFileSync(new URL("../src/app/image/components/image-prompt-market.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect;
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(marketSource) === "useEffect"
        && node.arguments[0]?.getText(marketSource).includes("fetchPromptSourcesConfig()")) {
        effect = node.arguments[0].getText(marketSource);
      }
      ts.forEachChild(node, visit);
    }
    visit(marketSource);
    assert.ok(effect);
    const response = deferred();
    let promptsRequested = 0;
    const commits = [];
    const context = {
      open: true, loadedPromptKey: { current: null }, promptReloadKey: 0, setIsLoading: value => commits.push(["loading", value]), setError: value => commits.push(["error", value]),
      fetchPromptSourcesConfig: () => stage === "configuration" ? response.promise : Promise.resolve({ sources: [] }),
      normalizePromptMarketSources: items => items, setSourceConfigs: value => commits.push(["sources", value]),
      fetchPromptMarketPrompts: () => { promptsRequested++; return response.promise; }, setPrompts: value => commits.push(["prompts", value]),
    };
    const compiled = ts.transpile(`const handler = ${effect};`, { target: ts.ScriptTarget.ES2022 });
    const cleanup = new Function(...Object.keys(context), `${compiled}\nreturn handler;`)(...Object.values(context))();
    await Promise.resolve();
    cleanup();
    const before = commits.slice();
    response.resolve(stage === "configuration" ? { sources: [] } : { prompts: [{ id: "stale" }], failedSources: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(commits, before);
    assert.equal(promptsRequested, stage === "configuration" ? 0 : 1);
  });
}

test("compensating cancellation stops after the session changes during its delay", async () => {
  let current = true;
  let allowed = true;
  const response = deferred();
  const cancelled = [];
  const { createStudioTaskSubmitter, ImageTaskDispatchAbortedError } = studioSubmitter({
    createVideoGenerationTask: () => response.promise,
    cancelCreationTask: async id => cancelled.push(id),
  }, (resume, delay) => { assert.equal(delay, 500); current = false; resume(); });
  const submit = createStudioTaskSubmitter({
    ...studioSubmissionOptions({ mode: "video" }),
    assertDispatchAllowed: () => { if (!allowed || !current) throw new ImageTaskDispatchAbortedError(); },
    isSessionCurrent: () => current,
  });
  const pending = submit([{ taskId: "task", count: 1 }]);
  allowed = false;
  response.resolve({ id: "task" });
  await assert.rejects(pending, ImageTaskDispatchAbortedError);
  assert.deepEqual(cancelled, ["task"]);
});

test("first and last frame uploads keep the remaining slot busy", async () => {
  const uploads = [deferred(), deferred()];
  const busy = [];
  let next = 0;
  const upload = extract("handleVideoFrameFileChange", {
    videoModel: "isolated-video",
    referenceUploadEpochRef: { current: 0 }, pageActiveRef: { current: true }, videoFrameUploadsRef: { current: new Map() },
    setVideoFrameUploading: value => busy.push(value), uploadVideoImageReference: () => uploads[next++].promise,
    setVideoFirstFrameURL: () => {}, setVideoLastFrameURL: () => {}, toast: { error: () => {}, success: () => {} },
  });
  const file = { type: "image/png", name: "frame.png", size: 10 };
  const first = upload("first", file);
  const last = upload("last", file);
  uploads[0].resolve({ url: "https://example.test/first.png" });
  await first;
  assert.equal(busy.at(-1), "last");
  uploads[1].resolve({ url: "https://example.test/last.png" });
  await last;
  assert.equal(busy.at(-1), null);
});

test("an obsolete upload cannot decrement a new draft's pending count", async () => {
  const old = deferred();
  const epoch = { current: 0 };
  const count = { current: 0 };
  const busy = [];
  const upload = extract("handleVideoReferenceFileChange", {
    referenceUploadEpochRef: epoch, pageActiveRef: { current: true }, videoReferenceUploadPendingCountRef: count,
    setVideoReferenceUploading: value => busy.push(value), uploadVideoReference: () => old.promise,
    setVideoReferenceVideoURLs: () => assert.fail("Obsolete upload applied"), toast: { error: () => {}, success: () => {} },
  });
  const pending = upload({ type: "video/mp4", name: "ref.mp4", size: 10 });
  epoch.current++;
  count.current = 2;
  old.resolve({ url: "https://example.test/obsolete.mp4" });
  await pending;
  assert.equal(count.current, 2);
  assert.equal(busy.at(-1), true);
});

for (const kind of ["video", "audio"]) {
  test(`${kind} upload remains busy until all concurrent files finish`, async () => {
    const uploads = [deferred(), deferred()];
    const busy = [];
    let next = 0;
    const context = {
      videoModel: "isolated-video",
      pageActiveRef: { current: true }, referenceUploadEpochRef: { current: 0 },
      videoReferenceUploadPendingCountRef: { current: 0 }, audioReferenceUploadPendingCountRef: { current: 0 },
      pendingAudioReferenceDurationMsRef: { current: 0 }, audioReferenceMetadataRef: { current: new Map() },
      videoReferenceAudioURLs: [], videoReferenceAudioURLsRef: { current: [] },
      inspectAudioReferenceFile: async () => ({ durationMs: 1000 }), audioReferenceMetadataError: () => "",
      uploadVideoReference: () => uploads[next++].promise, uploadAudioReference: () => uploads[next++].promise,
      setVideoReferenceUploading: value => busy.push(value), setAudioReferenceUploading: value => busy.push(value),
      setVideoReferenceVideoURLs: () => {}, setVideoReferenceAudioURLs: () => {},
      toast: { error: () => {}, success: () => {} },
    };
    const fn = extract(kind === "video" ? "handleVideoReferenceFileChange" : "handleAudioReferenceFileChange", context);
    const file = kind === "video" ? { type: "video/mp4", name: "ref.mp4", size: 10 } : { type: "audio/mpeg", name: "ref.mp3", size: 10 };
    const one = fn(file);
    const two = fn(file);
    await Promise.resolve();
    uploads[0].resolve({ url: "https://example.test/one" });
    await one;
    assert.equal(busy.at(-1), true);
    uploads[1].resolve({ url: "https://example.test/two" });
    await two;
    assert.equal(busy.at(-1), false);
  });
}

test("delayed audio inspection counts another upload that already completed", async () => {
  const inspections = [deferred(), deferred()];
  const metadata = { current: new Map() };
  let next = 0;
  let uploads = 0;
  const totals = [];
  const upload = extract("handleAudioReferenceFileChange", {
    videoModel: "isolated-video",
    referenceUploadEpochRef: { current: 0 }, pageActiveRef: { current: true }, audioReferenceUploadPendingCountRef: { current: 0 },
    pendingAudioReferenceDurationMsRef: { current: 0 }, audioReferenceMetadataRef: metadata,
    videoReferenceAudioURLs: [], videoReferenceAudioURLsRef: { current: [] },
    inspectAudioReferenceFile: () => inspections[next++].promise,
    audioReferenceMetadataError: (_metadata, total) => { totals.push(total); return ""; },
    setAudioReferenceUploading: () => {}, setVideoReferenceAudioURLs: () => {},
    uploadAudioReference: async () => ({ url: `https://example.test/audio-${uploads++}.mp3` }),
    toast: { error: () => {}, success: () => {} },
  });
  const file = { type: "audio/mpeg", name: "ref.mp3", size: 10 };
  const first = upload(file);
  const second = upload(file);
  inspections[0].resolve({ durationMs: 8000 });
  await first;
  inspections[1].resolve({ durationMs: 8000 });
  await second;
  assert.deepEqual(totals, [0, 8000]);
});

function retryFixture(mode = "generate", status = "message") {
  const turn = { id: "turn", mode, model: "old", prompt: "draw", referenceImages: [], count: 1, images: [{ id: "slot", status, text_response: "Please retry" }] };
  const conversation = { id: "conversation", turns: [turn] };
  const errors = [];
  let saved;
  return {
    turn, errors, get saved() { return saved; },
    context: {
      pageActiveRef: { current: true }, conversationsRef: { current: [conversation] },
      retryingImageIdsRef: { current: new Set() }, queueingTurnIdsRef: { current: new Set() },
      isTurnInProgress: () => false, isConfiguredCreationModel: () => true,
      canRecoverVideoTask,
      videoModelContract,
      imageConversationHasActiveTurn, isImageConversationHistorySummaryOnly: item => item?.historySummaryOnly === true,
      imageTurnReferenceValidationError: () => "", requireRelayToken: () => true,
      imageModel: "new-image", videoModel: "new-video", imageTurnProgressKey: () => "turn-key",
      createId: () => "new", imageTaskBatchId: () => "new-task", deriveTurnStatus: () => ({ status: "queued" }),
      relayTokenNameForKind: () => "relay", normalizeRequestedImageCount: Number, buildConversationTitle: value => value,
      updateConversation: async (_id, update) => { saved = update(conversation); return saved; },
      runConversationQueue: () => {}, toast: { error: value => errors.push(value), success: () => {} },
    },
  };
}

test("retry on a model text response queues the requested slot", async () => {
  const fixture = retryFixture();
  await extract("handleRetryImage", fixture.context)("conversation", "turn", 0);
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.saved.turns[0].images[0].status, "loading");
  assert.equal(fixture.saved.turns[0].images[0].text_response, undefined);
});

for (const outcome of ["success", "download-error", "session-change", "replaced-task"]) {
  test(`video save retry never regenerates after ${outcome}`, async () => {
    const fixture = retryFixture("video", "error");
    const original = fixture.turn.images[0];
    original.taskId = "completed-video";
    original.canRecoverVideo = true;
    original.error = "视频已生成但保存失败: video content returned status 502";
    const response = deferred();
    const session = { current: "original-session" };
    let downloads = 0;
    const retry = extract("handleRetryImage", {
      ...fixture.context,
      currentSessionKeyRef: session,
      CREATION_TASK_POLL_MAX_DURATION_MS: 8 * 60_000,
      isTaskActive: status => status === "queued" || status === "running",
      creationTaskRequestOptions: { sessionKey: session.current },
      recoverVideoTask: async id => {
        assert.equal(id, "completed-video");
        downloads++;
        await response.promise;
        if (outcome === "download-error") throw new Error("Gateway 502");
        return { id, status: "success" };
      },
      runConversationQueue: () => assert.fail("Recovery submitted a new generation"),
      requireRelayToken: () => assert.fail("Recovery selected a generation token"),
      taskDataToStoredImage: image => ({ ...image, status: "success", error: undefined, videoUrl: "/videos/recovered.mp4" }),
      deriveGenerationTaskStatus: images => ({ status: images.every(image => image.status === "success") ? "success" : "error" }),
      formatCreationTaskError: error => error.message,
      toast: { error: error => fixture.errors.push(error), loading: () => "saving", dismiss: () => {}, success: () => {} },
    });
    const pending = retry("conversation", "turn", 0);
    await retry("conversation", "turn", 0);
    assert.equal(downloads, 1);
    if (outcome === "session-change") session.current = "another-session";
    if (outcome === "replaced-task") original.taskId = "replacement-video";
    response.resolve();
    await pending;
    assert.equal(fixture.context.retryingImageIdsRef.current.size, 0);
    if (outcome === "success") {
      assert.equal(fixture.saved.turns[0].images[0].videoUrl, "/videos/recovered.mp4");
      assert.equal(fixture.saved.turns[0].images[0].taskId, "completed-video");
    } else if (outcome === "replaced-task") {
      assert.equal(fixture.saved.turns[0].images[0].taskId, "replacement-video");
      assert.equal(fixture.saved.turns[0].images[0].status, "error");
    } else {
      assert.equal(fixture.saved, undefined);
      assert.equal(fixture.errors.length, outcome === "download-error" ? 1 : 0);
    }
  });
}

for (const mode of ["generate", "chat"]) {
  test(`retry still rejects a ${mode === "chat" ? "chat response" : "successful image"}`, async () => {
    const fixture = retryFixture(mode, mode === "chat" ? "message" : "success");
    await extract("handleRetryImage", fixture.context)("conversation", "turn", 0);
    assert.equal(fixture.saved, undefined);
    assert.equal(fixture.errors.length, 1);
  });
}

for (const name of ["handleRetryImage", "handleRegenerateTurn"]) {
  for (const required of [false, true]) {
    test(`${name} respects the selected video's prompt requirement (${required})`, async () => {
      const previous = activeVideoModelContracts();
      const contract = structuredClone(contractDocument.contracts[0]);
      contract.models = ["new-video"];
      contract.model_profiles = [];
      contract.capability.prompt = { required, min_length: 0, max_length: 0 };
      installVideoModelContracts([contract]);
      try {
        const fixture = retryFixture("video", "error");
        fixture.turn.prompt = "";
        const normalize = extract("normalizeRetryVideoTurnFields", { normalizeVideoRequest, videoTurnFieldsFromNormalizedRequest });
        await extract(name, { ...fixture.context, normalizeRetryVideoTurnFields: normalize })("conversation", "turn", 0);
        if (required) {
          assert.deepEqual(fixture.errors, ["请输入提示词"]);
          assert.equal(fixture.saved, undefined);
        } else {
          assert.deepEqual(fixture.errors, []);
          assert.equal(fixture.saved.turns[0].prompt, "");
          assert.equal(fixture.saved.turns[0].images[0].status, "loading");
        }
      } finally { installVideoModelContracts(previous); }
    });
  }
  test(`${name} persists all normalized video references and clears hidden inputs`, async () => {
    const previous = activeVideoModelContracts();
    const contract = structuredClone(contractDocument.contracts[0]);
    contract.models = ["new-video"];
    contract.rules = [{ when: { field: "first_frame", operator: "present" }, ui: { hide: ["reference_image", "reference_video", "reference_audio"] } }];
    installVideoModelContracts([contract]);
    try {
      const fixture = retryFixture("video", "error");
      Object.assign(fixture.turn, {
        videoFirstFrameURL: "https://example.test/frame.png", videoReferenceMode: "first-frame",
        videoReferenceImageURLs: ["https://example.test/image.png"],
        referenceImages: [{ name: "local.png", dataUrl: "/assets/local.png" }],
        videoReferenceVideoURLs: ["https://example.test/video.mp4"], videoReferenceAudioURLs: ["https://example.test/audio.mp3"],
      });
      const normalize = extract("normalizeRetryVideoTurnFields", { normalizeVideoRequest, videoTurnFieldsFromNormalizedRequest });
      await extract(name, { ...fixture.context, normalizeRetryVideoTurnFields: normalize })("conversation", "turn", 0);
      assert.deepEqual(fixture.errors, []);
      const saved = fixture.saved.turns[0];
      assert.equal(saved.videoFirstFrameURL, "https://example.test/frame.png");
      assert.deepEqual(saved.referenceImages, []);
      assert.deepEqual(saved.videoReferenceImageURLs, []);
      assert.deepEqual(saved.videoReferenceVideoURLs, []);
      assert.deepEqual(saved.videoReferenceAudioURLs, []);
    } finally {
      installVideoModelContracts(previous);
    }
  });
}

test("video retry preserves uploadable local references without duplicating URL inputs", () => {
  const previous = activeVideoModelContracts();
  installVideoModelContracts(structuredClone(contractDocument.contracts));
  try {
    const reference = { name: "ref.png", dataUrl: "/assets/ref.png" };
    const normalized = extract("normalizeRetryVideoTurnFields", { normalizeVideoRequest, videoTurnFieldsFromNormalizedRequest })({
      referenceImages: [reference], videoReferenceMode: "reference",
      videoReferenceImageURLs: ["https://example.test/reference.png"],
    }, "minimax-h3-768p");
    assert.deepEqual(normalized.referenceImages, [reference]);
    assert.deepEqual(normalized.videoReferenceImageURLs, ["https://example.test/reference.png"]);
  } finally { installVideoModelContracts(previous); }
});

for (const mode of ["generate", "edit"]) {
  test(`${mode} task dispatch uses the turn API mode after preferences change`, async () => {
    let options;
    const { createStudioTaskSubmitter } = studioSubmitter({
      createImageGenerationTask: (...args) => { options = args[13]; },
      createImageEditTask: (...args) => { options = args[14]; },
    });
    const submit = createStudioTaskSubmitter(studioSubmissionOptions({ mode, apiMode: "responses" }));
    await submit([{ taskId: "task", count: 1 }]);
    assert.equal(options.apiMode, "responses");
  });
}

for (const align of [false, true]) {
  test(`submit, edit, and queue preserve custom dimensions with alignment ${align ? "enabled" : "disabled"}`, () => {
    const helpers = { ...imageOptions };
    helpers.effectiveImageSizeSelection = extract("effectiveImageSizeSelection", helpers);
    helpers.buildEffectiveImageSizeRequest = extract("buildEffectiveImageSizeRequest", helpers);
    helpers.parseRequestedImageSizeDimensions = extract("parseRequestedImageSizeDimensions", helpers);
    helpers.applyNormalizedCustomImageSize = extract("applyNormalizedCustomImageSize", helpers);
    helpers.serializeImageSizeSelection = extract("serializeImageSizeSelection", helpers);
    helpers.restoreImageSizeSelection = extract("restoreImageSizeSelection", helpers);
    const selection = { mode: "custom", aspectRatio: "", resolution: "auto", customRatio: "16:9", customWidth: "1001", customHeight: "997" };
    const context = { ...helpers, videoMode: false, effectiveModel: "image", rawImageSizeSelection: selection,
      rawDraftSizeSelection: selection, imageSnapToMultiple16: align, imageQuality: "auto", draft: { model: "image", quality: "auto" } };
    const expected = align ? "1008x1008" : "1001x997";
    for (const requestName of ["currentImageSizeRequest", "draftSizeRequest"]) {
      const request = extract(requestName, context);
      assert.equal(request.size, expected);
      const stored = helpers.serializeImageSizeSelection(helpers.applyNormalizedCustomImageSize(request.selection, request.size));
      const queued = extract("activeTurnSizeRequest", { ...helpers, activeTurn: { model: "image", size: request.size, sizeSelection: stored } });
      assert.equal(queued.size, expected);
      assert.equal(queued.upstreamSize, expected);
    }
    const preview = extract("editingDraftSizeRequest", { ...helpers, imageSnapToMultiple16: align,
      editingTurnDraft: { ...selection, sizeMode: "custom", model: "image", quality: "auto" } })();
    assert.equal(preview.size, expected);
  });
}

test("video recovery follows the original task asynchronously with the configured authentication", async () => {
 const fixture=retryFixture("video","error");
 fixture.turn.images[0].taskId="original-video";
 fixture.turn.images[0].canRecoverVideo=true;
 const seen=[];
 const requestOptions={sessionKey:"custom-session"};
 const snapshots=[{id:"original-video",status:"running",revision:4},{id:"original-video",status:"success",revision:5}];
 const retry=extract("handleRetryImage",{
  ...fixture.context, currentSessionKeyRef:{current:"custom-session"},creationTaskRequestOptions:requestOptions,
  CREATION_TASK_POLL_MAX_DURATION_MS:60_000,isTaskActive:status=>["queued","running"].includes(status),
  recoverVideoTask:async(id,options)=>{assert.equal(options,requestOptions);return {id,status:"queued",revision:3};},
  fetchCreationTasks:async(ids,options)=>{assert.deepEqual(ids,["original-video"]);assert.equal(options,requestOptions);return {items:[snapshots.shift()]};},
  sleep:async()=>{},
  taskDataToStoredImage:(image,task)=>{seen.push(task.status);return {...image,status:task.status==="success"?"success":"loading",taskRevision:task.revision};},
  deriveGenerationTaskStatus:()=>({}),
  runConversationQueue:()=>assert.fail("must not submit generation while recovering"),
  formatCreationTaskError:error=>error.message,
  toast:{loading:()=>1,dismiss:()=>{},success:()=>{},error:error=>fixture.errors.push(error)},
 });
 await retry("conversation","turn",0);
 assert.deepEqual(fixture.errors,[]);
 assert.deepEqual(seen,["queued","running","success"]);
 assert.equal(fixture.saved.turns[0].images[0].taskId,"original-video");
});

for (const outcome of ["found", "missing", "lookup error"]) {
  test(`an accepted video with ${outcome} observes its original ID and keeps new submissions`, async () => {
    const accepted = { taskId: "accepted-original", count: 1 };
    const fresh = { taskId: "new-submission", count: 1 };
    const options = studioSubmissionOptions({
      mode: "video", images: [{ taskId: accepted.taskId, taskRevision: 2, status: "loading" }],
    });
    const calls = [];
    const { createStudioTaskSubmitter } = studioSubmitter({
      fetchCreationTasks: async (ids, auth) => {
        assert.equal(auth, options.requestOptions);
        calls.push(["lookup", ...ids]);
        if (outcome === "lookup error") throw new Error("Temporary lookup error");
        return { items: outcome === "found" ? [{ id: accepted.taskId, status: "running" }] : [] };
      },
      createVideoGenerationTask: async ({ clientTaskId }) => {
        calls.push(["create", clientTaskId]);
        return { id: clientTaskId, status: "queued" };
      },
    });
    const result = await createStudioTaskSubmitter(options)([accepted, fresh]);
    assert.deepEqual(calls, [["lookup", accepted.taskId], ["create", fresh.taskId]]);
    assert.deepEqual(result.submitted.map(task => task.id), outcome === "found" ? [accepted.taskId, fresh.taskId] : [fresh.taskId]);
    assert.deepEqual(result.failed.map(({ group }) => group.taskId), outcome === "found" ? [] : [accepted.taskId]);
  });
}

test("a retryable image submission reuses its ID and preserves other task outcomes", async () => {
  const calls = [];
  const retries = [];
  const { createStudioTaskSubmitter } = studioSubmitter({
    createImageGenerationTask: async (id) => {
      calls.push(id);
      if (id === "retry" && calls.filter(item => item === id).length === 1) throw { status: 503 };
      if (id === "invalid") throw { status: 400 };
      return { id, status: "queued" };
    },
  }, (resume, delay) => { retries.push(delay); resume(); });
  const result = await createStudioTaskSubmitter(studioSubmissionOptions({ mode: "generate" }))(
    ["retry", "invalid", "success"].map(taskId => ({ taskId, count: 1 })),
  );
  assert.deepEqual(calls, ["retry", "invalid", "success", "retry"]);
  assert.deepEqual(retries, [750]);
  assert.deepEqual(result.submitted.map(task => task.id), ["retry", "success"]);
  assert.deepEqual(result.failed.map(({ group }) => group.taskId), ["invalid"]);
});

test("a session change before retry discards the result and skips cancellation", async () => {
  let current = true;
  let requests = 0;
  const { createStudioTaskSubmitter, ImageTaskDispatchAbortedError } = studioSubmitter({
    createImageGenerationTask: async () => { requests++; throw { status: 503 }; },
    cancelCreationTask: () => assert.fail("A new account cannot cancel the old account's tasks"),
  }, (resume) => { current = false; resume(); });
  const submit = createStudioTaskSubmitter({
    ...studioSubmissionOptions({ mode: "generate" }),
    assertDispatchAllowed: () => { if (!current) throw new ImageTaskDispatchAbortedError(); },
    isSessionCurrent: () => current,
  });
  await assert.rejects(submit([{ taskId: "retry", count: 1 }]), ImageTaskDispatchAbortedError);
  assert.equal(requests, 1);
});
