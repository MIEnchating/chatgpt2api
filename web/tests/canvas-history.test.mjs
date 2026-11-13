import assert from "node:assert/strict";
import test from "node:test";

import { appendCanvasHistorySnapshot, canvasHistoryKey, canvasHistoryStorageObjectIDs, canvasHistoryStorageObjectURLs, canvasHistoryLeaseExpired, commitCanvasGenerationHistory, restoreCanvasHistoryDocument } from "../src/app/canvas/canvas-history.ts";
import { mergeCanvasDocuments } from "../src/app/canvas/canvas-document-merge.ts";
import { canvasAgentHistoryChanges, canvasAgentHistoryReceipt } from "../src/app/canvas/agent/canvas-agent-history.ts";

function document(values = {}) {
  return {
    version: 1,
    id: "canvas-1",
    revision: 3,
    title: "画布",
    background: "dots",
    nodes: [],
    connections: [],
    viewport: { zoom: 1, x: 0, y: 0 },
    ...values,
  };
}

test("engine and title updates do not retransmit an unchanged long conversation", () => {
  const session = { id: "s", title: "Original", createdAt: "now", updatedAt: "now", messages: [{ id: "u", role: "user", text: "Keep this request" }], protocolMessages: [{ role: "assistant", content: "Retained history. ".repeat(50000) }], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } };
  const base = document({ agent_history_partial: true, agent_sessions: [session], agent_session_summaries: [{ id: "s", content_hash: "original-hash" }] });
  const changed = { ...base, agent_sessions: [{ ...session, title: "Renamed", engine: "codex", updatedAt: "later" }] };
  const payload = canvasAgentHistoryChanges(changed, base);
  assert.deepEqual(payload.agent_sessions, []);
  assert.deepEqual(payload.agent_session_updates, [{ id: "s", changes: { title: "Renamed", updatedAt: "later", engine: "codex" } }]);
  assert.equal(payload.agent_session_summaries[0].content_hash, "original-hash");
  assert.ok(JSON.stringify(payload).length < 1000);
  const edited = { ...changed, agent_sessions: [{ ...changed.agent_sessions[0], messages: [{ ...session.messages[0], text: "Edited request" }] }] };
  assert.deepEqual(canvasAgentHistoryChanges(edited, base).agent_sessions, edited.agent_sessions);
  assert.equal(canvasAgentHistoryChanges(edited, base).agent_session_updates, undefined);
});

test("metadata receipts restore the submitted conversation before merging newer local edits", () => {
  const session = { id: "s", title: "Original", createdAt: "now", updatedAt: "later", engine: "codex", messages: [{ id: "u", role: "user", text: "Keep this request" }], protocolMessages: [{ role: "assistant", content: "Complete private history" }], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } };
  const submitted = document({ agent_history_partial: true, agent_sessions: [session], agent_session_summaries: [{ id: "s", content_hash: "before" }] });
  const receipt = document({ revision: 4, agent_history_partial: true, agent_sessions: [], agent_session_summaries: [{ id: "s", content_hash: "after" }], agent_session_updates: [{ id: "s", changes: { engine: "codex", updatedAt: "later" } }] });
  submitted.agent_session_updates = receipt.agent_session_updates;
  const acknowledged = canvasAgentHistoryReceipt(receipt, submitted);
  assert.deepEqual(acknowledged.agent_sessions, [session]);
  assert.equal(acknowledged.agent_sessions[0].messages, session.messages);
  assert.equal(acknowledged.agent_sessions[0].protocolMessages, session.protocolMessages);
  assert.equal(acknowledged.agent_session_updates, undefined);
  assert.deepEqual(receipt.agent_sessions, []);
  const editing = { ...submitted, agent_sessions: [{ ...session, engine: "native", messages: [...session.messages, { id: "later", role: "user", text: "New unsaved request" }] }] };
  const merged = mergeCanvasDocuments(submitted, editing, acknowledged);
  assert.deepEqual(merged.agent_sessions, editing.agent_sessions);
  for (const invalid of [
    { ...receipt, agent_session_updates: undefined },
    { ...receipt, agent_session_updates: [{ id: "missing", changes: { engine: "native" } }] },
    { ...receipt, agent_session_updates: [{ id: "s", changes: { engine: "native", updatedAt: "later" } }] },
    { ...receipt, agent_session_updates: [{ id: "s", changes: { engine: "codex" } }] },
    { ...receipt, agent_session_summaries: [] },
    { ...receipt, agent_session_updates: [...receipt.agent_session_updates, ...receipt.agent_session_updates] },
    { ...receipt, agent_session_updates: [{ id: "s", changes: { messages: [] } }] },
  ]) assert.throws(() => canvasAgentHistoryReceipt(invalid, submitted), /原记录未被替换/);
});

