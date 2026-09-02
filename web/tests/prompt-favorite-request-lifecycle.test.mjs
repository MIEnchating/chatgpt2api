import { describe, expect, test } from "bun:test";

import { PromptFavoriteRequestLifecycle } from "../src/app/image/prompt-favorite-request-lifecycle.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("prompt favorite request lifecycle", () => {
  test("a deferred GET cannot replace a newer POST snapshot", async () => {
    const lifecycle = new PromptFavoriteRequestLifecycle();
    lifecycle.activate();
    const getResponse = deferred();
    const postResponse = deferred();
    const load = lifecycle.beginLoad();
    expect(load).not.toBeNull();

    let items = ["before"];
    const pendingGet = getResponse.promise.then((nextItems) => {
      if (lifecycle.isCurrentLoad(load)) items = nextItems;
    }).finally(() => lifecycle.releaseLoad(load));

    const mutation = lifecycle.beginMutation();
    expect(mutation).not.toBeNull();
    expect(load.controller.signal.aborted).toBe(true);
    const pendingPost = postResponse.promise.then((nextItems) => {
      const decision = lifecycle.completeMutation(mutation, true);
      if (decision.applySnapshot) items = nextItems;
    });

    postResponse.resolve(["created"]);
    await pendingPost;
    getResponse.resolve(["stale"]);
    await pendingGet;

    expect(items).toEqual(["created"]);
  });

  test("manual retries share one load controller and only the latest GET commits", async () => {
    const lifecycle = new PromptFavoriteRequestLifecycle();
    lifecycle.activate();
    const firstResponse = deferred();
    const retryResponse = deferred();
    const firstLoad = lifecycle.beginLoad();
    const retryLoad = lifecycle.beginLoad();
    expect(firstLoad).not.toBeNull();
    expect(retryLoad).not.toBeNull();
    expect(firstLoad.controller.signal.aborted).toBe(true);

    let items = [];
    const first = firstResponse.promise.then((nextItems) => {
      if (lifecycle.isCurrentLoad(firstLoad)) items = nextItems;
    }).finally(() => lifecycle.releaseLoad(firstLoad));
    const retry = retryResponse.promise.then((nextItems) => {
      if (lifecycle.isCurrentLoad(retryLoad)) items = nextItems;
    }).finally(() => lifecycle.releaseLoad(retryLoad));

    retryResponse.resolve(["retry"]);
    await retry;
    firstResponse.resolve(["stale"]);
    await first;

    expect(items).toEqual(["retry"]);
  });

  test("closing invalidates deferred GET and DELETE state or toast commits", async () => {
    const lifecycle = new PromptFavoriteRequestLifecycle();
    lifecycle.activate();
    const getResponse = deferred();
    const deleteResponse = deferred();
    const load = lifecycle.beginLoad();
    const mutation = lifecycle.beginMutation();
    expect(load).not.toBeNull();
    expect(mutation).not.toBeNull();

    let stateCommits = 0;
    let toastCommits = 0;
    const pendingGet = getResponse.promise.then(() => {
      if (lifecycle.isCurrentLoad(load)) stateCommits += 1;
    }).finally(() => lifecycle.releaseLoad(load));
    const pendingDelete = deleteResponse.promise.then(() => {
      const decision = lifecycle.completeMutation(mutation, true);
      if (!decision.current) return;
      if (decision.applySnapshot) stateCommits += 1;
      toastCommits += 1;
    });

    lifecycle.deactivate();
    deleteResponse.resolve([]);
    getResponse.resolve(["stale"]);
    await Promise.all([pendingDelete, pendingGet]);

    expect(stateCommits).toBe(0);
    expect(toastCommits).toBe(0);
  });

  test("overlapping mutation snapshots request one reconciliation after settling", () => {
    const lifecycle = new PromptFavoriteRequestLifecycle();
    lifecycle.activate();
    const first = lifecycle.beginMutation();
    const second = lifecycle.beginMutation();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    expect(lifecycle.completeMutation(second, true)).toEqual({
      current: true,
      applySnapshot: true,
      reconcile: false,
    });
    expect(lifecycle.completeMutation(first, true)).toEqual({
      current: true,
      applySnapshot: false,
      reconcile: true,
    });
  });
});
