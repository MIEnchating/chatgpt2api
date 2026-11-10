import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const definition = (name) => ({ function: { name, description: name, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } });
function worker(config, handler, store = { items: [], transactions: new Map() }) {
  config.sessionId ||= 'test';
  config.completionTool ||= 'finish_task';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '';
    let contextCalls = 0;
    child.stderr.on('data', data => { error += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('SDK worker timed out')); }, 30000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', async line => {
      try {
        const message = JSON.parse(line);
        if (message.method === 'error') throw new Error(message.params.message);
        let result;
        if (message.method === 'session') {
          const params = message.params;
          if (params.action === 'get' && store.getError) { child.stdin.write(JSON.stringify({ id: message.id, error: store.getError }) + '\n'); return; }
          if (params.action === 'get') result = store.items;
          else if (params.action === 'append') store.items.push(...params.items);
          else if (params.action === 'transaction') {
            const previous = store.transactions.get(params.operationId);
            const body = JSON.stringify(params.transaction);
            if (previous) assert.equal(previous, body);
            else {
              if (params.transaction.type === 'append_items') store.items.push(...params.transaction.items);
              else {
                const { expectedSuffix, replacement } = params.transaction;
                assert.deepEqual(store.items.slice(store.items.length - expectedSuffix.length), expectedSuffix);
                store.items.splice(store.items.length - expectedSuffix.length, expectedSuffix.length, ...replacement);
              }
              store.transactions.set(params.operationId, body);
            }
          } else throw new Error(`unhandled session action ${params.action}`);
        } else if (message.method === 'context') result = { instructions: config.instructions || 'Use tools.', ...(config.contextSnapshots ? { snapshot: config.contextSnapshots[Math.min(contextCalls++, config.contextSnapshots.length - 1)] } : {}) };
        else result = await handler(message.method, message.params);
        child.stdin.write(JSON.stringify(result?.rpcError ? { id: message.id, error: result.rpcError, retryable: result.retryable } : { id: message.id, result }) + '\n');
      } catch (e) { child.kill(); reject(e); }
    });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); lines.close(); if (code) reject(new Error(error || `worker exit ${code}`)); else resolve(); });
    child.stdin.write(JSON.stringify(config) + '\n');
  });
}
test('completion mixed with another tool rejects the batch before executing either', async () => {
  let turns = 0;
  const executed = [];
  await worker({ tools: [definition('create_text_node'), definition('finish_task')], input: [{ role: 'user', content: 'Create a node.' }] }, async (method, params) => {
    if (method === 'model') {
      turns++;
      if (turns === 1) return { tool_calls: ['finish_task', 'create_text_node'].map((name, i) => ({ id: `mixed-${i}`, function: { name, arguments: '{"text":"done"}' } })) };
      if (turns === 2) {
        assert.match(JSON.stringify(params.input), /完成工具必须单独调用/);
        return { tool_calls: [{ id: 'create', function: { name: 'create_text_node', arguments: '{"text":"done"}' } }] };
      }
      return { tool_calls: [{ id: 'finish', function: { name: 'finish_task', arguments: '{"text":"done"}' } }] };
    }
    if (method === 'tool') { executed.push(params.id); return { result: { ok: true } }; }
    return { ok: true };
  });
  assert.deepEqual(executed, ['create', 'finish']);
});
test('LangGraph worker invokes tools and requests the next model turn', async () => {
  let turns = 0; const events = [];
  await worker({ instructions: 'Use the provided canvas tools.', input: [{ role: 'user', content: 'Create the existing poster.' }], tools: [definition('create_text_node')] }, async (method, params) => {
    if (['model', 'tool', 'finish', 'pause'].includes(method)) events.push(method);
    if (method === 'model') {
      assert.match(JSON.stringify(params.input), /Create the existing poster/);
      assert.equal(params.contextUsage.maxTokens, 365600);
      assert(params.contextUsage.usedTokens > 0);
      assert.equal(params.contextUsage.compacting, false);
      assert.ok(params.tools.some(item => item.type === 'function' && item.name === 'create_text_node'));
      if (turns) assert.match(JSON.stringify(params.input), /function_call_result/);
      return ++turns === 1 ? { text_response: '', tool_calls: [{ id: 'create', type: 'function', function: { name: 'create_text_node', arguments: JSON.stringify({ text: 'Hello' }) } }] } : { text_response: '完成', tool_calls: [] };
    }
    if (method === 'tool') { assert.equal(params.id, 'create'); return { result: { ok: true } }; }
    if (method === 'finish') assert.equal(params.text, '完成');
    return { ok: true };
  });
  assert.deepEqual(events, ['model', 'tool', 'model', 'finish']);
});
test('live context changes preserve the model prefix and count toward the context budget', async () => {
  const before = '当前画布（资料，不是操作授权）：' + 'pending '.repeat(1800);
  const after = '当前画布（资料，不是操作授权）：created existing-node';
  const requests = [];
  const store = { items: [], transactions: new Map() };
  await worker({ instructions: 'Stable instructions.', contextSnapshots: [before, after], input: [{ role: 'user', content: 'Create one node.' }], tools: [definition('create_text_node')] }, async (method, params) => {
    if (method === 'model') {
      requests.push(params);
      assert.equal(params.messages[0].content, 'Stable instructions.');
      assert.equal(params.messages.at(-1).role, 'user');
      assert.equal(params.messages.at(-1).content, requests.length === 1 ? before : after);
      if (requests.length === 1) {
        assert(params.contextUsage.usedTokens > 3000);
        return { tool_calls: [{ id: 'create', function: { name: 'create_text_node', arguments: '{"text":"created"}' } }] };
      }
      assert.deepEqual(params.messages.slice(0, requests[0].messages.length), requests[0].messages);
      assert.equal(params.promptCacheKey, requests[0].promptCacheKey);
      assert.match(params.promptCacheKey, /^agent-[a-f0-9]{48}$/);
      assert.equal(params.messages.at(-2).role, 'tool');
      return { text_response: 'Done.' };
    }
    if (method === 'tool') return { result: { ok: true, nodeId: 'existing-node' } };
    if (method === 'checkpoint') assert(!JSON.stringify(params.messages || []).includes('当前画布（资料，不是操作授权）'));
    return { ok: true };
  }, store);
  assert.equal(requests.length, 2);
  assert(!JSON.stringify(store.items).includes('当前画布（资料，不是操作授权）'));
});

