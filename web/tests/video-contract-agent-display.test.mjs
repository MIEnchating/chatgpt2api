import assert from "node:assert/strict";
import test from "node:test";
import { videoContractToolSummary } from "../src/lib/video-contract-agent-display.ts";

const entry = (name, output, status = "completed", input = "{}") => ({ id: "tool-1", kind: "tool", name, status, input, output });

test("protocol catalogs render a summary rather than their raw JSON", () => {
  assert.equal(videoContractToolSummary(entry("inspect_protocols", JSON.stringify([{ driver: "a" }, { driver: "b" }]))), "已读取 2 种内置协议，供模型匹配");
  assert.equal(videoContractToolSummary(entry("inspect_protocols", '[{"driver": …（详情过长）')), "已读取内置协议目录");
});

test("tool summaries reflect document counts and review outcomes", () => {
  assert.equal(videoContractToolSummary(entry("read_documents", "", "running", '{"ids":[1,2,3]}')), "正在读取 3 个相关页面");
  assert.equal(videoContractToolSummary({ ...entry("read_documents", '{"documents":[{},{}]}'), summary: "已读取 2 页" }), "已读取 2 页");
  assert.equal(videoContractToolSummary(entry("validate_contracts", '{"review":[{"review_passed":true},{"review_passed":false}]}')), "已校验 2 份契约，其中 1 份有待确认项");
  assert.equal(videoContractToolSummary(entry("finish", '{"contracts":5}')), "已整理 5 份契约草稿，等待审核");
});

test("document summaries remain accurate when raw results are truncated", () => {
  const partial = { ...entry("read_documents", '{"documents":[ …（详情过长）', "partial", '{"ids":[1,2,3]}'), summary: "已读取 2 页，1 页读取失败", error: "页面 3 · 查询：HTTP 503" };
  assert.equal(videoContractToolSummary(partial), "已读取 2 页，1 页读取失败");
  assert.equal(videoContractToolSummary({ ...partial, status: "failed", summary: "已读取 0 页，3 页读取失败" }), "已读取 0 页，3 页读取失败");
  assert.equal(videoContractToolSummary(entry("read_documents", "truncated", "completed", '{"ids":[1,2,3]}')), "读取已结束");
});

test("tool failures remain visible without expanding raw data", () => {
  assert.equal(videoContractToolSummary(entry("validate_contracts", "request.duration_field 缺失", "failed")), "request.duration_field 缺失");
});
