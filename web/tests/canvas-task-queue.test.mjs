import assert from "node:assert/strict";
import test from "node:test";

import {
  activateCanvasTaskQueueSession,
  clearCanvasTaskQueueForCanvas,
  clearCanvasTaskQueueForSession,
  getCanvasTaskQueueSnapshot,
  resetCanvasTaskQueueForTests,
  subscribeCanvasTaskQueue,
  syncCanvasTaskQueue,
} from "../src/store/canvas-task-queue.ts";

const SESSION_KEY = "session-a";

function startQueueSession(sessionKey = SESSION_KEY) {
  resetCanvasTaskQueueForTests();
  activateCanvasTaskQueueSession(sessionKey);
}

function imageNode(id, taskID, status = "loading", extra = {}) {
  return {
    id,
    type: "image",
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    scale_x: 1,
    scale_y: 1,
    title: id,
    prompt: `prompt-${id}`,
    task_id: taskID,
    generation_status: status,
    generation_started_at: 1000,
    generation_progress: status === "success" ? 100 : 0,
    ...extra,
  };
}

test("same-type canvas nodes create independent concurrent queue items", () => {
  startQueueSession();
  syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [
    imageNode("image-a", "task-a"),
    imageNode("image-b", "task-b"),
  ]);

  const tasks = getCanvasTaskQueueSnapshot();
  assert.equal(tasks.length, 2);
  assert.deepEqual(new Set(tasks.map((item) => item.serverTaskID)), new Set(["task-a", "task-b"]));
  assert.ok(tasks.every((item) => item.status === "generating"));
  resetCanvasTaskQueueForTests();
});

test("a server task id replacement keeps the existing canvas queue item", () => {
  startQueueSession();
  syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [imageNode("image-a", "client-task")]);
  const queueID = getCanvasTaskQueueSnapshot()[0].id;

  syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [imageNode("image-a", "server-task")]);
  assert.equal(getCanvasTaskQueueSnapshot().length, 1);
  assert.equal(getCanvasTaskQueueSnapshot()[0].id, queueID);
  assert.equal(getCanvasTaskQueueSnapshot()[0].serverTaskID, "server-task");
  resetCanvasTaskQueueForTests();
});

test("a config and output id transition does not duplicate one canvas task", () => {
  startQueueSession();
  const config = {
    ...imageNode("config", "client-task"),
    type: "config",
    generation_mode: "image",
  };
  syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [config, imageNode("result", "client-task")]);

  syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [
    { ...config, task_id: "server-task", generation_status: "success", generation_progress: 100 },
    imageNode("result", "client-task"),
  ]);

  assert.equal(getCanvasTaskQueueSnapshot().length, 1);
  assert.equal(getCanvasTaskQueueSnapshot()[0].status, "generating");
  resetCanvasTaskQueueForTests();
});

test("canvas image batches are aggregated into one queue item", () => {
  startQueueSession();
  syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [
    imageNode("root", "batch-task", "loading", { batch_child_ids: ["child-a", "child-b"] }),
    imageNode("child-a", "batch-task", "success", { batch_root_id: "root" }),
    imageNode("child-b", "batch-task", "loading", { batch_root_id: "root" }),
  ]);

  const task = getCanvasTaskQueueSnapshot()[0];
  assert.equal(task.totalCount, 2);
  assert.equal(task.completedCount, 1);
  assert.equal(task.status, "generating");
  assert.equal(task.progress, 50);
  resetCanvasTaskQueueForTests();
});

test("clearing one canvas keeps tasks owned by other canvases", () => {
  startQueueSession();
  syncCanvasTaskQueue(SESSION_KEY, "canvas-a", "Canvas A", [imageNode("image-a", "task-a")]);
  syncCanvasTaskQueue(SESSION_KEY, "canvas-b", "Canvas B", [imageNode("image-b", "task-b")]);

  clearCanvasTaskQueueForCanvas(SESSION_KEY, "canvas-a");

  assert.deepEqual(getCanvasTaskQueueSnapshot().map((item) => item.canvasID), ["canvas-b"]);
  resetCanvasTaskQueueForTests();
});

test("activating another session clears tasks and ignores stale session updates", () => {
  startQueueSession();
  syncCanvasTaskQueue(SESSION_KEY, "canvas-a", "Canvas A", [imageNode("image-a", "task-a")]);

  activateCanvasTaskQueueSession("session-b");
  syncCanvasTaskQueue(SESSION_KEY, "canvas-a", "Canvas A", [imageNode("stale", "stale-task")]);

  assert.deepEqual(getCanvasTaskQueueSnapshot(), []);
  syncCanvasTaskQueue("session-b", "canvas-b", "Canvas B", [imageNode("image-b", "task-b")]);
  clearCanvasTaskQueueForSession(SESSION_KEY);
  assert.deepEqual(getCanvasTaskQueueSnapshot().map((item) => item.canvasID), ["canvas-b"]);
  resetCanvasTaskQueueForTests();
});

test("moving and resizing canvas nodes preserves the task snapshot without notifying subscribers", () => {
  startQueueSession();
  let notifications = 0;
  const unsubscribe = subscribeCanvasTaskQueue(() => { notifications += 1; });
  try {
    const empty = getCanvasTaskQueueSnapshot();
    syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", []);
    assert.equal(getCanvasTaskQueueSnapshot(), empty);
    assert.equal(notifications, 0);

    const nodes = [imageNode("image-a", "task-a")];
    syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", nodes);
    const tasks = getCanvasTaskQueueSnapshot();
    for (let frame = 1; frame <= 60; frame += 1) {
      syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [
        { ...nodes[0], x: frame, y: frame, width: 320 + frame, height: 240 + frame },
      ]);
    }
    assert.equal(getCanvasTaskQueueSnapshot(), tasks);
    assert.equal(notifications, 1);

    syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Renamed", [
      { ...nodes[0], generation_progress: 40, title: "Changed", prompt: "New prompt", generation_model: "model-a" },
    ]);
    assert.equal(notifications, 2);
    assert.equal(getCanvasTaskQueueSnapshot()[0].canvasTitle, "Renamed");
    assert.equal(getCanvasTaskQueueSnapshot()[0].progress, 40);
    assert.equal(getCanvasTaskQueueSnapshot()[0].title, "Changed");
    assert.equal(getCanvasTaskQueueSnapshot()[0].prompt, "New prompt");
    assert.equal(getCanvasTaskQueueSnapshot()[0].model, "model-a");
  } finally {
    unsubscribe();
    resetCanvasTaskQueueForTests();
  }
});

test("unchanged task synchronization preserves terminal retention and still removes expired results", () => {
  startQueueSession();
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", [imageNode("image-a", "task-a")]);
    const completed = [imageNode("image-a", "task-a", "success")];
    syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", completed);
    const tasks = getCanvasTaskQueueSnapshot();
    now += 4000;
    syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", completed);
    assert.equal(getCanvasTaskQueueSnapshot(), tasks);
    assert.equal(tasks[0].completedAt, 10_000);
    now += 1000;
    syncCanvasTaskQueue(SESSION_KEY, "canvas-project", "Project", completed);
    assert.deepEqual(getCanvasTaskQueueSnapshot(), []);
  } finally {
    Date.now = originalNow;
    resetCanvasTaskQueueForTests();
  }
});
