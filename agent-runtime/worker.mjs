import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createExecutionGraph } from './graph.mjs';
import { migrateOpenAIState } from './migrate-state.mjs';
import { createInputFilter, estimateTokens, isContextLimitError, textual, visualWindow } from './memory.mjs';
import { GatewaySession, importProtocol, modelMessages, modelOutput, protocolMessages } from './history.mjs';

const lines = createInterface({ input: process.stdin });
const pending = new Map();
const modelMaxAttempts = 6;
let serial = 0;
let started = false;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const toolDigest = value => createHash('sha256').update(JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)).digest('hex');

function projectHistory(history, previous) {
  const through = previous?.through ?? 0;
  const tail = history.slice(through);
  // Existing projections may predate source tracking.
  const origins = previous?.origins ?? previous?.input.map(item => item.contextSnapshot ? [] : null) ?? [];
  return {
    through: history.length,
    input: [...(previous?.input || []), ...tail],
    origins: [...origins, ...tail.map((_, index) => through + index)],
    compactions: previous?.compactions || [],
  };
}

function modelContext({ through, input, origins, compactions }) {
  return { through, input, origins, ...(compactions.length ? { compactions } : {}) };
}
function fallbackRetryDelayMs(attempt) {
  const base = Math.min(10000, 500 * (2 ** attempt));
  return Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
}
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
  if (message.error) waiter.reject(Object.assign(new Error(message.error), { retryable: message.retryable === true, retryAfterMs: message.retryAfterMs, failureCode: message.failureCode })); else waiter.resolve(message.result);
});
lines.on('close', () => {
  for (const waiter of pending.values()) waiter.reject(new Error('Agent parent disconnected'));
  pending.clear();
  process.stdin.destroy();
});

