import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { createRelayTokenModelLoader, RELAY_MODEL_CONFIG_CHANGED_EVENT } from "../src/lib/relay-token-models.ts";

const source = ts.createSourceFile(
  "relay-token-preferences.tsx",
  readFileSync(new URL("../src/lib/relay-token-preferences.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let modelEffect;
let modelDependencies;
const modelExpressions = {};
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && node.arguments[0]?.getText(source).includes("createRelayTokenModelLoader")) {
    modelEffect = node.arguments[0].getText(source);
    modelDependencies = node.arguments[1].getText(source);
  }
  if (ts.isVariableDeclaration(node) && ["modelTokenNamesKey", "modelScope"].includes(node.name.getText(source))) {
    modelExpressions[node.name.getText(source)] = node.initializer.getText(source);
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
  let dependencies;
  let cleanup;
  const context = {
    preferencesReady: true,
    sessionKey: "session-a",
    tokenNames: { image: ["image-key"], video: ["image-key"], text: [], audio: [] },
    pathname: "/image",
    modelLoaderRef,
    createRelayTokenModelLoader,
    RELAY_MODEL_CONFIG_CHANGED_EVENT,
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
      for (const name of ["modelTokenNamesKey", "modelScope"]) {
        context[name] = new Function(...Object.keys(context), `return ${modelExpressions[name]};`)(...Object.values(context));
      }
      const next = new Function(...Object.keys(context), `return ${modelDependencies};`)(...Object.values(context));
      if (!dependencies || next.some((value, index) => !Object.is(value, dependencies[index]))) {
        cleanup?.();
        dependencies = next;
        cleanup = new Function(...Object.keys(context), `${compiled}\nreturn effect();`)(...Object.values(context));
      }
      return () => { cleanup?.(); cleanup = undefined; dependencies = undefined; };
    },
    configChanged: (tokenName) => window.dispatchEvent(new CustomEvent(RELAY_MODEL_CONFIG_CHANGED_EVENT, { detail: { tokenName } })),
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

test("navigation and equivalent key selections reuse the model list", async () => {
  const state = harness();
  const leave = state.enter();
  await state.modelLoaderRef.current.refresh();
  const loader = state.modelLoaderRef.current;
  state.enter({ pathname: "/settings" });
  state.enter({ pathname: "/image" });
  state.enter({ tokenNames: { video: ["image-key"], image: [], text: ["image-key"], audio: [] } });
  assert.equal(state.modelLoaderRef.current, loader);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].signal.aborted, false);
  leave();
});

test("changing keys or sessions replaces the model list and aborts old requests", async () => {
  const state = harness();
  const leave = state.enter();
  await state.modelLoaderRef.current.refresh();
  state.enter({ tokenNames: { image: ["new-key"] } });
  await state.modelLoaderRef.current.refresh();
  assert.equal(state.requests[0].signal.aborted, true);
  assert.deepEqual(state.requests.map((request) => request.tokenName), ["image-key", "new-key"]);
  state.enter({ sessionKey: "session-b" });
  await state.modelLoaderRef.current.refresh();
  assert.equal(state.requests[1].signal.aborted, true);
  assert.equal(state.requests.length, 3);
  assert.deepEqual(state.snapshots.at(-1).snapshot.modelsByToken, { "new-key": ["image-model"] });
  leave();
});

test("selected interface and global config changes reload models and discard an in-flight old response", async () => {
  const pending = [];
  const state = harness(() => new Promise((resolve) => pending.push(resolve)));
  const leave = state.enter();
  const old = state.modelLoaderRef.current.refresh();
  state.configChanged("unselected-key");
  assert.equal(state.requests.length, 1);
  state.configChanged("image-key");
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0].signal.aborted, true);
  const current = state.modelLoaderRef.current.refresh();
  pending[1]({ data: [{ id: "new-interface-model" }] });
  await current;
  pending[0]({ data: [{ id: "old-interface-model" }] });
  await old;
  assert.deepEqual(state.snapshots.at(-1).snapshot.modelsByToken, { "image-key": ["new-interface-model"] });
  state.configChanged();
  assert.equal(state.requests.length, 3);
  leave();
  state.configChanged();
  assert.equal(state.requests.length, 3);
  assert.equal(state.requests[2].signal.aborted, true);
  pending[2]({ data: [] });
});

test("model loading waits for authenticated preferences", () => {
  const state = harness();
  state.enter({ preferencesReady: false });
  state.enter({ preferencesReady: true, sessionKey: "" });
  assert.equal(state.requests.length, 0);
  assert.equal(state.modelLoaderRef.current, null);
});
