// These conversions adapt SDK items to the application's existing model gateway.
// The Runner and its Session remain the owners of conversation history.
const text = (value) => typeof value === 'string' ? value : '';

export function importProtocol(messages, omittedCallIDs = []) {
  const omitted = new Set(omittedCallIDs);
  const items = [];
  const pending = new Map();
  const closeRound = () => {
    for (const [callId, name] of pending) items.push({ type: 'function_call_result', callId, name, status: 'completed', output: { type: 'text', text: JSON.stringify({ ok: false, code: 'execution_unknown', message: '原执行没有保存结果，请核对已有节点和任务，不重复创建或提交。' }) } });
    pending.clear();
  };
  for (const message of messages) {
    if (message.role !== 'tool') closeRound();
    if (message.role === 'tool') {
      if (omitted.has(message.toolCallId) || !pending.has(message.toolCallId)) continue;
      items.push({ type: 'function_call_result', callId: message.toolCallId, name: message.name || 'unknown', status: 'completed', output: { type: 'text', text: text(message.content) } });
      pending.delete(message.toolCallId);
      continue;
    }
    if (message.reasoningContent || message.responseItems) items.push({ type: 'reasoning', content: [], providerData: { reasoningContent: message.reasoningContent, responseItems: message.responseItems } });
    if (message.role === 'assistant') {
      if (text(message.content)) items.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.toolCalls || []) {
        if (omitted.has(call.id)) continue;
        items.push({ type: 'function_call', callId: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' });
        pending.set(call.id, call.name);
      }
    } else {
      const content = typeof message.content === 'string' ? message.content : (message.content || []).map((part) => part.type === 'image_url' ? { type: 'input_image', image: part.image_url.url, detail: 'auto' } : { type: 'input_text', text: part.text });
      items.push({ role: message.role === 'system' ? 'system' : 'user', content });
    }
  }
  closeRound();
  return items;
}

export function modelMessages(items, instructions = '') {
  const messages = instructions ? [{ role: 'system', content: instructions }] : [];
  let assistant;
  const currentAssistant = () => {
    if (!assistant) { assistant = { role: 'assistant', content: '' }; messages.push(assistant); }
    return assistant;
  };
  for (const item of typeof items === 'string' ? [{ role: 'user', content: items }] : items) {
    if (item.type === 'reasoning') {
      Object.assign(currentAssistant(), { reasoning_content: item.providerData?.reasoningContent, response_items: item.providerData?.responseItems });
    } else if (item.type === 'function_call') {
      const message = currentAssistant();
      (message.tool_calls ||= []).push({ id: item.callId, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'function_call_result') {
      assistant = undefined;
      const parts = Array.isArray(item.output) ? item.output : [];
      const content = parts.length ? parts.filter(part => ['text', 'input_text'].includes(part.type)).map(part => part.text).join('\n') : typeof item.output === 'string' ? item.output : item.output?.type === 'text' ? item.output.text : JSON.stringify(item.output);
      messages.push({ role: 'tool', tool_call_id: item.callId, name: item.name, content });
      if (parts.some(part => ['image', 'input_image'].includes(part.type))) messages.push({ role: 'user', content: parts.map(part => ['image', 'input_image'].includes(part.type) ? { type: 'image_url', image_url: { url: typeof part.image === 'string' ? part.image : part.image.url, detail: part.detail || 'auto' } } : { type: 'text', text: part.text }) });
    } else if (item.role === 'assistant') {
      currentAssistant().content += (typeof item.content === 'string' ? item.content : (item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text).join(''));
    } else if (['user', 'system', 'developer'].includes(item.role)) {
      assistant = undefined;
      const content = typeof item.content === 'string' ? item.content : (item.content || []).map((part) => part.type === 'input_image' ? { type: 'image_url', image_url: { url: part.image, detail: part.detail } } : { type: 'text', text: part.text });
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content });
    }
  }
  return messages;
}

export function protocolMessages(items) {
  return modelMessages(items).map((message) => {
    if (message.role === 'tool') return { role: 'tool', name: message.name, toolCallId: message.tool_call_id, content: message.content };
    const result = { role: message.role, content: message.content };
    if (message.tool_calls) result.toolCalls = message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) }));
    if (message.reasoning_content !== undefined) result.reasoningContent = message.reasoning_content;
    if (message.response_items !== undefined) result.responseItems = message.response_items;
    return result;
  });
}

export function modelOutput(turn) {
  const output = [];
  if (turn.reasoning_content || turn.response_items) output.push({ type: 'reasoning', content: [], providerData: { reasoningContent: turn.reasoning_content, responseItems: turn.response_items } });
  if (turn.text_response) output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn.text_response }] });
  for (const call of turn.tool_calls || []) output.push({ type: 'function_call', callId: call.id, name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments), status: 'completed' });
  return output;
}

export class GatewaySession {
  constructor(id, rpc) { this.id = id; this.rpc = rpc; }
  async getSessionId() { return this.id; }
  async getItems(limit) { return this.rpc('session', { action: 'get', limit }); }
  async addItems(items) { await this.rpc('session', { action: 'append', items }); }
  async popItem() { return this.rpc('session', { action: 'pop' }); }
  async clearSession() { await this.rpc('session', { action: 'clear' }); }
  async applyHistoryTransaction(args) { await this.rpc('session', { action: 'transaction', ...args }); }
  async applyHistoryMutations(args) { await this.rpc('session', { action: 'mutate', ...args }); }
}