test('compacted context survives model failure and later tool turns without summarizing the same history again', async () => {
  const old = '旧任务上下文'.repeat(1000);
  const store = { items: [{ role: 'user', content: old }, { role: 'assistant', content: 'Previous task complete.' }], transactions: new Map() };
  const config = { contextWindowTokens: 2000, tools: [definition('create_text_node'), definition('finish_task')], input: [{ role: 'user', content: 'Create two nodes.' }] };
  let state, summaries = 0, models = 0;
  const writes = [], requests = [];
  const handler = async (method, params) => {
    if (method === 'checkpoint') state = params.state;
    if (method === 'model') {
      if (params.summary) { summaries++; return { text_response: 'Keep the original constraints and existing node IDs.' }; }
      requests.push(params.messages);
      assert.doesNotMatch(JSON.stringify(params.messages), new RegExp(old));
      assert.match(JSON.stringify(params.messages), /original constraints/);
      if (++models === 2) return { rpcError: 'HTTP 400 model unavailable' };
      const name = models < 4 ? 'create_text_node' : 'finish_task';
      return { tool_calls: [{ id: `call-${models}`, function: { name, arguments: '{"text":"done"}' } }] };
    }
    if (method === 'tool') { writes.push(params.id); return { result: { ok: true } }; }
    return {};
  };
  await assert.rejects(worker(config, handler, store), /HTTP 400/);
  assert.ok(JSON.parse(state).modelContext);
  await worker({ ...config, input: [], state }, handler, store);
  assert.equal(summaries, 1);
  assert.deepEqual(writes, ['call-1', 'call-3', 'call-4']);
  for (const request of requests.slice(1)) assert.deepEqual(request.slice(0, requests[0].length), requests[0]);
  assert.equal(store.items[0].content, old, 'authoritative history must remain intact');
});
test('SDK approval state survives worker exit and resumes without repeating the question', async () => {
  let state = ''; let tools = 0;
  const config = { tools: [definition('ask_user_question')], input: [{ role: 'user', content: 'Ask me.' }] };
  const store = { items: [], transactions: new Map() };
  await worker(config, async (method, params) => {
    if (method === 'model') return { text_response: '', tool_calls: [{ id: 'question', function: { name: 'ask_user_question', arguments: JSON.stringify({ text: '什么比例？' }) } }] };
    if (method === 'tool') tools++;
    if (method === 'pause') { state = params.state; assert.deepEqual(params.callIds, ['question']); }
    return { ok: true };
  }, store);
  assert.equal(tools, 0); assert.ok(state);
  const events = [];
  await worker({ ...config, input: [], state, answerCallId: 'question' }, async (method, params) => {
    if (['model', 'tool', 'finish', 'pause'].includes(method)) events.push(method);
    if (method === 'tool') { tools++; assert.equal(params.id, 'question'); return { result: { ok: true, answer: '1:1' } }; }
    if (method === 'model') return { text_response: '已确认', tool_calls: [] };
    return { ok: true };
  }, store);
  assert.equal(tools, 1); assert.deepEqual(events, ['tool', 'model', 'finish']);
});

