import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
let calls = [], handler;
const loaded = new Map();
function loadModule(name) {
 if (loaded.has(name)) return loaded.get(name);
 const module = { exports: {} };
 const require = createRequire(import.meta.url);
 const source = ts.transpileModule(readFileSync(new URL(["agent-executions", "agent-execution-monitor"].includes(name) ? `../src/lib/${name}.ts` : `../src/services/api/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 new Function("require", "module", "exports", source)((id) => {
  if (id === "@/lib/request") return { httpRequest: async (path, options = {}) => { calls.push({ path, options }); return handler(path, options); } };
  if (id === "@/lib/agent-executions" || id === "./agent-executions") return loadModule("agent-executions");
  return require(id);
 }, module, module.exports);
 loaded.set(name, module.exports);
 return module.exports;
}
const { observeAgentExecution, resumeAgentExecution } = loadModule("agent-executions");
const { draftWorkflowWithAgent } = loadModule("workflows");

test("a detached observer does not cancel or resubmit the server-side execution", async () => {
 calls=[];handler=()=>({run:{id:"saved",domain:"workflow",status:"running",events:[]}});
 const controller=new AbortController();
 await assert.rejects(observeAgentExecution("saved",controller.signal,()=>controller.abort()),{name:"AbortError"});
 assert.equal(calls.length,1);assert.equal(calls[0].options.method,undefined);
});
test("failed executions need explicit resume and keep the original execution ID",async()=>{
 calls=[];handler=()=>({run:{id:"saved",domain:"video_contract",status:"error",error:"上游 HTTP 400",events:[]}});
 await assert.rejects(observeAgentExecution("saved",new AbortController().signal),/400/);
 assert.equal(calls.length,1);
 await resumeAgentExecution("saved");
 assert.equal(calls[1].options.method,"POST");assert.equal(calls[1].path,"/api/agent-runs?id=saved");assert.equal(calls[1].options.body,undefined);
});
test("a lost workflow acknowledgement reads the same job instead of starting it again",async()=>{
 calls=[];let id;
 const draft={draft:{name:"saved workflow"},warnings:[],model:"test"};
 handler=(path,options)=>{
  if(options.method==="POST"){id=options.headers["X-Agent-Run-ID"];throw new Error("acknowledgement lost");}
  assert.equal(path,`/api/agent-runs?id=${id}`);
  return {run:{id,domain:"workflow",status:"success",result:draft,events:[]}};
 };
 const result=await draftWorkflowWithAgent({prompt:"original",scope:"private"},{signal:new AbortController().signal});
 assert.deepEqual(result,draft);assert.equal(calls.filter(call=>call.options.method==="POST").length,1);
});
test("an incomplete success response cannot be presented as a completed draft",async()=>{
 calls=[];handler=()=>({run:{id:"saved",domain:"workflow",status:"success",events:[]}});
 await assert.rejects(observeAgentExecution("saved",new AbortController().signal),/已验收/);
});

const { AgentExecutionMonitor } = loadModule("agent-execution-monitor");
const execution = (status = "running") => ({ id: "saved", domain: "workflow", status, events: [], updatedAt: "2026-11-09T10:00:00Z" });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("an obsolete success response cannot reach a detached observer", async () => {
 calls = []; const response = deferred(); const controller = new AbortController(); let progress = 0;
 handler = () => response.promise;
 const pending = observeAgentExecution("saved", controller.signal, () => progress++);
 controller.abort(); response.resolve({ run: { ...execution("success"), result: { draft: true } } });
 await assert.rejects(pending, { name: "AbortError" }); assert.equal(progress, 0);
});
test("an observer rejects progress belonging to a different execution", async () => {
 calls = []; handler = () => ({ run: { ...execution("success"), id: "other", result: { draft: true } } });
 await assert.rejects(observeAgentExecution("saved", new AbortController().signal), /标识不匹配/);
});
test("disposing a recovery monitor discards in-flight progress without cancelling the server task", async () => {
 const response = deferred(); let stops = 0, changes = 0;
 const monitor = new AgentExecutionMonitor("workflow", { fetch: () => response.promise, stop: async () => { stops++; } });
 monitor.subscribe(() => changes++);
 const pending = monitor.refresh(); const before = changes;
 monitor.dispose(); response.resolve(execution()); await pending;
 assert.equal(changes, before); assert.equal(stops, 0); assert.equal(monitor.getSnapshot().run, null);
});
test("recovery fetch errors remain visible and can be explicitly retried", async () => {
 let count = 0;
 const monitor = new AgentExecutionMonitor("workflow", { fetch: async () => { if (++count === 1) throw new Error("网络中断"); return execution("error"); } });
 try {
  await monitor.refresh(); assert.match(monitor.getSnapshot().error, /网络中断/);
  await monitor.refresh(); assert.equal(monitor.getSnapshot().error, ""); assert.equal(monitor.getSnapshot().run.status, "error");
 } finally { monitor.dispose(); }
});
test("recovery uses one explicit resume and suppresses duplicate clicks", async () => {
 const response = deferred(); let resumes = 0, results = 0;
 const monitor = new AgentExecutionMonitor("workflow", {
  fetch: async () => execution("interrupted"),
  resume: async id => { assert.equal(id, "saved"); resumes++; await response.promise; return execution(); },
  observe: async (id, signal, progress) => { progress(execution("success")); return { draft: true }; },
 });
 try {
  await monitor.refresh(); assert.equal(resumes, 0);
  const pending = monitor.continueRun(() => results++);
  await monitor.continueRun(() => results++); assert.equal(resumes, 1);
  response.resolve(); await pending; assert.equal(results, 1); assert.equal(monitor.getSnapshot().action, "idle");
 } finally { monitor.dispose(); }
});
test("stop interrupts observation, reads server state and rejects late results", async () => {
 const response = deferred(), stopped = deferred(); let stops = 0, progress, results = 0, resumes = 0;
 const monitor = new AgentExecutionMonitor("workflow", {
  fetch: async query => execution("id" in query ? "cancelled" : "running"),
  resume: async () => { resumes++; return execution(); },
  observe: async (id, signal, notify) => { progress = notify; return response.promise; },
  stop: async () => { stops++; await stopped.promise; },
 });
 try {
  await monitor.refresh(); const observing = monitor.continueRun(() => results++);
  const stopping = monitor.stop(); await monitor.stop();
  assert.equal(stops, 1); assert.equal(resumes, 0); assert.equal(monitor.getSnapshot().action, "stopping");
  stopped.resolve(); await stopping; assert.equal(monitor.getSnapshot().run.status, "cancelled");
  progress(execution("success")); response.resolve({ draft: true }); await observing;
  assert.equal(results, 0); assert.equal(monitor.getSnapshot().run.status, "cancelled");
 } finally { monitor.dispose(); }
});
test("a stopped monitor cannot apply results after an account change", async () => {
 const response = deferred(); let applied = 0;
 const monitor = new AgentExecutionMonitor("workflow", { fetch: async () => execution("success"), observe: () => response.promise });
 await monitor.refresh(); const pending = monitor.continueRun(() => applied++);
 monitor.dispose(); response.resolve({ draft: true }); await pending; assert.equal(applied, 0);
});

test("workflow creation publishes the submitted ID for live progress before the request starts", async () => {
 calls = []; let startedID;
 const result = { draft: { name: "workflow" }, warnings: [], model: "test" };
 handler = (path, options) => { assert.equal(options.headers["X-Agent-Run-ID"], startedID); return result; };
 assert.deepEqual(await draftWorkflowWithAgent({ prompt: "create", scope: "private" }, { signal: new AbortController().signal, onStarted: id => { assert.equal(calls.length, 0); startedID = id; } }), result);
 assert.ok(startedID); assert.equal(calls.length, 1);
});
test("live progress queries the submitted ID while the run is being persisted", async () => {
 const queries = [];
 const monitor = new AgentExecutionMonitor({ id: "submitted" }, { fetch: async query => { queries.push(query); return null; } });
 try {
  await monitor.refresh(); assert.deepEqual(queries, [{ id: "submitted" }]); assert.equal(monitor.getSnapshot().run, null);
 } finally { monitor.dispose(); }
});
test("a superseded progress response cannot overwrite a newer snapshot", async () => {
 const first = deferred(); let count = 0;
 const monitor = new AgentExecutionMonitor("workflow", { fetch: async () => ++count === 1 ? first.promise : execution("success") });
 try {
  const old = monitor.refresh(); await monitor.refresh(); first.resolve(execution("error")); await old;
  assert.equal(monitor.getSnapshot().run.status, "success");
 } finally { monitor.dispose(); }
});
