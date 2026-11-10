import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createExecutionGraph } from './graph.mjs';
import { migrateOpenAIState } from './migrate-state.mjs';
import { createInputFilter, visualWindow } from './memory.mjs';
import { GatewaySession, importProtocol, modelMessages, modelOutput, protocolMessages } from './history.mjs';

const lines = createInterface({ input: process.stdin });
const pending = new Map();
let serial = 0;
let started = false;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
function rpc(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }); });
}
lines.on('line', line => {
  const message = JSON.parse(line);
  if (!started) {
    started = true;
    void execute(message).then(() => lines.close()).catch(error => {
      send({ method: 'error', params: { message: error.message } });
      process.exitCode = 1;
      lines.close();
    });
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(Object.assign(new Error(message.error), { retryable: message.retryable === true })); else waiter.resolve(message.result);
});
lines.on('close', () => {
  for (const waiter of pending.values()) waiter.reject(new Error('Agent parent disconnected'));
  pending.clear();
  process.stdin.destroy();
});

async function execute(config) {
  const modelRPC = async (method, params) => {
    if (method !== 'model') return rpc(method, params);
    const promptCacheKey = 'agent-' + createHash('sha256').update(JSON.stringify([config.sessionId, params.summary === true ? 'summary' : 'turn'])).digest('hex').slice(0, 48);
    for (let attempt = 0;; attempt++) {
      try {
        return await rpc(method, { ...params, attempt: attempt + 1, promptCacheKey });
      } catch (error) {
        if (!error.retryable || attempt >= 5) throw error;
        await rpc('retry', { attempt: attempt + 1 });
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }
  };
  const session = new GatewaySession(config.sessionId, rpc);
  let stored = await session.getItems() || [];
  let run;
  let migrated = false;
  if (config.state) {
    run = JSON.parse(config.state);
    if (run.version !== 'langgraph-1') { run = migrateOpenAIState(run, stored, config); migrated = true; }
    if (run.status === 'waiting') run.status = 'running';
    run.validationFailures = 0;
    delete run.validationError;
    if (config.rejectCallIds?.length && config.input?.length) run.additionalInput = config.input;
  } else {
    const legacy = config.legacy ? importProtocol(config.legacy, config.omittedCallIds) : [];
    const input = config.inputProtocol ? importProtocol(config.inputProtocol) : (config.input || []);
    run = { version: 'langgraph-1', history: [...stored, ...legacy, ...input], currentStart: stored.length + legacy.length, pending: [], turns: 0, maxTurns: config.maxTurns || 40, status: 'running' };
  }
  let contextUsage;
  let bootstrap = config.bootstrap;
  if (!config.state && bootstrap?.tool_calls?.length) {
    const calls = bootstrap.tool_calls;
    const pendingCalls = calls.filter(call => stored.some(item => item.type === 'function_call' && item.callId === call.id) && !stored.some(item => item.type === 'function_call_result' && item.callId === call.id));
    if (pendingCalls.length === calls.length) {
      run.pending = pendingCalls;
      run.batch = { question: pendingCalls.find(call => ['ask_user_question', 'delete_node'].includes(call.function.name))?.id };
      bootstrap = undefined;
    }
  }
  let correction = '';
  const filter = createInputFilter(modelRPC, config.contextWindowTokens, config.tools, usage => { contextUsage = usage; });
  const checkpoint = async state => {
    if (!isDeepStrictEqual(state.history.slice(0, stored.length), stored)) throw new Error('Agent 历史与检查点不一致，已保留原始记录');
    await rpc('checkpoint', { state: JSON.stringify(state), committedCallIds: state.history.filter(item => item.type === 'function_call_result').map(item => item.callId), messages: protocolMessages(state.history), ...(contextUsage ? { contextUsage } : {}) });
    const items = state.history.slice(stored.length);
    if (!items.length) return;
    const operationId = createHash('sha256').update(JSON.stringify([stored.length, items])).digest('hex');
    await session.applyHistoryTransaction({ operationId, transaction: { type: 'append_items', items } });
    stored = [...stored, ...items];
  };
  if (migrated) await checkpoint(run);
  const graph = createExecutionGraph({
    checkpoint,
    authorize: async (call, state) => {
      if (state.batch?.error || state.batch?.question && state.batch.question !== call.id) return true;
      return !['ask_user_question', 'delete_node'].includes(call.function.name) || config.answerCallId === call.id || (config.rejectCallIds || []).includes(call.id);
    },
    model: async state => {
      if (state.validationFailures >= 2) throw new Error(state.validationError);
      if (state.additionalInput?.length) {
        state = { ...state, history: [...state.history, ...state.additionalInput], additionalInput: [] };
        await checkpoint(state);
      }
      const latest = await rpc('context');
      let input = state.modelContext
        ? visualWindow([...state.modelContext.input, ...state.history.slice(state.modelContext.through)], 8)
        : [...visualWindow(state.history.slice(0, state.currentStart), 0), ...visualWindow(state.history.slice(state.currentStart), 8)];
      if (config.conversation) {
        input = input.filter(item => ['user', 'assistant'].includes(item.role)).slice(-6).map(item => ({ ...item, content: typeof item.content === 'string' ? item.content.slice(0, 1200) : item.content.filter(part => ['input_text', 'output_text'].includes(part.type)).map(part => ({ ...part, text: part.text.slice(0, 1200) })) }));
      } else {
        // Keep snapshots in the private model projection so the entire preceding
        // request remains a prefix, even when a relay hoists system messages.
        if (latest.snapshot && input.findLast(item => item.contextSnapshot)?.content !== latest.snapshot) {
          input.push({ role: 'user', content: latest.snapshot, contextSnapshot: true });
        }
        const budgetInstructions = [latest.instructions, correction].filter(Boolean).join('\n\n');
        let filtered;
        try {
          filtered = await filter({ modelData: { input, instructions: budgetInstructions } });
        } catch (error) {
          // Publish the failing input estimate while preserving the last valid projection.
          await checkpoint(state);
          throw error;
        }
        input = filtered.input;
        state = { ...state, modelContext: { through: state.history.length, input } };
        await checkpoint(state);
      }
      const messages = modelMessages(input, latest.instructions);
      const transient = correction;
      if (transient) messages.push({ role: 'user', content: transient });
      const tools = config.tools.map(({ function: item }) => ({ type: 'function', ...item }));
      let turn;
      let invalid = 0;
      for (;;) {
        turn = bootstrap || await modelRPC('model', { contextUsage, input, messages, tools, modelSettings: { parallelToolCalls: false, ...(config.tools.some(item => item.function.name === config.completionTool) ? { toolChoice: 'required' } : {}) } });
        bootstrap = undefined;
        const ids = new Set(state.history.filter(item => item.type === 'function_call').map(item => item.callId.trim()));
        const malformed = !Array.isArray(turn.tool_calls || []) || (turn.tool_calls || []).some(call => {
          if (typeof call?.id !== 'string' || !call.id.trim() || ids.has(call.id.trim()) || !call.function?.name) return true;
          ids.add(call.id.trim());
          try { const args = JSON.parse(call.function.arguments); return !args || typeof args !== 'object' || Array.isArray(args); } catch { return true; }
        });
        const batch = malformed ? { error: '工具调用格式无效或 ID 已使用，请提供有效 JSON 对象参数和新的调用 ID。' } : await rpc('prepare', { turn });
        if (!batch.error && !batch.question && turn.tool_calls?.length > 1 && turn.tool_calls.some(call => call.function.name === config.completionTool)) {
          batch.error = '完成工具必须单独调用，请先处理其他操作。';
        }
        if (batch.error) {
          state = { ...state, validationFailures: (state.validationFailures || 0) + 1, validationError: batch.error };
          correction = `服务端校验反馈：${batch.error}。本批未执行任何工具，请纠正后继续。`;
          if (malformed || batch.errorCode === 'duplicate_call_id' || !turn.tool_calls?.length && config.completionTool) {
            if (invalid++) throw new Error(batch.error);
            messages.push({ role: 'user', content: correction });
            await rpc('retry', { attempt: 1, validation: true });
            continue;
          }
        } else {
          correction = '';
          state = { ...state, validationFailures: 0, validationError: undefined };
        }
        return { calls: turn.tool_calls || [], output: turn.text_response, state: { ...state, history: [...state.history, ...modelOutput(turn)], batch } };
      }
    },
    executeTool: async (call, state) => {
      let result, visuals;
      if (state.batch?.error) result = { ok: false, code: state.batch.failedCallId === call.id ? state.batch.errorCode || 'invalid_tool_arguments' : 'dependency_failed', message: state.batch.error };
      else if (state.batch?.question && state.batch.question !== call.id) result = { ok: false, code: 'waiting_for_user', message: '本批未执行，等待用户回答' };
      else if ((config.rejectCallIds || []).includes(call.id)) result = { ok: false, code: 'rejected', message: '用户拒绝了此操作' };
      else if (!config.tools.some(item => item.function.name === call.function.name)) result = { ok: false, code: 'unknown_tool', message: '未知工具' };
      else ({ result, visuals } = await rpc('tool', { id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) }));
      const output = visuals?.length ? [{ type: 'text', text: JSON.stringify(result) }, ...visuals] : JSON.stringify(result);
      const item = { type: 'function_call_result', callId: call.id, name: call.function.name, status: 'completed', output };
      return { state: { history: [...state.history, item] }, done: call.function.name === config.completionTool && result?.ok === true, output: result?.text };
    },
  });
  const result = (await graph.invoke({ run }, { recursionLimit: Math.max(100, (run.maxTurns || 40) * 20) })).run;
  if (result.status === 'waiting') {
    await rpc('pause', { state: JSON.stringify(result), messages: protocolMessages(result.history), callIds: result.pending.filter(call => ['ask_user_question', 'delete_node'].includes(call.function.name)).map(call => call.id) });
  } else if (result.status === 'exhausted') {
    await rpc('finish', { status: 'waiting', text: '已保存当前进度，可以继续完成剩余步骤。', exhausted: true, messages: protocolMessages(result.history) });
  } else {
    await checkpoint(result);
    await rpc('finish', { status: 'success', text: result.output || '本轮处理完成。', state: JSON.stringify(result), messages: protocolMessages(result.history) });
  }
}
