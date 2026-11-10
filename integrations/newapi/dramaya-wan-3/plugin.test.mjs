import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./dramaya-wan-3-1.0.0.js', import.meta.url));
const plugin = await import(`data:text/javascript;base64,${source.toString('base64')}`);
const body = { model: 'wan-3', prompt: '镜头缓慢推进，云朵掠过山顶' };
const baseUrl = 'https://channel.example.com';
const apiKey = 'fixture-key';
const context = requestBody => ({ requestBody, model: 'wan-3', upstreamModel: 'wan-3', baseUrl, apiKey, files: [] });
const decode = value => plugin.protocols.openai_video.decodeRequest({ model: 'wan-3', body: { kind: 'json', value } });

test('exact model, protocol, defaults and channel address', () => {
  assert.equal(plugin.meta.key, 'dramaya-wan-3');
  assert.equal(plugin.meta.version, '1.0.0');
  assert.equal(plugin.meta.baseUrl, 'https://video.dramaya.us');
  assert.equal(plugin.meta.auth, 'api_key');
  assert.deepEqual(plugin.meta.models, ['wan-3']);
  assert.deepEqual(plugin.meta.protocols, ['openai_video']);
  assert.equal(decode(body).action, 'text_to_video');
  assert.deepEqual(plugin.buildSubmitRequest(context(body)), {
    url: baseUrl + '/v1/videos', method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: { ...body, duration: 5, resolution: '480p' },
  });
  assert.deepEqual(body, { model: 'wan-3', prompt: '镜头缓慢推进，云朵掠过山顶' });
});

test('all nine duration and resolution combinations preserve the request and usage', () => {
  for (const duration of [5, 10, 15]) {
    for (const resolution of ['480p', '720p', '1080p']) {
      const input = { ...body, duration, resolution };
      assert.equal(decode(input).kind, 'submit');
      assert.deepEqual(plugin.buildSubmitRequest(context(input)).body, input);
      assert.deepEqual(plugin.extractUsage({ ...context(input), usagePurpose: 'facts' }), { seconds: duration, resolution });
      assert.deepEqual(plugin.extractUsage({ ...context(input), usagePurpose: 'billing_ratios' }), {});
    }
  }
});

test('reject invalid parameters and undeclared capabilities before submission', () => {
  const invalid = [
    ...[0, 4, 6, 9, 11, 16, 5.5, '5', null, true].map(duration => ({ ...body, duration })),
    ...['4K', '768p', '', null, 720].map(resolution => ({ ...body, resolution })),
    ...['', '   ', null, 123].map(prompt => ({ ...body, prompt })),
    ...['seconds', 'size', 'aspect_ratio', 'image_urls', 'references', 'reference_video_urls',
      'reference_audio_urls', 'first_frame', 'last_frame', 'generate_audio', 'watermark', 'mode', 'seed']
      .map(field => ({ ...body, [field]: 'undeclared' })),
  ];
  for (const input of invalid) {
    assert.throws(() => decode(input), JSON.stringify(input));
    assert.throws(() => plugin.buildSubmitRequest(context(input)), JSON.stringify(input));
  }
  assert.throws(() => plugin.buildSubmitRequest({ ...context(body), model: 'wan-3-other', upstreamModel: 'wan-3-other' }));
  assert.throws(() => plugin.buildSubmitRequest({ ...context(body), files: [{ ref: 'file-1' }] }));
  assert.throws(() => plugin.buildSubmitRequest({ ...context(body), apiKey: '' }));
});

test('creation and polling distinguish task IDs, progress and terminal states', () => {
  assert.equal(plugin.parseSubmitResponse({}, { body: { id: 'video_task_fixture', status: 'queued' } }).taskId, 'video_task_fixture');
  assert.throws(() => plugin.parseSubmitResponse({}, { body: { status: 'queued' } }));
  assert.deepEqual(plugin.buildQueryRequest({ ...context(body), taskId: 'private/a?b' }), {
    url: baseUrl + '/v1/videos/private%2Fa%3Fb', method: 'GET', headers: { Authorization: 'Bearer ' + apiKey },
  });
  const states = {
    queued: 'QUEUED', running: 'IN_PROGRESS', in_progress: 'IN_PROGRESS', processing: 'IN_PROGRESS',
    pending: 'IN_PROGRESS', cancel_requested: 'IN_PROGRESS', completed: 'SUCCESS',
    failed: 'FAILURE', cancelled: 'FAILURE', expired: 'FAILURE', unexpected: 'UNKNOWN',
  };
  for (const [status, expected] of Object.entries(states)) {
    assert.equal(plugin.parseTaskResult({ taskId: 'vendor-id' }, { id: 'vendor-id', status, progress: 100 }).status, expected);
  }
  assert.equal(plugin.parseTaskResult({ taskId: 'vendor-id' }, { id: 'other-id', status: 'completed' }).status, 'UNKNOWN');
  assert.equal(plugin.parseTaskResult({}, { status: 'failed', error: { message: 'provider failure' } }).reason, 'provider failure');
});

test('GET and HEAD refresh signed URLs with the channel key, then download without credentials', () => {
  const signedURL = 'https://cdn.example.com/result.mp4?signature=fixture';
  const ctx = {
    ...context(body), taskId: 'public-id', upstreamTaskId: 'vendor-id', artifactKey: 'video',
    data: { video_url: 'https://expired.example.com/result.mp4' },
  };
  const originalUtils = globalThis.utils;
  try {
    for (const method of ['GET', 'HEAD']) {
      for (const result of [{ video_url: signedURL }, { data: [{ url: signedURL }] }]) {
        const requests = [];
        globalThis.utils = { fetch(request) {
          requests.push(request);
          return { status: 200, body: { id: 'vendor-id', status: 'completed', ...result } };
        } };
        assert.deepEqual(plugin.buildContentRequest({ ...ctx, clientRequest: { method } }), {
          url: signedURL, method, credentialless: true,
        });
        assert.deepEqual(requests, [{
          url: baseUrl + '/v1/videos/vendor-id', method: 'GET', headers: { Authorization: 'Bearer ' + apiKey },
        }]);
      }
    }
    for (const response of [
      { status: 401, body: {} },
      { status: 503, body: {} },
      { status: 200, body: { id: 'vendor-id', status: 'running', video_url: signedURL } },
      { status: 200, body: { id: 'other-id', status: 'completed', video_url: signedURL } },
      { status: 200, body: { id: 'vendor-id', status: 'completed' } },
    ]) {
      globalThis.utils = { fetch: () => response };
      assert.throws(() => plugin.buildContentRequest({ ...ctx, clientRequest: { method: 'GET' } }));
    }
  } finally {
    if (originalUtils === undefined) delete globalThis.utils;
    else globalThis.utils = originalUtils;
  }
});