test('a completed checkpoint resumes final acknowledgement without rerunning model or tool', async () => {
  let state, executions = 0;
  const store = { items: [], transactions: new Map() };
  const config = { tools: [definition('finish_task')], input: [{ role: 'user', content: 'Finish.' }] };
  await assert.rejects(worker(config, async (method, params) => {
    if (method === 'model') return { tool_calls: [{ id: 'finish', function: { name: 'finish_task', arguments: '{"text":"done"}' } }] };
    if (method === 'tool') { executions++; return { result: { ok: true, text: 'done' } }; }
    if (method === 'checkpoint' && JSON.parse(params.state).status === 'finished') state = params.state;
    if (method === 'finish') return { rpcError: 'connection lost' };
    return {};
  }, store), /connection lost/);
  assert.ok(state);
  store.items.pop();
  store.transactions.clear();
  await worker({ ...config, input: [], state }, async (method, params) => {
    if (method === 'model' || method === 'tool') assert.fail('completed work must not be repeated');
    if (method === 'finish') { assert.equal(params.status, 'success'); assert.equal(params.text, 'done'); }
    return {};
  }, store);
  assert.equal(executions, 1);
  assert.equal(store.items.at(-1).callId, 'finish');
  assert.equal(store.items.at(-1).type, 'function_call_result');
});

test('an SDK checkpoint migrates once and retains real-user approval and committed tools', async () => {
  const user = { role: 'user', content: 'Continue the saved task.' };
  const completedCall = { type: 'function_call', callId: 'created', name: 'create_text_node', arguments: '{"text":"saved"}', status: 'completed' };
  const completedResult = { type: 'function_call_result', callId: 'created', name: 'create_text_node', output: '{"ok":true}', status: 'completed' };
  const question = { type: 'function_call', callId: 'approval', name: 'ask_user_question', arguments: '{"text":"Confirm?"}', status: 'completed' };
  const store = { items: [user, completedCall, completedResult], transactions: new Map() };
  const state = JSON.stringify({ $schemaVersion: '1.23', currentTurn: 2, maxTurns: 40, originalInput: [user], generatedItems: [
    { type: 'tool_call_item', rawItem: completedCall }, { type: 'tool_call_output_item', rawItem: completedResult },
    { type: 'tool_call_item', rawItem: question }, { type: 'tool_approval_item', rawItem: question },
  ] });
  const config = { state, tools: [definition('create_text_node'), definition('ask_user_question'), definition('finish_task')] };
  let saved;
  await worker(config, async (method, params) => {
    if (method === 'tool' || method === 'model') assert.fail('migration cannot approve or repeat work');
    if (method === 'checkpoint') assert.equal(JSON.parse(params.state).version, 'langgraph-1');
    if (method === 'pause') saved = params.state;
    return {};
  }, store);
  assert.ok(saved);
  let executed = [];
  await worker({ ...config, state: saved, answerCallId: 'approval' }, async (method, params) => {
    if (method === 'tool') { executed.push(params.id); return { result: { ok: true, text: 'done' } }; }
    if (method === 'model') return { tool_calls: [{ id: 'finish', function: { name: 'finish_task', arguments: '{"text":"done"}' } }] };
    return {};
  }, store);
  assert.deepEqual(executed, ['approval', 'finish']);
  assert.equal(store.items.filter(item => item.callId === 'created' && item.type === 'function_call').length, 1);
  assert.equal(store.items.filter(item => item.role === 'user').length, 1);
});

