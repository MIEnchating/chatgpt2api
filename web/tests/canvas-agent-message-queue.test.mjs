import assert from "node:assert/strict";
import test from "node:test";
import { canvasAgentComposerAction, canvasAgentCanResume, canvasAgentNextQueuedMessage, canvasAgentConsumeQueuedMessage } from "../src/app/canvas/agent/canvas-agent-message-queue.ts";
import { isCanvasAgentSession, syncCanvasAgentSessions } from "../src/app/canvas/agent/canvas-agent-sessions.ts";
const queued = id => ({ id, text: `message ${id}`, references: [], createdAt: "now" });
const session = status => ({ id:"s",title:"test",createdAt:"now",updatedAt:"now",messages:[{id:"a",role:"assistant",text:"reply",status}],protocolMessages:[],agentState:{phase:"intake",approvedNodeIds:[],referenceNodeIds:[],pendingTaskIds:[],completedTaskIds:[]},messageQueue:{paused:false,messages:[queued("1"),queued("2")]}});

test("composer prioritizes a new draft over resume and allows enqueueing during a run", () => {
  for(const resumable of [true,false]) {
    assert.equal(canvasAgentComposerAction({busy:false,hasDraft:true,resumable,queued:true}),"send");
    assert.equal(canvasAgentComposerAction({busy:true,hasDraft:true,resumable,queued:false}),"enqueue");
    assert.equal(canvasAgentComposerAction({busy:true,hasDraft:false,resumable,queued:true}),"pause");
  }
  assert.equal(canvasAgentComposerAction({busy:false,hasDraft:false,resumable:true,queued:false}),"resume");
  assert.equal(canvasAgentComposerAction({busy:false,hasDraft:false,resumable:false,queued:false}),"send");
  assert.equal(canvasAgentComposerAction({busy:false,hasDraft:false,resumable:false,queued:true,waitingForAnswer:true}),"send");
  assert.equal(canvasAgentComposerAction({busy:false,hasDraft:true,resumable:false,queued:true,waitingForAnswer:true}),"send");
});

test("only the active conversation's interrupted or failed run can resume", () => {
  for (const status of ["error", "waiting", "cancelled", "interrupted"]) assert.equal(canvasAgentCanResume(session("waiting"), { sessionId: "s", assistantId: "a", status }), true);
  assert.equal(canvasAgentCanResume(session("success"),{sessionId:"other",assistantId:"a",status:"error"}),false);
  assert.equal(canvasAgentCanResume(session("success"),{sessionId:"s",assistantId:"old",status:"error"}),false);
  const question=session("waiting");question.agentState.pendingQuestion={id:"question"};assert.equal(canvasAgentCanResume(question),false);
});

test("FIFO waits after failure, pause and pending questions; steering selects a fresh next turn", () => {
  const done=session("success");assert.equal(canvasAgentNextQueuedMessage(done).id,"1");
  for(const status of ["running","error","waiting"])assert.equal(canvasAgentNextQueuedMessage(session(status)),undefined);
  done.messageQueue.paused=true;assert.equal(canvasAgentNextQueuedMessage(done),undefined);
  const steer=session("waiting");steer.messageQueue.steeringId="2";steer.messageQueue.messages.reverse();assert.equal(canvasAgentNextQueuedMessage(steer).id,"2");
  steer.agentState.pendingQuestion={id:"question"};assert.equal(canvasAgentNextQueuedMessage(steer),undefined);
});

test("queue consumption removes exactly the committed message and persists through reload", () => {
  const value=session("success");value.messageQueue.steeringId="1";
  assert.equal(isCanvasAgentSession(value),true);
  value.messageQueue=canvasAgentConsumeQueuedMessage(value.messageQueue,"1");
  assert.deepEqual(value.messageQueue.messages.map(item=>item.id),["2"]);
  assert.equal(value.messageQueue.steeringId,undefined);
  assert.deepEqual(syncCanvasAgentSessions([JSON.parse(JSON.stringify(value))],[],true)[0].messageQueue,JSON.parse(JSON.stringify(value.messageQueue)));
  value.messageQueue.messages.push({...queued("2")});assert.equal(isCanvasAgentSession(value),false);
});

test("queued turns wait for the current server execution to succeed", () => {
  for (const status of ["running", "waiting", "interrupted", "cancelled", "error"]) {
    assert.equal(canvasAgentNextQueuedMessage(session("success"), { sessionId: "s", assistantId: "a", status }), undefined);
  }
  assert.equal(canvasAgentNextQueuedMessage(session("waiting"), { sessionId: "s", assistantId: "a", status: "success" }).id, "1");
  assert.equal(canvasAgentNextQueuedMessage(session("success"), { sessionId: "other", assistantId: "a", status: "error" }).id, "1");
});
