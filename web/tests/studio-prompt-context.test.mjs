import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { buildStudioPromptContext, normalizeStudioPromptContext, parseStudioPromptPlan } from "../src/lib/studio-prompt-context.ts";

const reference = (name = "manual") => ({ name, type: "image/png", dataUrl: `https://example.test/${name}.png`, source: "upload" });
const turn = (id, prompt, extra = {}) => ({ id, prompt, mode: "generate", status: "success", model: "image", referenceImages: [], images: [], ...extra });
function fixture() {
  const previous = turn("one", "红衣女孩，水彩风格", { images: [{ status: "success", url: "https://example.test/one.png" }] });
  const current = turn("two", "背景改成海边", {
    status: "queued", promptContext: { model: "vision-text", tokenName: "text-key", taskId: "two-context" },
  });
  const future = turn("three", "future instruction", { images: [{ status: "success", url: "https://example.test/future.png" }] });
  return { current, conversation: { id: "conversation", turns: [previous, current, future] } };
}

test("context includes previous requirements and labeled images, excluding the current output and future turns", () => {
  const { conversation, current } = fixture();
  current.images = [{ status: "success", url: "https://example.test/current.png" }];
  const context = buildStudioPromptContext(conversation, current, 4);
  const history = JSON.parse(context.messages[1].content[0].text);
  assert.deepEqual(history.history.map(item => item.request), ["红衣女孩，水彩风格"]);
  assert.equal(history.current_request, "背景改成海边");
  assert.deepEqual(context.images.map(item => item.id), ["turn-1-image-1"]);
  assert.equal(context.images[0].image.dataUrl, "https://example.test/one.png");
  assert.match(context.messages[0].content, /Do not invent requirements/);
});

test("all text history is preserved while historical pictures are bounded and manual references remain available", () => {
  const { current } = fixture();
  current.referenceImages = [reference()];
  const history = Array.from({ length: 20 }, (_, i) => turn(`history-${i}`, `instruction-${i}`, {
    images: [{ status: "success", url: `https://example.test/${i}.png` }, { status: "error", url: "https://example.test/failed.png" }],
  }));
  history[0].promptContext = { model: "text", tokenName: "key", taskId: "task", preparedPrompt: "original fixed constraints" };
  const context = buildStudioPromptContext({ turns: [...history, current] }, current, 4);
  const data = JSON.parse(context.messages[1].content[0].text);
  assert.equal(data.history.length, 20);
  assert.equal(data.history[0].image_instruction, "original fixed constraints");
  assert.equal(context.images.length, 13);
  assert.equal(context.images[0].id, "turn-9-image-1");
  assert.equal(context.images.at(-1).id, "current-reference-1");
});

test("the plan preserves the model's reference order and cannot silently omit manual references", () => {
  const { conversation, current } = fixture();
  current.referenceImages = [reference()];
  const { images } = buildStudioPromptContext(conversation, current, 2);
  const parsed = parseStudioPromptPlan(JSON.stringify({ prompt: "使用图 1 的人物和图 2 的场景", reference_ids: ["turn-1-image-1", "current-reference-1"] }), images, 2);
  assert.equal(parsed.references[0].dataUrl, "https://example.test/one.png");
  assert.equal(parsed.references[1].name, "manual");
  assert.throws(() => parseStudioPromptPlan('{"prompt":"draw","reference_ids":[]}', images, 2), /遗漏/);
});

test("new subjects can generate without referencing the last image", () => {
  const { conversation, current } = fixture();
  const { images } = buildStudioPromptContext(conversation, current, 4);
  assert.deepEqual(parseStudioPromptPlan('{"prompt":"画一座雪山","reference_ids":[]}', images, 4), { prompt: "画一座雪山", references: [] });
});

for (const [text, limit] of [
  ["not json", 4], ['{"prompt":"","reference_ids":[]}', 4],
  ['{"prompt":"draw","reference_ids":["https://attacker.test/image"]}', 4],
  ['{"prompt":"draw","reference_ids":["turn-1-image-1"]}', 0],
  ['{"prompt":"draw","reference_ids":["turn-1-image-1","turn-1-image-1"]}', 4],
]) {
  test(`invalid or unsupported plans are rejected: ${text}`, () => {
    const { conversation, current } = fixture();
    const { images } = buildStudioPromptContext(conversation, current, limit);
    assert.throws(() => parseStudioPromptPlan(text, images, limit));
  });
}

