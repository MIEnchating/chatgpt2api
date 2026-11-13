import assert from "node:assert/strict";
import test from "node:test";
import { createCreationTaskEventClient, CreationTaskTimeoutError } from "../src/lib/creation-task-events.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const connections = [];
  const client = createCreationTaskEventClient(({ signal, onData }) => new Promise((resolve, reject) => {
    const connection = { signal, emit: event => {
      try { onData(JSON.stringify(event)); } catch (error) { reject(error); }
    }, resolve, reject };
    connections.push(connection);
    signal.addEventListener("abort", resolve, { once: true });
  }));
  return { client, connections };
}
function task(id, revision, status, text = "") { return { id, revision, status, data: [{ text_response: text }] }; }
const event = (items, type = "tasks", deleted_ids = []) => ({ type, items, deleted_ids });

test("task waiters share SSE, receive partial text and unsubscribe independently", async () => {
  const { client, connections } = fixture();
  try {
    const progress = [];
    const first = client.wait("one", { onProgress: task => progress.push(task.data[0].text_response) });
    const second = client.wait("two");
    assert.equal(connections.length, 1);
    connections[0].emit(event([task("one", 1, "running", "你"), task("two", 1, "queued")], "snapshot"));
    connections[0].emit(event([task("one", 2, "running", "你好")]));
    connections[0].emit(event([task("one", 3, "success", "你好！")]));
    assert.equal((await first).data[0].text_response, "你好！");
    assert.equal(connections[0].signal.aborted, false);
    connections[0].emit(event([task("two", 2, "error")]));
    assert.equal((await second).status, "error");
    assert.deepEqual(progress, ["你", "你好", "你好！"]);
    assert.equal(connections[0].signal.aborted, true);
  } finally { client.reset(); }
});

test("task SSE rejects stale revisions and discovers workflow children", async () => {
  const { client, connections } = fixture();
  const snapshots = [];
  const stop = client.watch({ onUpdate: value => snapshots.push(value), onError: assert.fail });
  try {
    connections[0].emit(event([task("one", 4, "running", "latest")], "snapshot"));
    connections[0].emit(event([task("one", 2, "queued", "old")]));
    assert.equal(snapshots.at(-1).items[0].data[0].text_response, "latest");
    connections[0].emit(event([task("two", 1, "queued")]));
    assert.equal(snapshots.at(-1).items.length, 2);
    connections[0].emit(event([], "tasks", ["one"]));
    assert.deepEqual(snapshots.at(-1).items.map(task => task.id), ["two"]);
  } finally { stop(); client.reset(); }
});

test("task SSE reconnects to a fresh snapshot without polling task lists", async () => {
  const { client, connections } = fixture();
  const pending = client.wait("one");
  try {
    connections[0].emit(event([task("one", 1, "running")], "snapshot"));
    connections[0].reject(new TypeError("connection lost"));
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(connections.length, 2);
    connections[1].emit(event([task("one", 2, "success", "restored")], "snapshot"));
    assert.equal((await pending).data[0].text_response, "restored");
  } finally { client.reset(); }
});

test("task SSE reports records deleted while disconnected", async () => {
  const { client, connections } = fixture();
  const snapshots = [];
  const stop = client.watch({ onUpdate: value => snapshots.push(value), onError: assert.fail });
  const pending = client.wait("removed", { timeoutMs: 1500 });
  const rejected = assert.rejects(pending, /已被删除/);
  try {
    connections[0].emit(event([task("removed", 1, "running"), task("kept", 1, "queued")], "snapshot"));
    connections[0].reject(new TypeError("connection lost"));
    await new Promise(resolve => setTimeout(resolve, 550));
    connections[1].emit(event([task("kept", 2, "success")], "snapshot"));
    await rejected;
    assert.deepEqual(snapshots.at(-1).deletedIDs, ["removed"]);
    assert.deepEqual(snapshots.at(-1).items.map(item => item.id), ["kept"]);
  } finally { stop(); client.reset(); }
});

test("task SSE cancellation, timeout and account changes release connections", async () => {
  const { client, connections } = fixture();
  const controller = new AbortController();
  const cancelled = client.wait("one", { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(connections[0].signal.aborted, true);
  await assert.rejects(client.wait("two", { timeoutMs: 5 }), CreationTaskTimeoutError);
  assert.equal(connections[1].signal.aborted, true);
  const pending = client.wait("three");
  client.reset();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(connections[2].signal.aborted, true);
  const next = client.wait("three");
  connections[2].emit(event([task("three", 4, "success", "old account")]));
  connections[3].emit(event([task("three", 1, "success", "new account")], "snapshot"));
  assert.equal((await next).data[0].text_response, "new account");
  client.reset();
});

test("long task observation waits for the server terminal state and remains cancellable", async () => {
  for (const cancel of [false, true]) {
    const { client, connections } = fixture();
    const controller = new AbortController();
    const deadlines = [];
    const originalSetTimeout = globalThis.setTimeout;
    let pending;
    try {
      globalThis.setTimeout = callback => { deadlines.push(callback); return 0; };
      pending = client.wait("long", { signal: controller.signal, timeoutMs: null });
    } finally { globalThis.setTimeout = originalSetTimeout; }
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      connections[0].emit(event([task("long", 1, "running")], "snapshot"));
      deadlines.forEach(callback => callback());
      await Promise.resolve();
      assert.equal(settled, false, "an observation deadline must not interrupt a running paid task");
      if (cancel) {
        controller.abort();
        await assert.rejects(pending, { name: "AbortError" });
      } else {
        connections[0].emit(event([task("long", 2, "success")]));
        assert.equal((await pending).status, "success");
      }
      assert.equal(connections[0].signal.aborted, true);
    } finally { client.reset(); }
  }
});

test("task SSE stops retrying denied requests and reports deleted tasks", async () => {
  const { client, connections } = fixture();
  const denied = client.wait("one");
  connections[0].reject(Object.assign(new Error("denied"), { status: 403 }));
  await assert.rejects(denied, /denied/);
  await tick();
  assert.equal(connections.length, 1);
  const deleted = client.wait("two");
  connections[1].emit(event([], "tasks", ["two"]));
  await assert.rejects(deleted, /已被删除/);
  client.reset();
});

test("task SSE stops reconnecting when an open stream revokes access", async () => {
  for (const status of [401, 403]) {
    const { client, connections } = fixture();
    try {
      const pending = client.wait("one");
      connections[0].emit(event([task("one", 1, "running")], "snapshot"));
      connections[0].emit({ type: "error", status, message: "access revoked" });
      await assert.rejects(pending, { message: "access revoked", status });
      assert.equal(connections[0].signal.aborted, true);
      await tick();
      assert.equal(connections.length, 1);
    } finally { client.reset(); }
  }
});

test("recovery ignores cached terminal snapshots older than the claimed revision", async () => {
 const { client, connections } = fixture();
 const controller = new AbortController();
 try {
  const keepAlive=client.watch({signal:controller.signal,onUpdate:()=>{},onError:()=>{}});
  connections[0].emit(event([task("recover",2,"error")],"snapshot"));
  const progress=[];
  let settled=false;
  const pending=client.wait("recover",{minRevision:3,onProgress:t=>progress.push(t.status)}).then(t=>{settled=true;return t;});
  await tick();
  assert.equal(settled,false);
  connections[0].emit(event([task("recover",3,"queued")]));
  connections[0].emit(event([task("recover",5,"success")]));
  assert.equal((await pending).status,"success");
  assert.deepEqual(progress,["queued","success"]);
  keepAlive();
 } finally {controller.abort();client.reset();}
});
