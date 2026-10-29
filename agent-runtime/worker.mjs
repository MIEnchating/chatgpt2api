import { Agent, Runner, RunState, Usage, tool, setTracingDisabled } from '@openai/agents';
import { createInterface } from 'node:readline';

// The authenticated Go parent owns persistence and model transport. No credentials
// or network listeners are exposed to this isolated SDK worker.
setTracingDisabled(true);
const lines = createInterface({ input: process.stdin });
const pending = new Map();
let serial = 0;
let started = false;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
function rpc(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!started) {
    started = true;
    void execute(message).then(() => lines.close()).catch((error) => {
      send({ method: 'error', params: { message: error.message } });
      process.exitCode = 1;
      lines.close();
    });
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error));
  else waiter.resolve(message.result);
});
lines.on('close', () => {
  for (const waiter of pending.values()) waiter.reject(new Error('Agent parent disconnected'));
  pending.clear();
  process.stdin.destroy();
});

async function execute(config) {
  const model = {
    async getResponse() {
      const turn = await rpc('model');
      const output = [];
      if (turn.text) output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn.text }] });
      for (const call of turn.calls) output.push({ type: 'function_call', callId: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' });
      if (!output.length) output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '本轮处理完成。' }] });
      return { output, usage: new Usage() };
    },
    async *getStreamedResponse() { throw new Error('Worker uses checkpoint events, not provider streaming'); },
  };
  // Serialize side effects even if a provider returns parallel tool calls.
  let queue = Promise.resolve();
  const tools = config.tools.map(({ function: definition }) => tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    strict: false,
    needsApproval: ['ask_user_question', 'delete_node'].includes(definition.name),
    errorFunction: null,
    execute(args, _context, details) {
      const result = queue.then(() => rpc('tool', { id: details.toolCall.callId, name: definition.name, arguments: args }));
      queue = result.then(() => {}, () => {});
      return result.then(JSON.stringify);
    },
  }));
  const agent = new Agent({ name: 'Canvas Creative Agent', model, tools, instructions: 'Execute the saved canvas request using the built-in tools.', modelSettings: { parallelToolCalls: false } });
  const runner = new Runner({ tracingDisabled: true });
  let input = '处理当前已保存的画布请求。';
  if (config.state) {
    input = await RunState.fromString(agent, config.state);
    for (const interruption of input.getInterruptions()) input.approve(interruption);
  }
  let result;
  try {
    result = await runner.run(agent, input, { maxTurns: 40 });
  } catch (error) {
    if (error.name === 'MaxTurnsExceededError') {
      await rpc('finish', { status: 'waiting', text: '已保存当前进度，可以继续完成剩余步骤。' });
      return;
    }
    throw error;
  }
  if (result.interruptions.length) {
    await rpc('pause', { state: result.state.toString(), callIds: result.interruptions.map((item) => item.rawItem.callId) });
  } else {
    await rpc('finish', { status: 'success', text: result.finalOutput || '本轮处理完成。' });
  }
}
