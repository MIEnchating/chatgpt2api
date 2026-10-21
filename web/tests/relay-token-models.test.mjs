import assert from "node:assert/strict";
import test from "node:test";

import { createRelayTokenModelLoader } from "../src/lib/relay-token-models.ts";
import { relayTokenRouteForModel } from "../src/lib/relay-token-selection.ts";

const videoModel = "grok-imagine-video";
const modelList = (...models) => ({ data: models.map((id) => ({ id })) });

function harness(load, tokenNames = ["video-key"]) {
  const snapshots = [];
  const loader = createRelayTokenModelLoader({
    tokenNames,
    load,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return {
    loader,
    snapshots,
    route: () => {
      const snapshot = snapshots.at(-1);
      return relayTokenRouteForModel(tokenNames, videoModel, snapshot.modelsByToken, snapshot.failedModelTokenNames, snapshot.ready);
    },
  };
}

test("an incomplete model list recovers when explicitly refreshed", async () => {
  let requests = 0;
  const state = harness(async () => ++requests === 1 ? modelList("text-model") : modelList(videoModel));
  await state.loader.refresh();
  assert.equal(state.route().status, "model-unavailable");

  assert.equal(requests, 1);
  await state.loader.refresh();
  assert.equal(requests, 2);
  assert.deepEqual(state.route(), { status: "ready", tokenName: "video-key" });
  state.loader.dispose();
});

test("manual refresh immediately retries an empty model list", async () => {
  let requests = 0;
  const state = harness(async () => ++requests === 1 ? modelList() : modelList(videoModel));
  await state.loader.refresh();
  assert.equal(state.route().status, "model-unavailable");
  await state.loader.refresh();
  assert.equal(state.route().status, "ready");
  assert.equal(requests, 2);
  state.loader.dispose();
});

test("malformed successful responses are read errors, not unsupported model claims", async () => {
  for (const response of [null, {}, { data: null }, { error: "temporarily unavailable" }, { data: {} }, { data: [{}] }, { data: [null] }, { data: [{ id: " " }] }]) {
    const state = harness(async () => response);
    await state.loader.refresh();
    assert.equal(state.route().status, "model-list-error");
    state.loader.dispose();
  }
});

test("a transient request failure can recover on manual refresh", async () => {
  let requests = 0;
  const state = harness(async () => {
    if (++requests === 1) throw new Error("network unavailable");
    return modelList(videoModel);
  });
  await state.loader.refresh();
  assert.equal(state.route().status, "model-list-error");
  await state.loader.refresh();
  assert.equal(state.route().status, "ready");
  assert.deepEqual(state.snapshots.at(-1).failedModelTokenNames, []);
  state.loader.dispose();
});

test("page entry and repeated manual refreshes share an in-flight request", async () => {
  let requests = 0;
  let resolve;
  const state = harness(() => {
    requests += 1;
    return new Promise((complete) => { resolve = complete; });
  });
  const first = state.loader.refresh();
  const second = state.loader.refresh();
  const third = state.loader.refresh();
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(requests, 1);
  assert.equal(state.route().status, "loading");
  resolve(modelList(videoModel));
  await first;
  assert.equal(state.route().status, "ready");
  state.loader.dispose();
});

test("manual refresh preserves a usable route until the new list arrives", async () => {
  let resolve;
  let requests = 0;
  const state = harness(() => ++requests === 1
    ? Promise.resolve(modelList(videoModel))
    : new Promise((complete) => { resolve = complete; }));
  await state.loader.refresh();
  const refreshing = state.loader.refresh();
  assert.equal(state.snapshots.at(-1).refreshing, true);
  assert.equal(state.route().status, "ready");

  resolve(modelList("text-model"));
  await refreshing;
  assert.equal(state.snapshots.at(-1).refreshing, false);
  assert.equal(state.route().status, "model-unavailable");
  state.loader.dispose();
});

test("changing keys or sessions aborts and ignores the previous pending response", async () => {
  let resolve;
  let signal;
  const old = harness((options) => {
    signal = options.signal;
    return new Promise((complete) => { resolve = complete; });
  });
  const pending = old.loader.refresh();
  old.loader.dispose();
  assert.equal(signal.aborted, true);

  const current = harness(async () => modelList(videoModel), ["new-key"]);
  await current.loader.refresh();
  resolve(modelList());
  await pending;
  assert.equal(old.snapshots.length, 1);
  assert.deepEqual(current.route(), { status: "ready", tokenName: "new-key" });
  await old.loader.refresh();
  assert.equal(old.snapshots.length, 1);
  current.loader.dispose();
});

test("one failed key does not hide a model exposed by another selected key", async () => {
  const requests = [];
  const state = harness(async ({ tokenName }) => {
    requests.push(tokenName);
    if (tokenName === "broken") throw new Error("timeout");
    return modelList(` ${videoModel} `, videoModel);
  }, ["broken", "working", "working"]);
  await state.loader.refresh();
  assert.deepEqual(requests, ["broken", "working"]);
  assert.deepEqual(state.route(), { status: "ready", tokenName: "working" });
  assert.deepEqual(state.snapshots.at(-1).modelsByToken.working, [videoModel]);
  state.loader.dispose();
});

test("no selected keys does not send model requests", async () => {
  const state = harness(async () => { assert.fail("unexpected model request"); }, []);
  await state.loader.refresh();
  assert.equal(state.route().status, "missing-selection");
  state.loader.dispose();
});
