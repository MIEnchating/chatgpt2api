import assert from "node:assert/strict";
import { afterAll, mock, test } from "bun:test";
const actual = { ...await import("../src/lib/request.ts") };
let calls = [], handler;
mock.module("@/lib/request", () => ({ ...actual, httpRequest: async (path, options = {}) => { calls.push({ path, options }); return handler(path, options); } }));
const { runBackendCanvasAgent, fetchCanvasAgentRun, runBackendCanvasTool, answerBackendWorkflowReview, CanvasAgentStopError, CanvasAgentObservationError } = await import("../src/app/canvas/agent/canvas-agent-backend.ts");
afterAll(() => mock.module("@/lib/request", () => actual));
const snapshot = (status) => ({ document: { id: "project", revision: 2, agent_run: { id: "run", status } } });
test("closing the page detaches without cancelling the backend run", async () => {
  calls = []; handler = () => snapshot("running"); const controller = new AbortController();
  await runBackendCanvasAgent("project", { id: "run", references: [] }, () => controller.abort("canvas-detached"), controller.signal);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(calls.some((call) => call.options.method === "DELETE"), false);
});

test("rejected accepted-run snapshots are observation errors and never cancel or resubmit work", async () => {
  for (const status of ["running", "success"]) {
    calls = []; handler = () => snapshot(status);
    await assert.rejects(() => runBackendCanvasAgent("project", { id: "run", references: [] }, () => { throw new Error("对话记录数据无效"); }, new AbortController().signal), error => error instanceof CanvasAgentObservationError && error.cause?.message === "对话记录数据无效");
    assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
    assert.equal(calls.some(call => call.options.method === "DELETE"), false);
  }
});

test("an invalid first acknowledgement keeps observing the same run until a valid terminal snapshot", async () => {
  calls = []; let reads = 0;
  handler = (_path, options) => options.method === "POST" ? snapshot("running") : { document: { ...snapshot("success").document, valid: ++reads > 1 } };
  const errors = [], accepted = [];
  const result = await runBackendCanvasAgent("project", { id: "run", references: [] }, document => {
    if (!document.valid) throw new Error("invalid transcript snapshot");
    accepted.push(document.agent_run.status);
  }, new AbortController().signal, error => errors.push(error));
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => error instanceof CanvasAgentObservationError));
  assert.deepEqual(accepted, ["success"]);
  assert.equal(result.agent_run.id, "run");
  assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
  assert.equal(calls.some(call => call.options.method === "DELETE"), false);
});

