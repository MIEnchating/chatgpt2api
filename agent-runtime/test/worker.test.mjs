import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const definition = (name) => ({ function: { name, description: name, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } });
function worker(config, handler) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', data => { error += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('SDK worker timed out')); }, 15000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', async line => {
      try {
        const message = JSON.parse(line);
        if (message.method === 'error') throw new Error(message.params.message);
        const result = await handler(message.method, message.params);
        child.stdin.write(JSON.stringify({ id: message.id, result }) + '\n');
      } catch (e) { child.kill(); reject(e); }
    });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); lines.close(); if (code) reject(new Error(error || `worker exit ${code}`)); else resolve(); });
    child.stdin.write(JSON.stringify(config) + '\n');
  });
}
test('SDK Runner invokes tools and requests the next model turn', async () => {
  let turns = 0; const events = [];
  await worker({ tools: [definition('create_text_node')] }, async (method, params) => {
    events.push(method);
    if (method === 'model') return ++turns === 1 ? { text: '', calls: [{ id: 'create', name: 'create_text_node', arguments: { text: 'Hello' } }] } : { text: '完成', calls: [] };
    if (method === 'tool') { assert.equal(params.id, 'create'); return { ok: true }; }
    if (method === 'finish') assert.equal(params.text, '完成');
    return { ok: true };
  });
  assert.deepEqual(events, ['model', 'tool', 'model', 'finish']);
});
test('SDK approval state survives worker exit and resumes without repeating the question', async () => {
  let state = ''; let tools = 0;
  const config = { tools: [definition('ask_user_question')] };
  await worker(config, async (method, params) => {
    if (method === 'model') return { text: '', calls: [{ id: 'question', name: 'ask_user_question', arguments: { text: '什么比例？' } }] };
    if (method === 'tool') tools++;
    if (method === 'pause') { state = params.state; assert.deepEqual(params.callIds, ['question']); }
    return { ok: true };
  });
  assert.equal(tools, 0); assert.ok(state);
  const events = [];
  await worker({ ...config, state }, async (method, params) => {
    events.push(method);
    if (method === 'tool') { tools++; assert.equal(params.id, 'question'); return { ok: true, answer: '1:1' }; }
    if (method === 'model') return { text: '已确认', calls: [] };
    return { ok: true };
  });
  assert.equal(tools, 1); assert.deepEqual(events, ['tool', 'model', 'finish']);
});