test("prepared context survives history normalization", () => {
  const context = { model: "vision", tokenName: "key", taskId: "task", preparedPrompt: "保持红衣和水彩风格，只改背景" };
  assert.deepEqual(normalizeStudioPromptContext(JSON.parse(JSON.stringify(context))), context);
  assert.equal(normalizeStudioPromptContext({ model: "vision" }), undefined);
});

const service = ts.createSourceFile("service.ts", readFileSync(new URL("../src/services/studio-prompt-context.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function prepare(mocks) {
  const node = service.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "prepareStudioPromptContext");
  const expression = node.getText(service).replace("export async function", "async function");
  const context = { buildStudioPromptContext, parseStudioPromptPlan, ...mocks };
  const code = ts.transpile(`${expression}\nconst handler = prepareStudioPromptContext;`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${code}\nreturn handler;`)(...Object.values(context));
}
function serviceFixture() {
  const { current, conversation } = fixture();
  const controller = new AbortController();
  const submitted = [], cancelled = [], downloaded = [];
  const result = { id: "two-context", status: "success", data: [{ text_response: '{"prompt":"保持红衣水彩人物，只将背景改成海边","reference_ids":["turn-1-image-1"]}' }] };
  const mocks = {
    fetchCreationTasks: async () => ({ items: [] }),
    createChatGenerationTask: async input => { submitted.push(input); return { id: "two-context", status: "running" }; },
    waitForCreationTask: async () => result,
    imageToDataURL: async ({ url }) => { downloaded.push(url); return "data:image/png;base64,aW1hZ2U="; },
    resolveImageRequestURL: value => value,
    cancelCreationTask: async id => { cancelled.push(id); },
  };
  return { mocks, submitted, cancelled, downloaded, result, controller,
    input: { conversation, turn: current, referenceLimit: 4, signal: controller.signal, assertCurrent: () => {}, isSessionCurrent: () => true } };
}

test("text preparation sends image content and returns instructions and selected references", async () => {
  const fixture = serviceFixture();
  const plan = await prepare(fixture.mocks)(fixture.input);
  assert.equal(fixture.submitted.length, 1);
  assert.equal(fixture.submitted[0].model, "vision-text");
  assert.equal(fixture.submitted[0].relayTokenName, "text-key");
  assert.equal(fixture.submitted[0].messages[1].content.at(-1).type, "image_url");
  assert.match(plan.prompt, /保持红衣水彩/);
  assert.equal(plan.references[0].dataUrl, "https://example.test/one.png");
});

for (const status of ["running", "success"]) {
  test(`restoring a ${status} preparation task reuses it without another model call or image download`, async () => {
    const fixture = serviceFixture();
    fixture.mocks.fetchCreationTasks = async () => ({ items: [{ ...fixture.result, status }] });
    await prepare(fixture.mocks)(fixture.input);
    assert.equal(fixture.submitted.length, 0);
    assert.equal(fixture.downloaded.length, 0);
  });
}

test("a failed text task stops the pipeline", async () => {
  const fixture = serviceFixture();
  fixture.mocks.waitForCreationTask = async () => ({ status: "error", error: "vision not supported" });
  await assert.rejects(prepare(fixture.mocks)(fixture.input), /vision not supported/);
});

test("a failed recovery lookup stops and cancels the known text task without resubmission", async () => {
  const fixture = serviceFixture();
  fixture.mocks.fetchCreationTasks = async () => { throw new Error("lookup unavailable"); };
  await assert.rejects(prepare(fixture.mocks)(fixture.input), /lookup unavailable/);
  assert.equal(fixture.submitted.length, 0);
  assert.deepEqual(fixture.cancelled, ["two-context"]);
});

for (const sameSession of [true, false]) {
  test(`cancelling an in-flight text submission compensates only in its original session (${sameSession})`, async () => {
    const fixture = serviceFixture();
    fixture.input.isSessionCurrent = () => sameSession;
    fixture.mocks.createChatGenerationTask = async () => {
      fixture.controller.abort();
      return { id: "two-context", status: "running" };
    };
    await assert.rejects(prepare(fixture.mocks)(fixture.input), { name: "AbortError" });
    assert.deepEqual(fixture.cancelled, sameSession ? ["two-context"] : []);
  });
}

test("session expiry during image loading stops before submitting the text model", async () => {
  const fixture = serviceFixture();
  let current = true;
  fixture.input.assertCurrent = () => { if (!current) throw new DOMException("Session changed", "AbortError"); };
  fixture.mocks.imageToDataURL = async () => { current = false; return "data:image/png;base64,aW1hZ2U="; };
  await assert.rejects(prepare(fixture.mocks)(fixture.input), { name: "AbortError" });
  assert.equal(fixture.submitted.length, 0);
});