test("canvas history ignores viewport-only changes", () => {
  const before = document();
  const after = document({ viewport: { zoom: 2, x: -400, y: 120 } });
  assert.equal(canvasHistoryKey(before), canvasHistoryKey(after));
});

test("restoring history keeps the current viewport and server revision", () => {
  const current = document({ revision: 9, updated_at: "new", viewport: { zoom: 2, x: -400, y: 120 }, nodes: [{ id: "new" }] });
  const snapshot = document({ revision: 2, updated_at: "old", viewport: { zoom: 0.5, x: 10, y: 20 }, nodes: [{ id: "old" }] });
  assert.deepEqual(restoreCanvasHistoryDocument(current, snapshot), {
    ...snapshot,
    revision: 9,
    updated_at: "new",
    viewport: current.viewport,
  });
});

test("undo restores canvas content while retaining current conversations, session deletions and Agent state", () => {
  const snapshot = document({
    title: "旧画布", nodes: [{ id: "old" }], agent_sessions: [{ id: "deleted", messages: [{ text: "旧聊天" }] }],
    active_agent_session_id: "deleted", agent_config: { textModel: "old" }, agent_panel: { open: false, width: 400 },
    agent_run: { id: "old-run", status: "running" }, pending_agent_request: { prompt: "已经消费的请求" },
    agent_auto_title_pending: true, show_image_info: true,
  });
  const current = document({
    revision: 12, title: "新画布", nodes: [{ id: "new" }],
    agent_sessions: [{ id: "current", messages: [{ text: "最新请求" }, { text: "最新答复" }] }],
    agent_messages: [{ id: "message", content: "最新旧格式记录" }],
    active_agent_session_id: "current", agent_session_summaries: [{ id: "current", content_hash: "new-hash" }],
    deleted_agent_session_ids: ["deleted"], agent_history_partial: true,
    agent_config: { textModel: "new" }, agent_panel: { open: true, width: 480 }, agent_run: { id: "current-run", status: "success" },
  });
  const restored = restoreCanvasHistoryDocument(current, snapshot);
  assert.equal(restored.title, snapshot.title);
  assert.deepEqual(restored.nodes, snapshot.nodes);
  assert.equal(restored.show_image_info, true);
  for (const key of ["agent_sessions", "agent_messages", "active_agent_session_id", "agent_session_summaries", "deleted_agent_session_ids", "agent_history_partial", "agent_config", "agent_panel", "agent_run"]) {
    assert.deepEqual(restored[key], current[key], `undo must retain current ${key}`);
  }
  assert.equal(restored.pending_agent_request, undefined, "consumed requests must not be resurrected");
  assert.equal(restored.agent_auto_title_pending, undefined);
  assert.deepEqual(restoreCanvasHistoryDocument(document(), snapshot).agent_sessions, undefined, "cleared conversations must remain cleared");
});

test("saving undo and redo never submits a stale transcript or resurrects a deleted session", () => {
  const now = "2026-11-12T00:00:00Z";
  const session = { id: "s", title: "对话", createdAt: now, updatedAt: now, messages: [{ id: "u", role: "user", text: "第一条" }], protocolMessages: [], agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] } };
  const snapshot = document({ agent_history_partial: true, agent_sessions: [session], agent_session_summaries: [{ id: "s", content_hash: "old" }] });
  const moved = { ...snapshot, nodes: [{ id: "moved", x: 200 }] };
  const current = document({ ...moved, revision: 6, agent_sessions: [{ ...session, messages: [...session.messages, { id: "a", role: "assistant", text: "最新答复必须保留", status: "success" }] }], agent_session_summaries: [{ id: "s", content_hash: "latest" }] });
  for (const historical of [snapshot, moved]) {
    const restored = restoreCanvasHistoryDocument(current, historical);
    const payload = canvasAgentHistoryChanges(mergeCanvasDocuments(current, restored, current), current);
    assert.deepEqual(payload.agent_sessions, [], "a geometry undo save must not overwrite newer chat bodies");
    assert.deepEqual(restored.agent_sessions, current.agent_sessions);
    assert.equal(payload.agent_session_summaries[0].content_hash, "latest");
  }
  const deleted = { ...current, agent_sessions: [], deleted_agent_session_ids: ["s"] };
  assert.deepEqual(restoreCanvasHistoryDocument(deleted, snapshot).deleted_agent_session_ids, ["s"]);
  assert.deepEqual(restoreCanvasHistoryDocument(deleted, snapshot).agent_sessions, []);
});

