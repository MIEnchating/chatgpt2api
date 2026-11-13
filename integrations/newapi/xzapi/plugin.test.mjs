import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test, { after } from 'node:test';

const source = readFileSync(new URL('./xzapi-video-1.1.0.js', import.meta.url));
const plugin = await import(`data:text/javascript;base64,${source.toString('base64')}`);
const models = JSON.parse(readFileSync(new URL('./source-models.json', import.meta.url))).models;
const document = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url)));
const profiles = document.contracts.flatMap(item => item.contract.model_profiles);
const cases = [];
const context = body => ({ requestBody: body, model: body.model, upstreamModel: body.model, baseUrl: 'https://provider.example.com', apiKey: 'fixture-key', publicTaskId: 'task_fixture-order.1', files: [] });
const expected = body => ({ url: 'https://provider.example.com/v1/videos', method: 'POST', headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' }, body: { ...body, mode: 'references', client_task_id: 'task_fixture-order.1' } });
function checkSubmit(name, input, output) {
  const args = [context(input)];
  const want = expected(output);
  assert.deepEqual(plugin.buildSubmitRequest(...args), want);
  cases.push({ name, hook: 'buildSubmitRequest', args, expected: want });
}

test('all 23 exact pricing models have embedded, model-specific contracts', () => {
  assert.equal(plugin.meta.key, 'xzapi-video');
  assert.equal(plugin.meta.version, '1.1.0');
  assert.equal(plugin.meta.baseUrl, 'https://api.xzapi.vip');
  assert.equal(plugin.meta.auth, 'api_key');
  assert.deepEqual(plugin.meta.protocols, ['openai_video']);
  assert.deepEqual([...plugin.meta.models].sort(), models.map(row => row.model_name).sort());
  assert.equal(document.contracts.length, 1);
  assert.equal(profiles.length, 23);
  for (const row of models) {
    const cap = profiles.find(profile => profile.model === row.model_name).capability;
    const bounds = row.description.match(/(\d+)s\s*-\s*(\d+)s/);
    assert.equal(cap.seconds_range.min, Number(bounds[1]));
    assert.equal(cap.seconds_range.max, Number(bounds[2]));
    for (const [key, label] of [['image', '图片'], ['video', '视频'], ['audio', '音频']]) {
      assert.equal(cap.references[key], Number(row.description.match(new RegExp('(\\d+)\\s*' + label))[1]));
    }
  }
});

for (const { model, capability: cap } of profiles) {
  test(`${model}: defaults, every supported duration, and request boundaries`, () => {
    const base = { model, prompt: 'A moving cloud' };
    checkSubmit(model + ' defaults', base, { ...base, duration: 5, resolution: cap.default_resolution, aspect_ratio: '16:9' });
    for (let duration = cap.seconds_range.min; duration <= cap.seconds_range.max; duration++) {
      const body = { ...base, duration, resolution: cap.default_resolution, aspect_ratio: '9:16' };
      checkSubmit(`${model} ${duration}s`, body, body);
    }
    for (const duration of [cap.seconds_range.min - 1, cap.seconds_range.max + 1, 5.5, '5', null]) {
      assert.throws(() => plugin.buildSubmitRequest(context({ ...base, duration })));
    }
    assert.throws(() => plugin.buildSubmitRequest(context({ ...base, resolution: '4K' })));
    assert.throws(() => plugin.buildSubmitRequest(context({ ...base, aspect_ratio: 'Auto' })));
  });
  test(`${model}: singular, plural and total reference limits`, () => {
    for (const amount of [1, 2]) {
      const references = {};
      const encoded = {};
      for (const [kind, plural] of [['image', 'images'], ['video', 'videos'], ['audio', 'audios']]) {
        if (!cap.references[kind]) continue;
        const urls = Array.from({ length: amount }, (_, i) => `https://media.example.com/${kind}-${i}`);
        references[plural] = urls;
        encoded[amount === 1 ? kind : plural] = amount === 1 ? urls[0] : urls;
      }
      const input = { model, prompt: 'Animate references', references };
      checkSubmit(`${model} ${amount} references each`, input, { ...input, references: encoded, duration: 5, resolution: cap.default_resolution, aspect_ratio: '16:9' });
      assert.equal(references.images.length, amount);
    }
    for (const [kind, plural] of [['image', 'images'], ['video', 'videos'], ['audio', 'audios']]) {
      const urls = Array.from({ length: cap.references[kind] + 1 }, (_, i) => `https://media.example.com/${kind}-${i}`);
      assert.throws(() => plugin.buildSubmitRequest(context({ model, prompt: 'Limit', references: { [plural]: urls } })));
    }
    const maximum = Object.fromEntries([['image', 'images'], ['video', 'videos'], ['audio', 'audios']]
      .filter(([kind]) => cap.references[kind] > 0)
      .map(([kind, plural]) => [plural, Array.from({ length: cap.references[kind] }, (_, i) => `https://media.example.com/${kind}-${i}`)]));
    const input = { model, prompt: 'Limits', references: maximum };
    const total = Object.values(maximum).reduce((sum, urls) => sum + urls.length, 0);
    if (total > cap.references.total) assert.throws(() => plugin.buildSubmitRequest(context(input)));
    else assert.doesNotThrow(() => plugin.buildSubmitRequest(context(input)));
  });
}

test('public task ID supplies stable idempotency; caller input and billing are separate', () => {
  const body = { model: profiles[0].model, prompt: 'Cloud', duration: 10 };
  const ctx = context(body);
  const first = plugin.buildSubmitRequest(ctx);
  assert.deepEqual(plugin.buildSubmitRequest(ctx), first);
  assert.equal(plugin.buildSubmitRequest({ ...ctx, publicTaskId: 'task_other' }).body.client_task_id, 'task_other');
  assert.equal(body.client_task_id, undefined);
  assert.equal(first.body.seconds, undefined);
  assert.deepEqual(plugin.extractUsage({ ...ctx, usagePurpose: 'facts' }), { seconds: 10, resolution: profiles[0].capability.default_resolution });
  assert.deepEqual(plugin.extractUsage({ ...ctx, usagePurpose: 'billing_ratios' }), {});
  for (const id of [undefined, '', 'a/b', 'x'.repeat(129)]) assert.throws(() => plugin.buildSubmitRequest({ ...ctx, publicTaskId: id }));
  for (const field of ['seconds', 'frames', 'mode', 'client_task_id', 'generate_audio', 'watermark']) {
    assert.throws(() => plugin.buildSubmitRequest(context({ ...body, [field]: 'undeclared' })));
  }
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, files: [{ ref: 'file-1' }] }));
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, apiKey: '' }));
  cases.push({ name: 'missing stable idempotency ID', hook: 'buildSubmitRequest', args: [{ ...ctx, publicTaskId: '' }], expectedError: 'publicTaskId' });
});

