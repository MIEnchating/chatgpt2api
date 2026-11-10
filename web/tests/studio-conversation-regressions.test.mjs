import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { imageConversationHasActiveTurn, mergeImageConversationSnapshot } from "../src/lib/image-task-state.ts";
import { isGPTImage26 } from "../src/lib/image-model-capabilities.ts";

const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../src/app/image/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const store = ts.createSourceFile("store.ts", readFileSync(new URL("../src/store/image-conversations.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const isSummary = item => item?.historySummaryOnly === true;
function findNode(file, predicate) {
  let found;
  function visit(node) {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, "Source callback must exist");
  return found;
}
function compile(expression, context) {
  const code = ts.transpile(`const callback = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${code}\nreturn callback;`)(...Object.values(context));
}
function submit(context) {
  const node = findNode(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === "handleSubmit");
  return compile(node.initializer.getText(source), context);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function submissionFixture(conversation) {
  const errors = [], queued = [], selected = [];
  let cleared = 0, id = 0;
  const snapshot = { selectedConversationId: conversation?.id ?? null, imagePrompt: "next request" };
  const context = {
    isGPTImage26,
    selectedConversationId: snapshot.selectedConversationId, isLoadingHistory: false,
    conversationsRef: { current: conversation ? [conversation] : [] },
    imageConversationHasActiveTurn, isImageConversationHistorySummaryOnly: isSummary,
    isSubmitDispatchingRef: { current: false }, setIsSubmitDispatching: () => {},
    referenceUploadPendingCountRef: { current: 0 }, videoFrameUploadsRef: { current: new Map() },
    videoReferenceUploadPendingCountRef: { current: 0 }, audioReferenceUploadPendingCountRef: { current: 0 },
    composerMode: "image", imagePrompt: snapshot.imagePrompt, imageModel: "new-model",
    smartContextEnabled: false, contextTextModel: "vision-text", contextTextModels: ["vision-text"],
    imageCreationModelOptions: [{ value: "new-model" }], defaultImageModel: "new-model", requireRelayToken: () => true,
    referenceImages: [], videoFirstFrameURL: "", videoLastFrameURL: "", videoReferenceImageURLs: [], videoReferenceVideoURLs: [], videoReferenceAudioURLs: [], videoSeconds: "4",
    absoluteReferenceURL: value => value, cleanReferenceURLs: value => value,
    videoRequiresMultimodalReferenceMode: () => false, supportsVideoMultimodalReferences: () => false,
    imageConversationReferenceLimitMessage: () => "", imageWorkbenchReferenceImageLimit: () => 10,
    composerSubmissionStateRef: { current: snapshot },
    getComposerConversationMode: () => "generate", normalizeRequestedImageCount: Number, imageCount: "1",
    imageSizeMode: "auto", imageAspectRatio: "1:1", imageResolution: "1k", imageCustomRatio: "", imageCustomWidth: "", imageCustomHeight: "", imageSnapToMultiple16: true, imageQuality: "auto",
    buildEffectiveImageSizeRequest: () => ({ selection: { mode: "auto" }, size: "1024x1024" }),
    isInvalidCustomRatioSelection: () => false, customImageSizeChanged: () => false,
    applyNormalizedCustomImageSize: value => value, serializeImageSizeSelection: value => value,
    imageOutputFormat: "png", imageOutputFormatForModel: () => undefined, imageQualityForRequest: () => "auto",
    imageStreamEnabled: false, imageAPIMode: "images", imageGenerationPreferences: {}, imageResponseFormatB64JSON: false, imageCodexCLICompatibility: false,
    activeRelayTokenKind: "image", nextTokenNameForModel: (_kind, model) => `key-${model}`, defaultImageVisibility: "private",
    createId: () => `new-${++id}`, imageTaskBatchId: (id, index) => `${id}-${index}`, usesReferenceImages: () => false,
    buildConversationTitle: value => value, updateTurnProgress: () => {}, clearTurnProgress: () => {},
    setSelectedConversationId: value => selected.push(value), clearComposerInputs: () => cleared++,
    runConversationQueue: value => queued.push(value), pageActiveRef: { current: true }, formatCreationTaskError: String,
    toast: { error: message => errors.push(message) },
  };
  context.updateConversation = async (_id, update) => {
    const next = update(context.conversationsRef.current[0] ?? null);
    context.conversationsRef.current = [next];
    return next;
  };
  return { context, errors, queued, selected, get cleared() { return cleared; } };
}
const complete = () => ({ id: "conversation", turns: [{ id: "first", model: "old-model", status: "success", images: [{ status: "success" }] }] });

test("direct generation never requires a text model or text key", async () => {
  const fixture = submissionFixture(complete());
  fixture.context.contextTextModels = [];
  fixture.context.contextTextModel = "";
  const kinds = [];
  fixture.context.requireRelayToken = kind => { kinds.push(kind); return kind === "image"; };
  await submit(fixture.context)();
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(kinds, ["image"]);
  assert.equal(fixture.context.conversationsRef.current[0].turns.at(-1).promptContext, undefined);
  assert.equal(fixture.queued.length, 1);
});

test("smart generation saves its model and execution ID before queueing", async () => {
  const fixture = submissionFixture(complete());
  fixture.context.smartContextEnabled = true;
  const kinds = [];
  fixture.context.requireRelayToken = kind => { kinds.push(kind); return true; };
  await submit(fixture.context)();
  assert.deepEqual(fixture.errors, []);
  const turn = fixture.context.conversationsRef.current[0].turns.at(-1);
  assert.deepEqual(kinds, ["image", "text"]);
  assert.equal(turn.prompt, "next request");
  assert.deepEqual(turn.studioAgent, { model: "vision-text", tokenName: "key-vision-text", runId: `${turn.id}-agent` });
  assert.equal(fixture.queued.length, 1);
});

for (const missing of ["model", "key"]) {
  test(`smart context refuses generation when its text ${missing} is missing`, async () => {
    const fixture = submissionFixture(complete());
    fixture.context.smartContextEnabled = true;
    if (missing === "model") fixture.context.contextTextModels = [];
    else fixture.context.requireRelayToken = kind => kind === "image";
    await submit(fixture.context)();
    assert.equal(fixture.queued.length, 0);
    assert.equal(fixture.context.conversationsRef.current[0].turns.length, 1);
  });
}

for (const status of ["queued", "generating"]) {
  test(`submit refuses a second request while the same conversation is ${status}`, async () => {
    const conversation = complete();
    conversation.turns[0].status = status;
    const fixture = submissionFixture(conversation);
    await submit(fixture.context)();
    assert.match(fixture.errors[0], /等待完成/);
    assert.equal(fixture.queued.length, 0);
    assert.equal(conversation.turns.length, 1);
  });
}
for (const state of ["missing", "summary", "history-loading"]) {
  test(`submit refuses incomplete conversation state: ${state}`, async () => {
    const fixture = submissionFixture(state === "summary" ? { id: "conversation", historySummaryOnly: true, turns: [] } : null);
    fixture.context.selectedConversationId = "conversation";
    fixture.context.isLoadingHistory = state === "history-loading";
    await submit(fixture.context)();
    assert.match(fixture.errors[0], /详情/);
    assert.deepEqual(fixture.queued, []);
  });
}
test("after completion, switching model appends a new turn and keeps the first result", async () => {
  const fixture = submissionFixture(complete());
  await submit(fixture.context)();
  assert.deepEqual(fixture.errors, []);
  const turns = fixture.context.conversationsRef.current[0].turns;
  assert.equal(turns.length, 2);
  assert.equal(turns[0].model, "old-model");
  assert.equal(turns[1].model, "new-model");
  assert.equal(turns[1].tokenName, "key-new-model");
  assert.deepEqual(fixture.queued, ["conversation"]);
  assert.equal(fixture.cleared, 1);
});
test("the serialized save rechecks busy state before appending", async () => {
  const fixture = submissionFixture(complete());
  const save = fixture.context.updateConversation;
  fixture.context.updateConversation = async (...args) => {
    fixture.context.conversationsRef.current[0].turns[0].status = "generating";
    return save(...args);
  };
  await submit(fixture.context)();
  assert.match(fixture.errors[0], /会话正在/);
  assert.equal(fixture.context.conversationsRef.current[0].turns.length, 1);
  assert.deepEqual(fixture.queued, []);
  assert.equal(fixture.context.isSubmitDispatchingRef.current, false);
});
for (const change of ["new-draft", "edited-prompt"]) {
  test(`a pending save cannot clear the composer after ${change}`, async () => {
    const fixture = submissionFixture(complete());
    const saved = deferred();
    const save = fixture.context.updateConversation;
    fixture.context.updateConversation = async (...args) => { await saved.promise; return save(...args); };
    const pending = submit(fixture.context)();
    fixture.context.composerSubmissionStateRef.current = change === "new-draft"
      ? { selectedConversationId: null, imagePrompt: "another draft" }
      : { selectedConversationId: "conversation", imagePrompt: "edited during save" };
    saved.resolve();
    await pending;
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.cleared, 0);
    assert.deepEqual(fixture.selected, []);
    assert.deepEqual(fixture.queued, ["conversation"]);
  });
}

const detailEffect = findNode(source, node => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
  && node.arguments[0]?.getText(source).includes("void getImageConversation(conversationID)"));
function detailFixture() {
  const requests = new Map(), calls = [], selected = [];
  const state = { error: "", id: null };
  const context = {
    selectedConversationId: "a", selectedConversationNeedsDetail: true, isLoadingHistory: false, conversationDetailRetryVersion: 0,
    deletedConversationIdsRef: { current: new Set() }, pageActiveRef: { current: true },
    conversationsRef: { current: [{ id: "a", turns: [], historySummaryOnly: true, revision: 1 }] },
    setConversationDetailId: value => { state.id = value; }, setConversationDetailError: value => { state.error = value; },
    setSelectedConversationId: value => selected.push(value), setConversations: value => { context.conversationsRef.current = value; },
    getImageConversation: id => {
      calls.push(id);
      if (!requests.has(id)) requests.set(id, deferred());
      return requests.get(id).promise;
    },
    mergeImageConversationItems: (current, incoming) => {
      const map = new Map(current.map(item => [item.id, item]));
      for (const item of incoming) map.set(item.id, map.has(item.id) ? mergeImageConversationSnapshot(map.get(item.id), item) : item);
      return [...map.values()];
    },
    isImageConversationHistorySummaryOnly: isSummary,
    pickFallbackConversationId: items => items[0]?.id ?? null,
    shouldFallbackToImageConversationHistoryDetail: status => status === 404 || status === 410,
  };
  let previous, cleanup;
  return {
    context, state, requests, calls, selected,
    render() {
      const deps = compile(detailEffect.arguments[1].getText(source), context);
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        cleanup?.();
        cleanup = compile(detailEffect.arguments[0].getText(source), context)();
        previous = deps;
      }
    },
  };
}
test("unrelated history refresh does not cancel a pending detail request", async () => {
  const fixture = detailFixture();
  fixture.render();
  fixture.context.conversationsRef.current = [...fixture.context.conversationsRef.current, { id: "b", turns: [] }];
  fixture.render();
  fixture.requests.get("a").resolve({ id: "a", turns: [], revision: 1 });
  await settle();
  assert.equal(fixture.context.conversationsRef.current.find(item => item.id === "a").historySummaryOnly, undefined);
  assert.deepEqual(fixture.calls, ["a"]);
});
test("switching A to B to A applies the shared pending request to the current selection", async () => {
  const fixture = detailFixture();
  fixture.render();
  fixture.context.selectedConversationId = "b";
  fixture.render();
  fixture.context.selectedConversationId = "a";
  fixture.render();
  fixture.requests.get("a").resolve({ id: "a", turns: [{ id: "first", images: [] }], revision: 1 });
  fixture.requests.get("b").resolve({ id: "b", turns: [], revision: 1 });
  await settle();
  assert.equal(fixture.context.conversationsRef.current[0].turns[0].id, "first");
  assert.equal(fixture.context.conversationsRef.current.some(item => item.id === "b"), false);
});
test("detail failure becomes a retryable error and a retry can load the conversation", async () => {
  const fixture = detailFixture();
  fixture.render();
  fixture.requests.get("a").reject(new Error("network unavailable"));
  await settle();
  assert.equal(fixture.state.error, "network unavailable");
  fixture.requests.delete("a");
  fixture.context.conversationDetailRetryVersion++;
  fixture.render();
  assert.equal(fixture.state.error, "");
  fixture.requests.get("a").resolve({ id: "a", turns: [], revision: 1 });
  await settle();
  assert.equal(fixture.context.conversationsRef.current[0].historySummaryOnly, undefined);
});
test("an outdated detail response reports retry instead of leaving an endless loader", async () => {
  const fixture = detailFixture();
  fixture.context.conversationsRef.current[0].revision = 2;
  fixture.render();
  fixture.requests.get("a").resolve({ id: "a", turns: [], revision: 1 });
  await settle();
  assert.match(fixture.state.error, /重试/);
});
test("a missing detail chooses another conversation rather than the same summary", async () => {
  const fixture = detailFixture();
  fixture.render();
  fixture.requests.get("a").resolve(null);
  await settle();
  assert.deepEqual(fixture.selected, [null]);
});
for (const name of ["saveImageConversation", "saveImageConversationCoalesced"]) {
  test(`${name} rejects a summary before touching persistence`, async () => {
    const node = findNode(store, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    const save = compile(node.getText(store).replace(/^export\s+/, ""), {
      isImageConversationHistorySummaryOnly: isSummary,
      getCurrentImageConversationScopeState: () => assert.fail("Summary must never reach persistence"),
    });
    await assert.rejects(save({ id: "a", turns: [], historySummaryOnly: true }), /incomplete/);
  });
}


function renameFixture(conversation) {
  const errors = [], writes = [], busy = [];
  const context = {
    renameTitle: "  New title  ", renameBusy: false, renamingConversation: { id: conversation.id },
    conversationsRef: { current: [conversation] }, isImageConversationHistorySummaryOnly: isSummary,
    pageActiveRef: { current: true }, setRenameBusy: value => busy.push(value), setRenameError: value => errors.push(value),
    setRenamingConversation: value => { context.dialog = value; }, assertPageSessionCurrent() {},
    getImageConversation: async () => { throw new Error("detail unavailable"); },
    updateConversation: async (id, update, options) => {
      const next = update(context.conversationsRef.current.find(item => item.id === id));
      writes.push({ id, next, options }); return next;
    },
  };
  const node = findNode(source, node => ts.isFunctionDeclaration(node) && node.name?.text === "handleRenameConversation");
  return { context, errors, writes, busy, run: () => compile(node.getText(source).replace("async function handleRenameConversation", "async function"), context)() };
}

test("renaming uses a durable save and preserves the latest conversation turns", async () => {
  const conversation = { ...complete(), title: "Old", revision: 4 };
  const fixture = renameFixture(conversation);
  fixture.context.conversationsRef.current = [{ ...conversation, turns: [...conversation.turns, { id: "second" }] }];
  await fixture.run();
  assert.equal(fixture.writes[0].next.title, "New title");
  assert.equal(fixture.writes[0].next.turns.length, 2);
  assert.deepEqual(fixture.writes[0].options, { persist: "durable" });
  assert.equal(fixture.context.dialog, null);
});

test("renaming a history summary loads full turns before saving", async () => {
  const summary = { id: "conversation", revision: 3, historySummaryOnly: true, turns: [] };
  const fixture = renameFixture(summary);
  const detail = { ...complete(), revision: 3 };
  fixture.context.getImageConversation = async () => detail;
  await fixture.run();
  assert.equal(fixture.writes[0].next.turns.length, 1);
  assert.equal(fixture.writes[0].next.historySummaryOnly, undefined);
});

for (const failure of ["load", "newer-summary", "save", "session-changed"]) {
  test(`renaming keeps the dialog open and reports ${failure} errors`, async () => {
    const summary = { id: "conversation", revision: 4, historySummaryOnly: true, turns: [] };
    const fixture = renameFixture(failure === "save" ? complete() : summary);
    if (failure !== "load") fixture.context.getImageConversation = async () => ({ ...complete(), revision: failure === "newer-summary" ? 3 : 4 });
    if (failure === "save") fixture.context.updateConversation = async () => { throw new Error("save rejected"); };
    if (failure === "session-changed") fixture.context.assertPageSessionCurrent = () => { throw new Error("session changed"); };
    await fixture.run();
    assert.ok(fixture.errors.at(-1));
    assert.equal(fixture.context.dialog, undefined);
    assert.deepEqual(fixture.busy, [true, false]);
    assert.equal(fixture.writes.length, 0);
  });
}


test("smart video generation can choose required material from conversation history", async () => {
  const fixture = submissionFixture(complete());
  Object.assign(fixture.context, {
    composerMode: "video", smartContextEnabled: true, videoModel: "image-to-video",
    setImagePrompt: () => {}, replaceReferenceImages: () => {}, setVideoFirstFrameURL: () => {}, setVideoLastFrameURL: () => {}, setVideoReferenceImageURLs: () => {}, setVideoReferenceVideoURLs: () => {}, setVideoReferenceAudioURLs: () => {}, videoReferenceAudioURLsRef: { current: [] },
    videoModelOptions: [{ value: "image-to-video" }], videoTaskCount: "1", videoSize: "16:9",
    videoResolution: "720p", videoGenerateAudio: false, videoWatermark: false, videoParameters: { seed: 0 },
    videoRequiresReferenceImage: () => true, videoRequiresReferenceVideo: () => true, videoRequiresReferenceAudio: () => true,
    videoWorkbenchReferenceLimitError: () => "", videoReferenceImageLimit: () => 2,
    videoReferenceCombinationError: () => { throw Error("Agent must select materials first"); },
    normalizeVideoRequest: () => { throw Error("Agent must select materials first"); },
    getComposerConversationMode: () => "video",
  });
  await submit(fixture.context)();
  assert.deepEqual(fixture.errors, []);
  const turn = fixture.context.conversationsRef.current[0].turns.at(-1);
  assert.equal(turn.mode, "video"); assert.equal(turn.studioAgent.model, "vision-text");
  assert.equal(turn.videoGenerateAudio, false); assert.deepEqual(turn.videoParameters, { seed: 0 });
  assert.equal(fixture.queued.length, 1);
});
