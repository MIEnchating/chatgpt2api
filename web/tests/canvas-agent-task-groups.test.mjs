import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { canvasAgentTaskGroups } from '../src/app/canvas/agent/canvas-agent-task-groups.ts';
import { canvasAgentTaskTimings } from '../src/app/canvas/agent/canvas-agent-timing.ts';

test('clarifications and resumed work keep one process and cumulative duration under the request', () => {
  const messages = [
    { id: 'u', role: 'user', text: 'make ad' },
    { id: 'a', role: 'assistant', text: 'which size?', elapsedMs: 10000, status: 'waiting' },
    { id: 'answer', role: 'user', text: '3:4', questionAnswerFor: 'q' },
    { id: 'b', role: 'assistant', text: 'done', elapsedMs: 20000, status: 'success' },
    { id: 'u2', role: 'user', text: 'next task' },
    { id: 'c', role: 'assistant', text: '', elapsedMs: 0, processingStartedAt: 100000, status: 'running' },
  ];
  const groups = canvasAgentTaskGroups(messages);
  assert.deepEqual(groups.map(g => [g.request.id, g.replies.map(m => m.id)]), [['u', ['a', 'b']], ['u2', ['c']]]);
  const timings = canvasAgentTaskTimings(messages);
  assert.equal(timings.get(groups[0].replies.at(-1).id).elapsedMs, 30000);
  assert.equal(timings.get(groups[1].replies.at(-1).id).elapsedMs, 0);
});

test('empty history, initial requests and assistant-only records retain their content', () => {
  assert.deepEqual(canvasAgentTaskGroups([]), []);
  assert.equal(canvasAgentTaskGroups([{ id: 'u', role: 'user', text: 'starting' }])[0].replies.length, 0);
  const groups = canvasAgentTaskGroups([{ id: 'a', role: 'assistant', text: 'restored' }]);
  assert.equal(groups[0].replies[0].text, 'restored');
});