test("observation transport errors remain visible and recover the accepted run without changing messages", async () => {
  calls = []; let reads = 0;
  handler = (_path, options) => {
    if (options.method === "POST") return snapshot("running");
    if (++reads === 1) throw new Error("network denied");
    return snapshot("success");
  };
  const errors = [], statuses = [];
  await runBackendCanvasAgent("project", { id: "run", references: [] }, document => statuses.push(document.agent_run.status), new AbortController().signal, error => errors.push(error.message));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /network denied/);
  assert.deepEqual(statuses, ["running", "success"], "a failed fetch cannot republish old state and clear the visible sync error");
  assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
});
test("detaching releases a pending submission without waiting for its acknowledgement", async () => {
  calls = []; let releaseStart;
  handler = () => new Promise(resolve => { releaseStart = resolve; });
  const controller = new AbortController();
  const execution = runBackendCanvasAgent("project", { id: "run", references: [] }, () => assert.fail("A detached page must not receive snapshots"), controller.signal);
  controller.abort("canvas-detached");
  let timer;
  try {
    assert.equal(await Promise.race([execution.then(() => "detached"), new Promise(resolve => { timer = setTimeout(() => resolve("waiting"), 100); })]), "detached");
    assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
    assert.equal(calls.some(call => call.options.method === "DELETE"), false);
  } finally {
    clearTimeout(timer);
    releaseStart(snapshot("running"));
    await execution;
  }
});
for (const reason of [undefined, "canvas-detached"]) {
  test(`an already ${reason ? "detached" : "stopped"} page cannot submit a new backend run`, async () => {
    calls = []; handler = () => snapshot("success");
    const controller = new AbortController();
    controller.abort(reason);
    await runBackendCanvasAgent("project", { id: "run", references: [] }, () => assert.fail("Cancelled snapshot"), controller.signal);
    assert.deepEqual(calls, []);
  });
}
test("explicit stop cancels the same run and receives its final snapshot", async () => {
  calls = []; let status = "running"; handler = (_path, options) => { if (options.method === "DELETE") status = "cancelled"; return snapshot(status); };
  const controller = new AbortController(); const seen = [];
  await runBackendCanvasAgent("project", { id: "run", references: [] }, (document) => { seen.push(document.agent_run.status); if (seen.length === 1) controller.abort(); }, controller.signal);
  assert.equal(calls.filter((call) => call.options.method === "DELETE").length, 1);
  assert.match(calls.find((call) => call.options.method === "DELETE").path, /run_id=run/);
  assert.equal(seen.at(-1), "cancelled");
  assert.equal(calls.filter((call) => !call.options.method).length, 0, "terminal stop response should not wait for polling");
});
test("stop can cancel an accepted run while its start acknowledgement is delayed", async () => {
  calls = []; let releaseStart;
  handler = (_path, options) => options.method === "POST" ? new Promise(resolve => { releaseStart = resolve; }) : snapshot("cancelled");
  const controller = new AbortController(), seen = [];
  const execution = runBackendCanvasAgent("project", { id: "run", references: [] }, doc => seen.push(doc.agent_run.status), controller.signal);
  controller.abort();
  await execution;
  assert.deepEqual(seen, ["cancelled"]);
  assert.equal(calls.filter(call => call.options.method === "DELETE").length, 1);
  releaseStart(snapshot("running"));
});
test("stop retries after start when the initial stop arrives before the run exists", async () => {
  calls = []; let releaseStart, stops = 0;
  handler = (_path, options) => {
    if (options.method === "POST") return new Promise(resolve => { releaseStart = resolve; });
    if (options.method === "DELETE" && ++stops === 1) throw new Error("run not found");
    return snapshot("cancelled");
  };
  const controller = new AbortController(), seen = [];
  const execution = runBackendCanvasAgent("project", { id: "run", references: [] }, doc => seen.push(doc.agent_run.status), controller.signal);
  controller.abort();
  await Promise.resolve();
  releaseStart(snapshot("running"));
  await execution;
  assert.equal(stops, 2);
  assert.equal(seen.at(-1), "cancelled");
});
test("stop interrupts an in-flight poll and applies the stop response", async () => {
  calls = []; let polling;
  const started = new Promise(resolve => { polling = resolve; });
  handler = (_path, options) => {
    if (options.method === "POST") return snapshot("running");
    if (options.method === "DELETE") return snapshot("cancelled");
    polling();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const controller = new AbortController(), seen = [];
  const execution = runBackendCanvasAgent("project", { id: "run", references: [] }, doc => seen.push(doc.agent_run.status), controller.signal);
  await started;
  controller.abort();
  await execution;
  assert.equal(seen.at(-1), "cancelled");
});
test("a rejected stop is reported instead of claiming the run stopped", async () => {
  calls = []; handler = (_path, options) => { if (options.method === "DELETE") throw new Error("network unavailable"); return snapshot("running"); };
  const controller = new AbortController();
  await assert.rejects(() => runBackendCanvasAgent("project", { id: "run", references: [] }, () => controller.abort(), controller.signal), CanvasAgentStopError);
});
test("reconnecting only reads the persisted run without resubmitting it", async () => {
  calls = []; handler = () => snapshot("success");
  const response = await fetchCanvasAgentRun("project");
  assert.equal(response.document.agent_run.status, "success");
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, undefined);
});

test("a lost start acknowledgement reconnects to the same run without resubmitting", async () => {
  calls = []; handler = (_path, options) => { if (options.method === "POST") throw new Error("acknowledgement lost"); return snapshot("success"); };
  const seen = [];
  await runBackendCanvasAgent("project", { id: "run", references: [] }, (doc) => seen.push(doc.agent_run.status), new AbortController().signal);
  assert.deepEqual(seen, ["success"]);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(calls.filter((call) => !call.options.method).length, 1);
});

