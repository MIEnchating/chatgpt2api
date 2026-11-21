import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL(name, import.meta.url));
const plugin = await import(`data:text/javascript;base64,${read('aigasapi-video-2.0.3.js').toString('base64')}`);
const mapping = JSON.parse(read('model-mapping.json'));
const catalog = JSON.parse(read('source-models.json')).models;
const contract = JSON.parse(read('contract.json')).contracts[0].contract;
const image = 'https://media.example/image.png';
const closingImage = 'https://media.example/closing.png';
const video = 'https://media.example/video.mp4';
const audio = 'https://media.example/audio.mp3';

function context(model, input = {}) {
  return {
    model, upstreamModel: mapping[model], publicTaskId: 'task_gateway_123',
    baseUrl: 'https://channel.example', apiKey: 'fixture-key', files: [],
    requestBody: { model, prompt: 'A moving cloud', ...input },
  };
}

test('every catalog model has a unique channel name and emits exact upstream requests in all declared modes', () => {
  assert.equal(plugin.meta.key, 'aigasapi-video');
  assert.equal(plugin.meta.version, '2.0.3');
  assert.equal(plugin.meta.baseUrl, 'https://www.aigasapi.com');
  assert.deepEqual(plugin.meta.models, contract.models);
  assert.ok(contract.models.every(model => /^video-/.test(model)));
  assert.equal(contract.provider, undefined);
  assert.deepEqual(Object.values(mapping).sort(), catalog.map(model => model.id).sort());
  let checked = 0;
  for (const profile of contract.model_profiles) {
    const { model, capability } = profile;
    const entry = catalog.find(item => item.id === mapping[model]);
    for (const mode of profile.generation.modes) {
      const inputs = [{ input: {}, references: undefined }];
      if (mode.kind === 'image') {
        inputs[0] = { input: { first_frame: image }, references: [{ type: 'image', role: 'first_frame', url: image }] };
        if (mode.materials.last_frame.max) {
          inputs.push({
            input: { first_frame: image, last_frame: closingImage },
            references: [{ type: 'image', role: 'first_frame', url: image }, { type: 'image', role: 'last_frame', url: closingImage }],
          });
        }
      }
      if (mode.kind === 'reference') {
        const sources = [['image', 'images', image], ['video', 'videos', video], ['audio', 'audios', audio]];
        const available = sources.filter(([type]) => mode.materials[type].max);
        inputs[0] = {
          input: { references: Object.fromEntries(available.map(([, field, url]) => [field, [url]])) },
          references: available.map(([type, , url]) => ({ type, role: 'reference', url })),
        };
      }
      for (const { input, references } of inputs) {
        const ctx = context(model, input);
        const decoded = plugin.protocols.openai_video.decodeRequest({ ...ctx, body: { kind: 'json', value: ctx.requestBody } });
        assert.equal(decoded.model, model);
        assert.equal(decoded.action, mode.kind === 'text' ? 'text_to_video' : 'image_to_video');
        const request = plugin.buildSubmitRequest(ctx);
        assert.deepEqual(request, {
          url: 'https://channel.example/v1/videos', method: 'POST',
          headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' },
          body: {
            model: entry.id, prompt: 'A moving cloud', out_task_id: 'video_' + ctx.publicTaskId,
            duration: capability.default_seconds, aspect_ratio: capability.default_size,
            ...(capability.default_resolution && { resolution: capability.default_resolution }),
            ...(entry.watermark && { watermark: false }),
            ...(references && { references }),
          },
        }, model);
        assert.deepEqual(plugin.extractUsage(ctx), {
          ...(entry.billing_mode === 'per_request' ? { count: 1 } : { seconds: capability.default_seconds }),
          ...(capability.default_resolution && { resolution: capability.default_resolution }),
        }, model);
        checked++;
      }
    }
  }
  assert.equal(checked, 99);
});

test('enforces frames, audio, fixed duration, and per-model material restrictions', () => {
  const fixed = 'video-sd-2.0-720-900';
  const fast = 'video-sd-2.0-fast-official-720p';
  const frames = 'video-sd-2.5-flash-720p-per-request';
  const noVideo = 'video-sd-2.5-flash-720-novideo';
  const submit = (model, input) => plugin.buildSubmitRequest(context(model, input));
  assert.throws(() => submit(fixed, {}), /不支持所选生成模式/);
  assert.throws(() => submit(fixed, { first_frame: image, duration: 5 }), /不支持所选时长/);
  assert.throws(() => submit(fixed, { first_frame: image, resolution: '1080p' }), /未声明字段/);
  assert.throws(() => submit(frames, { last_frame: image }), /素材数量/);
  assert.throws(() => submit(frames, { first_frame: image, references: { images: [image] } }), /未声明字段/);
  assert.throws(() => submit(fast, { references: { audios: [audio] } }), /需要同时提供/);
  assert.throws(() => submit(noVideo, { references: { images: [image], videos: [video] } }), /未声明字段/);
  assert.throws(() => submit(noVideo, { references: { images: Array(11).fill(image) } }), /素材数量/);
  assert.throws(() => submit(fast, { references: { images: ['data:image/png;base64,AA=='] } }), /HTTP/);
  const ctx = context(fast, { watermark: true });
  assert.equal(plugin.buildSubmitRequest(ctx).body.watermark, true);
  assert.equal(plugin.buildSubmitRequest({ ...ctx, upstreamModel: ctx.model }).body.model, mapping[fast]);
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, upstreamModel: 'wrong' }), /模型映射/);
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, publicTaskId: 'a'.repeat(65) }), /out_task_id/);
});

