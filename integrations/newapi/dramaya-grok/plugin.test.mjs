import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8')
const plugin = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const model = 'grok-imagine-video'
const model15 = 'grok-imagine-video-1.5'
const baseUrl = 'https://video.dramaya.us'
const defaults = { model, prompt: 'A blue cup', duration: 8, aspect_ratio: '16:9', resolution: '480p' }
const driver = {
  model, upstreamModel: model, requestBody: defaults, baseUrl, apiKey: 'fixture-key',
  publicTaskId: 'task_gateway_example', files: [], action: 'text_to_video',
}
const cases = []
function add(name, hook, args, expected, expectedError, path) {
  const entry = { name, hook, args, ...(expectedError ? { expectedError } : { expected }), ...(path ? { path } : {}) }
  cases.push(entry)
  return entry
}
function decode(name, request, expected, error, selectedModel = model, kind = 'json') {
  add(name, 'protocols', [{ model: selectedModel, body: { kind, value: request } }], expected, error, ['openai_video', 'decodeRequest'])
}
function intent(body) {
  return { kind: 'submit', model: body.model, action: body.image_urls ? 'image_to_video' : 'text_to_video', requestBody: body }
}

decode('Apply catalog defaults', { model, prompt: defaults.prompt }, intent(defaults))
const imageBody = { ...defaults, model: model15, duration: 15, resolution: '1080p', aspect_ratio: '2:3', image_urls: ['https://images.example/cup.png'] }
decode('Accept 1.5 reference image and 1080p', imageBody, intent(imageBody), undefined, model15)
for (const aspect_ratio of ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']) {
  decode(`Keep aspect ratio ${aspect_ratio}`, { ...defaults, aspect_ratio }, intent({ ...defaults, aspect_ratio }))
}
for (const duration of [1, 15]) decode(`Accept duration boundary ${duration}`, { ...defaults, duration }, intent({ ...defaults, duration }))
for (const duration of [0, -1, 16, 1.5, '8', null, true, 1e100]) {
  decode(`Reject invalid duration ${JSON.stringify(duration)}`, { ...defaults, duration }, undefined, 'duration must be an integer between 1 and 15')
}
decode('Reject 1080p on standard model', { ...defaults, resolution: '1080p' }, undefined, 'Unsupported resolution')
decode('Reject resolution null', { ...defaults, resolution: null }, undefined, 'Unsupported resolution')
decode('Reject unsupported ratio', { ...defaults, aspect_ratio: 'Auto' }, undefined, 'Unsupported aspect_ratio')
decode('Reject standard model images', { ...defaults, image_urls: imageBody.image_urls }, undefined, 'at most 0')
decode('Reject two reference images', { ...imageBody, image_urls: [...imageBody.image_urls, 'https://images.example/second.png'] }, undefined, 'at most 1', model15)
decode('Reject null image list', { ...imageBody, image_urls: null }, undefined, 'at most 1', model15)
for (const url of ['http://images.example/a.png', 'file:///tmp/a.png', 'data:image/png;base64,YQ==', 'https://key@images.example/a.png', 'https://images.example/a b.png', null]) {
  decode(`Reject invalid image URL ${url}`, { ...imageBody, image_urls: [url] }, undefined, 'public HTTPS URLs', model15)
}
for (const field of ['seconds', 'size', 'image', 'reference_images', 'metadata', 'watermark', 'generate_audio']) {
  decode(`Reject undeclared field ${field}`, { ...defaults, [field]: 'unexpected' }, undefined, 'Unsupported field: ' + field)
}
decode('Reject empty prompt', { ...defaults, prompt: '   ' }, undefined, 'prompt must be a non-empty string')
decode('Reject non-object request', [], undefined, 'JSON object required')
decode('Reject unknown model', { ...defaults, model: 'grok-imagine-video-lite' }, undefined, 'Unsupported Dramaya Grok model', 'grok-imagine-video-lite')
decode('Reject prototype model names', { ...defaults, model: '__proto__' }, undefined, 'Unsupported Dramaya Grok model', '__proto__')
decode('Reject multipart input', defaults, undefined, 'requires a JSON body', model, 'multipart')

