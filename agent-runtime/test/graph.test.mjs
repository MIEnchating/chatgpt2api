import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionGraph } from '../graph.mjs';

test('graph checkpoints a pending approval and resumes without replaying earlier tools', async () => {
  let saved, modelCalls = 0;
  const writes = [];
  const graph = createExecutionGraph({
    model: async () => { modelCalls++; return { calls: [{ id: 'write' }, { id: 'question' }] }; },
    authorize: async (call, run) => call.id !== 'question' || run.approved,
    executeTool: async call => { writes.push(call.id); return { done: call.id === 'question', output: 'done' }; },
    checkpoint: async run => { saved = structuredClone(run); },
  });
  const first = await graph.invoke({ run: { turns: 0, maxTurns: 4 } });
  assert.equal(first.run.status, 'waiting');
  assert.deepEqual(writes, ['write']);
  assert.deepEqual(saved.pending, [{ id: 'question' }]);
  const resumed = await graph.invoke({ run: { ...saved, status: 'running', approved: true } });
  assert.equal(resumed.run.status, 'finished');
  assert.deepEqual(writes, ['write', 'question']);
  assert.equal(modelCalls, 1);
});

test('graph stops at its turn limit without declaring success', async () => {
  let calls = 0;
  const graph = createExecutionGraph({
    model: async () => ({ calls: [{ id: String(++calls) }] }),
    authorize: async () => true,
    executeTool: async () => ({}),
    checkpoint: async () => {},
  });
  const result = await graph.invoke({ run: { turns: 0, maxTurns: 2 } });
  assert.equal(result.run.status, 'exhausted');
  assert.equal(calls, 2);
});

test('failed checkpoint prevents a pending tool from executing', async () => {
  let writes = 0;
  const graph = createExecutionGraph({
    model: async () => assert.fail('must resume the pending tool'),
    authorize: async () => true,
    executeTool: async () => { writes++; return {}; },
    checkpoint: async () => { throw new Error('storage unavailable'); },
  });
  await assert.rejects(graph.invoke({ run: { turns: 1, maxTurns: 4, pending: [{ id: 'write' }] } }), /storage unavailable/);
  assert.equal(writes, 0);
});
