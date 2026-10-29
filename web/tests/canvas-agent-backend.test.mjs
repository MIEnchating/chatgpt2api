import assert from "node:assert/strict";
import { afterAll, mock, test } from "bun:test";
const actual = { ...await import("../src/lib/request.ts") };
let calls = [], handler;
mock.module("@/lib/request", () => ({ ...actual, httpRequest: async (path, options = {}) => { calls.push({ path, options }); return handler(path, options); } }));
const { runBackendCanvasAgent, fetchCanvasAgentRun, runBackendCanvasTool, answerBackendWorkflowReview } = await import("../src/app/canvas/agent/canvas-agent-backend.ts");
afterAll(() => mock.module("@/lib/request", () => actual));
const snapshot = (status) => ({ document: { id: "project", revision: 2, agent_run: { id: "run", status } } });
test("closing the page detaches without cancelling the backend run", async () => {
  calls = []; handler = () => snapshot("running"); const controller = new AbortController();
  await runBackendCanvasAgent("project", { id: "run", references: [] }, () => controller.abort("canvas-detached"), controller.signal);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(calls.some((call) => call.options.method === "DELETE"), false);
});
test("explicit stop cancels the same run and receives its final snapshot", async () => {
  calls = []; let status = "running"; handler = (_path, options) => { if (options.method === "DELETE") status = "cancelled"; return snapshot(status); };
  const controller = new AbortController(); const seen = [];
  await runBackendCanvasAgent("project", { id: "run", references: [] }, (document) => { seen.push(document.agent_run.status); if (seen.length === 1) controller.abort(); }, controller.signal);
  assert.equal(calls.filter((call) => call.options.method === "DELETE").length, 1);
  assert.match(calls.find((call) => call.options.method === "DELETE").path, /run_id=run/);
  assert.equal(seen.at(-1), "cancelled");
});
test("reconnecting only reads the persisted run without resubmitting it", async () => {
  calls = []; handler = () => snapshot("success");
  const response = await fetchCanvasAgentRun("project");
  assert.equal(response.document.agent_run.status, "success");
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, undefined);
});

test("Codex tool dispatch shares persisted backend progress and returns its result", async () => {
  calls = []; const result = { ok: true, nodeIds: ["poster", "video"] };
  handler = (_path, options) => options.method === "POST" ? snapshot("running") : { document: { ...snapshot("success").document, agent_run: { id: "run", status: "success", toolResult: result } } };
  const seen = [];
  const response = await runBackendCanvasTool("project", { id: "run", references: [] }, { id: "call", name: "run_canvas_workflow", arguments: { nodeIds: ["video"] } }, doc => seen.push(doc.agent_run.status), new AbortController().signal);
  assert.deepEqual(response.result, result);
  assert.deepEqual(seen, ["running", "success"]);
  assert.equal(calls[0].path, "/api/canvas/agent-tools?project_id=project");
  assert.equal(calls[0].options.body.call.name, "run_canvas_workflow");
  assert.equal(calls[1].path, "/api/canvas/agent-runs?project_id=project");
});
test("workflow approval sends the user's actual answer and reviewed fingerprints separately", async () => {
  calls = []; handler = () => snapshot("success");
  await answerBackendWorkflowReview("project", "session", { poster: "fingerprint" }, "暂不生成，先修改颜色");
  assert.equal(calls[0].path, "/api/canvas/agent-tools/review-answers?project_id=project");
  assert.deepEqual(calls[0].options.body, { sessionId: "session", prompts: { poster: "fingerprint" }, answer: "暂不生成，先修改颜色" });
});
test("missing or replaced tool results never masquerade as successful execution", async () => {
  calls = []; handler = () => snapshot("error");
  await assert.rejects(() => runBackendCanvasTool("project", { id: "run", references: [] }, { id: "call", name: "get_canvas_summary", arguments: {} }, () => {}, new AbortController().signal), /未返回结果/);
});

test("backend requests contain reference IDs without duplicate pixels, text or node copies", async () => {
  calls = []; handler = () => snapshot("success");
  await runBackendCanvasAgent("project", { id: "run", references: [
    { id: "node", type: "text", title: "Long script", text: "body".repeat(10000) },
    { id: "photo", source: "attachment", url: "/api/files/photo/content", dataUrl: "data:image/png;base64,AAAA" },
  ] }, () => {}, new AbortController().signal);
  assert.deepEqual(calls[0].options.body.references, [{ id: "node", source: undefined }, { id: "photo", source: "attachment" }]);
});
