import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoContractAgentDetails } from "../src/app/settings/components/video-contract-agent-details.tsx";
import { updateVideoContractAgentDetails, updateVideoContractImportActivity } from "../src/lib/video-contract-agent-progress.ts";

test("agent details update in place and keep bounded history", () => {
  const entry = { id: "tool-1", kind: "tool", name: "inspect_protocols", status: "running" };
  let entries = updateVideoContractAgentDetails([], entry);
  entries = updateVideoContractAgentDetails(entries, { ...entry, status: "completed", output: "result" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].output, "result");
  assert.equal(entry.status, "running");
  for (let i = 2; i < 80; i++) entries = updateVideoContractAgentDetails(entries, { ...entry, id: `tool-${i}` });
  assert.equal(entries.length, 60);
  assert.equal(entries.at(-1).id, "tool-79");
});

test("contract output separates assistant messages, corrections and real tool calls", () => {
  const html = renderToStaticMarkup(createElement(VideoContractAgentDetails, { running: true, entries: [
    { id: "reply", kind: "model", name: "model", status: "running", output: "正在整理文档", round: 2, request_attempt: 3 },
    { id: "correction", kind: "correction", name: "format", status: "completed", summary: "已修正工具参数" },
    { id: "tool", kind: "tool", name: "validate_contracts", status: "failed", input: "model=test", output: "invalid", error: "schema invalid" },
  ] }));
  assert.equal((html.match(/data-ai-element="tool"/g) || []).length, 1);
  assert.equal((html.match(/data-ai-element="message"/g) || []).length, 1);
  assert.match(html, /模型第 2 轮/);
  assert.match(html, /第 3 次请求/);
  assert.match(html, /正在整理文档/);
  assert.match(html, /已修正工具参数/);
  assert.match(html, /复制工具输入/);
  assert.match(html, /schema invalid/);
});

test("execution details expose repairable tool data and escape untrusted content", () => {
  const html = renderToStaticMarkup(createElement(VideoContractAgentDetails, { running: true, entries: [
    { id: "failed", kind: "tool", name: "validate_contracts", status: "failed", input: "model=test", output: "<script>alert(1)</script>", error: "schema invalid" },
    { id: "running", kind: "model", name: "model", status: "running", output: "正在整理文档", round: 2 },
  ] }));
  assert.match(html, /执行记录/);
  assert.match(html, /data-ai-element="conversation"/);
  assert.match(html, /data-message-id="failed"/);
  assert.match(html, /data-message-id="running"/);
  assert.match(html, /schema invalid/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /复制工具输入/);
  assert.match(html, /复制工具输出/);
  assert.match(html, /模型第 2 轮/);
  assert.match(html, /正在整理文档/);
});

test("workflow progress keeps the current operation through heartbeats", () => {
  let activity = updateVideoContractImportActivity(null, { stage: "document_ready", message: "已读取" });
  activity = updateVideoContractImportActivity(activity, { stage: "matching_protocol", message: "正在匹配协议", attempt: 1, max_attempts: 12 });
  activity = updateVideoContractImportActivity(activity, { stage: "heartbeat", message: "保活", elapsed_seconds: 10 });
  assert.equal(activity.step, 1);
  assert.equal(activity.message, "正在匹配协议");
  assert.equal(activity.stage, "matching_protocol");
  assert.equal(activity.attempt, 1);
  assert.equal(activity.elapsed_seconds, 10);
  assert.deepEqual(activity.completedSteps, [0]);
});

test("tool outcomes drive workflow steps, including repair and failure", () => {
  let activity = null;
  const update = (stage, name, status) => activity = updateVideoContractImportActivity(activity, {
    stage, message: stage, detail: { id: name, kind: "tool", name, status },
  });
  update("matching_protocol", "inspect_protocols", "completed");
  update("validating", "validate_contracts", "running");
  assert.equal(activity.step, 3);
  assert.deepEqual(activity.completedSteps, [1, 2]);
  update("repairing", "validate_contracts", "failed");
  assert.equal(activity.step, 3);
  assert.ok(!activity.completedSteps.includes(3));
  activity = updateVideoContractImportActivity(activity, { stage: "failed", message: "模型输出不完整" });
  assert.equal(activity.step, 3);
  assert.equal(activity.message, "模型输出不完整");
  update("validating", "validate_contracts", "completed");
  update("validating", "finish", "running");
  assert.equal(activity.step, 4);
  assert.ok(activity.completedSteps.includes(3));
});

