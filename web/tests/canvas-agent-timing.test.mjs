import assert from "node:assert/strict";
import { test } from "bun:test";
import { canvasAgentElapsedMs, setCanvasAgentProcessing, formatCanvasAgentElapsed } from "../src/app/canvas/agent/canvas-agent-timing.ts";
import { syncCanvasAgentSessions } from "../src/app/canvas/agent/canvas-agent-sessions.ts";

test("processing time survives serialization, excludes user waiting, and stops permanently", () => {
  let message = setCanvasAgentProcessing({}, true, 1000);
  assert.equal(canvasAgentElapsedMs(message, 76000), 75000);
  message = JSON.parse(JSON.stringify(message));
  message = setCanvasAgentProcessing(message, false, 76000);
  assert.equal(canvasAgentElapsedMs(message, 1000000), 75000);
  message = setCanvasAgentProcessing(message, true, 1000000);
  message = setCanvasAgentProcessing(message, true, 1001000);
  assert.equal(canvasAgentElapsedMs(message, 1005000), 80000);
  message = setCanvasAgentProcessing(message, false, 1005000);
  assert.equal(canvasAgentElapsedMs(setCanvasAgentProcessing(message, false, 2000000)), 80000);
});
test("duration formatting always shows minutes and seconds, including totals over an hour", () => {
  for (const [ms, expected] of [[0,"0分 0秒"], [59999,"0分 59秒"], [60000,"1分 0秒"], [75000,"1分 15秒"], [2967000,"49分 27秒"], [3600000,"60分 0秒"], [7206000,"120分 6秒"]]) assert.equal(formatCanvasAgentElapsed(ms),expected);
  assert.equal(canvasAgentElapsedMs({ elapsedMs: 500, processingStartedAt: 2000 },1000),500);
});
test("disconnected Codex timing freezes at its saved checkpoint rather than including offline time", () => {
  const session = { id:"s",engine:"codex",updatedAt:new Date(76000).toISOString(),messages:[{id:"a",role:"assistant",text:"",status:"success",elapsedMs:1000,processingStartedAt:1000}] };
  const [restored] = syncCanvasAgentSessions([session],[],true);
  assert.equal(restored.messages[0].processingStartedAt,undefined);
  assert.equal(restored.messages[0].elapsedMs,76000);
  assert.equal(restored.messages[0].status,"waiting");
  assert.equal(restored.resumeAssistantMessageId,"a");
  assert.equal(syncCanvasAgentSessions([session],[],false)[0].messages[0].processingStartedAt,1000);
});

test("one task timer sums clarification rounds without counting user waiting or other tasks", async () => {
 const {canvasAgentTaskTimings}=await import('../src/app/canvas/agent/canvas-agent-timing.ts');
 const timings=canvasAgentTaskTimings([{id:'u',role:'user',text:'task'},{id:'a',role:'assistant',text:'question',elapsedMs:75000},{id:'answer',role:'user',text:'yes',questionAnswerFor:'q'},{id:'b',role:'assistant',text:'',elapsedMs:10000,processingStartedAt:1000000}]);
 assert.equal(timings.has('a'),false);assert.equal(canvasAgentElapsedMs(timings.get('b'),1005000),90000);
 const separate=canvasAgentTaskTimings([{id:'a',role:'assistant',text:'done',elapsedMs:75000},{id:'u2',role:'user',text:'new task'},{id:'b',role:'assistant',text:'done',elapsedMs:5000}]);
 assert.equal(separate.get('a').elapsedMs,75000);assert.equal(separate.get('b').elapsedMs,5000);
});
