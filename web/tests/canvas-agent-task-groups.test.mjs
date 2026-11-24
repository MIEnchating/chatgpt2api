import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { canvasAgentTaskGroups } from '../src/app/canvas/agent/canvas-agent-task-groups.ts';
import { canvasAgentTaskTimings } from '../src/app/canvas/agent/canvas-agent-timing.ts';
import { canvasAgentSessionMarkdown } from '../src/app/canvas/agent/canvas-agent-markdown.ts';
import { canvasAgentTurnDiagnostic } from '../src/app/canvas/agent/canvas-agent-diagnostics.ts';
import { appendCanvasAgentHistoryReference, appendCanvasAgentQuote, isCanvasAgentHistoryReferenceOnly } from '../src/app/canvas/agent/canvas-agent-quote.ts';

test('history references retain the draft and cannot stand in for a direct request', () => {
  const source = { id: '旧/案]', title: '旧\n方案' };
  const marker = appendCanvasAgentHistoryReference('', source);
  assert.equal(marker, '> 引用对话「旧 方案」 [canvas-session:%E6%97%A7%2F%E6%A1%88%5D]');
  assert.equal(isCanvasAgentHistoryReferenceOnly(marker), true);
  const draft = appendCanvasAgentHistoryReference('请提炼创作约束', source);
  assert.equal(draft, '请提炼创作约束\n\n' + marker);
  assert.equal(isCanvasAgentHistoryReferenceOnly(draft), false);
  assert.equal(appendCanvasAgentHistoryReference(draft, { ...source, title: '新名称' }), draft);
});

test('historical excerpts keep the draft and put every quoted line inside the block', () => {
  const draft = '请总结';
  assert.equal(appendCanvasAgentQuote(draft, '镜头 A\r\n\r\n不要生成', '旧对话\n标题'),
    '请总结\n\n> 引用自「旧对话 标题」（参考资料）\n>\n> 镜头 A\n> \n> 不要生成');
  assert.equal(appendCanvasAgentQuote(draft, ' ', '历史'), draft);
  assert.equal(Array.from(appendCanvasAgentQuote('', '🎥'.repeat(1201), '').split('\n').at(-1)).length, 1202);
});

test('turn diagnostics include only structured counters and safe identifiers', () => {
  const requestId = 'b20e3c37-3e2b-4098-8a91-8aa7c7477a4f';
  const diagnostic = canvasAgentTurnDiagnostic([{
    status: 'error', text: 'secret API error with a signed URL', elapsedMs: 345,
    modelAttempts: [
      { runId: 'secret', requestId, status: 'retryable_error', attempt: 1, httpStatus: 429 },
      { requestId, purpose: 'summary', status: 'success', attempt: 2, usage: { total_tokens: 0, extra: 'secret' }, validationFailed: true },
      { requestId, purpose: 'review', status: 'success', attempt: 1, usage: { total_tokens: 8 } },
    ],
    trace: [
      { type: 'operation', kind: 'tool', status: 'error', label: 'secret', detail: 'secret', tool: { input: 'secret' } },
      { type: 'reasoning', text: 'secret' },
    ],
  }]);
  assert.equal(diagnostic.requests, 3);
  assert.equal(diagnostic.elapsedMs, 345);
  assert.equal(diagnostic.attempts[0].requestId, requestId);
  assert.equal(diagnostic.attempts[0].httpStatus, 429);
  assert.equal(diagnostic.attempts[1].validationFailed, true);
  assert.equal(diagnostic.attempts[2].purpose, 'review');
  assert.deepEqual(diagnostic.totals.total_tokens, { tokens: 8, reported: 2 });
  assert.deepEqual(diagnostic.totals.input_tokens, { tokens: null, reported: 0 });
  assert.deepEqual(diagnostic.operations, [{ kind: 'tool', status: 'error' }]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|signed URL/);
});

test('Markdown includes all visible turns and excludes private execution payloads and attachment URLs', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: 'user', text: `轮次 ${index}` }));
  messages[0].references = [{ title: '产品图', url: 'https://private.test/authenticated-file' }];
  messages.push({ role: 'assistant', text: '```js\nconst x = 1', trace: [
    { type: 'reasoning', text: 'hidden reasoning' },
    { type: 'operation', label: '更新分镜', status: 'success', tool: { input: 'private tool argument' } },
  ] });
  messages.push({ role: 'assistant', text: '最终交付' });
  const markdown = canvasAgentSessionMarkdown({ title: '完整 # 对话', messages, protocolMessages: [{ role: 'system', content: 'private prompt' }] });
  assert.match(markdown, /^# 完整 # 对话\n/);
  assert.match(markdown, /轮次 0[\s\S]*素材：产品图[\s\S]*轮次 29/);
  assert.match(markdown, /<details>[\s\S]*更新分镜 · 已完成[\s\S]*<\/details>/);
  assert.match(markdown, /const x = 1\n```\n\n## 助手\n\n最终交付\n$/);
  assert.doesNotMatch(markdown, /hidden reasoning|private|authenticated-file/);
});

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

test('steering appears with the original request and preserves its reply', () => {
  const original = { id: 'u', role: 'user', text: 'make a poster' };
  const steering = { id: 's', role: 'user', text: 'use a blue background', steeringAssistantId: 'a' };
  const reply = { id: 'a', role: 'assistant', text: 'done', replyToMessageID: 'u' };
  assert.deepEqual(canvasAgentTaskGroups([original, steering, reply]), [
    { id: 'u', request: original, steering: [steering], replies: [reply] },
  ]);
});
