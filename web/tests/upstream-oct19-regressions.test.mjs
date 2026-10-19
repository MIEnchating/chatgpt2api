import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createMaskEditTurn, imageMaskEditPrompt } from "../src/lib/image-mask-edit.ts";

function callback(path, name, context) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export /, "");
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = `const ${name} = ${node.initializer.getText(source)};`;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, `Missing ${name}`);
  const code = ts.transpile(expression.replaceAll("import.meta.url", JSON.stringify(new URL(path, import.meta.url).href)), { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${code}\nreturn ${name};`)(...Object.values(context));
}
function sourceTurn() {
  return {
    id: "original", model: "image-model", prompt: "Original prompt", mode: "generate", count: 3, size: "1536x1024",
    sizeSelection: { mode: "custom", customWidth: "1536", customHeight: "1024" }, quality: "high", outputFormat: "webp", outputCompression: 88,
    apiMode: "responses", imageSystemPrompt: "Original system", stream: true, partialImages: 2,
    responseFormatB64JSON: true, codexCLICompatibility: true, moderation: "low", tokenGroup: "group", tokenName: "key", visibility: "private",
    images: [{ id: "old-output", status: "success", url: "/images/original.webp" }], referenceImages: [],
    status: "success", createdAt: "2026-10-19T00:00:00Z", processingStartedAt: "old", error: "old error", workflowId: "old-workflow", videoSeconds: 5,
  };
}

test("mask editing creates a fresh queued task without modifying source configuration or output", () => {
  const source = sourceTurn(), original = structuredClone(source);
  const reference = { name: "mask.png", type: "image/png", dataUrl: "/conversation-assets/mask.png" };
  const result = createMaskEditTurn(source, "new-turn", "换成红色", source.model, reference, "now");
  assert.deepEqual(source, original);
  for (const key of ["model", "size", "sizeSelection", "quality", "outputFormat", "outputCompression", "apiMode", "imageSystemPrompt", "stream", "partialImages", "responseFormatB64JSON", "codexCLICompatibility", "moderation", "tokenGroup", "tokenName", "visibility"]) assert.deepEqual(result[key], source[key], key);
  assert.equal(result.mode, "edit");
  assert.equal(result.source, "image-workbench");
  assert.equal(result.count, 1);
  assert.equal(result.status, "queued");
  assert.equal(result.images[0].taskId, "new-turn-task-0");
  assert.equal(result.images[0].status, "loading");
  assert.deepEqual(result.referenceImages, [reference]);
  for (const key of ["workflowId", "processingStartedAt", "error", "videoSeconds"]) assert.equal(result[key], undefined);
  assert.equal(result.prompt, imageMaskEditPrompt("换成红色"));
});

test("mask edits persist history before dispatch and reject a second concurrent turn", async () => {
  let conversation = { id: "conversation", turns: [sourceTurn()] };
  const order = [];
  const handler = callback("../src/app/image/page.tsx", "handleMaskEdit", {
    maskEdit: { conversationId: "conversation", turnId: "original" }, maskOperationRef: { current: false },
    assertPageSessionCurrent() {}, imageCreationModelOptions: [{ value: "image-model" }], imageWorkbenchAcceptsReferenceImages: () => true,
    requireRelayToken: () => true, setMaskEditBusy() {}, ensureReferenceImageAsset: async () => ({ name: "mask.png", type: "image/png", dataUrl: "/conversation-assets/mask.png" }),
    createId: () => "new-turn", createMaskEditTurn, isImageConversationHistorySummaryOnly: () => false,
    imageConversationHasActiveTurn: (item) => item.turns.some(turn => turn.status === "queued"),
    updateConversation: async (id, update, options) => { assert.equal(id, "conversation"); assert.equal(options.persist, "durable"); conversation = update(conversation); await Promise.resolve(); order.push("saved"); return true; },
    setMaskEdit: () => order.push("closed"), setSelectedConversationId() {}, runConversationQueue: () => order.push("started"), pageActiveRef: { current: true },
  });
  await handler({ model: "image-model", prompt: "Change", markedDataURL: "data:image/png;base64,AA==" });
  assert.deepEqual(order, ["saved", "closed", "started"]);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].images[0].url, "/images/original.webp");
  await assert.rejects(handler({ model: "image-model", prompt: "Again", markedDataURL: "test" }), /正在生成/);
  assert.equal(conversation.turns.length, 2);
});

test("failed stops retry only failures and cannot cross an account switch", async () => {
  const requests = [], errors = [];
  let sessionKey = "original-session", fail = true;
  const stop = callback("../src/lib/stop-creation-tasks.ts", "stopCreationTasks", {
    getCachedAuthSession: () => ({ key: sessionKey }),
    cancelCreationTask: async id => { requests.push(id); if (id === "failed" && fail) throw new Error("network"); return { id }; },
    toast: { error: (message, options) => errors.push(options), success() {} },
  });
  const results = await stop(["done", "failed", "done"]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
  fail = false;
  errors[0].action.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ["done", "failed", "failed"]);
  sessionKey = "new-session";
  errors[0].action.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ["done", "failed", "failed"]);
});

test("cancelling ZIP creation terminates the active worker", async () => {
  let terminated = 0;
  class WorkerFixture { postMessage() {} terminate() { terminated++; } }
  const run = callback("../src/lib/zip.ts", "runZipWorker", { Worker: WorkerFixture });
  const controller = new AbortController();
  const pending = run({ operation: "create", entries: [] }, [], controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(terminated, 1);
});

test("late canvas task acknowledgements cancel with the generation's original session", async () => {
  const calls = [];
  const addTask = callback("../src/app/canvas/page.tsx", "addActiveGenerationTask", {
    stopCreationTasks: async (...args) => calls.push(args),
  });
  const controller = new AbortController();
  controller.abort();
  const generation = { controller, sessionKey: "original-session", taskIDs: new Set(["pending"]), submittedTaskIDs: new Set() };
  addTask(generation, "confirmed", "pending");
  assert.deepEqual([...generation.taskIDs], ["confirmed"]);
  assert.deepEqual([...generation.submittedTaskIDs], ["confirmed"]);
  assert.deepEqual(calls, [[["confirmed"], undefined, "original-session"]]);
});
