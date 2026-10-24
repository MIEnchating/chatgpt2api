import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sources = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const plugins = {};
for (const [name, source] of Object.entries(sources)) {
  plugins[name] = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
let checks = 0;
function check(name, run) {
  try { run(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const model = 'grok-imagine-video';
const enhanced = 'grok-imagine-video-1.5';
const baseUrl = 'https://video.example.com';
const key = 'fixture-key';
const body = { model, prompt: 'A blue cup' };
const ctx = requestBody => ({ requestBody, upstreamModel: requestBody.model, model: requestBody.model, baseUrl, apiKey: key, files: [] });
const plugin = plugins.dramaya;
const submit = (p, value) => p.buildSubmitRequest(ctx(value));
const decode = (p, value) => p.protocols.openai_video.decodeRequest({ model: value.model, body: { kind: 'json', value } });
const defaults = { model, prompt: body.prompt, duration: 8, aspect_ratio: '16:9', resolution: '480p' };

check('metadata', () => {
  assert.deepEqual(plugin.meta.models, [model, enhanced]);
  assert.deepEqual(plugin.meta.protocols, ['openai_video']);
  assert.equal(plugin.meta.routes, undefined);
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ['480p', '720p']);
  assert.deepEqual(plugin.meta.usageProfiles[0].schema.resolution.enum, ['480p', '720p', '1080p']);
});
check('optional default URL and channel override', () => {
  assert.equal(Object.hasOwn(plugins['no-base'].meta, 'baseUrl'), false);
  assert.equal(plugin.meta.auth, 'api_key');
  assert.equal(plugins.public.meta.auth, 'none');
  for (const candidate of [plugin, plugins['no-base']]) {
    const override = {...ctx(body), baseUrl:'http://channel.example:3000/proxy'};
    assert.equal(candidate.buildSubmitRequest(override).url, override.baseUrl+'/v1/videos');
    assert.equal(candidate.buildQueryRequest({...override,taskId:'task-1'}).url, override.baseUrl+'/v1/videos/task-1');
    assert.throws(()=>candidate.buildSubmitRequest({...override,baseUrl:''}), /渠道中配置上游地址/);
  }
});
check('mapped model decode preserves alias and validates upstream profile', () => {
  const alias = 'client-alias';
  const value = {...body,model:alias,resolution:'1080p'};
  const context = {model:alias,upstreamModel:enhanced,body:{kind:'json',value}};
  const first = plugin.protocols.openai_video.decodeRequest(context);
  assert.equal(first.model,alias);
  assert.deepEqual(plugin.protocols.openai_video.decodeRequest(context),first);
  assert.deepEqual(context.body.value,value);
  assert.equal(plugin.buildSubmitRequest({...ctx(value),upstreamModel:enhanced,requestBody:first.requestBody}).body.model,enhanced);
  assert.deepEqual(plugin.extractUsage({...ctx(value),upstreamModel:enhanced}), {seconds:8,resolution:'1080p'});
  assert.throws(()=>plugin.protocols.openai_video.decodeRequest({...context,upstreamModel:model}));
});
check('vendor endpoint ID uses client capability profile', () => {
  const value={...body,model:enhanced,resolution:'1080p'};
  const upstreamModel='provider-endpoint-123';
  const intent=plugin.protocols.openai_video.decodeRequest({model:enhanced,upstreamModel,body:{kind:'json',value}});
  const context={...ctx(value),upstreamModel,requestBody:intent.requestBody};
  assert.equal(intent.model,enhanced);
  assert.equal(plugin.buildSubmitRequest(context).body.model,upstreamModel);
  assert.deepEqual(plugin.extractUsage(context),{seconds:8,resolution:'1080p'});
});
check('default generation request', () => {
  const request = submit(plugin, body);
  assert.deepEqual(request.body, defaults);
  assert.equal(request.url, baseUrl + '/v1/videos');
  assert.equal(request.headers.Authorization, 'Bearer ' + key);
  assert.deepEqual(decode(plugin, body).requestBody, body);
});
for (const duration of [1, 15]) check(`duration ${duration}`, () => assert.equal(submit(plugin, { ...body, duration }).body.duration, duration));
for (const duration of [0, 16, 1.5, '8', null, true]) check(`invalid duration ${duration}`, () => assert.throws(() => submit(plugin, { ...body, duration })));
for (const aspect_ratio of ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']) check(`ratio ${aspect_ratio}`, () => assert.equal(submit(plugin, { ...body, aspect_ratio }).body.aspect_ratio, aspect_ratio));
check('ordinary model rejects 1080p', () => assert.throws(() => submit(plugin, { ...body, resolution: '1080p' })));
check('enhanced model supports 1080p and image', () => {
  const image_urls = ['https://images.example.com/cup.png'];
  const input = { ...body, model: enhanced, resolution: '1080p', image_urls };
  assert.deepEqual(submit(plugin, input).body.image_urls, image_urls);
  assert.equal(decode(plugin, input).action, 'image_to_video');
});
check('too many images', () => assert.throws(() => submit(plugin, { ...body, model: enhanced, image_urls: ['https://images.example/1', 'https://images.example/2'] })));
check('reject image on ordinary model', () => assert.throws(() => submit(plugin, { ...body, image_urls: ['https://images.example/1'] })));
for (const image of ['file:///tmp/image', 'https://secret@images.example/image', 'data:image/png;base64,YQ==', 1]) check(`invalid image ${image}`, () => assert.throws(() => submit(plugin, { ...body, model: enhanced, image_urls: [image] })));
for (const unknown of ['seconds', 'size', 'api_key', 'metadata']) check(`reject unknown ${unknown}`, () => assert.throws(() => submit(plugin, { ...body, [unknown]: 'ignored' })));
check('reject prototype field', () => assert.throws(() => submit(plugin, JSON.parse('{"model":"grok-imagine-video","prompt":"cup","__proto__":{"x":true}}'))));
check('reject file upload', () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx(body), files: [{}] })));
check('reject missing channel credential', () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx(body), apiKey: '' })));
check('mapped upstream capability revalidation', () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx({ ...body, model: enhanced, resolution: '1080p' }), upstreamModel: model })));
check('usage facts', () => assert.deepEqual(plugin.extractUsage({ ...ctx(body), usagePurpose: 'facts' }), { seconds: 8, resolution: '480p' }));
check('per-call ratios', () => assert.deepEqual(plugin.extractUsage({ ...ctx(body), usagePurpose: 'billing_ratios' }), {}));
check('submit without status', () => assert.deepEqual(plugin.parseSubmitResponse({}, { body: { id: 'vendor-id' } }), { taskId: 'vendor-id', taskData: { id: 'vendor-id' } }));
check('submit immediate completion', () => assert.equal(plugin.parseSubmitResponse({}, { body: { id: 'vendor-id', status: 'completed' } }).immediate.status, 'SUCCESS'));
for (const status of ['unexpected', null, 200]) check(`reject invalid submit status ${status}`, () => assert.throws(() => plugin.parseSubmitResponse({}, { body: { id: 'vendor-id', status } })));
for (const [status, expected] of [['queued', 'QUEUED'], ['pending', 'IN_PROGRESS'], ['cancel_requested', 'IN_PROGRESS'], ['completed', 'SUCCESS'], ['failed', 'FAILURE'], ['expired', 'FAILURE']]) {
  check(`poll ${status}`, () => assert.equal(plugin.parseTaskResult({ taskId: 'vendor-id' }, { id: 'vendor-id', status }).status, expected));
}
check('unknown status', () => assert.equal(plugin.parseTaskResult({}, { status: 'new-status' }).status, 'UNKNOWN'));
check('wrong task id', () => assert.equal(plugin.parseTaskResult({ taskId: 'vendor-id' }, { id: 'other-id', status: 'completed' }).status, 'UNKNOWN'));
check('progress does not complete task', () => assert.equal(plugin.parseTaskResult({}, { status: 'running', progress: '100%' }).status, 'IN_PROGRESS'));
check('encode private task path', () => assert.equal(plugin.buildQueryRequest({ ...ctx(body), taskId: 'private/a?b' }).url, baseUrl + '/v1/videos/private%2Fa%3Fb'));
check('reject invalid task id', () => assert.throws(() => plugin.buildQueryRequest({ ...ctx(body), taskId: '..' })));
check('render does not leak upstream data', () => assert.deepEqual(plugin.protocols.openai_video.render({}, { status: 'SUCCESS', data: { api_key: key, video_url: 'https://private.example/video' } }), {}));
check('nonterminal artifacts', () => assert.deepEqual(plugin.listArtifacts({ status: 'IN_PROGRESS' }), []));