const headers = { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json', 'Idempotency-Key': 'newapi-task_gateway_example' }
add('Build canonical JSON create request', 'buildSubmitRequest', [driver], { url: baseUrl + '/v1/videos', method: 'POST', headers, body: defaults })
add('Normalize trailing base URL slash', 'buildSubmitRequest', [{ ...driver, baseUrl: baseUrl + '/' }], { url: baseUrl + '/v1/videos', method: 'POST', headers, body: defaults })
add('Build image create request', 'buildSubmitRequest', [{ ...driver, model: model15, upstreamModel: model15, requestBody: imageBody }], { url: baseUrl + '/v1/videos', method: 'POST', headers, body: imageBody })
add('Validate after upstream model mapping', 'buildSubmitRequest', [{ ...driver, model: model15, upstreamModel: model, requestBody: imageBody }], undefined, 'Unsupported resolution')
add('Reject files at driver boundary', 'buildSubmitRequest', [{ ...driver, files: [{ ref: 'request_file:image' }] }], undefined, 'File uploads are not supported')
add('Require stable gateway task identity', 'buildSubmitRequest', [{ ...driver, publicTaskId: '' }], undefined, 'public task id is required')
add('Reject invalid billing quantity at driver boundary', 'buildSubmitRequest', [{ ...driver, requestBody: { ...defaults, duration: -1 } }], undefined, 'duration must be an integer')

const queued = { id: 'video_example', task_id: 'video_example', status: 'queued' }
add('Read documented 202 create response', 'parseSubmitResponse', [driver, { statusCode: 202, body: queued }], { taskId: 'video_example', taskData: queued })
add('Reject missing create id', 'parseSubmitResponse', [driver, { statusCode: 202, body: { request_id: 'wrong-protocol', status: 'queued' } }], undefined, 'missing id')
add('Reject missing create status', 'parseSubmitResponse', [driver, { statusCode: 202, body: { id: 'video_example' } }], undefined, 'unrecognized status')
const complete = { id: 'video_example', status: 'completed' }
add('Honor completed idempotent replay', 'parseSubmitResponse', [driver, { statusCode: 202, body: complete }], { taskId: 'video_example', taskData: complete, immediate: { status: 'SUCCESS', progress: '100%' } })
const failed = { id: 'video_example', status: 'failed', error: { message: 'Provider rejected prompt' } }
add('Honor failed idempotent replay', 'parseSubmitResponse', [driver, { statusCode: 202, body: failed }], { taskId: 'video_example', taskData: failed, immediate: { status: 'FAILURE', reason: 'Provider rejected prompt' } })

add('Expose bounded pricing facts', 'extractUsage', [{ ...driver, usagePurpose: 'facts' }], { seconds: 8, resolution: '480p' })
add('Preserve per-call pricing', 'extractUsage', [{ ...driver, usagePurpose: 'billing_ratios' }], {})
add('Reject billing bypass', 'extractUsage', [{ ...driver, requestBody: { ...defaults, duration: 1e100 } }], undefined, 'duration must be an integer')
add('Accept 1.5 pricing facts', 'extractUsage', [{ ...driver, upstreamModel: model15, requestBody: imageBody, usagePurpose: 'facts' }], { seconds: 15, resolution: '1080p' })

add('Use private upstream id for polling', 'buildQueryRequest', [{ baseUrl, apiKey: 'fixture-key', taskId: 'video_example', publicTaskId: 'task_gateway_example' }], { url: baseUrl + '/v1/videos/video_example', method: 'GET', headers: { Authorization: 'Bearer fixture-key' } })
add('Encode task id path segments', 'buildQueryRequest', [{ baseUrl, apiKey: 'fixture-key', taskId: 'video/a?b' }], { url: baseUrl + '/v1/videos/video%2Fa%3Fb', method: 'GET', headers: { Authorization: 'Bearer fixture-key' } })
add('Reject empty query id', 'buildQueryRequest', [{ baseUrl, taskId: '' }], undefined, 'valid upstream task id')
add('Reject dot segment task id', 'buildQueryRequest', [{ baseUrl, taskId: '..' }], undefined, 'valid upstream task id')
for (const [status, normalized] of Object.entries({ queued: 'QUEUED', pending: 'QUEUED', running: 'IN_PROGRESS', in_progress: 'IN_PROGRESS', processing: 'IN_PROGRESS', cancel_requested: 'IN_PROGRESS' })) {
  add(`Poll ${status}`, 'parseTaskResult', [{ taskId: 'video_example' }, { id: 'video_example', status, progress: 17 }], { status: normalized, progress: '17%' })
}
add('Completion does not require a stored signed URL', 'parseTaskResult', [{ taskId: 'video_example' }, complete], { status: 'SUCCESS', progress: '100%' })
for (const status of ['failed', 'cancelled', 'expired']) {
  add(`Terminate ${status}`, 'parseTaskResult', [{}, { status }], { status: 'FAILURE', reason: 'Dramaya video task ' + status })
}
add('Preserve provider failure message', 'parseTaskResult', [{ taskId: 'video_example' }, failed], { status: 'FAILURE', reason: 'Provider rejected prompt' })
add('Preserve string error', 'parseTaskResult', [{}, { status: 'failed', error: 'Generation rejected' }], { status: 'FAILURE', reason: 'Generation rejected' })
add('Do not infer completion from progress', 'parseTaskResult', [{}, { status: 'running', progress: 100 }], { status: 'IN_PROGRESS', progress: '100%' })
add('Ignore out-of-range progress', 'parseTaskResult', [{}, { status: 'running', progress: 123 }], { status: 'IN_PROGRESS' })
add('Unknown status stays unknown', 'parseTaskResult', [{}, { status: 'new_vendor_status', progress: 100 }], { status: 'UNKNOWN', reason: 'Unrecognized Dramaya task status' })
add('Prototype status stays unknown', 'parseTaskResult', [{}, { status: 'toString' }], { status: 'UNKNOWN', reason: 'Unrecognized Dramaya task status' })
add('Malformed poll stays unknown', 'parseTaskResult', [{}, null], { status: 'UNKNOWN', reason: 'Dramaya task response must be an object' })
add('Reject another task response', 'parseTaskResult', [{ taskId: 'video_example' }, { id: 'different', status: 'completed' }], { status: 'UNKNOWN', reason: 'Dramaya returned a different task id' })

add('List completed content without a CDN URL', 'listArtifacts', [{ status: 'SUCCESS', data: complete }], [{ key: 'video', type: 'video', mimeType: 'video/mp4' }])
add('Do not expose failed artifacts', 'listArtifacts', [{ status: 'FAILURE' }], [])
add('Do not expose running artifacts', 'listArtifacts', [{ status: 'IN_PROGRESS' }], [])
const content = { baseUrl, apiKey: 'fixture-key', artifactKey: 'video', upstreamTaskId: 'video_example', data: { video_url: 'https://expired.example/video.mp4' } }
const signedURL = 'https://storage.example/video.mp4?signature=fixture-only'
function download(name, response, expected, error, method = 'GET') {
  const entry = add(name, 'buildContentRequest', [{ ...content, clientRequest: { method } }], expected, error)
  entry.fetchResponse = response
}
for (const method of ['GET', 'HEAD']) {
  download(`Refresh signed URL and download ${method} without credentials`, { status: 200, body: { ...complete, video_url: signedURL } }, { url: signedURL, method, credentialless: true }, undefined, method)
}
download('Read documented data array result', { status: 200, body: { ...complete, data: [{ url: signedURL, mime_type: 'video/mp4' }] } }, { url: signedURL, method: 'GET', credentialless: true })
download('Read data URL when top-level video URL is empty', { status: 200, body: { ...complete, video_url: '', data: [{ url: signedURL, mime_type: 'video/mp4' }] } }, { url: signedURL, method: 'GET', credentialless: true })
download('Never use stale URL when lookup fails', { status: 503, body: {} }, undefined, 'lookup failed with status 503')
download('Reject upstream auth failure', { status: 401, body: {} }, undefined, 'lookup failed with status 401')
download('Reject credentialed lookup redirect', { status: 302, body: '' }, undefined, 'lookup failed with status 302')
download('Reject missing fresh signed URL', { status: 200, body: complete }, undefined, 'missing a valid HTTPS video URL')
download('Reject unfinished download', { status: 200, body: queued }, undefined, 'not available for download')
download('Reject wrong task on download', { status: 200, body: { ...complete, id: 'wrong_task', video_url: signedURL } }, undefined, 'not available for download')
for (const video_url of ['http://storage.example/video.mp4', 'https://key@storage.example/video.mp4', 'https://storage.example/video.mp4#fragment', 'file:///tmp/video.mp4']) {
  download(`Reject unsafe result URL ${video_url}`, { status: 200, body: { ...complete, video_url } }, undefined, 'missing a valid HTTPS video URL')
}
add('Reject another artifact', 'buildContentRequest', [{ ...content, artifactKey: 'audio', clientRequest: { method: 'GET' } }], undefined, 'artifact_not_found')
add('Reject content mutation', 'buildContentRequest', [{ ...content, clientRequest: { method: 'POST' } }], undefined, 'GET and HEAD only')
add('Do not expose private provider response', 'protocols', [{}, { status: 'SUCCESS', data: { ...complete, status_url: 'https://private.example/video', video_url: 'https://signed.example/video' } }], {}, undefined, ['openai_video', 'render'])
add('Render useful failure', 'protocols', [{}, { status: 'FAILURE', fail_reason: 'Provider rejected prompt' }], { error: { code: 'video_generation_failed', message: 'Provider rejected prompt' } }, undefined, ['openai_video', 'render'])

if (process.argv[2] === '--fixture') {
  // The official dry-run CLI cannot provide utils.fetch. Exercise those cases
  // through the host runtime with WithFetcher instead.
  writeFileSync(process.argv[3], JSON.stringify({ cases: cases.filter(entry => !entry.fetchResponse) }, null, 2) + '\n')
} else if (process.argv[2] === '--runtime-fixture') {
  writeFileSync(process.argv[3], JSON.stringify({ cases }, null, 2) + '\n')
} else {
  test('Plugin metadata uses independent task binding and model-specific pricing', () => {
    assert.equal(plugin.meta.key, 'dramaya-grok')
    assert.equal(plugin.meta.channelTypes, undefined)
    assert.deepEqual(plugin.meta.models, [model, model15])
    assert.deepEqual(plugin.meta.protocols, ['openai_video'])
    assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ['480p', '720p'])
    assert.deepEqual(plugin.meta.usageProfiles[0].schema.resolution.enum, ['480p', '720p', '1080p'])
  })
  for (const entry of cases) {
    test(entry.name, () => {
      let fn = plugin[entry.hook]
      for (const member of entry.path || []) fn = fn[member]
      const args = structuredClone(entry.args)
      let lookups = 0
      globalThis.utils = { fetch(request) {
        assert.ok(entry.fetchResponse, 'Unexpected vendor lookup')
        assert.deepEqual(request, { url: baseUrl + '/v1/videos/video_example', method: 'GET', headers: { Authorization: 'Bearer fixture-key' } })
        lookups++
        return structuredClone(entry.fetchResponse)
      } }
      try {
        if (entry.expectedError) assert.throws(() => fn(...args), error => error.message.includes(entry.expectedError))
        else assert.deepEqual(fn(...args), entry.expected)
      } finally {
        delete globalThis.utils
      }
      assert.equal(lookups, entry.fetchResponse ? 1 : 0)
      assert.deepEqual(args, entry.args, 'Hooks must not mutate host-owned inputs')
    })
  }
  test('Retries keep idempotency while a new task gets a new key', () => {
    const a = plugin.buildSubmitRequest(driver)
    assert.deepEqual(plugin.buildSubmitRequest(driver), a)
    const b = plugin.buildSubmitRequest({ ...driver, publicTaskId: 'task_another' })
    assert.notEqual(a.headers['Idempotency-Key'], b.headers['Idempotency-Key'])
  })
}