test('SDK turn limit pauses with a resumable finish instead of claiming completion', async () => {
  let turns = 0;
  let finished = false;
  const store = { items: [], transactions: new Map() };
  await worker({ tools: [definition('get_canvas_summary')] }, async (method, params) => {
    if (method === 'model') return { text_response: '', tool_calls: [{ id: `read-${++turns}`, function: { name: 'get_canvas_summary', arguments: JSON.stringify({ text: 'read' }) } }] };
    if (method === 'tool') return { result: { ok: true } };
    if (method === 'finish') { finished = true; assert.equal(params.status, 'waiting'); assert.match(params.text, /继续/); }
    return { ok: true };
  }, store);
  assert.equal(finished, true);
  assert.equal(turns, 40);
  assert.ok(store.items.some(item => item.type === 'function_call_result' && item.callId === 'read-40'), 'last completed tool result must survive the SDK turn limit');
});

test('continue does not approve a pending SDK question or call the model', async () => {
  const store = { items: [], transactions: new Map() };
  let state;
  const config = { tools: [definition('ask_user_question')], input: [{ role: 'user', content: 'Ask first.' }] };
  await worker(config, async (method, params) => {
    if (method === 'model') return { tool_calls: [{ id: 'approval', function: { name: 'ask_user_question', arguments: '{"text":"需要授权"}' } }] };
    if (method === 'pause') state = params.state;
    return {};
  }, store);
  await worker({ ...config, input: [], state }, async (method, params) => {
    assert.notEqual(method, 'model'); assert.notEqual(method, 'tool');
    if (method === 'pause') assert.deepEqual(params.callIds, ['approval']);
    return {};
  }, store);
});

test('independent SDK turns load one session without duplicating historical inputs', async () => {
  const store = { items: [], transactions: new Map() };
  for (const text of ['First request', 'Second request']) {
    await worker({ tools: [], input: [{ role: 'user', content: text }] }, async (method, params) => {
      if (method === 'model') {
        assert.match(JSON.stringify(params.input), /First request/);
        if (text === 'Second request') assert.match(JSON.stringify(params.input), /First reply/);
        return { text_response: text === 'First request' ? 'First reply' : 'Second reply' };
      }
      return {};
    }, store);
  }
  assert.deepEqual(store.items.filter(item => item.role === 'user').map(item => item.content), ['First request', 'Second request']);
});

test('a new request keeps its own image without resending previous request images', async () => {
  const store = { items: [], transactions: new Map() };
  for (const image of ['/old.png', '/new.png']) {
    await worker({ tools: [], input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect' }, { type: 'input_image', image }] }] }, async (method, params) => {
      if (method === 'model') {
        assert.match(JSON.stringify(params.messages), new RegExp(image));
        if (image === '/new.png') assert.doesNotMatch(JSON.stringify(params.messages), /old\.png/);
        return { text_response: 'Done.' };
      }
      return {};
    }, store);
  }
});

