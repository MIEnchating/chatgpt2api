import assert from "node:assert/strict";
import test from "node:test";

import { applyCanvasTaskProgressNodes, canvasTaskImageSlots, canvasTaskImages, reconcileCancelledCanvasTaskNodes, reconcilePersistedCanvasTaskNodes, successfulCanvasTaskImagesByNodeID, summarizeCanvasTaskResult } from "../src/app/canvas/canvas-task-results.ts";

test("canvas task images preserve output order and support base64 results", () => {
  assert.deepEqual(canvasTaskImages({ id: "task", status: "success", data: [
    { url: "/images/a.png", width: 100, height: 80 },
    { b64_json: "YWJj", width: 64, height: 64 },
  ] }), [
    { url: "/images/a.png", width: 100, height: 80 },
    { url: "data:image/png;base64,YWJj", width: 64, height: 64 },
  ]);
});

test("canvas task images carry persisted storage keys into result nodes", () => {
  const progress = applyCanvasTaskProgressNodes([{
    id: "result",
    type: "image",
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    generation_status: "loading",
  }], {
    id: "task-storage",
    status: "success",
    mode: "generate",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z",
    data: [{ url: "/api/files/object/content", storageKey: "server:object", width: 800, height: 600 }],
    output_statuses: ["success"],
  }, { outputNodeIDs: ["result"], taskID: "task-storage" });

  assert.equal(progress.nodes[0].storage_key, "server:object");
});

test("partial task errors retain completed images and report missing slots", () => {
  assert.deepEqual(summarizeCanvasTaskResult({ id: "task", status: "error", error: "partial failure", data: [{ url: "/images/a.png" }], output_statuses: ["success", "error", "error"] }, 3), {
    slots: [
      { image: { url: "/images/a.png", width: undefined, height: undefined }, status: "success" },
      { image: undefined, status: "error" },
      { image: undefined, status: "error" },
    ],
    images: [{ url: "/images/a.png", width: undefined, height: undefined }],
    cancelled: false,
    missingCount: 2,
    error: "partial failure",
  });
});

test("terminal task summaries ignore previews and non-success output slots", () => {
  assert.deepEqual(summarizeCanvasTaskResult({
    id: "task",
    status: "error",
    data: [
      { url: "/images/final.png" },
      { b64_json: "cHJldmlldw==", preview: true },
      { url: "/images/failed-but-present.png" },
    ],
    output_statuses: ["success", "running", "error"],
  }, 3), {
    slots: [
      { image: { url: "/images/final.png", width: undefined, height: undefined }, status: "success" },
      { image: undefined, status: "running" },
      { image: undefined, status: "error" },
    ],
    images: [{ url: "/images/final.png", width: undefined, height: undefined }],
    cancelled: false,
    missingCount: 2,
    error: "",
  });
});

test("cancelled tasks are distinguished from failed tasks", () => {
  assert.deepEqual(summarizeCanvasTaskResult({ id: "task", status: "cancelled", error: "cancelled" }, 1), {
    slots: [{ image: undefined, status: undefined }],
    images: [],
    cancelled: true,
    missingCount: 1,
    error: "cancelled",
  });
});

test("batch progress commits final slots immediately and keeps the first completed primary", () => {
  const base = { type: "image", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, generation_status: "loading" };
  const nodes = [
    { ...base, id: "root", batch_child_ids: ["first", "second"] },
    { ...base, id: "first", batch_root_id: "root" },
    { ...base, id: "second", batch_root_id: "root" },
  ];
  const firstProgress = applyCanvasTaskProgressNodes(nodes, {
    id: "task",
    status: "running",
    data: [{ b64_json: "cHJldmlldw==", preview: true }, { url: "/final/second.png", width: 1024, height: 1024 }],
    output_statuses: ["running", "success"],
  }, {
    outputNodeIDs: ["first", "second"],
    batchRootID: "root",
    taskID: "task",
  });
  assert.equal(firstProgress.nodes[0].url, "/final/second.png");
  assert.equal(firstProgress.nodes[0].batch_primary_id, "second");
  assert.equal(firstProgress.nodes[0].generation_status, "success");
  assert.equal(firstProgress.nodes[1].url, "data:image/png;base64,cHJldmlldw==");
  assert.equal(firstProgress.nodes[1].generation_status, "loading");
  assert.equal(firstProgress.nodes[2].generation_status, "success");

  const completed = applyCanvasTaskProgressNodes(firstProgress.nodes, {
    id: "task",
    status: "success",
    data: [{ url: "/final/first.png" }, { url: "/final/second.png", width: 1024, height: 1024 }],
    output_statuses: ["success", "success"],
  }, {
    outputNodeIDs: ["first", "second"],
    batchRootID: "root",
    taskID: "task",
  });
  assert.equal(completed.nodes[0].url, "/final/second.png");
  assert.equal(completed.nodes[0].batch_primary_id, "second");
  assert.equal(completed.nodes[1].url, "/final/first.png");
  assert.equal(completed.nodes[1].generation_status, "success");
});

