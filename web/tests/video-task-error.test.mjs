import assert from "node:assert/strict";
import test from "node:test";
import { videoTaskErrorMessage } from "../src/lib/video-task-error.ts";

test("video errors preserve upstream reasons without inventing refund or prompt advice", () => {
  const reason = "请更换提示词后重试（积分已退回）";
  assert.equal(videoTaskErrorMessage(reason), reason);
  assert.equal(videoTaskErrorMessage("余额不足"), "余额不足");
  assert.equal(videoTaskErrorMessage("task failed"), "上游视频生成失败，未提供具体原因。请稍后重试。");
});

test("missing reasons and bare task identifiers are not displayed as failure explanations", () => {
  for (const error of [undefined, "", "  ", "task_example", "video_task_example-123"]) {
    assert.equal(videoTaskErrorMessage(error), "上游未提供具体失败原因，请稍后重试。");
  }
});