test('legacy pending question is imported and its actual answer resumes the same SDK call', async () => {
  const store = { items: [], transactions: new Map() };
  let executed = 0;
  const call = { id: 'legacy-question', function: { name: 'ask_user_question', arguments: '{"text":"什么比例？"}' } };
  await worker({ tools: [definition('ask_user_question')], legacy: [{ role: 'user', content: '制作已有任务' }], bootstrap: { tool_calls: [call] }, answerCallId: 'legacy-question' }, async (method, params) => {
    if (method === 'model') { assert.match(JSON.stringify(params.input), /用户真实答案/); return { text_response: '完成' }; }
    if (method === 'tool') { executed++; assert.equal(params.id, 'legacy-question'); return { result: { ok: true, answer: '用户真实答案' } }; }
    if (method === 'pause') assert.fail('actual answer should resume the imported question');
    return {};
  }, store);
  assert.equal(executed, 1);
});

test('SDK session initialization errors preserve the storage cause', async () => {
  await assert.rejects(worker({ tools: [], input: [{ role: 'user', content: 'Continue.' }] }, async (method) => {
    assert.notEqual(method, 'model');
    return {};
  }, { items: [], transactions: new Map(), getError: 'SDK storage unavailable' }), /SDK storage unavailable/);
});

test('a finish call in the same batch cannot bypass a pending question', async () => {
  let paused = false;
  await worker({ tools: [definition('ask_user_question'), definition('finish_task')], input: [{ role: 'user', content: 'Ask before continuing.' }] }, async (method, params) => {
    if (method === 'model') return { tool_calls: [{ id: 'pending-question', function: { name: 'ask_user_question', arguments: '{"text":"确认？"}' } }, { id: 'blocked-finish', function: { name: 'finish_task', arguments: '{"text":"完成"}' } }] };
    if (method === 'prepare') return { question: 'pending-question' };
    if (method === 'tool' || method === 'finish') assert.fail('pending question must pause the batch');
    if (method === 'pause') { paused = true; assert.deepEqual(params.callIds, ['pending-question']); }
    return {};
  });
  assert.equal(paused, true);
});

test('SDK retries a reset model stream without replaying completed business tools', async () => {
  let models = 0, writes = 0;
  await worker({ tools: [definition('create_text_node')], input: [{role:'user',content:'Create once.'}] }, async method => {
    if (method === 'model') {
      models++;
      if (models === 1) return { tool_calls: [{id:'create-once',function:{name:'create_text_node',arguments:'{"text":"saved"}'}}] };
      if (models === 2) return { rpcError: 'stream error: stream ID 127; INTERNAL_ERROR; received from peer', retryable: true };
      return {text_response:'完成'};
    }
    if (method === 'tool') { writes++; return {result:{ok:true}}; }
    return {ok:true};
  });
  assert.equal(models,3);
  assert.equal(writes,1);
});

test('SDK preserves checkpoint and does not retry a rejected model request', async () => {
  let calls = 0, checkpoint;
  await assert.rejects(worker({tools:[],input:[{role:'user',content:'Keep progress.'}]}, async (method,params) => {
    if (method === 'checkpoint') checkpoint = params.state;
    if (method === 'model') { calls++; return {rpcError:'HTTP 400 invalid parameter',retryable:false}; }
    return {ok:true};
  }), /HTTP 400/);
  assert.equal(calls,1);
  assert.ok(checkpoint);
});

test('SDK corrects malformed arguments without executing the rejected tool', async () => {
  let turns=0, writes=0;
  await worker({tools:[definition('finish_task')],input:[{role:'user',content:'Validate before finishing.'}]},async(method,params)=>{
    if(method==='model')return {tool_calls:[{id:++turns===1?'invalid':'valid',function:{name:'finish_task',arguments:turns===1?'{broken':'{"text":"done"}'}}]};
    if(method==='prepare')return turns===1?{error:'invalid JSON arguments',failedCallId:'invalid'}:{};
    if(method==='tool'){writes++;return {result:{ok:true,text:'done'}};}
    return {ok:true};
  });
  assert.equal(turns,2);assert.equal(writes,1);
});

