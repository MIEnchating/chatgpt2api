import assert from "node:assert/strict";
import test from "node:test";
import { createCreationTaskEventClient, CreationTaskTimeoutError } from "../src/lib/creation-task-events.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const connections = [];
  const client = createCreationTaskEventClient(({ scope, signal, onData }) => new Promise((resolve, reject) => {
    const connection = { scope, signal, emit: event => {
      try { onData(JSON.stringify(event)); } catch (error) { reject(error); }
    }, resolve, reject };
    connections.push(connection);
    signal.addEventListener("abort", resolve, { once: true });
  }));
  return { client, connections };
}
function task(id, revision, status, text = "") { return { id, revision, status, data: [{ text_response: text }] }; }
function workflowTask(id, revision, status, text = "") {
  return { ...task(id, revision, status, text), workflow_context: { workflow_id: "workflow", batch_task_id: "batch" } };
}
const event = (items, type = "tasks", deleted_ids = []) => ({ type, items, deleted_ids });

test("task waiters share SSE, receive partial text and unsubscribe independently", async () => {
  const { client, connections } = fixture();
  try {
    const progress = [];
    const first = client.wait("one", { onProgress: task => progress.push(task.data[0].text_response) });
    const second = client.wait("two");
    await Promise.resolve();
    assert.equal(connections.length, 1);
    assert.deepEqual(connections[0].scope, { task_ids: ["one", "two"], workflow_batch_ids: [] });
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
  const stop = client.watch({ workflowBatchIDs: ["batch"], onUpdate: value => snapshots.push(value), onError: assert.fail });
  try {
    await Promise.resolve();
    assert.deepEqual(connections[0].scope, { task_ids: [], workflow_batch_ids: ["batch"] });
    connections[0].emit(event([workflowTask("one", 4, "running", "latest")], "snapshot"));
    connections[0].emit(event([workflowTask("one", 2, "queued", "old")]));
    assert.equal(snapshots.at(-1).items[0].data[0].text_response, "latest");
    connections[0].emit(event([workflowTask("two", 1, "queued"), task("unrelated", 1, "queued")]));
    assert.equal(snapshots.at(-1).items.length, 2);
    connections[0].emit(event([], "tasks", ["one"]));
    assert.deepEqual(snapshots.at(-1).items.map(task => task.id), ["two"]);
  } finally { stop(); client.reset(); }
});

test("unrelated task updates do not redeliver progress to an ID waiter", async () => {
  const { client, connections } = fixture();
  const progress = [];
  try {
    const pending = client.wait("wanted", { onProgress: item => progress.push(item.revision) });
    await Promise.resolve();
    const history = Array.from({ length: 250 }, (_, i) => task(`history-${i}`, 1, "success"));
    connections[0].emit(event([...history, task("wanted", 1, "running")], "snapshot"));
    connections[0].emit(event([task("another", 1, "running")], "tasks", ["history-0"]));
    assert.deepEqual(progress, [1]);
    connections[0].emit(event([task("wanted", 2, "success")]));
    assert.equal((await pending).revision, 2);
    assert.deepEqual(progress, [1, 2]);
  } finally { client.reset(); }
});

test("task SSE reconnects to a fresh snapshot without polling task lists", async () => {
  const { client, connections } = fixture();
  const pending = client.wait("one");
  try {
    await Promise.resolve();
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
  const stop = client.watch({ workflowBatchIDs: ["batch"], onUpdate: value => snapshots.push(value), onError: assert.fail });
  const pending = client.wait("removed", { timeoutMs: 1500 });
  const rejected = assert.rejects(pending, /已被删除/);
  try {
    await Promise.resolve();
    connections[0].emit(event([workflowTask("removed", 1, "running"), workflowTask("kept", 1, "queued")], "snapshot"));
    connections[0].reject(new TypeError("connection lost"));
    await new Promise(resolve => setTimeout(resolve, 550));
    connections[1].emit(event([workflowTask("kept", 2, "success")], "snapshot"));
    await rejected;
    assert.deepEqual(snapshots.at(-1).deletedIDs, ["removed"]);
    assert.deepEqual(snapshots.at(-1).items.map(item => item.id), ["kept"]);
  } finally { stop(); client.reset(); }
});

test("task SSE cancellation, timeout and account changes release connections", async () => {
  const { client, connections } = fixture();
  const controller = new AbortController();
  const cancelled = client.wait("one", { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(connections[0].signal.aborted, true);
  await assert.rejects(client.wait("two", { timeoutMs: 5 }), CreationTaskTimeoutError);
  assert.equal(connections[1].signal.aborted, true);
  const pending = client.wait("three");
  await Promise.resolve();
  client.reset();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(connections[2].signal.aborted, true);
  const next = client.wait("three");
  await Promise.resolve();
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
      await Promise.resolve();
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
  await Promise.resolve();
  connections[0].reject(Object.assign(new Error("denied"), { status: 403 }));
  await assert.rejects(denied, /denied/);
  await tick();
  assert.equal(connections.length, 1);
  const deleted = client.wait("two");
  await Promise.resolve();
  connections[1].emit(event([], "snapshot", ["two"]));
  await assert.rejects(deleted, /已被删除/);
  client.reset();
});

test("task SSE stops reconnecting when an open stream revokes access", async () => {
  for (const status of [401, 403]) {
    const { client, connections } = fixture();
    try {
      const pending = client.wait("one");
      await Promise.resolve();
      connections[0].emit(event([task("one", 1, "running")], "snapshot"));
      connections[0].emit({ type: "error", status, message: "access revoked" });
      await assert.rejects(pending, { message: "access revoked", status });
      assert.equal(connections[0].signal.aborted, true);
      await tick();
      assert.equal(connections.length, 1);
    } finally { client.reset(); }
  }
});

test("a shared stream remembers explicit task deletions for new waiters", async () => {
  const { client, connections } = fixture();
  const keepAlive = client.wait("active");
  try {
    const removed = assert.rejects(client.wait("removed"), /已被删除/);
    await Promise.resolve();
    connections[0].emit(event([task("active", 1, "running")], "snapshot", ["removed"]));
    await removed;
    await assert.rejects(client.wait("removed"), /已被删除/);
    assert.equal(connections.length, 1);
    connections[0].emit(event([task("active", 2, "success")]));
    await keepAlive;
  } finally { client.reset(); }
});

test("recovery ignores cached terminal snapshots older than the claimed revision", async () => {
 const { client, connections } = fixture();
 const controller = new AbortController();
 try {
  const keepAlive=client.watch({workflowBatchIDs:["batch"],signal:controller.signal,onUpdate:()=>{},onError:()=>{}});
  await Promise.resolve();
  connections[0].emit(event([workflowTask("recover",2,"error")],"snapshot"));
  const progress=[];
  let settled=false;
  const pending=client.wait("recover",{minRevision:3,onProgress:t=>progress.push(t.status)}).then(t=>{settled=true;return t;});
  await tick();
  assert.equal(settled,false);
  assert.equal(connections[0].signal.aborted,true);
  connections[1].emit(event([workflowTask("recover",2,"error")],"snapshot"));
  connections[1].emit(event([workflowTask("recover",3,"queued")]));
  connections[1].emit(event([workflowTask("recover",5,"success")]));
  assert.equal((await pending).status,"success");
  assert.deepEqual(progress,["queued","success"]);
  keepAlive();
 } finally {controller.abort();client.reset();}
});

test("a new task expands the stream and reconnect drops out-of-scope records without deletion notices", async () => {
  const { client, connections } = fixture();
  const snapshots = [];
  const stop = client.watch({ workflowBatchIDs: ["batch"], onUpdate: value => snapshots.push(value), onError: assert.fail });
  try {
    const first = client.wait("first");
    await Promise.resolve();
    connections[0].emit(event([task("first", 1, "success"), workflowTask("child-one", 1, "running")], "snapshot"));
    await first;
    const second = client.wait("second");
    await Promise.resolve();
    assert.equal(connections[0].signal.aborted, true);
    assert.deepEqual(connections[1].scope, { task_ids: ["second"], workflow_batch_ids: ["batch"] });
    connections[0].emit(event([task("second", 99, "error")]));
    connections[1].emit(event([task("second", 1, "success"), workflowTask("child-one", 2, "success"), workflowTask("child-two", 1, "success")], "snapshot"));
    assert.equal((await second).status, "success");
    assert.deepEqual(snapshots.at(-1).items.map(item => item.id), ["child-one", "child-two"]);
    assert.deepEqual(snapshots.at(-1).deletedIDs, []);
  } finally { stop(); client.reset(); }
});