test("later previews never overwrite a completed output node", () => {
  const node = {
    id: "image",
    type: "image",
    x: 0,
    y: 0,
    width: 340,
    height: 240,
    scale_x: 1,
    scale_y: 1,
    url: "/final.png",
    generation_status: "success",
  };
  const progress = applyCanvasTaskProgressNodes([node], {
    id: "task",
    status: "running",
    data: [{ b64_json: "bGF0ZS1wcmV2aWV3", preview: true }],
    output_statuses: ["running"],
  }, {
    outputNodeIDs: ["image"],
    taskID: "task",
  });
  assert.equal(progress.nodes[0].url, "/final.png");
  assert.equal(progress.nodes[0].generation_status, "success");
});

test("sparse task data stays aligned with its original output slots", () => {
  const task = {
    id: "task",
    status: "error",
    data: [
      { url: "/images/first.png" },
      {},
      { b64_json: "dGhpcmQ=" },
    ],
    output_statuses: ["success", "error", "success"],
  };
  assert.deepEqual(canvasTaskImageSlots(task, 3), [
    { image: { url: "/images/first.png", width: undefined, height: undefined }, status: "success" },
    { image: undefined, status: "error" },
    { image: { url: "data:image/png;base64,dGhpcmQ=", width: undefined, height: undefined }, status: "success" },
  ]);
  assert.deepEqual(canvasTaskImages(task).map((image) => image.url), [
    "/images/first.png",
    "data:image/png;base64,dGhpcmQ=",
  ]);
});

test("cancelled batches preserve only completed output slots", () => {
  const images = successfulCanvasTaskImagesByNodeID({
    id: "task",
    status: "cancelled",
    data: [
      { url: "/images/first.png" },
      { b64_json: "cHJldmlldw==", preview: true },
      { url: "/images/third.png" },
    ],
    output_statuses: ["success", "cancelled", "success"],
  }, ["first", "second", "third"]);
  assert.deepEqual([...images], [
    ["first", { url: "/images/first.png", width: undefined, height: undefined }],
    ["third", { url: "/images/third.png", width: undefined, height: undefined }],
  ]);
});

test("cancelled batch reconciliation keeps finals and restores unfinished nodes", () => {
  const base = { type: "image", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, generation_status: "loading" };
  const root = { ...base, id: "root", batch_child_ids: ["first", "second", "third"], url: "/preview/root.png" };
  const first = { ...base, id: "first", batch_root_id: "root", url: "/preview/first.png" };
  const second = { ...base, id: "second", batch_root_id: "root", url: "/preview/second.png" };
  const third = { ...base, id: "third", batch_root_id: "root", url: "/preview/third.png" };
  const task = {
    id: "task",
    status: "cancelled",
    data: [{ url: "/final/first.png", width: 1024, height: 1024 }, { b64_json: "cHJldmlldw==", preview: true }, { url: "/final/third.png" }],
    output_statuses: ["success", "cancelled", "success"],
  };
  const result = reconcileCancelledCanvasTaskNodes([root, first, second, third], task, {
    resultNodeIDs: ["root", "first", "second", "third"],
    outputNodeIDs: ["first", "second", "third"],
    batchRootID: "root",
    taskID: "task",
    initialImageByNodeID: new Map([
      ["root", { url: "", thumbnailURL: "" }],
      ["first", { url: "", thumbnailURL: "" }],
      ["second", { url: "", thumbnailURL: "" }],
      ["third", { url: "", thumbnailURL: "" }],
    ]),
  });
  assert.equal(result.nodes[0].url, "/final/first.png");
  assert.equal(result.nodes[0].batch_primary_id, "first");
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[1].url, "/final/first.png");
  assert.equal(result.nodes[1].generation_status, "success");
  assert.equal(result.nodes[2].url, "");
  assert.equal(result.nodes[2].generation_status, "idle");
  assert.equal(result.nodes[3].url, "/final/third.png");
  assert.equal(result.nodes[3].generation_status, "success");
});

test("cancelled retries restore the original image and thumbnail", () => {
  const node = {
    id: "image",
    type: "image",
    x: 0,
    y: 0,
    width: 340,
    height: 240,
    scale_x: 1,
    scale_y: 1,
    url: "/preview.png",
    thumbnail_url: "",
    generation_status: "loading",
  };
  const result = reconcileCancelledCanvasTaskNodes([node], null, {
    resultNodeIDs: ["image"],
    outputNodeIDs: ["image"],
    taskID: "task",
    initialImageByNodeID: new Map([["image", { url: "/original.png", thumbnailURL: "/original-thumb.png" }]]),
  });
  assert.equal(result.nodes[0].url, "/original.png");
  assert.equal(result.nodes[0].thumbnail_url, "/original-thumb.png");
  assert.equal(result.nodes[0].generation_status, "idle");
});