test("a new model round resets its character count without losing workflow progress", () => {
  let activity = updateVideoContractImportActivity(null, { stage: "generating", message: "分析", attempt: 1 });
  activity = updateVideoContractImportActivity(activity, { stage: "receiving", message: "输出", received_characters: 42 });
  activity = updateVideoContractImportActivity(activity, { stage: "generating", message: "分析", attempt: 2 });
  assert.equal(activity.received_characters, 0);
  assert.equal(activity.step, 2);
});

test("new document evidence clears downstream completion, cached reads preserve validation", () => {
  const ready = { stage: "validating", message: "完成校验", document_revision: 1, validation_current: true, step: 3, completedSteps: [0,1,2,3,4], connected: true };
  const read = { stage: "reading_documents", message: "补读", detail: { id: "tool-3", kind: "tool", name: "read_documents", status: "running" } };
  let activity = updateVideoContractImportActivity(ready, { ...read, document_revision: 1, validation_current: true });
  assert.deepEqual(activity.completedSteps, [1,2,3,4]);
  activity = updateVideoContractImportActivity(activity, { ...read, document_revision: 2, validation_current: false });
  assert.deepEqual(activity.completedSteps, [1]);
  activity = updateVideoContractImportActivity(activity, { ...read, document_revision: 2, validation_current: false, detail: { ...read.detail, status: "partial" } });
  assert.deepEqual(activity.completedSteps, [1]);
  activity = updateVideoContractImportActivity(activity, { stage: "heartbeat", message: "等待" });
  assert.equal(activity.document_revision, 2);
  assert.equal(activity.validation_current, false);
  const cached = updateVideoContractImportActivity(ready, { ...read, document_revision: 1, validation_current: true, detail: { ...read.detail, status: "completed" } });
  assert.deepEqual(cached.completedSteps, [0,1,2,3,4]);
  const failedOnly = updateVideoContractImportActivity(ready, { ...read, document_revision: 1, validation_current: true, detail: { ...read.detail, status: "failed" } });
  assert.ok(failedOnly.completedSteps.includes(3));
});

test("starting a new validation clears its old completion and finished draft", () => {
  const current = { stage: "validating", step: 4, completedSteps: [0,1,2,3,4], validation_current: true, document_revision: 1 };
  const activity = updateVideoContractImportActivity(current, { stage: "validating", message: "校验", validation_current: false, document_revision: 1, detail: { id: "tool-5", kind: "tool", name: "validate_contracts", status: "running" } });
  assert.deepEqual(activity.completedSteps, [0,1,2]);
  assert.equal(activity.step, 3);
});

test("new request attempts reset streamed character counts and remain separate entries", () => {
  let activity = updateVideoContractImportActivity(null, { stage: "receiving", message: "输出", attempt: 1, request_attempt: 1, received_characters: 42 });
  activity = updateVideoContractImportActivity(activity, { stage: "retrying", message: "等待退避" });
  assert.equal(activity.received_characters, 42);
  activity = updateVideoContractImportActivity(activity, { stage: "generating", message: "请求", attempt: 1, request_attempt: 2 });
  assert.equal(activity.received_characters, 0);
  activity = updateVideoContractImportActivity(activity, { stage: "receiving", message: "输出", received_characters: 3 });
  activity = updateVideoContractImportActivity(activity, { stage: "generating", message: "下一轮", attempt: 2 });
  assert.equal(activity.received_characters, 0);
  assert.equal(activity.request_attempt, undefined);
  const first = { id: "model-1-attempt-1", kind: "model", status: "failed", output: "已输出的文本", error: "HTTP 524", round: 1, request_attempt: 1 };
  let details = updateVideoContractAgentDetails([], first);
  details = updateVideoContractAgentDetails(details, { ...first, id: "model-1-attempt-2", status: "running", output: "新回复", error: undefined, request_attempt: 2 });
  assert.equal(details.length, 2);
  assert.equal(details[0].output, "已输出的文本");
  assert.equal(details[0].error, "HTTP 524");
  assert.equal(details[1].output, "新回复");
});