test('maps lifecycle states and refreshes the credentialless OSS download', () => {
  const ctx = context('video-sd-2.5-flash-720p');
  const taskId = 'task_vendor_123';
  assert.equal(plugin.parseSubmitResponse(ctx, { body: { task_id: taskId, status: 'queued' } }).taskId, taskId);
  assert.deepEqual(plugin.buildQueryRequest({ ...ctx, taskId }), {
    url: 'https://channel.example/v1/videos/task_vendor_123', method: 'GET', headers: { Authorization: 'Bearer fixture-key' },
  });
  assert.deepEqual(plugin.parseTaskResult({ taskId }, { id: taskId, status: 'in_progress', progress: 31 }), {
    status: 'IN_PROGRESS', progress: '31%',
  });
  assert.deepEqual(plugin.parseTaskResult({ taskId }, { id: taskId, status: 'failed', error: { message: 'fixture failure' } }), {
    status: 'FAILURE', reason: 'fixture failure',
  });
  assert.equal(plugin.parseTaskResult({ taskId }, { id: 'other', status: 'completed' }).status, 'UNKNOWN');
  const downloadContext = { ...ctx, upstreamTaskId: taskId, artifactKey: 'video', clientRequest: { method: 'HEAD' } };
  let url = 'https://oss.example/video.mp4?fixture=first';
  globalThis.utils = { fetch(request) {
    assert.deepEqual(request, plugin.buildQueryRequest({ ...ctx, taskId }));
    return { status: 200, body: { id: taskId, status: 'completed', metadata: { url } } };
  } };
  assert.deepEqual(plugin.buildContentRequest(downloadContext), { url, method: 'GET', credentialless: true });
  url = 'https://oss.example/video.mp4?fixture=second';
  assert.deepEqual(plugin.buildContentRequest(downloadContext), { url, method: 'GET', credentialless: true });
  url = 'http://oss.example/video.mp4';
  assert.throws(() => plugin.buildContentRequest(downloadContext), /HTTPS/);
});

test('derives an allowed and stable upstream idempotency key from a New API task ID', () => {
  const ctx = { ...context('video-minimax-h3-768p'), publicTaskId: 'task_' + 'A'.repeat(32) };
  const expected = 'video_' + ctx.publicTaskId;
  assert.equal(plugin.buildSubmitRequest(ctx).body.out_task_id, expected);
  assert.equal(plugin.buildSubmitRequest(ctx).body.out_task_id, expected);
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, publicTaskId: 'a'.repeat(59) }), /out_task_id/);
});

test('sends the exact H3 768P resolution with and without explicit input', () => {
  const model = 'video-minimax-h3-official-768p';
  for (const resolution of [undefined, '768p', '768P']) {
    const input = { duration: 5, aspect_ratio: '16:9', ...(resolution && { resolution }) };
    const ctx = context(model, input);
    assert.deepEqual(plugin.buildSubmitRequest(ctx).body, {
      model: 'minimax-h3-官方版-768p', prompt: 'A moving cloud', duration: 5, aspect_ratio: '16:9',
      resolution: '768P', out_task_id: 'video_' + ctx.publicTaskId,
    });
    assert.deepEqual(plugin.extractUsage(ctx), { seconds: 5, resolution: '768P' });
  }
  assert.throws(() => plugin.buildSubmitRequest(context(model, { resolution: '720p' })), /不支持所选清晰度/);
  assert.equal(plugin.buildSubmitRequest(context('video-minimax-h3-official-1080p')).body.resolution, '1080p');
});

test('model discovery returns only supported aliases and preserves case-distinct model routing', () => {
  const response = plugin.convertResponse({}, { status: 200, body: JSON.stringify({ data: [
    { id: 'sd-2.5-flash-720P', owned_by: 'AIGASAPI', upstream_url: 'https://www.aigasapi.com' },
    { id: 'sd-2.5-flash-720p' }, { id: 'unlisted' },
  ] }) });
  assert.deepEqual(response.body.data, [
    { id: 'video-sd-2.5-flash-720p', object: 'model' },
    { id: 'video-sd-2.5-flash-720p-per-request', object: 'model' },
  ]);
  assert.equal(plugin.convertResponse({}, { status: 401 }).error.status, 401);
});