test("persisted canvas tasks restore completed images after the page reloads", () => {
  const nodes = [
    { id: "config", type: "config", task_id: "task", generation_status: "loading", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1 },
    { id: "result", type: "image", task_id: "task", generation_status: "loading", x: 420, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1 },
  ];
  const result = reconcilePersistedCanvasTaskNodes(nodes, {
    id: "task",
    status: "success",
    data: [{ url: "/images/restored.png", width: 1024, height: 1024 }],
    output_statuses: ["success"],
  });
  assert.equal(result.terminal, true);
  assert.equal(result.completedImageCount, 1);
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[1].generation_status, "success");
  assert.equal(result.nodes[1].url, "/images/restored.png");
});

test("persisted panorama tasks restore the fixed frame and projection after reload", () => {
  const startedAt = Date.now() - 2200;
  const result = reconcilePersistedCanvasTaskNodes([{
    id: "panorama",
    type: "panorama",
    task_id: "panorama-task",
    generation_status: "loading",
    generation_started_at: startedAt,
    x: 0,
    y: 0,
    width: 500,
    height: 300,
    scale_x: 1,
    scale_y: 1,
  }], {
    id: "panorama-task",
    status: "success",
    data: [{ url: "/images/panorama.png", width: 2048, height: 1024, mime_type: "image/webp" }],
    output_statuses: ["success"],
  });
  assert.equal(result.completedImageCount, 1);
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[0].url, "/images/panorama.png");
  assert.equal(result.nodes[0].width, 340);
  assert.equal(result.nodes[0].height, 170);
  assert.equal(result.nodes[0].panorama_projection, "equirectangular");
  assert.equal(result.nodes[0].mime_type, "image/webp");
  assert.equal(result.nodes[0].generation_progress, 100);
  assert.ok(result.nodes[0].duration_ms >= 2200);
  assert.ok(result.nodes[0].duration_ms < 4700);
});

test("persisted video tasks restore completed video nodes after the page reloads", () => {
  const startedAt = Date.now() - 2500;
  const result = reconcilePersistedCanvasTaskNodes([{
    id: "video", type: "video", task_id: "video-task", generation_status: "loading",
    generation_started_at: startedAt,
    x: 0, y: 0, width: 420, height: 236, scale_x: 1, scale_y: 1,
  }], {
    id: "video-task",
    status: "success",
    data: [{ type: "video", video_url: "/videos/restored.mp4", width: 1280, height: 720 }],
  });
  assert.equal(result.terminal, true);
  assert.equal(result.completedImageCount, 1);
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[0].url, "/videos/restored.mp4");
  assert.equal(result.nodes[0].mime_type, "video/mp4");
  assert.equal(result.nodes[0].natural_width, 1280);
  assert.equal(result.nodes[0].natural_height, 720);
  assert.ok(result.nodes[0].duration_ms >= 2500);
  assert.ok(result.nodes[0].duration_ms < 5000);
});

test("persisted image task terminal states save generation duration", () => {
  const startedAt = Date.now() - 1800;
  const result = reconcilePersistedCanvasTaskNodes([{
    id: "image", type: "image", task_id: "image-task", generation_status: "loading",
    generation_started_at: startedAt,
    x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1,
  }], {
    id: "image-task",
    status: "success",
    data: [{ url: "/images/result.png", width: 1024, height: 1024 }],
    output_statuses: ["success"],
  });
  assert.ok(result.nodes[0].duration_ms >= 1800);
  assert.ok(result.nodes[0].duration_ms < 4300);
});

test("persisted successful image tasks repair serialized blob URLs", () => {
  const node = {
    id: "result",
    type: "image",
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    scale_x: 1,
    scale_y: 1,
    url: "blob:http://example.test/expired",
    storage_key: "image:local-only",
    task_id: "task-durable-image",
    generation_status: "success",
  };
  const result = reconcilePersistedCanvasTaskNodes([node], {
    id: "task-durable-image",
    status: "success",
    data: [{ url: "/images/2026/08/27/final.png", width: 1024, height: 1024 }],
    output_statuses: ["success"],
  });

  assert.equal(result.changed, true);
  assert.equal(result.nodes[0].url, "/images/2026/08/27/final.png");
  assert.equal(result.nodes[0].storage_key, undefined);
  assert.equal(result.nodes[0].generation_status, "success");
});