test('invalid tool call IDs are corrected without adding invalid calls to history', async () => {
  for (const calls of [
    [{ id: '', function: { name: 'finish_task', arguments: '{"text":"done"}' } }],
    ['same', 'same'].map(id => ({ id, function: { name: 'finish_task', arguments: '{"text":"done"}' } })),
    [{ id: 'used', function: { name: 'finish_task', arguments: '{"text":"done"}' } }],
  ]) {
    let turns = 0, writes = 0;
    const store = { items: [], transactions: new Map() };
    await worker({ tools: [definition('finish_task')], input: [{ role: 'user', content: 'Finish.' }] }, async (method, params) => {
      if (method === 'model') {
        if (++turns === 1) return { tool_calls: calls };
        assert.equal(params.messages.some(message => message.tool_calls), false);
        return { tool_calls: [{ id: 'valid', function: { name: 'finish_task', arguments: '{"text":"done"}' } }] };
      }
      if (method === 'prepare') return turns === 1 ? { error: 'invalid call ID', errorCode: 'duplicate_call_id' } : {};
      if (method === 'tool') { writes++; assert.equal(params.id, 'valid'); return { result: { ok: true } }; }
      return { ok: true };
    }, store);
    assert.equal(writes, 1);
    assert.deepEqual(store.items.filter(item => item.type === 'function_call').map(item => item.callId), ['valid']);
  }
});

test('repeated business validation errors stop after two paired batches without executing tools', async () => {
  const store = { items: [], transactions: new Map() };
  let turns = 0, state;
  const config = { tools: [definition('create_text_node'), definition('finish_task')], input: [{ role: 'user', content: 'Create a node.' }] };
  await assert.rejects(worker(config, async (method, params) => {
    if (method === 'checkpoint') state = params.state;
    if (method === 'model') return { tool_calls: [{ id: `invalid-${++turns}`, function: { name: 'create_text_node', arguments: '{"text":"invalid"}' } }] };
    if (method === 'prepare') return { error: 'invalid business arguments' };
    if (method === 'tool') assert.fail('invalid batches must never execute');
    return {};
  }, store), /invalid business arguments/);
  assert.equal(turns, 2);
  assert.deepEqual(store.items.filter(item => item.type === 'function_call').map(item => item.callId), ['invalid-1', 'invalid-2']);
  assert.deepEqual(store.items.filter(item => item.type === 'function_call_result').map(item => item.callId), ['invalid-1', 'invalid-2']);
  await worker({ ...config, input: [], state }, async (method) => {
    if (method === 'model') return { tool_calls: [{ id: 'corrected', function: { name: 'finish_task', arguments: '{"text":"done"}' } }] };
    if (method === 'tool') return { result: { ok: true } };
    return {};
  }, store);
  assert.equal(store.items.filter(item => item.role === 'user').length, 1);
});

test('reusing an old tool ID is corrected before domain preparation or receipt lookup', async () => {
  const store = { items: [
    { type: 'function_call', callId: 'used', name: 'create_text_node', arguments: '{"text":"old"}', status: 'completed' },
    { type: 'function_call_result', callId: 'used', name: 'create_text_node', output: '{"ok":true}', status: 'completed' },
  ], transactions: new Map() };
  let turns = 0, prepared = 0, executed = [];
  await worker({ tools: [definition('create_text_node'), definition('finish_task')], input: [{ role: 'user', content: 'New task.' }] }, async (method, params) => {
    if (method === 'model') {
      if (++turns === 1) return { tool_calls: [{ id: 'used', function: { name: 'create_text_node', arguments: '{"text":"new"}' } }] };
      return { tool_calls: [{ id: 'fresh', function: { name: 'finish_task', arguments: '{"text":"done"}' } }] };
    }
    if (method === 'prepare') { prepared++; assert.equal(params.turn.tool_calls[0].id, 'fresh'); }
    if (method === 'tool') { executed.push(params.id); return { result: { ok: true } }; }
    return {};
  }, store);
  assert.equal(prepared, 1);
  assert.deepEqual(executed, ['fresh']);
  assert.equal(store.items.filter(item => item.type === 'function_call' && item.callId === 'used').length, 1);
});

