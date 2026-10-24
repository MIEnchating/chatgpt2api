import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const plugin = await import(`data:text/javascript;base64,${Buffer.from(readFileSync(process.argv[2], 'utf8')).toString('base64')}`);
const baseUrl = 'https://video.dramaya.us';
const apiKey = 'fixture-key';
const first = 'https://example.com/first.png';
const last = 'https://example.com/last.png';
const submit = body => plugin.buildSubmitRequest({ requestBody: body, upstreamModel: body.model, baseUrl, apiKey, files: [] });
const body = { model: 'seedance2.0-A', prompt: 'A landscape' };
assert.equal(plugin.meta.version, '1.0.1');
assert.deepEqual(plugin.meta.models, ['seedance2.0-A', 'seedance2.5-A']);
for (const [model, max] of [['seedance2.0-A', 15], ['seedance2.5-A', 30]]) {
  for (const duration of [4, max]) assert.equal(submit({ ...body, model, duration }).body.duration, duration);
  for (const duration of [3, max + 1, 4.5]) assert.throws(() => submit({ ...body, model, duration }));
  assert.deepEqual(submit({ ...body, model, reference_audio_urls: ['https://example.com/a.mp3'] }).body.references,
    [{ type: 'audio', role: 'reference', source: 'https://example.com/a.mp3' }]);
  assert.deepEqual(submit({ ...body, model, reference_video_urls: ['https://example.com/v.mp4'] }).body.references,
    [{ type: 'video', role: 'reference', source: 'https://example.com/v.mp4' }]);
}
const frames = { ...body, first_frame_url: first, last_frame_url: last };
const request = submit(frames);
assert.equal(request.body.aspect_ratio, 'Auto');
assert.deepEqual(request.body.references, [{ type: 'image', role: 'first_frame', source: first }, { type: 'image', role: 'last_frame', source: last }]);
assert.equal(request.body.first_frame_url, undefined);
assert.throws(() => submit({ ...body, first_frame_url: first }));
assert.throws(() => submit({ ...body, last_frame_url: last }));
assert.throws(() => submit({ ...frames, image_urls: [first] }));
assert.throws(() => submit({ ...frames, model: 'seedance2.5-A' }));
const references = { image_urls: Array(9).fill(first), reference_video_urls: Array(3).fill('https://example.com/v.mp4') };
assert.equal(submit({ ...body, ...references }).body.references.length, 12);
assert.throws(() => submit({ ...body, ...references, reference_audio_urls: ['https://example.com/a.mp3'] }));
assert.equal(submit({ ...body, model: 'seedance2.5-A', image_urls: Array(30).fill(first), reference_video_urls: Array(10).fill('https://example.com/v.mp4'), reference_audio_urls: Array(10).fill('https://example.com/a.mp3') }).body.references.length, 50);
assert.throws(() => submit({ ...body, model: 'seedance2.5-A', image_urls: Array(31).fill(first) }));
assert.equal(plugin.parseTaskResult({ taskId: 'task-1' }, { id: 'task-1', status: 'running' }).status, 'IN_PROGRESS');
for (const status of ['cancelled', 'expired']) assert.equal(plugin.parseTaskResult({ taskId: 'task-1' }, { id: 'task-1', status }).status, 'FAILURE');
globalThis.utils = { fetch(request) {
  assert.equal(request.headers.Authorization, 'Bearer ' + apiKey);
  assert.equal(request.url, baseUrl + '/v1/videos/task-1');
  return { status: 200, body: { id: 'task-1', status: 'completed', data: [{ url: 'https://cdn.example.com/video.mp4' }] } };
} };
assert.deepEqual(plugin.buildContentRequest({ artifactKey: 'video', upstreamTaskId: 'task-1', baseUrl, apiKey, clientRequest: { method: 'GET' } }),
  { url: 'https://cdn.example.com/video.mp4', method: 'GET', credentialless: true });
console.log('Seedance plugin: model limits, references, frame pairs, task status and download passed');