test("generation completion collapses every temporary loading snapshot", () => {
  const initial = document({ nodes: [{ id: "source", generation_status: "success" }] });
  const completed = document({ nodes: [{ id: "source", x: 40, generation_status: "success" }, { id: "result", generation_status: "success" }] });
  assert.deepEqual(commitCanvasGenerationHistory([initial], completed), [initial, completed]);
});

test("generation baseline captures edits made immediately before submission", () => {
  const initial = document({ nodes: [{ id: "source", prompt: "旧提示词" }] });
  const edited = document({ nodes: [{ id: "source", prompt: "刚输入的提示词" }] });
  assert.deepEqual(appendCanvasHistorySnapshot([initial], edited), [initial, edited]);
  assert.deepEqual(commitCanvasGenerationHistory(appendCanvasHistorySnapshot([initial], edited), edited), [initial, edited]);
});

test("history initializes from the current snapshot when no baseline exists", () => {
  const initial = document({ title: "初始画布" });
  assert.deepEqual(appendCanvasHistorySnapshot([], initial), [initial]);
});

test("generation cancellation does not add a duplicate of its base snapshot", () => {
  const initial = document({ nodes: [{ id: "source" }] });
  assert.deepEqual(commitCanvasGenerationHistory([initial], initial), [initial]);
});

test("generation completion keeps the configured history limit", () => {
  const history = Array.from({ length: 50 }, (_, index) => document({ title: `画布 ${index}` }));
  const completed = document({ title: "完成" });
  const result = commitCanvasGenerationHistory(history, completed, 50);
  assert.equal(result.length, 50);
  assert.equal(result[0].title, "画布 1");
  assert.equal(result.at(-1).title, "完成");
});


test("history retention includes redo and nested director or Agent references without inheriting stale claims", () => {
  const history = [document({ nodes: [{ url: "/api/files/video/content", director_project: { key: "server:director" } }], retained_storage_object_ids: ["stale"], agent_sessions: [{ messages: [{ image: "/api/files/agent/content" }] }] })];
  const redo = [document({ nodes: [{ storage_key: "server:redo", url: "/api/files/video/content" }] })];
  assert.deepEqual(canvasHistoryStorageObjectIDs(history, redo), ["agent", "director", "redo", "video"]);
  assert.deepEqual(canvasHistoryStorageObjectIDs([], redo), ["redo", "video"]);
});

test("expired browser history cannot renew an already elapsed lease", () => {
  assert.equal(canvasHistoryLeaseExpired(document(), 1000), false);
  assert.equal(canvasHistoryLeaseExpired(document({ retained_storage_objects_until: new Date(2000).toISOString() }), 1000), false);
  assert.equal(canvasHistoryLeaseExpired(document({ retained_storage_objects_until: new Date(2000).toISOString() }), 2000), true);
  assert.equal(canvasHistoryLeaseExpired(document({ retained_storage_objects_until: "invalid" }), 1000), true);
});


test("undo preserves the renewed server lease and never resurrects an old history lease", () => {
  const snapshot = document({ retained_storage_object_ids: ["old"], retained_storage_objects_until: "old expiry" });
  const current = document({ retained_storage_object_ids: ["new"], retained_storage_objects_until: "new expiry" });
  const restored = restoreCanvasHistoryDocument(current, snapshot);
  assert.deepEqual(restored.retained_storage_object_ids, ["new"]);
  assert.equal(restored.retained_storage_objects_until, "new expiry");
  assert.equal(restoreCanvasHistoryDocument(document(), snapshot).retained_storage_objects_until, undefined);
});


test("undo retains files referenced inside serialized tool results and Markdown messages", () => {
  const snapshot = document({ agent_sessions: [{ messages: [{ content: '{"url":"/api/files/tool/content"}' }, { content: "![picture](/api/files/markdown/content)" }, { content: '{"storage_key":"server:stored"}' }] }] });
  assert.deepEqual(canvasHistoryStorageObjectIDs([snapshot]), ["markdown", "stored", "tool"]);
});