test('a text-only reply cannot finish a tool-validated task and SDK retries the model',async()=>{
 let models=0, tools=0;
 await worker({tools:[definition('finish_task')],input:[{role:'user',content:'Finish only after validation.'}]},async(method,params)=>{
  if(method==='model'){
   models++;
   if(models===1)return {text_response:'I am done.'};
   assert.equal(params.messages[0].content,'Use tools.');
   assert.match(params.messages.at(-1).content,/服务端校验反馈/);
   return {tool_calls:[{id:'finish',function:{name:'finish_task',arguments:'{"text":"done"}'}}]};
  }
  if(method==='prepare')return models===1?{error:'must use a tool'}:{};
  if(method==='tool'){tools++;return {result:{ok:true,text:'done'}};}
  return {ok:true};
 });
 assert.equal(models,2);assert.equal(tools,1);
});

test('restored SDK state keeps the retry policy without replaying the original input',async()=>{
 const store={items:[],transactions:new Map()};let state,models=0,tools=0;
 const config={tools:[definition('finish_task')],contextSnapshots:['Original progress.'],input:[{role:'user',content:'Resume the saved task.'}]};
 await assert.rejects(worker(config,async(method,params)=>{
  if(method==='checkpoint')state=params.state;
  if(method==='model'){models++;return {rpcError:'HTTP 400 invalid parameter',retryable:false};}
  return {ok:true};
 },store),/400/);
 await worker({...config,input:[],state,contextSnapshots:['Latest progress after restart.']},async(method,params)=>{
  if(method==='model'){
   assert.equal(params.messages.at(-1).content,'Latest progress after restart.');
   assert.equal(params.messages.filter(item => item.content === 'Original progress.').length, 1);
   assert.equal(params.messages.filter(item => item.content === 'Resume the saved task.').length, 1);
   if(++models===2)return {rpcError:'stream error: stream ID 127; INTERNAL_ERROR; received from peer',retryable:true};
   return {tool_calls:[{id:'finish',function:{name:'finish_task',arguments:'{"text":"done"}'}}]};
  }
  if(method==='tool'){tools++;return {result:{ok:true,text:'done'}};}
  return {ok:true};
 },store);
 assert.equal(models,3);assert.equal(tools,1);
 assert.equal(store.items.filter(item=>item.role==='user').length,1);
});

test('an oversized live snapshot is rejected before the model without replacing saved input', async () => {
 const store={items:[],transactions:new Map()};let models=0;
 await assert.rejects(worker({contextWindowTokens:1000,contextSnapshots:['文'.repeat(1500)],tools:[],input:[{role:'user',content:'Keep my original request.'}]},async(method)=>{
  if(method==='model')models++;
  return {ok:true};
 },store),/本轮输入及必要指令超过上下文预算/);
 assert.equal(models,0);
 assert(!JSON.stringify(store.items).includes('文'.repeat(1500)));
});


test('LangGraph worker uses the configured context window for its actual compaction budget', async () => {
  for (const contextWindowTokens of [457000,128000]) {
    let called=false;
    await worker({contextWindowTokens,tools:[],input:[{role:'user',content:'文'.repeat(60000)}]},async(method,params)=>{
      if(method==='model'){
        called=true;
        assert.notEqual(params.summary,true);
        assert.equal(params.contextUsage.maxTokens,contextWindowTokens*.8);
        assert(params.contextUsage.usedTokens>56000);
        assert.equal(params.contextUsage.compacting,false);
        return{text_response:'已确认',tool_calls:[]};
      }
      return{ok:true};
    });
    assert(called);
  }
});


test('cache identity survives a worker restart and separates independent sessions and summary calls', async () => {
 const keys = [];
 for (const sessionId of ['owner-one/session-a', 'owner-one/session-a', 'owner-one/session-b', 'owner-two/session-a']) {
  await worker({sessionId, tools: [], input: [{role:'user',content:'Hello'}]}, async (method, params) => {
   if (method === 'model') { keys.push(params.promptCacheKey); return {text_response:'Hello'}; }
   return {};
  });
 }
 assert.equal(keys[0], keys[1]);
 assert.notEqual(keys[0], keys[2]);
 assert.notEqual(keys[0], keys[3]);
 assert.match(keys[0], /^agent-[a-f0-9]{48}$/);
 const summaryKeys = [];
 await worker({sessionId:'owner-one/session-a', contextWindowTokens:2000, tools:[], input:[{role:'user',content:'Current request'}]}, async(method,params)=>{
  if(method==='model'){summaryKeys.push([params.summary===true,params.promptCacheKey]);return{text_response:params.summary?'Previous constraints':'Done'};}
  return {};
 },{items:[{role:'user',content:'older context '.repeat(1300)},{role:'assistant',content:'Done'}],transactions:new Map()});
 assert.equal(summaryKeys.length,2);
 assert.equal(summaryKeys[0][0],true);
 assert.notEqual(summaryKeys[0][1],summaryKeys[1][1]);
 assert.equal(summaryKeys[1][1],keys[0]);
});

