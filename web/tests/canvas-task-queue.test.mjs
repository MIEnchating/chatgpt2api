import assert from "node:assert/strict";
import test from "node:test";

import {
  activateCanvasTaskQueueSession,
  clearCanvasTaskQueueForCanvas,
  clearCanvasTaskQueueForSession,
  getCanvasTaskQueueSnapshot,
  resetCanvasTaskQueueForTests,
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