test('decoding preserves aliases and selects the mapped model capability', () => {
  const model = profiles.find(p => p.capability.default_resolution === '1080p').model;
  const body = { model: 'client-alias', prompt: 'Cloud', resolution: '1080p', duration: 10 };
  const args = [{ model: 'client-alias', upstreamModel: model, body: { kind: 'json', value: body } }];
  const decoded = { kind: 'submit', model: 'client-alias', action: 'text_to_video', requestBody: body };
  assert.deepEqual(plugin.protocols.openai_video.decodeRequest(...args), decoded);
  cases.push({ name: 'mapped model decode', hook: 'protocols', path: ['openai_video', 'decodeRequest'], args, expected: decoded });
  assert.equal(plugin.buildSubmitRequest({ ...context(body), upstreamModel: model }).body.model, model);
});

test('documented statuses, failure reason and authenticated content download', () => {
  assert.equal(plugin.parseSubmitResponse({}, { body: { id: 'task_vendor', status: 'queued' } }).taskId, 'task_vendor');
  for (const [state, status] of Object.entries({ queued: 'QUEUED', in_progress: 'IN_PROGRESS', completed: 'SUCCESS', failed: 'FAILURE', unknown: 'UNKNOWN' })) {
    const args = [{ taskId: 'task_vendor' }, { id: 'task_vendor', status: state, progress: 100, metadata: { fail_reason: 'provider failure' } }];
    const result = plugin.parseTaskResult(...args);
    assert.equal(result.status, status);
    if (state === 'failed') assert.equal(result.reason, 'provider failure');
    cases.push({ name: `status ${state}`, hook: 'parseTaskResult', args, expected: result });
  }
  for (const method of ['GET', 'HEAD']) {
    const ctx = { ...context({ model: profiles[0].model }), upstreamTaskId: 'task_vendor', artifactKey: 'video', clientRequest: { method } };
    const want = { url: 'https://provider.example.com/v1/videos/task_vendor/content', method: 'GET', headers: { Authorization: 'Bearer fixture-key' } };
    assert.deepEqual(plugin.buildContentRequest(ctx), want);
    cases.push({ name: `${method} authenticated download`, hook: 'buildContentRequest', args: [ctx], expected: want });
  }
});

after(() => {
  const index = process.argv.indexOf('--fixture');
  if (index >= 0) writeFileSync(process.argv[index + 1], JSON.stringify({ cases }, null, 2) + '\n');
});
