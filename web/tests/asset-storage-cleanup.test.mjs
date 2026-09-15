import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { assetListKey, collectAssetStorageKeys, settleAssetOperations } from "../src/app/assets/asset-library.ts";

const source = ts.createSourceFile("assets.tsx", readFileSync(new URL("../src/app/assets/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helpers = source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text.includes("AssetStorage"));
let deletion;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "deleteSelected") deletion = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(deletion);
const compiled = ts.transpile(`${helpers.map((node) => node.getText(source)).join("\n")}\nreturn (${deletion});`, { target: ts.ScriptTarget.ES2022 });

const asset = (id, overrides = {}) => ({ id, kind: "image", storageKey: `server:${id}`, owned: true, ...overrides });

function setup(items = [asset("one"), asset("two"), asset("three")]) {
  const controller = new AbortController();
  const lookups = [];
  const recordDeletions = [];
  const fileDeletions = [];
  const messages = [];
  let selectedKeys = new Set(items.map(assetListKey));
  let busy = false;
  let open = true;
  const context = {
    assets: items, deletableSelectedAssets: items, bulkActionBusy: false,
    mutationControllerRef: { current: controller },
    assetListKey, collectAssetStorageKeys, settleAssetOperations,
    setBulkActionBusy(value) { busy = value; },
    setBulkDeleteOpen(value) { open = value; },
    setSelectedKeys(value) { selectedKeys = typeof value === "function" ? value(selectedKeys) : value; },
    setManagedAssets() {},
    async deleteManagedImages() {},
    async deleteAsset(id) { recordDeletions.push(id); },
    async fetchCanvasDocument(id = "active") {
      lookups.push(id);
      return { document: { id, nodes: id === "other" ? [{ storage_key: "server:three" }] : [] }, projects: [{ id: "active" }, { id: "other" }, { id: "third" }] };
    },
    async deleteStoredImages(keys) { fileDeletions.push(...keys); },
    async deleteStoredMedia(keys) { fileDeletions.push(...keys); },
    toast: Object.fromEntries(["error", "warning", "success"].map((level) => [level, (message) => messages.push({ level, message })])),
  };
  return {
    context, controller, lookups, recordDeletions, fileDeletions, messages,
    get selectedKeys() { return selectedKeys; },
    get busy() { return busy; },
    get open() { return open; },
    run() { return new Function(...Object.keys(context), compiled)(...Object.values(context))(); },
  };
}

test("bulk asset cleanup reads each canvas once per operation and preserves referenced files", async () => {
  const state = setup();
  await state.run();
  assert.deepEqual(state.recordDeletions, ["one", "two", "three"]);
  assert.deepEqual(state.lookups, ["active", "other", "third"]);
  assert.deepEqual(state.fileDeletions.sort(), ["server:one", "server:two"]);
  assert.equal(state.busy, false);
  assert.equal(state.open, false);
});

test("a later deletion operation reads references again", async () => {
  const state = setup([asset("one")]);
  await state.run();
  await state.run();
  assert.deepEqual(state.lookups, ["active", "other", "third", "active", "other", "third"]);
});

test("a failed canvas lookup performs no file deletions and reports cleanup failures", async () => {
  const state = setup();
  state.context.fetchCanvasDocument = async () => { state.lookups.push("active"); throw new Error("permission changed"); };
  await state.run();
  assert.equal(state.lookups.length, 1);
  assert.deepEqual(state.fileDeletions, []);
  assert.ok(state.messages.some(({ level, message }) => level === "warning" && message.includes("3 个素材文件清理失败")));
  assert.equal(state.busy, false);
});

test("the backend can reject a newly referenced file without interrupting other cleanups", async () => {
  const state = setup();
  state.context.deleteStoredImages = async (keys) => {
    state.fileDeletions.push(...keys);
    if (keys.includes("server:one")) throw Object.assign(new Error("storage object is still referenced"), { status: 409 });
  };
  await state.run();
  assert.deepEqual(state.fileDeletions.sort(), ["server:one", "server:two"]);
  assert.ok(state.messages.some(({ level, message }) => level === "warning" && message.includes("1 个素材文件清理失败")));
  assert.equal(state.recordDeletions.length, 3);
});

test("partial record failures retain failed selections and clean only deleted records", async () => {
  const state = setup();
  state.context.deleteAsset = async (id) => {
    state.recordDeletions.push(id);
    if (id === "two") throw new Error("record deletion failed");
  };
  await state.run();
  assert.deepEqual(state.recordDeletions, ["one", "two", "three"]);
  assert.deepEqual(state.fileDeletions, ["server:one"]);
  assert.deepEqual(Array.from(state.selectedKeys), [assetListKey(asset("two"))]);
  assert.ok(state.messages.some(({ level, message }) => level === "error" && message.includes("已删除 2 个素材") && message.includes("1 个删除失败")));
  assert.equal(state.busy, false);
});

test("duplicate storage references trigger one file deletion in the same operation", async () => {
  const state = setup([asset("one"), asset("duplicate", { storageKey: "server:one" })]);
  await state.run();
  assert.deepEqual(state.fileDeletions, ["server:one"]);
});

test("text-only batches need no canvas reads or client-side file cleanup", async () => {
  const state = setup([asset("text", { kind: "text" })]);
  await state.run();
  assert.deepEqual(state.lookups, []);
  assert.deepEqual(state.fileDeletions, []);
});

test("failed records keep their shared storage protected", async () => {
  const state = setup([asset("one"), asset("two", { storageKey: "server:one" })]);
  state.context.deleteAsset = async (id) => {
    if (id === "two") throw new Error("record deletion failed");
  };
  await state.run();
  assert.deepEqual(state.lookups, []);
  assert.deepEqual(state.fileDeletions, []);
});

test("cancelling during a shared canvas lookup stops all further file requests", async () => {
  const state = setup();
  state.context.fetchCanvasDocument = async () => {
    state.lookups.push("active");
    state.controller.abort();
    return { document: { id: "active" }, projects: [{ id: "other" }] };
  };
  await state.run();
  assert.deepEqual(state.lookups, ["active"]);
  assert.deepEqual(state.fileDeletions, []);
  assert.deepEqual(state.messages, []);
  assert.equal(state.busy, false);
});