test("history protects public storage links without inheriting expired URL leases", () => {
  const snapshot = document({ nodes: [{ url: "https://cdn.example.test/video.mp4" }], agent_sessions: [{ messages: [{ content: "[clip](https://cdn.example.test/audio.wav)" }] }], retained_storage_object_urls: ["https://cdn.example.test/expired.png"] });
  assert.deepEqual(canvasHistoryStorageObjectURLs([snapshot]), ["https://cdn.example.test/audio.wav", "https://cdn.example.test/audio.wav)", "https://cdn.example.test/video.mp4"]);
  const restored = restoreCanvasHistoryDocument(document({ retained_storage_object_urls: ["https://cdn.example.test/current.png"] }), snapshot);
  assert.deepEqual(restored.retained_storage_object_urls, ["https://cdn.example.test/current.png"]);
  assert.equal(restoreCanvasHistoryDocument(document(), snapshot).retained_storage_object_urls, undefined);
});

test("history retains complete public URLs with legal trailing punctuation", () => {
  for (const suffix of [".", ")", "]", ";", "}"]) {
    const url = `https://cdn.example.test/file${suffix}`;
    const urls = canvasHistoryStorageObjectURLs([document({ nodes: [{ url }] })]);
    assert.ok(urls.includes(url), `${url} must not be truncated`);
    const markdown = canvasHistoryStorageObjectURLs([document({ nodes: [{ prompt: `[file](${url})` }] })]);
    assert.ok(markdown.includes(url), `Markdown ${url} must not lose URL punctuation`);
  }
});

test("history snapshots copy only reversible canvas fields without reading or serializing chat bodies", async () => {
 const {createCanvasHistorySnapshot} = await import('../src/app/canvas/canvas-history.ts');
 assert.equal(typeof createCanvasHistorySnapshot, 'function');
 const original = document({nodes: [{id: 'n', prompt: 'node content', director_project: {reference: '/api/files/director/content'}}], connections: [{id: 'e', from_node_id: 'n', to_node_id: 'n'}]});
 Object.defineProperty(original, 'agent_sessions', {enumerable: true, get() {throw new Error('A geometry history snapshot must not traverse complete conversations');}});
 Object.defineProperty(original, 'pending_agent_request', {enumerable: true, get() {throw new Error('Pending requests are not part of canvas undo');}});
 const snapshot = createCanvasHistorySnapshot(original);
 assert.deepEqual(Object.keys(snapshot).sort(), ['background', 'connections', 'id', 'nodes', 'title']);
 assert.equal(canvasHistoryKey(snapshot), canvasHistoryKey(original));
 original.nodes[0].director_project.reference = '/api/files/changed/content';
 original.connections[0].to_node_id = 'changed';
 assert.equal(snapshot.nodes[0].director_project.reference, '/api/files/director/content');
 assert.equal(snapshot.connections[0].to_node_id, 'n');
 assert.deepEqual(canvasHistoryStorageObjectIDs([snapshot]), ['director']);
 const current = document({agent_sessions: [{id: 's', messages: ['current']}], viewport: {x: 100, y: 50, zoom: 2}});
 const restored = restoreCanvasHistoryDocument(current, snapshot);
 assert.deepEqual(restored.agent_sessions, current.agent_sessions);
 assert.equal(restored.viewport, current.viewport);
 assert.equal(restored.nodes[0].director_project.reference, '/api/files/director/content');
});

test("rebased undo snapshots never acquire runtime chat, settings or a live run from server progress", async () => {
 const {mergeCanvasHistory} = await import('../src/app/canvas/canvas-document-merge.ts');
 const base = document({agent_run: {status: 'running'}, agent_sessions: [{id: 's', messages: ['old']}], agent_config: {textModel: 'model'}});
 const local = {...base, nodes: [{id: 'n', x: 100}]};
 const remote = {...local, revision: 4, agent_sessions: [{id: 's', messages: ['new']}], nodes: [{id: 'n', x: 100, url: '/api/files/result/content'}]};
 const snapshot = {id: base.id, title: base.title, background: base.background, nodes: [], connections: []};
 const rebased = mergeCanvasHistory(base, local, snapshot, remote);
 for (const key of ['agent_sessions','agent_config','agent_run','agent_session_summaries','viewport','retained_storage_object_ids']) assert.equal(key in rebased, false, `Undo snapshots must exclude ${key}`);
});
