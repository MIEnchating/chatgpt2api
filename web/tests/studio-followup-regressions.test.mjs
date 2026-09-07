import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as imageOptions from "../src/lib/image-options.ts";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { activeVideoModelContracts, installVideoModelContracts } from "../src/lib/video-model-contracts.ts";
import { normalizeVideoRequest } from "../src/lib/video-request-normalizer.ts";
import { videoTurnFieldsFromNormalizedRequest } from "../src/app/image/video-task-state.ts";
import { canDispatchImageTurn, canStartImageConversationQueueRunner } from "../src/lib/image-task-state.ts";

const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../src/app/image/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Execute source functions with deferred API boundaries to exercise races.
function extract(name, context) {
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      const value = node.initializer;
      expression = ts.isCallExpression(value) && ["useCallback", "useMemo"].includes(value.expression.getText(source))
        ? value.arguments[0].getText(source) : value.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
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
  class Aborted extends Error {}
  let allowed = true;
  const response = deferred();
  const cancellations = [];
  const groups = [{ taskId: "task", count: 1 }];
  const submit = extract("submitTaskGroups", {
    activeTurn: { mode: "video", prompt: "draw", model: "video" }, videoReferenceUrls: [], activeTurnRelayTokenName: undefined,
    assertTaskDispatchAllowed: () => { if (!allowed) throw new Aborted(); },
    taskDispatchIsAllowed: () => allowed, submitVideoTaskGroups: () => response.promise,
    pageActiveRef: { current: true }, runnerSessionEpoch: 0, pageSessionEpochRef: { current: 0 },
    ImageTaskDispatchAbortedError: Aborted,
    cancelTaskGroupsAfterSameSessionAbort: async ids => cancellations.push(...ids),
  });
  const pending = submit(groups);
  allowed = false;
  response.resolve({ submitted: [{ id: "task" }], failed: [] });
  await assert.rejects(pending, Aborted);
  assert.deepEqual(cancellations, ["task"]);
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
    pageActiveRef: active, pageSessionEpochRef: epoch, session: { key: "a" },
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

test("compensating cancellation stops after the session changes during its delay", async () => {
  let current = true;
  const cancelled = [];
  const cancel = extract("cancelTaskGroupsAfterSameSessionAbort", {
    pageActiveRef: { current: true }, runnerSessionEpoch: 0, pageSessionEpochRef: { current: 0 },
    getCachedAuthSession: () => ({ key: current ? "a" : "b" }), expectedSessionKey: "a", creationTaskRequestOptions: {},
    cancelCreationTask: async id => cancelled.push(id), sleep: async () => { current = false; },
  });
  await cancel(["task", "task"]);
  assert.deepEqual(cancelled, ["task"]);
});

test("first and last frame uploads keep the remaining slot busy", async () => {
  const uploads = [deferred(), deferred()];
  const busy = [];
  let next = 0;
  const upload = extract("handleVideoFrameFileChange", {
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

for (const mode of ["generate", "chat"]) {
  test(`retry still rejects a ${mode === "chat" ? "chat response" : "successful image"}`, async () => {
    const fixture = retryFixture(mode, mode === "chat" ? "message" : "success");
    await extract("handleRetryImage", fixture.context)("conversation", "turn", 0);
    assert.equal(fixture.saved, undefined);
    assert.equal(fixture.errors.length, 1);
  });
}

for (const name of ["handleRetryImage", "handleRegenerateTurn"]) {
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
  test(`${mode} task dispatch uses the turn API mode after preferences change`, () => {
    let options;
    const submit = extract("submitTaskGroup", {
      activeTurn: { mode, apiMode: "responses", model: "image", prompt: "draw" }, imageAPIMode: "images",
      usesReferenceImages: value => value === "edit", referenceFiles: [],
      activeTurnSizeRequest: {}, taskQuality: "auto", taskImageResolution: undefined,
      taskOutputFormat: undefined, taskOutputCompression: undefined, taskStream: false, taskPartialImages: 0,
      imageResponseFormatB64JSON: false, imageCodexCLICompatibility: false, imageGenerationPreferences: {},
      activeTurnRelayTokenGroup: undefined, activeTurnRelayTokenName: undefined, creationTaskRequestOptions: {},
      createImageGenerationTask: (...args) => { options = args[13]; },
      createImageEditTask: (...args) => { options = args[14]; },
    });
    submit({ taskId: "task", count: 1 });
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