test("persisted audio tasks restore audio nodes and synchronize task metadata", () => {
  const startedAt = Date.now() - 1400;
  const result = reconcilePersistedCanvasTaskNodes([{
    id: "audio", type: "audio", audio_task_id: "audio-task", generation_status: "loading",
    generation_started_at: startedAt,
    x: 0, y: 0, width: 420, height: 160, scale_x: 1, scale_y: 1,
  }], {
    id: "audio-task",
    status: "success",
    output_type: "audio",
    data: [{ type: "audio", audio_url: "/audios/restored.wav", mime_type: "audio/wav", bytes: 1234 }],
  });
  assert.equal(result.terminal, true);
  assert.equal(result.completedImageCount, 1);
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[0].url, "/audios/restored.wav");
  assert.equal(result.nodes[0].mime_type, "audio/wav");
  assert.equal(result.nodes[0].bytes, 1234);
  assert.equal(result.nodes[0].task_id, "audio-task");
  assert.equal(result.nodes[0].audio_task_id, "audio-task");
  assert.equal(result.nodes[0].audio_task_result_id, "audio-task");
  assert.equal(result.nodes[0].generation_progress, 100);
  assert.ok(result.nodes[0].duration_ms >= 1400);
  assert.ok(result.nodes[0].duration_ms < 3900);
});

test("persisted text tasks restore generated text nodes after the page reloads", () => {
  const result = reconcilePersistedCanvasTaskNodes([{
    id: "text", type: "text", task_id: "text-task", generation_status: "loading",
    x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1,
  }], {
    id: "text-task",
    status: "success",
    output_type: "text",
    data: [{ text_response: "恢复后的文本" }],
  });
  assert.equal(result.terminal, true);
  assert.equal(result.completedImageCount, 1);
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[0].prompt, "恢复后的文本");
  assert.equal(result.nodes[0].task_id, "text-task");
});

test("previously interrupted canvas nodes can be recovered on a later reload", () => {
  const result = reconcilePersistedCanvasTaskNodes([{
    id: "result",
    type: "image",
    task_id: "task",
    generation_status: "error",
    generation_error: "页面刷新后生成已中断，请重新生成。",
    x: 0,
    y: 0,
    width: 340,
    height: 240,
    scale_x: 1,
    scale_y: 1,
  }], {
    id: "task",
    status: "success",
    data: [{ url: "/images/late-result.png" }],
    output_statuses: ["success"],
  });
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[0].url, "/images/late-result.png");
});

test("canvas nodes marked for deferred recovery can be recovered on a later reload", () => {
  const result = reconcilePersistedCanvasTaskNodes([{
    id: "result",
    type: "image",
    task_id: "task",
    generation_status: "error",
    generation_error: "暂时无法同步后台任务，重新进入画布后将继续恢复。",
    x: 0,
    y: 0,
    width: 340,
    height: 240,
    scale_x: 1,
    scale_y: 1,
  }], {
    id: "task",
    status: "success",
    data: [{ url: "/images/deferred-result.png" }],
    output_statuses: ["success"],
  });
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[0].generation_error, "");
  assert.equal(result.nodes[0].url, "/images/deferred-result.png");
});

test("persisted canvas batch tasks restore sparse successful outputs", () => {
  const base = { type: "image", task_id: "task", generation_status: "loading", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1 };
  const nodes = [
    { ...base, id: "root", batch_child_ids: ["first", "second"] },
    { ...base, id: "first", batch_root_id: "root" },
    { ...base, id: "second", batch_root_id: "root" },
  ];
  const result = reconcilePersistedCanvasTaskNodes(nodes, {
    id: "task",
    status: "error",
    error: "第二张失败",
    data: [{ url: "/images/first.png" }, {}],
    output_statuses: ["success", "error"],
  });
  assert.equal(result.nodes[0].generation_status, "success");
  assert.equal(result.nodes[0].batch_primary_id, "first");
  assert.equal(result.nodes[1].url, "/images/first.png");
  assert.equal(result.nodes[2].generation_status, "error");
  assert.equal(result.nodes[2].generation_error, "第二张失败");
});

test("persisted canvas batch root keeps the upstream error when no output completed", () => {
  const base = { type: "image", task_id: "task", generation_status: "loading", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1 };
  const nodes = [
    { ...base, id: "root", batch_child_ids: ["first", "second"] },
    { ...base, id: "first", batch_root_id: "root" },
    { ...base, id: "second", batch_root_id: "root" },
  ];
  const result = reconcilePersistedCanvasTaskNodes(nodes, {
    id: "task",
    status: "error",
    error: "upstream quota exhausted",
    data: [],
    output_statuses: ["error", "error"],
  });
  assert.equal(result.nodes[0].generation_status, "error");
  assert.equal(result.nodes[0].generation_error, "upstream quota exhausted");
  assert.equal(result.nodes[1].generation_error, "upstream quota exhausted");
  assert.equal(result.nodes[2].generation_error, "upstream quota exhausted");
});
