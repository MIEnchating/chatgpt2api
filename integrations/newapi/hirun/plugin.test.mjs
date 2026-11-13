import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./hirun-video-1.0.2.js', import.meta.url));
globalThis.utils = {
  fetch(request) {
    assert.equal(request.url, 'https://hi.hi.run/api/openai/v1/videos/video_123');
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.headers, { Authorization: 'Bearer fixture-key' });
    return {
      status: 200,
      body: {
        id: 'video_123',
        status: 'completed',
        sparkcine: { outputs: [{ download_url: 'https://cdn.example/video_123.mp4' }] },
      },
    };
  },
};
const plugin = await import(`data:text/javascript;base64,${source.toString('base64')}`);

test('plugin advertises documented models and API endpoint', () => {
  assert.equal(plugin.meta.key, 'hirun-video');
  assert.equal(plugin.meta.version, '1.0.2');
  assert.equal(plugin.meta.baseUrl, 'https://hi.hi.run/api/openai/v1');
  assert.deepEqual(plugin.meta.models, ['h3-video', 'h3-video-flex']);
  assert.deepEqual(plugin.meta.protocols, ['openai_video']);
});

test('text video uses the OpenAI compatible seconds and size fields', () => {
  const result = plugin.buildSubmitRequest({
    requestBody: { model: 'h3-video', prompt: 'A quiet city street', duration: 6, aspect_ratio: '16:9', resolution: '720p' },
    model: 'h3-video', upstreamModel: 'h3-video', baseUrl: plugin.meta.baseUrl, apiKey: 'fixture-key', files: [],
  });
  assert.equal(result.url, `${plugin.meta.baseUrl}/videos`);
  assert.equal(result.body.seconds, 6);
  assert.equal(result.body.size, '1280x720');
  assert.equal(result.body.aspect_ratio, undefined);
  assert.equal(result.body.resolution, undefined);
  assert.equal(result.body.duration, undefined);
  assert.equal(result.body.optimize_prompt, false);
  assert.equal(result.body.duration, undefined);
  assert.deepEqual(plugin.extractUsage({ model: 'h3-video', requestBody: { prompt: 'City', duration: 6, aspect_ratio: '16:9', resolution: '720p' } }), { seconds: 6, resolution: '720p' });
  assert.deepEqual(plugin.extractUsage({ model: 'h3-video', requestBody: { prompt: 'City', duration: 6, aspect_ratio: '1:1', resolution: '768p' } }), { seconds: 6, resolution: '768p' });
});

test('reference image is submitted as a repeated multipart input_reference file', () => {
  const result = plugin.buildSubmitRequest({
    requestBody: { model: 'h3-video', prompt: 'Animate this image', duration: 6, aspect_ratio: '9:16', resolution: '768p', input_reference: ['file:ref-1'] },
    model: 'h3-video', upstreamModel: 'h3-video', baseUrl: plugin.meta.baseUrl, apiKey: 'fixture-key',
    files: [{ ref: 'file:ref-1', filename: 'reference.png', mimeType: 'image/png', size: 1024 }],
  });
  assert.equal(result.bodyType, 'multipart');
  assert.deepEqual(result.parts.find(part => part.name === 'seconds'), { name: 'seconds', value: '6' });
  assert.deepEqual(result.parts.find(part => part.fileRef), { name: 'input_reference', fileRef: 'file:ref-1', filename: 'reference.png' });
  assert.deepEqual(result.parts.find(part => part.name === 'size'), { name: 'size', value: '768x1365' });
  assert.throws(() => plugin.buildSubmitRequest({
    requestBody: { model: 'h3-video-flex', prompt: 'A scene', duration: 16, aspect_ratio: '16:9', resolution: '720p' },
    model: 'h3-video-flex', upstreamModel: 'h3-video-flex', baseUrl: plugin.meta.baseUrl, apiKey: 'fixture-key', files: [],
  }));
});

test('Hi.Run task states and refreshed signed download URL are wired', () => {
  assert.equal(plugin.parseSubmitResponse({}, { body: { id: 'video_123', status: 'queued' } }).taskId, 'video_123');
  assert.equal(plugin.parseTaskResult({ taskId: 'video_123' }, { id: 'video_123', status: 'completed', progress: 100 }).status, 'SUCCESS');
  assert.deepEqual(plugin.buildContentRequest({
    upstreamTaskId: 'video_123', artifactKey: 'video', baseUrl: plugin.meta.baseUrl, apiKey: 'fixture-key',
    clientRequest: { method: 'GET' },
  }), {
    url: 'https://cdn.example/video_123.mp4', method: 'GET', credentialless: true,
  });
});
