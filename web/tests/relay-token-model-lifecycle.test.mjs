import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { createRelayTokenModelLoader } from "../src/lib/relay-token-models.ts";

const source = ts.createSourceFile(
  "relay-token-preferences.tsx",
  readFileSync(new URL("../src/lib/relay-token-preferences.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let modelEffect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && node.arguments[0]?.getText(source).includes("createRelayTokenModelLoader")) {
    modelEffect = node.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(modelEffect, "Missing model loading lifecycle");
const compiled = ts.transpile(`const effect = ${modelEffect};`, { target: ts.ScriptTarget.ES2022 });

function harness(load = async () => ({ data: [{ id: "image-model" }] })) {
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  const timers = new Map();
  let timerID = 0;
  window.setInterval = (callback) => { timers.set(++timerID, callback); return timerID; };
  window.clearInterval = (id) => timers.delete(id);
  const requests = [];
  const snapshots = [];
  const modelLoaderRef = { current: null };
  const context = {
    preferencesReady: true,
    sessionKey: "session-a",
    tokenNames: { image: ["image-key"], video: ["image-key"], text: [], audio: [] },
    modelScope: "studio-entry",
    modelLoaderRef,
    createRelayTokenModelLoader,
    fetchRelayModels: (options) => { requests.push(options); return load(options); },
    setModelState: (snapshot) => snapshots.push(snapshot),
    window,
    document,
  };
  return {
    requests,
    snapshots,
    modelLoaderRef,
    timers,
    enter: (updates = {}) => {
      Object.assign(context, updates);
      return new Function(...Object.keys(context), `${compiled}\nreturn effect();`)(...Object.values(context));
    },
    returnToPage: () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      for (const callback of timers.values()) callback();
    },
  };
}

test("page entry reads each key once without polling or focus, online, and visibility refreshes", async () => {
  const state = harness();
  const leave = state.enter();
  await state.modelLoaderRef.current.refresh();
  assert.equal(state.requests.length, 1);
  assert.equal(state.snapshots.at(-1).snapshot.ready, true);
  assert.equal(state.timers.size, 0);
  state.returnToPage();
  await Promise.resolve();
  assert.equal(state.requests.length, 1);
  await state.modelLoaderRef.current.refresh();
  assert.equal(state.requests.length, 2);
  leave();
  assert.equal(state.modelLoaderRef.current, null);
});

test("reentering the page and changing keys reload models without retaining an old request", async () => {
  const state = harness();
  let leave = state.enter();
  await state.modelLoaderRef.current.refresh();
  leave();
  assert.equal(state.requests[0].signal.aborted, true);

  leave = state.enter({ modelScope: "studio-reentry" });
  await state.modelLoaderRef.current.refresh();
  assert.equal(state.requests.length, 2);
  assert.equal(state.snapshots.at(-1).scope, "studio-reentry");
  leave();

  leave = state.enter({ tokenNames: { image: ["new-key"] }, modelScope: "new-key-entry" });
  await state.modelLoaderRef.current.refresh();
  assert.deepEqual(state.requests.map((request) => request.tokenName), ["image-key", "image-key", "new-key"]);
  assert.equal(state.snapshots.at(-1).scope, "new-key-entry");
  leave();
});

test("model loading waits for authenticated preferences", () => {
  const state = harness();
  assert.equal(state.enter({ preferencesReady: false }), undefined);
  assert.equal(state.enter({ preferencesReady: true, sessionKey: "" }), undefined);
  assert.equal(state.requests.length, 0);
  assert.equal(state.modelLoaderRef.current, null);
});
