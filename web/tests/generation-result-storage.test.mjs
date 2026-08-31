import assert from "node:assert/strict";
import test from "node:test";

import {
  generatedAssetRegistrationKey,
  generatedMediaAsset,
  persistCreationTaskOutputs,
} from "../src/services/generation-result-storage.ts";

test("generated asset registration is isolated by authenticated session", () => {
  const asset = { id: "generated-video:shared-task:0", storageKey: "server:shared-video" };

  assert.notEqual(
    generatedAssetRegistrationKey(asset, "session-a"),
    generatedAssetRegistrationKey(asset, "session-b"),
  );
  assert.equal(
    generatedAssetRegistrationKey(asset, " session-a "),
    "session-a:generated-video:shared-task:0:server:shared-video",
  );
});

test("stored video results build a stable material record with prompt and source", () => {
  const task = {
    id: "task-video-1",
    status: "success",
    mode: "video",
    model: "minimax-h3-768p",
    visibility: "private",
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-08-30T10:01:00Z",
  };
  const item = {
    type: "video",
    video_url: "/api/files/video-1/content",
    storageKey: "server:video-1",
    mime_type: "video/mp4",
    bytes: 4096,
    width: 1280,
    height: 720,
    duration_ms: 5000,
  };

  const asset = generatedMediaAsset(task, item, 0, {
    prompt: "镜头缓慢推向夜晚的城市天际线",
    source: "无限画布",
    metadata: { projectId: "canvas-1" },
  });
  assert.equal(asset.id, "generated-video:task-video-1:0");
  assert.equal(asset.kind, "video");
  assert.equal(asset.source, "无限画布");
  assert.equal(asset.storageKey, "server:video-1");
  assert.equal(asset.durationMs, 5000);
  assert.equal(asset.metadata.prompt, "镜头缓慢推向夜晚的城市天际线");
  assert.equal(asset.metadata.taskId, "task-video-1");
  assert.equal(asset.metadata.projectId, "canvas-1");
});

test("stored audio results build an audio material record", () => {
  const task = {
    id: "task-audio-1",
    status: "success",
    mode: "audio",
    model: "gpt-4o-mini-tts",
    visibility: "private",
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-08-30T10:00:08Z",
  };
  const item = {
    type: "audio",
    audio_url: "/api/files/audio-1/content",
    storageKey: "server:audio-1",
    mime_type: "audio/mpeg",
    bytes: 2048,
    duration_ms: 3200,
  };

  const asset = generatedMediaAsset(task, item, 0, { prompt: "欢迎使用", source: "无限画布" });
  assert.equal(asset.id, "generated-audio:task-audio-1:0");
  assert.equal(asset.kind, "audio");
  assert.equal(asset.source, "无限画布");
  assert.equal(asset.storageKey, "server:audio-1");
  assert.equal(asset.durationMs, 3200);
  assert.equal(asset.metadata.prompt, "欢迎使用");
  assert.equal(asset.metadata.taskId, "task-audio-1");
});

test("already managed image results keep their durable server URL", async () => {
  const task = {
    id: "task-managed-image",
    status: "success",
    mode: "generate",
    data: [{ url: "/images/2026/08/27/result.png", width: 1024, height: 1024 }],
    output_statuses: ["success"],
  };

  assert.equal(await persistCreationTaskOutputs(task), task);
  assert.equal(task.data[0].url, "/images/2026/08/27/result.png");
  assert.equal(task.data[0].storageKey, undefined);
});

test("external video persistence omits cross-origin credentials and never changes generation success", async () => {
  const originalFetch = globalThis.fetch;
  const failures = [];
  const task = {
    id: "task-external-video",
    status: "success",
    mode: "video",
    output_type: "video",
    data: [{ type: "video", mime_type: "video/mp4", url: "https://media.example/video.mp4", video_url: "https://media.example/video.mp4" }],
  };

  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.credentials, "same-origin");
    throw new TypeError("Failed to fetch");
  };
  try {
    const result = await persistCreationTaskOutputs(task, { onError: (failure) => failures.push(failure) });
    assert.equal(result, task);
    assert.equal(result.status, "success");
    assert.equal(result.data[0].video_url, "https://media.example/video.mp4");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, "video");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
