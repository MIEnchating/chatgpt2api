import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowImageConversation,
  workflowImageConversationFailure,
  workflowImageConversationSuccess,
} from "../src/app/workflows/workflow-image-history.ts";

function startTask() {
  return {
    taskId: "workflow-task",
    workflowId: "workflow-id",
    workflowName: "商品海报",
    prompt: "为旅行背包生成海报",
    inputs: { product: "旅行背包" },
    references: [{
      id: "reference",
      name: "参考图",
      url: "/api/files/reference/content",
      storageKey: "server:reference",
      temporary: true,
    }],
    model: "gpt-image-1",
    apiMode: "images",
    config: {
      model: "gpt-image-1",
      image_model: "gpt-image-1",
      quality: "medium",
      size: "1024x1024",
      count: "1",
      api_mode: "images",
      timeout: "600",
      system_prompt: "",
      prompt_template: "{{product}}",
      negative_prompt: "",
    },
    execution: {
      stream: false,
      partial_images: 0,
      response_format_b64_json: true,
      codex_cli_compatibility: false,
      token_name: "image-token",
    },
    count: 1,
    startedAt: Date.parse("2026-08-26T10:00:00Z"),
  };
}

test("workflow task history keeps its source and reference parameters", () => {
  const conversation = createWorkflowImageConversation(startTask());
  const turn = conversation.turns[0];
  assert.equal(turn.source, "workflow");
  assert.equal(turn.workflowId, "workflow-id");
  assert.equal(turn.workflowName, "商品海报");
  assert.deepEqual(turn.workflowInputs, { product: "旅行背包" });
  assert.equal(turn.workflowTaskId, "workflow-task");
  assert.equal(turn.mode, "image");
  assert.equal(turn.referenceImages[0].dataUrl, "/api/files/reference/content");
  assert.equal(turn.stream, false);
  assert.equal(turn.responseFormatB64JSON, true);
  assert.equal(turn.codexCLICompatibility, false);
  assert.equal(turn.images[0].taskId, "workflow-task");
});

test("workflow task history transitions to a downloadable success", () => {
  const conversation = createWorkflowImageConversation(startTask());
  const completed = workflowImageConversationSuccess(conversation, {
    taskId: "workflow-task",
    images: [{
      id: "image",
      index: 0,
      workflowId: "workflow-id",
      workflowName: "商品海报",
      prompt: "为旅行背包生成海报",
      imageUrl: "/images/workflow.png",
      storageKey: "images/workflow.png",
      width: 1024,
      height: 1024,
      bytes: 2048,
      mimeType: "image/png",
      durationMs: 1200,
      createdAt: Date.parse("2026-08-26T10:00:02Z"),
    }],
    durationMs: 1200,
    endedAt: Date.parse("2026-08-26T10:00:02Z"),
  });
  assert.equal(completed.turns[0].status, "success");
  assert.equal(completed.turns[0].images[0].url, "/images/workflow.png");
  assert.equal(completed.turns[0].images[0].outputFormat, "png");
  assert.equal(completed.turns[0].images[0].generationDurationMs, 1200);
});

test("workflow task history preserves metadata on failure", () => {
  const conversation = createWorkflowImageConversation(startTask());
  const failed = workflowImageConversationFailure(conversation, {
    taskId: "workflow-task",
    error: "额度不足",
    images: [],
    durationMs: 800,
    endedAt: Date.parse("2026-08-26T10:00:01Z"),
  });
  assert.equal(failed.turns[0].source, "workflow");
  assert.equal(failed.turns[0].status, "error");
  assert.equal(failed.turns[0].images[0].error, "额度不足");
});

test("workflow partial failure preserves successful image positions", () => {
  const task = { ...startTask(), count: 2 };
  const conversation = createWorkflowImageConversation(task);
  const failed = workflowImageConversationFailure(conversation, {
    taskId: "workflow-task",
    error: "第 1 张生成失败",
    images: [{
      id: "workflow-task-2",
      index: 1,
      workflowId: "workflow-id",
      workflowName: "商品海报",
      prompt: "为旅行背包生成海报",
      imageUrl: "/images/second.webp",
      storageKey: "",
      width: 1024,
      height: 1024,
      bytes: 4096,
      mimeType: "image/webp",
      durationMs: 1600,
      createdAt: Date.parse("2026-08-26T10:00:02Z"),
    }],
    durationMs: 1600,
    endedAt: Date.parse("2026-08-26T10:00:02Z"),
  });
  assert.equal(failed.turns[0].images[0].status, "error");
  assert.equal(failed.turns[0].images[1].status, "success");
  assert.equal(failed.turns[0].images[1].url, "/images/second.webp");
  assert.equal(workflowImageConversationFailure(failed, {
    taskId: "workflow-task",
    error: "重复回调",
    images: [],
    durationMs: 2000,
    endedAt: Date.parse("2026-08-26T10:00:03Z"),
  }), failed);
});
