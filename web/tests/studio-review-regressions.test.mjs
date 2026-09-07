import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../src/app/image/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Execute the real callback body with controlled state and API boundaries.
function callback(name, context) {
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = node.initializer.arguments[0].getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Missing callback: ${name}`);
  const compiled = ts.transpile(`const handler = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${compiled}\nreturn handler;`)(...Object.values(context));
}

function turnContext() {
  const turn = { id: "turn", model: "old-model", mode: "generate", prompt: "draw", count: 1, referenceImages: [], images: [{ id: "slot", taskId: "old-task", storageKey: "old-output", status: "error" }] };
  const conversation = { id: "conversation", turns: [turn] };
  const messages = [];
  let saved;
  return {
    get saved() { return saved; }, messages,
    context: {
      conversationsRef: { current: [conversation] }, queueingTurnIdsRef: { current: new Set() },
      retryingImageIdsRef: { current: new Set() }, pageActiveRef: { current: true },
      isTurnInProgress: () => false, isConfiguredCreationModel: () => true,
      requireRelayToken: () => true, relayTokenNameForKind: (_kind, model) => `key-for-${model}`,
      imageModel: "new-model", videoModel: "video-model", imageTurnReferenceValidationError: () => "",
      imageTurnProgressKey: (a, b) => `${a}:${b}`, createId: () => "new-id", imageTaskBatchId: (id, i) => `${id}-${i}`,
      deriveTurnStatus: () => ({ status: "queued" }),
      updateConversation: async (_id, update) => { saved = update(conversation); return saved; },
      runConversationQueue: () => {}, formatCreationTaskError: String,
      toast: { error: value => messages.push(value), success: () => {}, message: () => {} },
    },
  };
}

test("editing a turn routes the new model through its own relay key", async () => {
  const fixture = turnContext();
  const selection = { mode: "auto" };
  const handler = callback("handleSaveEditingTurn", {
    ...fixture.context,
    editingTurnDraft: { conversationId: "conversation", turnId: "turn", prompt: "new prompt", model: "new-model", mode: "generate", referenceImages: [], count: "1" },
    editReferenceUploadPendingCountRef: { current: 0 }, editFileInputRef: { current: null },
    getComposerConversationMode: () => "generate", usesReferenceImages: () => false,
    imageWorkbenchAcceptsReferenceImages: () => true, imageConversationReferenceLimitMessage: () => "", imageWorkbenchReferenceImageLimit: () => 10,
    normalizeRequestedImageCount: Number, buildEffectiveImageSizeRequest: () => ({ selection, size: "" }),
    isInvalidCustomRatioSelection: () => false, customImageSizeChanged: () => false,
    applyNormalizedCustomImageSize: value => value, serializeImageSizeSelection: value => value,
    imageOutputFormatForModel: () => undefined, imageQualityForRequest: () => "auto", supportsStructuredImageParameters: () => false,
    buildConversationTitle: value => value, setEditingTurnDraft: () => {}, imageSnapToMultiple16: true,
  });
  await handler(true);
  assert.deepEqual(fixture.messages, []);
  assert.equal(fixture.saved.turns[0].model, "new-model");
  assert.equal(fixture.saved.turns[0].tokenName, "key-for-new-model");
});

test("retrying one failed slot removes its previous output storage key", async () => {
  const fixture = turnContext();
  await callback("handleRetryImage", fixture.context)("conversation", "turn", 0);
  assert.deepEqual(fixture.messages, []);
  const slot = fixture.saved.turns[0].images[0];
  assert.notEqual(slot.taskId, "old-task");
  assert.equal(slot.storageKey, undefined);
});

for (const name of ["handleVideoFrameFileChange", "handleVideoReferenceFileChange"]) {
  test(`${name} ignores upload completion after the draft is replaced`, async () => {
    let release;
    const upload = new Promise(resolve => { release = resolve; });
    const outputs = [];
    const epoch = { current: 0 };
    const context = {
      referenceUploadEpochRef: epoch, pageActiveRef: { current: true },
      videoFrameUploadsRef: { current: new Map() }, videoReferenceUploadPendingCountRef: { current: 0 },
      session: { key: "session-a" }, getCachedAuthSession: () => ({ key: "session-a" }),
      setVideoFrameUploading: () => {}, setVideoReferenceUploading: () => {},
      uploadVideoImageReference: () => upload, uploadVideoReference: () => upload,
      setVideoFirstFrameURL: value => outputs.push(value), setVideoLastFrameURL: value => outputs.push(value),
      setVideoReferenceVideoURLs: update => outputs.push(update([])),
      toast: { error: () => {}, success: () => {} },
    };
    const handler = callback(name, context);
    const pending = name === "handleVideoFrameFileChange"
      ? handler("first", { type: "image/png", name: "frame.png", size: 10 })
      : handler({ type: "video/mp4", name: "ref.mp4", size: 10 });
    epoch.current++;
    release({ url: "https://example.test/old-draft" });
    await pending;
    assert.deepEqual(outputs, []);
  });
}

for (const stage of ["inspection", "upload"]) {
  test(`audio reference ignores a replaced draft during ${stage}`, async () => {
    let release;
    const deferred = new Promise(resolve => { release = resolve; });
    const epoch = { current: 0 };
    const outputs = [];
    let uploadCount = 0;
    const metadata = { durationMs: 1000 };
    const handler = callback("handleAudioReferenceFileChange", {
      referenceUploadEpochRef: epoch, pageActiveRef: { current: true },
      audioReferenceUploadPendingCountRef: { current: 0 },
      inspectAudioReferenceFile: () => stage === "inspection" ? deferred : Promise.resolve(metadata),
      videoReferenceAudioURLs: [], audioReferenceMetadataRef: { current: new Map() },
      videoReferenceAudioURLsRef: { current: [] },
      pendingAudioReferenceDurationMsRef: { current: 0 }, audioReferenceMetadataError: () => "",
      setAudioReferenceUploading: () => {},
      uploadAudioReference: () => { uploadCount++; return deferred; },
      setVideoReferenceAudioURLs: update => outputs.push(update([])),
      toast: { error: () => {}, success: () => {} },
    });
    const pending = handler({ type: "audio/mpeg", name: "ref.mp3", size: 10 });
    await Promise.resolve();
    epoch.current++;
    release(stage === "inspection" ? metadata : { url: "https://example.test/old-audio" });
    await pending;
    assert.deepEqual(outputs, []);
    assert.equal(uploadCount, stage === "inspection" ? 0 : 1);
  });
}

test("IME confirmation does not submit a generation request", () => {
  const composer = ts.createSourceFile("composer.tsx", readFileSync(new URL("../src/app/image/components/image-composer.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(composer) === "Textarea") {
      const attribute = node.attributes.properties.find(prop => prop.name?.getText(composer) === "onKeyDown");
      expression = attribute.initializer.expression.getText(composer);
    }
    ts.forEachChild(node, visit);
  }
  visit(composer);
  let submitted = 0;
  let prevented = 0;
  const compiled = ts.transpile(`const handler = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  const handler = new Function("activeModelAvailable", "onSubmit", `${compiled}\nreturn handler;`)(true, () => submitted++);
  const event = { key: "Enter", shiftKey: false, nativeEvent: { isComposing: true }, preventDefault: () => prevented++ };
  handler(event);
  assert.equal(submitted, 0);
  assert.equal(prevented, 0);
  handler({ ...event, nativeEvent: { isComposing: false } });
  assert.equal(submitted, 1);
  assert.equal(prevented, 1);
});
