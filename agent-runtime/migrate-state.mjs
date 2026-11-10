import { isDeepStrictEqual } from 'node:util';

// One-time data conversion for the previously pinned @openai/agents 0.21.0.
// Execution and approval decisions always belong to the current runtime.
export function migrateOpenAIState(source, stored, config) {
  if (source.$schemaVersion !== '1.23' || !Array.isArray(source.generatedItems) ||
      !(typeof source.originalInput === 'string' || Array.isArray(source.originalInput)) ||
      !Number.isSafeInteger(source.currentTurn) || source.currentTurn < 0) {
    throw new Error('旧 Agent 检查点格式无法核对，原任务数据已保留');
  }
  if (source.pendingSessionHistoryTransaction || source.pendingSessionWrite || source.pendingInput?.length) {
    throw new Error('旧 Agent 检查点包含未确认的历史事务或输入，原任务数据已保留，请先在升级前完成该任务');
  }
  const input = typeof source.originalInput === 'string' ? [{ role: 'user', content: source.originalInput }] : source.originalInput;
  const generated = source.generatedItems.filter(item => item.type !== 'tool_approval_item').map(item => {
    if (!['input_item', 'message_output_item', 'tool_call_item', 'tool_call_output_item', 'reasoning_item'].includes(item.type) || !item.rawItem) {
      throw new Error('旧 Agent 检查点包含无法迁移的记录，原任务数据已保留');
    }
    return item.rawItem;
  });
  // Session persistence strips transient provider IDs and null statuses.
  const comparable = item => {
    const { id, status, ...rest } = item;
    return { ...rest, ...(!['function_call', 'function_call_result'].includes(item.type) && id !== undefined ? { id } : {}), ...(status != null ? { status } : {}) };
  };
  let history = structuredClone([...input, ...generated]);
  let checkpointIndex = 0;
  let hasCommittedUserInput = false;
  for (const item of stored) {
    if (checkpointIndex < history.length && isDeepStrictEqual(comparable(item), comparable(history[checkpointIndex]))) {
      checkpointIndex++;
      continue;
    }
    if (!isCommittedUserInput(item)) throw new Error('旧 Agent 检查点与已保存历史不一致，原任务数据已保留');
    hasCommittedUserInput = true;
  }
  if (hasCommittedUserInput && checkpointIndex !== history.length) throw new Error('旧 Agent 检查点与已保存历史不一致，原任务数据已保留');
  // A user input can be committed to Session before its matching runtime checkpoint.
  // Keep the exact durable order so resuming cannot lose or reorder the user's turn.
  if (hasCommittedUserInput) history = structuredClone(stored);
  else history.splice(0, stored.length, ...stored);
  const calls = new Map();
  for (const item of history) {
    if (item.type === 'function_call') {
      if (!item.callId || calls.has(item.callId) || !item.name || typeof item.arguments !== 'string') throw new Error('旧 Agent 工具调用无法核对，原任务数据已保留');
      const args = JSON.parse(item.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('旧 Agent 工具参数无效，原任务数据已保留');
      calls.set(item.callId, { call: item, completed: false });
    } else if (item.type === 'function_call_result') {
      const entry = calls.get(item.callId);
      if (!entry || entry.completed || item.name !== entry.call.name) throw new Error('旧 Agent 工具结果无法核对，原任务数据已保留');
      entry.completed = true;
    }
  }
  const pending = [...calls.values()].filter(entry => !entry.completed).map(({ call }) => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: call.arguments } }));
  let completion;
  for (const item of history) {
    if (item.type !== 'function_call_result' || item.name !== config.completionTool) continue;
    const output = typeof item.output === 'string' ? item.output : item.output?.type === 'text' ? item.output.text : undefined;
    try { const result = JSON.parse(output); if (result?.ok === true) completion = result; } catch { /* Unrecognized results cannot establish completion. */ }
  }
  const finished = !pending.length && source.currentStep?.type === 'next_step_final_output' && (completion || config.conversation);
  return {
    version: 'langgraph-1', history,
    currentStart: Math.max(0, history.findLastIndex(item => item.role === 'user')),
    pending, batch: { question: pending.find(call => ['ask_user_question', 'delete_node'].includes(call.function.name))?.id },
    turns: source.currentTurn, maxTurns: config.maxTurns || source.maxTurns || 40,
    status: finished ? 'finished' : 'running', ...(finished ? { output: completion?.text || source.currentStep.output } : {}),
  };
}

function isCommittedUserInput(item) {
  if (!item || item.role !== 'user') return false;
  if (typeof item.content === 'string') return true;
  if (!Array.isArray(item.content) || item.content.length === 0) return false;
  return item.content.every(part => part && typeof part === 'object' && (
    part.type === 'input_text' && typeof part.text === 'string' ||
    part.type === 'input_image' && typeof part.image === 'string'
  ));
}
