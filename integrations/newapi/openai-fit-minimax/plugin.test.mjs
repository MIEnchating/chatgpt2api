import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test, { after } from 'node:test';

const source = readFileSync(new URL('./openai-fit-minimax-video-1.2.0.js', import.meta.url));
const plugin = await import(`data:text/javascript;base64,${source.toString('base64')}`);
const document = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url)));
const models = JSON.parse(readFileSync(new URL('./source-models.json', import.meta.url))).models;
const cases = [];
const context = body => ({ requestBody: body, model: body.model, upstreamModel: body.model, baseUrl: 'https://channel.example.com', apiKey: 'fixture-key', files: [] });
const image = index => `https://media.example.com/image-${index}.jpg`;
const audio = index => `https://media.example.com/audio-${index}.mp3`;
function checkSubmit(name, ctx, body) {
  const expected = { url: 'https://channel.example.com/v1/videos', method: 'POST', headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' }, body };
  assert.deepEqual(plugin.buildSubmitRequest(ctx), expected);
  cases.push({ name, hook: 'buildSubmitRequest', args: [ctx], expected });
}
function checkReject(name, ctx, message) {
  assert.throws(() => plugin.buildSubmitRequest(ctx), error => new RegExp(message).test(error.message));
  cases.push({ name, hook: 'buildSubmitRequest', args: [ctx], expectedError: message });
}

test('one standalone plugin embeds one MiniMax contract with five model profiles', () => {
  assert.equal(plugin.meta.key, 'openai-fit-minimax');
	assert.equal(plugin.meta.version, '1.2.0');
  assert.equal(plugin.meta.baseUrl, 'https://openai.fit');
  assert.equal(plugin.meta.auth, 'api_key');
  assert.deepEqual(plugin.meta.protocols, ['openai_video']);
  assert.deepEqual(plugin.meta.models, models.map(row => row.model_name));
	assert.equal(document.contracts.length, 1);
	assert.equal(document.contracts[0].contract.model_profiles.length, 5);
  assert.equal(plugin.meta.usageProfiles.length, 4);
  for (const model of ['minimax H3 768 Spica', 'minimax-h3-chovy', 'minimax-H3-super']) {
    const profile = plugin.meta.usageProfiles.find(item => item.models.includes(model));
    assert.equal(profile.schema.count.unit, 'count');
    assert.equal(profile.schema.count.unitLabel.zh, '条');
    assert.equal(profile.schema.seconds, undefined);
  }
  assert.equal(plugin.meta.usageSchema.seconds.unit, 'second');
  assert.doesNotMatch(source.toString(), /^import\s/m);
});

for (const { contract } of document.contracts) {
 for (const profile of contract.model_profiles) {
  const model = profile.model;
  const cap = profile.capability;
  const self = model === 'minimax H3-self';
  const perCall = ['minimax H3 768 Spica', 'minimax-h3-chovy', 'minimax-H3-super'].includes(model);
  const base = { model, prompt: 'A cloud moving slowly' };
  const output = (seconds, ratio, resolution, extra = {}) => self
    ? { ...base, seconds, resolution: resolution + (ratio === '9:16' ? '竖' : '横'), ...extra }
    : { ...base, seconds, ratio, resolution, ...extra };

  test(`${model}: defaults and every duration, resolution and ratio`, () => {
    checkSubmit(`${model} defaults`, context(base), output(cap.default_seconds, cap.default_size, cap.default_resolution));
    const seconds = cap.seconds_range ? Array.from({ length: cap.seconds_range.max - cap.seconds_range.min + 1 }, (_, i) => cap.seconds_range.min + i) : cap.seconds;
    for (const duration of seconds) for (const resolution of cap.resolutions) for (const ratio of cap.sizes) {
      const body = { ...base, seconds: duration, resolution, ratio };
      checkSubmit(`${model} ${duration}s ${resolution} ${ratio}`, context(body), output(duration, ratio, resolution));
    }
    for (const duration of [0, 16, 5.5, '15', null]) checkReject(`${model} rejects duration ${duration}`, context({ ...base, seconds: duration }), '时长');
    for (const field of ['duration', 'size', 'metadata', 'ref_audio_0', 'first_frame', 'watermark', 'seed']) {
      checkReject(`${model} rejects ${field}`, context({ ...base, [field]: 'unknown' }), '未声明');
    }
    checkReject(`${model} rejects resolution case`, context({ ...base, resolution: '768P-not-valid' }), '清晰度');
    checkReject(`${model} rejects ratio`, context({ ...base, ratio: 'adaptive' }), '画幅');
    checkReject(`${model} empty prompt`, context({ ...base, prompt: ' ' }), '提示词');
  });

  test(`${model}: reference encoding, material limits and billing facts`, () => {
    const images = Array.from({ length: cap.references.image }, (_, i) => image(i));
    const body = { ...base, image_urls: images };
    const extra = self ? Object.fromEntries(images.map((url, i) => [`ref_image_${i}`, url])) : { image_urls: images };
    checkSubmit(`${model} maximum images`, context(body), output(cap.default_seconds, cap.default_size, cap.default_resolution, extra));
    assert.equal(body.image_urls.length, cap.references.image);
    checkReject(`${model} too many images`, context({ ...body, image_urls: [...images, image(10)] }), '素材');
    checkReject(`${model} rejects video`, context({ ...base, video_urls: ['https://media.example.com/v.mp4'] }), '未声明');
    const audios = Array.from({ length: cap.references.audio }, (_, i) => audio(i));
    if (audios.length) {
      checkSubmit(`${model} maximum audio and image`, context({ ...body, audio_urls: audios }), output(cap.default_seconds, cap.default_size, cap.default_resolution, { image_urls: images, audio_urls: audios }));
      checkReject(`${model} too many audios`, context({ ...body, audio_urls: [...audios, audio(4)] }), '素材');
    } else checkReject(`${model} rejects audio`, context({ ...base, audio_urls: [audio(0)] }), '未声明');
    if (!self) checkReject(`${model} requires HTTPS`, context({ ...base, image_urls: ['http://media.example.com/a.jpg'] }), 'HTTPS');
    checkReject(`${model} rejects local path`, context({ ...base, image_urls: ['/tmp/image.jpg'] }), 'URL');
    if (self) {
      checkSubmit(`${model} accepts inline Base64`, context({ ...base, image_urls: ['data:image/png;base64,YQ=='] }), output(cap.default_seconds, cap.default_size, cap.default_resolution, { ref_image_0: 'data:image/png;base64,YQ==' }));
      checkReject(`${model} rejects malformed Base64`, context({ ...base, image_urls: ['data:image/png;base64,@@@'] }), 'Base64');
      checkReject(`${model} rejects wrong Base64 media type`, context({ ...base, image_urls: ['data:video/mp4;base64,YQ=='] }), '类型');
    } else checkReject(`${model} rejects inline base64`, context({ ...base, image_urls: ['data:image/png;base64,YQ=='] }), 'URL');
    const ctx = { ...context(body), usagePurpose: 'facts' };
    const expected = perCall
      ? { count: 1, resolution: cap.default_resolution }
      : { seconds: cap.default_seconds, resolution: cap.default_resolution };
    assert.deepEqual(plugin.extractUsage(ctx), expected);
    cases.push({ name: `${model} billing facts`, hook: 'extractUsage', args: [ctx], expected });
    assert.deepEqual(plugin.extractUsage({ ...ctx, usagePurpose: 'billing_ratios' }), {});
  });
 }
}

test('Spica requires an image with audio; Chovy audio placeholders must exist', () => {
  checkReject('Spica audio alone', context({ model: 'minimax H3 768 Spica', prompt: 'Cloud', audio_urls: [audio(0)] }), '搭配参考图');
  checkReject('Chovy missing referenced audio', context({ model: 'minimax-h3-chovy', prompt: 'Say <Audio 2>', audio_urls: [audio(0)] }), '缺少对应素材');
  const body = { model: 'minimax-h3-chovy', prompt: 'Say <Audio 1>', audio_urls: [audio(0)] };
  checkSubmit('Chovy audio alone with matching placeholder', context(body), { ...body, seconds: 15, ratio: '9:16', resolution: '480P' });
});

test('Chovy accepts case-insensitive resolution input and emits the declared spelling', () => {
  const body = { model: 'minimax-h3-chovy', prompt: 'Cloud', resolution: '480p' };
  checkSubmit('Chovy canonical resolution', context(body), { ...body, seconds: 15, ratio: '9:16', resolution: '480P' });
});

test('H3-self multipart keeps opaque file references and assigns all nine numbered fields', () => {
  const model = 'minimax H3-self';
  const files = Array.from({ length: 9 }, (_, i) => ({ ref: `opaque-${i}`, field: 'image_urls', filename: `${i}.png`, mimeType: 'image/png' }));
  const ctx = { model, upstreamModel: model, body: { kind: 'multipart', fields: { model: [model], prompt: ['Cloud'], seconds: ['10'], ratio: ['16:9'], resolution: ['480p'] }, files } };
  const decoded = plugin.protocols.openai_video.decodeRequest(ctx);
  assert.deepEqual(decoded, { kind: 'submit', model, action: 'image_to_video', requestBody: { model, prompt: 'Cloud', seconds: 10, ratio: '16:9', resolution: '480p', image_urls: files.map(file => file.ref) } });
  cases.push({ name: 'self decode multipart', hook: 'protocols', path: ['openai_video', 'decodeRequest'], args: [ctx], expected: decoded });
  const args = [{ ...context(decoded.requestBody), files }];
  const expected = { url: 'https://channel.example.com/v1/videos', method: 'POST', headers: { Authorization: 'Bearer fixture-key' }, bodyType: 'multipart', parts: [
    ...files.map((file, i) => ({ name: `ref_image_${i}`, fileRef: file.ref, filename: file.filename })),
    { name: 'model', value: model }, { name: 'prompt', value: 'Cloud' }, { name: 'seconds', value: '10' }, { name: 'resolution', value: '480p横' },
  ] };
  assert.deepEqual(plugin.buildSubmitRequest(...args), expected);
  cases.push({ name: 'self numbered multipart', hook: 'buildSubmitRequest', args, expected });
  checkReject('self mixed URL and file', { ...args[0], requestBody: { ...decoded.requestBody, image_urls: ['opaque-0', image(0)] }, files: files.slice(0, 1) }, '混传');
  for (const model of plugin.meta.models.filter(model => model !== 'minimax H3-self')) {
    checkReject(`${model} rejects files`, { ...context({ model, prompt: 'Cloud' }), files: files.slice(0, 1) }, '不接受文件');
  }
});

test('mapped models preserve client identity and use upstream capabilities', () => {
  const body = { model: 'client-alias', prompt: 'Cloud', resolution: '1088P' };
  const ctx = { model: body.model, upstreamModel: 'minimax-h3-chovy', body: { kind: 'json', value: body } };
  const expected = { kind: 'submit', model: 'client-alias', action: 'text_to_video', requestBody: body };
  assert.deepEqual(plugin.protocols.openai_video.decodeRequest(ctx), expected);
  cases.push({ name: 'mapped decode', hook: 'protocols', path: ['openai_video', 'decodeRequest'], args: [ctx], expected });
  checkSubmit('mapped submit', { ...context(body), upstreamModel: 'minimax-h3-chovy' }, { model: 'minimax-h3-chovy', prompt: 'Cloud', seconds: 15, ratio: '9:16', resolution: '1088P' });
  checkReject('unlisted model', context({ model: 'minimax H3-MAX', prompt: 'Cloud' }), '不属于');
  checkReject('missing channel key', { ...context({ model: 'minimax H3', prompt: 'Cloud' }), apiKey: '' }, '密钥');
});

test('submission, polling, errors, artifacts and authenticated GET/HEAD downloads', () => {
  const submit = { body: { id: 'task_provider', status: 'queued' } };
  const submitted = { taskId: 'task_provider', taskData: submit.body };
  assert.deepEqual(plugin.parseSubmitResponse({}, submit), submitted);
  cases.push({ name: 'parse submission', hook: 'parseSubmitResponse', args: [{}, submit], expected: submitted });
  const ctx = { ...context({ model: 'minimax H3-self' }), taskId: 'task_provider' };
  const query = { url: 'https://channel.example.com/v1/videos/task_provider', method: 'GET', headers: { Authorization: 'Bearer fixture-key' } };
  assert.deepEqual(plugin.buildQueryRequest(ctx), query);
  cases.push({ name: 'query channel URL', hook: 'buildQueryRequest', args: [ctx], expected: query });
  for (const [state, status] of Object.entries({ queued: 'QUEUED', in_progress: 'IN_PROGRESS', completed: 'SUCCESS', failed: 'FAILURE' })) {
    const body = { id: 'task_provider', status: state, progress: 50, error: { message: 'provider failure' } };
    const expected = { status, progress: state === 'completed' ? '100%' : '50%', ...(state === 'failed' ? { reason: 'provider failure' } : {}) };
    assert.deepEqual(plugin.parseTaskResult(ctx, body), expected);
    cases.push({ name: `state ${state}`, hook: 'parseTaskResult', args: [ctx, body], expected });
  }
  assert.equal(plugin.parseTaskResult(ctx, { status: 'invented' }).status, 'UNKNOWN');
  assert.equal(plugin.parseTaskResult(ctx, { id: 'another', status: 'completed' }).status, 'UNKNOWN');
  assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS' }), [{ key: 'video', type: 'video', mimeType: 'video/mp4' }]);
  assert.deepEqual(plugin.listArtifacts({ status: 'IN_PROGRESS' }), []);
  for (const method of ['GET', 'HEAD']) {
    const ctx = { ...context({}), upstreamTaskId: 'task_provider', taskId: 'task_public', artifactKey: 'video', clientRequest: { method } };
    const expected = { url: 'https://channel.example.com/v1/videos/task_provider/content', method, headers: { Authorization: 'Bearer fixture-key' } };
    assert.deepEqual(plugin.buildContentRequest(ctx), expected);
    cases.push({ name: `${method} content`, hook: 'buildContentRequest', args: [ctx], expected });
  }
});

after(() => {
  const index = process.argv.indexOf('--fixture');
  if (index >= 0) writeFileSync(process.argv[index + 1], JSON.stringify({ cases }, null, 2) + '\n');
});