async function execute(config) {
  let step = 0;
  let modelAttempt;
  let retryWaitMs = Number.isSafeInteger(config.retryWaitMs) && config.retryWaitMs >= 0 ? config.retryWaitMs : 0;
  const modelRPC = async (method, params) => {
    if (method !== 'model') return rpc(method, params);
    const promptCacheKey = 'agent-' + createHash('sha256').update(JSON.stringify([config.sessionId, params.summary === true ? 'summary' : 'turn'])).digest('hex').slice(0, 48);
    const requestId = randomUUID();
    for (let attempt = 0;; attempt++) {
      const diagnostic = { step, requestId, attempt: attempt + 1, maxAttempts: modelMaxAttempts, purpose: params.summary === true ? 'summary' : 'turn' };
      try {
        const result = await rpc(method, { ...params, attempt: diagnostic.attempt, promptCacheKey, diagnostic });
        if (result?.goalContinuationYielded) throw Object.assign(new Error('目标续跑已让出执行机会'), { goalContinuationYielded: true });
        if (!params.summary) modelAttempt = diagnostic;
        return result;
      } catch (error) {
        if (!error.retryable || diagnostic.attempt >= modelMaxAttempts) throw error;
        const upstreamDelay = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0;
        const delayMs = upstreamDelay || fallbackRetryDelayMs(attempt);
        if (retryWaitMs + delayMs > 30000) {
          const retryAt = new Date(Math.min(253402300799999, Date.now() + delayMs)).toISOString();
          throw Object.assign(new Error('等待时间超过本次自动重试预算，进度已保存，请稍后继续。'), {
            retryBudgetExceeded: true, retryAt, delayMs, retryWaitMs, diagnostic,
            rateLimited: upstreamDelay > 0 || error.failureCode === 'RATE_LIMIT', failureCode: error.failureCode,
          });
        }
        retryWaitMs += delayMs;
        await rpc('retry', { attempt: attempt + 1, diagnostic, delayMs: Math.ceil(delayMs), retryWaitMs, retryAt: new Date(Date.now() + delayMs).toISOString(), rateLimited: upstreamDelay > 0 || error.failureCode === 'RATE_LIMIT', failureCode: error.failureCode });
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  };
  const session = new GatewaySession(config.sessionId, rpc);
  let stored = await session.getItems() || [];
  if (config.compact) {
    const history = [...stored, ...(config.legacy ? importProtocol(config.legacy) : [])];
    const projection = config.modelContext;
    const context = projectHistory(history, projection);
    const origins = context.origins.filter((_, index) => context.input[index].type !== 'reasoning');
    const input = textual(context.input);
    const instructions = config.instructions || '';
    let before;
    let after;
    const compact = createInputFilter((method, params) => method === 'memory' ? undefined : modelRPC(method, params),
      config.contextWindowTokens, config.tools, usage => { before ??= usage; after = usage; });
    const filtered = input.some(item => item.role === 'user')
      ? await compact({ modelData: { ...context, input, origins, instructions, trigger: 'manual' }, force: true })
      : {};
    const changed = filtered.compacted && after.usedTokens < before.usedTokens;
    await rpc('compact_complete', {
      kind: changed ? filtered.compactionKind : 'unchanged',
      savedTokens: changed ? before.usedTokens - after.usedTokens : 0,
      ...(changed ? { modelContext: modelContext(filtered), ...(config.legacy ? { imported: history } : {}) } : {}),
    });
    return;
  }
  let run;
  let migrated = false;
  if (config.state) {
    run = JSON.parse(config.state);
    if (run.version !== 'langgraph-1') { run = migrateOpenAIState(run, stored, config); migrated = true; }
    if (run.status === 'waiting') run.status = 'running';
    delete run.repeatedRead;
    run.validationFailures = 0;
    delete run.validationError;
    if (config.rejectCallIds?.length && config.input?.length) run.additionalInput = config.input;
    if (config.modelContext?.through <= run.history.length && config.modelContext.through >= (run.modelContext?.through ?? 0)) {
      run.modelContext = config.modelContext;
    }
  } else {
    const legacy = config.legacy ? importProtocol(config.legacy, config.omittedCallIds) : [];
    const input = config.inputProtocol ? importProtocol(config.inputProtocol) : (config.input || []);
    run = { version: 'langgraph-1', history: [...stored, ...legacy, ...input], currentStart: stored.length + legacy.length, pending: [], turns: 0, maxTurns: config.maxTurns || 40, status: 'running' };
    if (config.modelContext?.through <= run.currentStart) {
      run.modelContext = { ...config.modelContext, input: visualWindow(config.modelContext.input, 0) };
    }
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
      step = state.turns + 1;
      modelAttempt = undefined;
      if (state.validationFailures >= 2) throw new Error(state.validationError);
      if (state.additionalInput?.length) {
        state = { ...state, history: [...state.history, ...state.additionalInput], additionalInput: [] };
        await checkpoint(state);
      }
      const latest = await rpc('context');
      for (const message of latest.steering || []) {
        if (state.history.some(item => item.steeringId === message.id)) continue;
        const [input] = importProtocol([{ role: 'user', content: message.content }]);
        state = { ...state, history: [...state.history, { ...input, steeringId: message.id }], currentStart: state.history.length, repeatedRead: undefined };
      }
      const budgetInstructions = [latest.instructions, correction].filter(Boolean).join('\n\n');
      let context = projectHistory(state.history, state.modelContext);
      let input = state.modelContext
        ? visualWindow(context.input, 8)
        : [...visualWindow(state.history.slice(0, state.currentStart), 0), ...visualWindow(state.history.slice(state.currentStart), 8)];
      if (config.conversation) {
        input = input.filter(item => ['user', 'assistant'].includes(item.role)).slice(-6).map(item => ({ ...item, content: typeof item.content === 'string' ? item.content.slice(0, 1200) : item.content.filter(part => ['input_text', 'output_text'].includes(part.type)).map(part => ({ ...part, text: part.text.slice(0, 1200) })) }));
      } else {
        // Keep snapshots in the private model projection so the entire preceding
        // request remains a prefix, even when a relay hoists system messages.
        if (latest.snapshot && input.findLast(item => item.contextSnapshot)?.content !== latest.snapshot) {
          input.push({ role: 'user', content: latest.snapshot, contextSnapshot: true });
          context.origins.push([]);
        }
        let filtered;
        try {
          filtered = await filter({ modelData: { ...context, input, instructions: budgetInstructions, trigger: 'pressure' } });
        } catch (error) {
          // Publish the failing input estimate while preserving the last valid projection.
          await checkpoint(state);
          throw error;
        }
        input = filtered.input;
        context = filtered;
        state = { ...state, modelContext: modelContext(filtered) };
        await checkpoint(state);
      }
      let messages = modelMessages(input, latest.instructions);
      const transient = correction;
      if (transient) messages.push({ role: 'user', content: transient });
      const tools = config.tools.map(({ function: item }) => ({ type: 'function', ...item }));
      let turn;
      let invalid = 0;
      let compactions = 0;
      for (;;) {
        try {
          turn = bootstrap || await modelRPC('model', { contextUsage, input, messages, tools, modelSettings: { parallelToolCalls: false, ...(config.tools.some(item => item.function.name === config.completionTool) ? { toolChoice: 'required' } : {}) } });
        } catch (error) {
          if (config.conversation || !isContextLimitError(error) || compactions >= 3) throw error;
          const filtered = await filter({ modelData: { ...context, input, instructions: budgetInstructions, trigger: 'overflow' }, force: true });
          if (!filtered.compacted || estimateTokens(filtered.input) >= estimateTokens(input)) throw error;
          input = filtered.input;
          context = filtered;
          state = { ...state, modelContext: modelContext(filtered) };
          await checkpoint(state);
          messages = modelMessages(input, latest.instructions);
          if (correction) messages.push({ role: 'user', content: correction });
          compactions++;
          continue;
        }
        bootstrap = undefined;
        const ids = new Set(state.history.filter(item => item.type === 'function_call').map(item => item.callId.trim()));
        const malformed = !Array.isArray(turn.tool_calls || []) || (turn.tool_calls || []).some(call => {
          if (typeof call?.id !== 'string' || !call.id.trim() || ids.has(call.id.trim()) || !call.function?.name) return true;
          ids.add(call.id.trim());
          try { const args = JSON.parse(call.function.arguments); return !args || typeof args !== 'object' || Array.isArray(args); } catch { return true; }
        });
        const batch = malformed ? { error: '工具调用格式无效或 ID 已使用，请提供有效 JSON 对象参数和新的调用 ID。' } : await rpc('prepare', { turn, diagnostic: modelAttempt });
        if (!batch.error && !batch.question && turn.tool_calls?.length > 1 && turn.tool_calls.some(call => call.function.name === config.completionTool)) {
          batch.error = '完成工具必须单独调用，请先处理其他操作。';
        }
        if (batch.error) {
          state = { ...state, validationFailures: (state.validationFailures || 0) + 1, validationError: batch.error };
          correction = `服务端校验反馈：${batch.error}。本批未执行任何工具，请纠正后继续。`;
          if (malformed || batch.errorCode === 'duplicate_call_id' || !turn.tool_calls?.length && config.completionTool) {
            if (invalid++) throw new Error(batch.error);
            messages.push({ role: 'user', content: correction });
            await rpc('retry', { attempt: 1, validation: true, diagnostic: modelAttempt });
            continue;
          }
        } else {
          correction = '';
          state = { ...state, validationFailures: 0, validationError: undefined };
        }
        return { calls: turn.tool_calls || [], output: turn.text_response, state: { ...state, history: [...state.history, ...modelOutput(turn)], batch, modelAttempt } };
      }
    },
    executeTool: async (call, state) => {
      let result, visuals, repeatedRead;
      if (state.batch?.error) result = { ok: false, code: state.batch.failedCallId === call.id ? state.batch.errorCode || 'invalid_tool_arguments' : 'dependency_failed', message: state.batch.error };
      else if (state.batch?.question && state.batch.question !== call.id) result = { ok: false, code: 'waiting_for_user', message: '本批未执行，等待用户回答' };
      else if ((config.rejectCallIds || []).includes(call.id)) result = { ok: false, code: 'rejected', message: '用户拒绝了此操作' };
      else if (!config.tools.some(item => item.function.name === call.function.name)) result = { ok: false, code: 'unknown_tool', message: '未知工具' };
      else {
        const name = call.function.name;
        const args = JSON.parse(call.function.arguments);
        ({ result, visuals } = await rpc('tool', { id: call.id, name, arguments: args, diagnostic: state.modelAttempt }));
        if (config.repeatReminderTools?.includes(name)) {
          const digest = toolDigest([name, args, result, visuals]);
          const count = state.repeatedRead?.digest === digest ? state.repeatedRead.count + 1 : 1;
          repeatedRead = { digest, count };
          if (count === 3 || count === 5 || count === 8) {
            result = { ...result, repeatedReadReminder: '该只读调用的参数与结果连续多次未变。请先核对已有结果，改查相关节点、等待已有任务推进，或说明当前阻塞。' };
          }
        } else if (config.repeatReminderIgnoreTools?.includes(name)) {
          repeatedRead = state.repeatedRead;
        }
      }
      const output = visuals?.length ? [{ type: 'text', text: JSON.stringify(result) }, ...visuals] : JSON.stringify(result);
      const item = { type: 'function_call_result', callId: call.id, name: call.function.name, status: 'completed', output };
      return { state: { history: [...state.history, item], repeatedRead }, done: call.function.name === config.completionTool && result?.ok === true, output: result?.text };
    },
  });
  let result;
  try {
    const turnsPerRound = config.maxTurns || 40;
    for (let round = 0;; round++) {
      result = (await graph.invoke({ run }, { recursionLimit: Math.max(100, turnsPerRound * 20) })).run;
      if (result.status !== 'exhausted' || round >= (config.goalContinuation ?? 0)) break;
      const { allowed } = await rpc('goal_continue', { round: round + 1 });
      if (!allowed) break;
      run = { ...result, status: 'running', maxTurns: result.turns + turnsPerRound };
    }
  } catch (error) {
    if (!error.goalContinuationYielded || result?.status !== 'exhausted') {
      if (!error.retryBudgetExceeded || !config.preserveRetryCheckpoint) throw error;
      await rpc('finish', {
        status: 'waiting', retryBudgetExceeded: true, text: error.message,
        retryAt: error.retryAt, delayMs: error.delayMs, retryWaitMs: error.retryWaitMs,
        diagnostic: error.diagnostic, rateLimited: error.rateLimited, failureCode: error.failureCode,
      });
      return;
    }
  }
  if (result.status === 'waiting') {
    await rpc('pause', { state: JSON.stringify(result), messages: protocolMessages(result.history), callIds: result.pending.filter(call => ['ask_user_question', 'delete_node'].includes(call.function.name)).map(call => call.id) });
  } else if (result.status === 'exhausted') {
    await rpc('finish', { status: 'waiting', text: '已保存当前进度，可以继续完成剩余步骤。', exhausted: true, messages: protocolMessages(result.history) });
  } else {
    await checkpoint(result);
    await rpc('finish', { status: 'success', text: result.output || '本轮处理完成。', state: JSON.stringify(result), messages: protocolMessages(result.history) });
  }
}