const signedURL = 'https://cdn.example/video.mp4?signature=fixture';
const content = { baseUrl, apiKey: key, upstreamTaskId: 'vendor-id', artifactKey: 'video', clientRequest: { method: 'GET' }, data: { video_url: 'https://expired.example/video' } };
let response = { status: 200, body: { id: 'vendor-id', status: 'completed', video_url: signedURL } };
let requests = [];
globalThis.utils = { fetch: request => { requests.push(request); return response; } };
check('signed download refreshes with key and downloads without key', () => {
  const result = plugin.buildContentRequest(content);
  assert.equal(requests[0].headers.Authorization, 'Bearer ' + key);
  assert.equal(requests[0].url, baseUrl + '/v1/videos/vendor-id');
  assert.deepEqual(result, { url: signedURL, method: 'GET', credentialless: true });
});
check('HEAD uses GET lookup and HEAD content', () => {
  requests = [];
  assert.equal(plugin.buildContentRequest({ ...content, clientRequest: { method: 'HEAD' } }).method, 'HEAD');
  assert.equal(requests[0].method, 'GET');
});
for (const status of [302, 401, 503]) check(`lookup error ${status} never reuses stale URL`, () => {
  response = { status, body: {} };
  assert.throws(() => plugin.buildContentRequest(content));
});
check('HTTP result URLs use the host credentialless transport', () => {
  const video_url='http://cdn.example/video';
  response={status:200,body:{id:'vendor-id',status:'completed',video_url}};
  assert.deepEqual(plugin.buildContentRequest(content),{url:video_url,method:'GET',credentialless:true});
});
for (const video_url of ['https://secret@cdn.example/video', 'ftp://cdn.example/video', 'https://cdn.example/video#fragment', '']) check(`unsafe media ${video_url}`, () => {
  response = { status: 200, body: { id: 'vendor-id', status: 'completed', video_url } };
  assert.throws(() => plugin.buildContentRequest(content));
});
check('wrong download task', () => {
  response = { status: 200, body: { id: 'wrong-id', status: 'completed', video_url: signedURL } };
  assert.throws(() => plugin.buildContentRequest(content));
});
check('result JSON path array', () => {
  response = { status: 200, body: { id: 'vendor-id', status: 'completed', data: [{ url: signedURL }] } };
  assert.equal(plugin.buildContentRequest(content).url, signedURL);
});
check('explicit content mode', () => {
  const before = requests.length;
  assert.deepEqual(plugins.content.buildContentRequest(content), { url: baseUrl + '/v1/videos/vendor-id/content', method: 'GET', headers: { Authorization: 'Bearer ' + key } });
  assert.equal(requests.length, before);
});
check('custom header mode', () => {
  assert.equal(submit(plugins.header, body).headers['X-API-Key'], key);
  assert.equal(plugins.header.buildContentRequest(content).headers['X-API-Key'], key);
});
check('no authentication mode', () => {
  assert.equal(submit(plugins.public, body).headers.Authorization, undefined);
  assert.equal(plugins.public.buildContentRequest({ ...content, apiKey: '' }).credentialless, true);
});
check('nested request mapping and string duration', () => {
  const input = { ...body, model: enhanced, input: { settings: { duration: '5' }, media: [{ urls: ['https://images.example/cup'] }] } };
  assert.equal(submit(plugins.nested, input).body.input.settings.duration, '5');
  assert.equal(submit(plugins.nested, input).body.input.media[0].urls.length, 1);
  assert.throws(() => submit(plugins.nested, { ...input, input: { ...input.input, unknown: 'drop' } }));
});
check('nested JSON-encoded response', () => {
  response = { status: 200, body: { data: JSON.stringify({ task_id: 'vendor-id', state: 'completed', output: { videos: [signedURL] } }) } };
  assert.equal(plugins.nested.buildContentRequest(content).url, signedURL);
});
check('forced rules run once across decode and submit', () => {
  const decoded = decode(plugins.rules, body);
  const submitted = plugins.rules.buildSubmitRequest(ctx(decoded.requestBody));
  assert.equal(submitted.body.duration, 9);
  assert.equal(plugins.rules.extractUsage(ctx(decoded.requestBody)).seconds, 9);
});
check('conditional required material', () => assert.throws(() => submit(plugins.rules, { ...body, model: enhanced, resolution: '1080p' }), /requires reference image/));
delete globalThis.utils;
console.log(`${checks} generated-plugin runtime checks passed across ${Object.keys(plugins).length} configurations`);