test('a rejected oversized input publishes its current counters instead of leaving stale context usage', async () => {
 const updates=[];
 await assert.rejects(worker({contextWindowTokens:1000,contextSnapshots:['文'.repeat(1500)],tools:[],input:[{role:'user',content:'Original request'}]},async(method,params)=>{
  if(method==='checkpoint'&&params.contextUsage)updates.push(params.contextUsage);
  if(method==='model')assert.fail('oversized input must not reach upstream');
  return {};
 }),/本轮输入及必要指令超过上下文预算/);
 assert(updates.length>0);
 assert(updates.at(-1).usedTokens>updates.at(-1).maxTokens);
});

test('SDK retries five times with identical input and cache identity before executing tools once', async () => {
  let calls = 0, writes = 0;
  const requests = [], retries = [];
  await worker({ tools: [definition('finish_task')], input: [{ role: 'user', content: 'Finish once.' }] }, async (method, params) => {
    if (method === 'model') {
      requests.push(params);
      if (++calls < 6) return { rpcError: 'upstream chat stream ended without a finish reason', retryable: true };
      return { tool_calls: [{ id: 'finish-once', function: { name: 'finish_task', arguments: '{"text":"done"}' } }] };
    }
    if (method === 'retry') retries.push(params.attempt);
    if (method === 'tool') { writes++; return { result: { ok: true, text: 'done' } }; }
    return {};
  });
  assert.equal(calls, 6);
  assert.equal(writes, 1);
  assert.deepEqual(retries, [1, 2, 3, 4, 5]);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.attempt, index + 1);
    assert.deepEqual(request.messages, requests[0].messages);
    assert.equal(request.promptCacheKey, requests[0].promptCacheKey);
  }
});

test('SDK stops after five stream retries without preparing or executing partial tools', async () => {
  let calls = 0, retries = 0, state;
  await assert.rejects(worker({ tools: [definition('create_text_node')], input: [{ role: 'user', content: 'Create once.' }] }, async (method, params) => {
    if (method === 'checkpoint') state = params.state;
    if (method === 'model') { calls++; return { rpcError: 'stream interrupted', retryable: true }; }
    if (method === 'retry') retries++;
    if (method === 'prepare' || method === 'tool') assert.fail('failed model turns must not execute');
    return {};
  }), /stream interrupted/);
  assert.equal(calls, 6);
  assert.equal(retries, 5);
  assert.ok(state);
});

test('SDK retries a failed summary stream and preserves authoritative history', async () => {
  const old = '旧任务上下文'.repeat(1000);
  const store = { items: [{ role: 'user', content: old }, { role: 'assistant', content: 'Previous task complete.' }], transactions: new Map() };
  let summaries = 0, turns = 0, retries = 0;
  await worker({ contextWindowTokens: 2000, tools: [], input: [{ role: 'user', content: 'Continue.' }] }, async (method, params) => {
    if (method === 'model') {
      if (params.summary) {
        if (++summaries === 1) return { rpcError: 'summary stream interrupted', retryable: true };
        return { text_response: 'Keep the original constraints.' };
      }
      turns++;
      assert.match(JSON.stringify(params.messages), /original constraints/);
      return { text_response: 'Done.' };
    }
    if (method === 'retry') retries++;
    return {};
  }, store);
  assert.equal(summaries, 2);
  assert.equal(turns, 1);
  assert.equal(retries, 1);
  assert.equal(store.items[0].content, old);
});
