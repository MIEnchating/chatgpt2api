import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateOpenAIState } from '../migrate-state.mjs';
import { readFileSync } from 'node:fs';

const call = { type: 'function_call', callId: 'write', name: 'create_text_node', arguments: '{"text":"saved"}', status: 'completed' };
const result = { type: 'function_call_result', callId: 'write', name: 'create_text_node', output: '{"ok":true}', status: 'completed' };
const state = generatedItems => ({ $schemaVersion: '1.23', currentTurn: 2, maxTurns: 40, originalInput: [{ role: 'user', content: 'Keep the original task.' }], generatedItems });

test('the pinned SDK 0.21.0 serialized approval migrates using its actual Session history', () => {
  // Generated with @openai/agents-core 0.21.0, an in-memory Session, and a mock
  // model: create_text_node succeeds, then ask_user_question pauses for approval.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/sdk-0.21.0-approval.json', import.meta.url), 'utf8'));
  const migrated = migrateOpenAIState(fixture.state, fixture.items, {});
  assert.deepEqual(migrated.history, fixture.items);
  assert.deepEqual(migrated.pending.map(item => item.id), ['approval']);
  assert.equal(migrated.batch.question, 'approval');
});

test('migration preserves the durable prefix and resumes only unfinished calls', () => {
  const question = { ...call, callId: 'question', name: 'ask_user_question' };
  const source = state([
    { type: 'tool_call_item', rawItem: { ...call, id: 'provider-id' } },
    { type: 'tool_call_output_item', rawItem: result },
    { type: 'tool_call_item', rawItem: question },
    { type: 'tool_approval_item', rawItem: question },
  ]);
  const stored = [...source.originalInput, call];
  const original = structuredClone({ source, stored });
  const migrated = migrateOpenAIState(source, stored, {});
  assert.deepEqual(migrated.history, [...stored, result, question]);
  assert.deepEqual(migrated.pending.map(item => item.id), ['question']);
  assert.equal(migrated.batch.question, 'question');
  assert.deepEqual({ source, stored }, original);
});

test('migration rejects conflicting or unsupported data without changing the source', () => {
  const source = state([{ type: 'tool_call_item', rawItem: call }]);
  for (const invalid of [
    { ...source, $schemaVersion: 'unknown' },
    { ...source, pendingSessionWrite: {} },
    { ...source, pendingSessionHistoryTransaction: {} },
    { ...source, pendingInput: [{ role: 'user', content: 'uncommitted' }] },
    state([{ type: 'handoff_call_item', rawItem: call }]),
    state([{ type: 'tool_call_output_item', rawItem: result }]),
    state([{ type: 'tool_call_item', rawItem: call }, { type: 'tool_call_item', rawItem: call }]),
  ]) {
    const original = structuredClone(invalid);
    assert.throws(() => migrateOpenAIState(invalid, [], {}));
    assert.deepEqual(invalid, original);
  }
  assert.throws(() => migrateOpenAIState(source, [{ role: 'user', content: 'conflicting task' }], {}), /历史不一致/);
});

test('migration retains a committed user turn written before its matching runtime checkpoint', () => {
  const task = { role: 'user', content: '先检查已经生成的分镜。' };
  const followup = { role: 'user', content: [{ type: 'input_text', text: '继续处理第03段。' }, { type: 'input_image', image: 'https://example.test/reference.png', detail: 'auto' }] };
  const question = { ...call, callId: 'saved-question', name: 'ask_user_question' };
  const answerRequest = state([{ type: 'tool_call_item', rawItem: question }, { type: 'tool_call_output_item', rawItem: { ...result, callId: question.callId, name: question.name } }]);
  answerRequest.originalInput = [task];
  const stored = [task, followup, question, { ...result, callId: question.callId, name: question.name }];
  const migrated = migrateOpenAIState(answerRequest, stored, {});
  assert.deepEqual(migrated.history, stored);
  assert.equal(migrated.currentStart, 1);
  assert.deepEqual(migrated.pending, []);
});

test('migration does not classify missing tool transactions as committed user input', () => {
  const source = state([{ type: 'tool_call_item', rawItem: call }, { type: 'tool_call_output_item', rawItem: result }]);
  assert.throws(() => migrateOpenAIState(source, [source.originalInput[0], { role: 'assistant', content: 'uncheckpointed' }, call, result], {}), /历史不一致/);
  assert.throws(() => migrateOpenAIState(source, [source.originalInput[0], { role: 'user', content: [{ type: 'tool_call', id: 'not-user-input' }] }, call, result], {}), /历史不一致/);
});

test('migration preserves a business-validated final checkpoint without another model turn', () => {
  const finish = { ...call, name: 'finish_task' };
  const done = { ...result, name: 'finish_task', output: { type: 'text', text: '{"ok":true,"text":"verified"}' } };
  const source = { ...state([{ type: 'tool_call_item', rawItem: finish }, { type: 'tool_call_output_item', rawItem: done }]), currentStep: { type: 'next_step_final_output', output: 'done' } };
  assert.equal(migrateOpenAIState(source, [], { completionTool: 'finish_task' }).status, 'finished');
  assert.equal(migrateOpenAIState(source, [], { completionTool: 'finish_task' }).output, 'verified');
  done.output.text = '{"ok":false}';
  assert.equal(migrateOpenAIState(source, [], { completionTool: 'finish_task' }).status, 'running');
});