test("start recovery never adopts another run or hides the original rejection", async () => {
  for (const unavailable of [false, true]) {
    calls = []; handler = (_path, options) => {
      if (options.method === "POST") throw new Error("original rejection");
      if (unavailable) throw new Error("recovery unavailable");
      return { document: { agent_run: { id: "other", status: "success" } } };
    };
    await assert.rejects(() => runBackendCanvasAgent("project", { id: "run", references: [] }, () => assert.fail("wrong run was published"), new AbortController().signal), /original rejection/);
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  }
});

test("tool submission recovery returns the saved result without executing again", async () => {
  calls = []; const result = { ok: true, nodeId: "existing" };
  handler = (_path, options) => {
    if (options.method === "POST") throw new Error("tool acknowledgement lost");
    return { document: { agent_run: { id: "run", status: "success", toolResult: result } } };
  };
  const response = await runBackendCanvasTool("project", { id: "run", references: [] }, { id: "call", name: "create_text_node", arguments: {} }, () => {}, new AbortController().signal);
  assert.deepEqual(response.result, result);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
});

test("Codex tool dispatch shares persisted backend progress and returns its result", async () => {
  calls = []; const result = { ok: true, nodeIds: ["poster", "video"] };
  handler = (_path, options) => options.method === "POST" ? snapshot("running") : { document: { ...snapshot("success").document, agent_run: { id: "run", status: "success", toolResult: result } } };
  const seen = [];
  const response = await runBackendCanvasTool("project", { id: "run", references: [] }, { id: "call", name: "run_canvas_workflow", arguments: { nodeIds: ["video"] } }, doc => seen.push(doc.agent_run.status), new AbortController().signal);
  assert.deepEqual(response.result, result);
  assert.deepEqual(seen, ["running", "success"]);
  assert.equal(calls[0].path, "/api/canvas/agent-tools?history=active&project_id=project");
  assert.equal(calls[0].options.body.call.name, "run_canvas_workflow");
  assert.equal(calls[1].path, "/api/canvas/agent-runs?history=active&project_id=project");
});
test("workflow approval sends the user's actual answer and reviewed fingerprints separately", async () => {
  calls = []; handler = () => snapshot("success");
  await answerBackendWorkflowReview("project", "session", { poster: "fingerprint" }, "暂不生成，先修改颜色");
  assert.equal(calls[0].path, "/api/canvas/agent-tools/review-answers?history=active&project_id=project");
  assert.deepEqual(calls[0].options.body, { sessionId: "session", prompts: { poster: "fingerprint" }, answer: "暂不生成，先修改颜色" });
});
test("missing or replaced tool results never masquerade as successful execution", async () => {
  calls = []; handler = () => ({ document: { agent_run: { id: "run", status: "error", error: "服务已重启，执行已暂停；请检查已有结果后继续。" } } });
  await assert.rejects(() => runBackendCanvasTool("project", { id: "run", references: [] }, { id: "call", name: "get_canvas_summary", arguments: {} }, () => {}, new AbortController().signal), /服务已重启，执行已暂停/);

  calls = []; handler = () => snapshot("error");
  await assert.rejects(() => runBackendCanvasTool("project", { id: "run", references: [] }, { id: "call", name: "get_canvas_summary", arguments: {} }, () => {}, new AbortController().signal), /执行状态待核实.*未返回执行结果/);
});

test("backend requests contain reference IDs without duplicate pixels, text or node copies", async () => {
  calls = []; handler = () => snapshot("success");
  await runBackendCanvasAgent("project", { id: "run", references: [
    { id: "node", type: "text", title: "Long script", text: "body".repeat(10000) },
    { id: "photo", source: "attachment", url: "/api/files/photo/content", dataUrl: "data:image/png;base64,AAAA" },
  ] }, () => {}, new AbortController().signal);
  assert.deepEqual(calls[0].options.body.references, [{ id: "node", source: undefined }, { id: "photo", source: "attachment" }]);
});
