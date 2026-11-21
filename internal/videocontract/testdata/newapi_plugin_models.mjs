import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runNewAPIVideoPluginDryRun } from '../../../web/src/lib/newapi-video-plugin-checks.ts';

const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const plugins = {};
for (const [name, fixture] of Object.entries(fixtures)) {
  plugins[name] = await import(`data:text/javascript;base64,${Buffer.from(fixture.source).toString('base64')}`);
}
assert.equal(plugins.static.meta.relay, undefined);
assert.equal(plugins.static.convertResponse, undefined);
for (const name of ['standard', 'custom', 'header', 'public']) {
  const plugin = plugins[name];
  const route = { incoming_path: '/v1/models', upstream_path: name === 'custom' ? '/models' : '/v1/models', converter: 'plugin' };
  if (name === 'header') route.auth = { type: 'header', name: 'X-API-Key', value: '{api_key}' };
  if (name === 'public') route.auth = { type: 'none' };
  assert.deepEqual(plugin.meta.relay, [route]);
  const supported = { id: 'grok-imagine-video', object: 'model', owned_by: 'fixture-provider' };
  const list = [supported, { id: 'grok-imagine-video-1.5' }, { id: 'text-model' }, null, {}, { id: 1 }];
  const response = { status: 200, body: JSON.stringify({ object: 'list', data: list }) };
  assert.deepEqual(plugin.convertResponse({}, response), { body: { object: 'list', data: [supported] } });
  assert.deepEqual(plugin.convertResponse({}, { status: 200, body: '{"data":[]}' }), { body: { object: 'list', data: [] } });
  assert.deepEqual(plugin.convertResponse({}, { status: 200, body: '{"data":[{"id":"text-model"}]}' }), { body: { object: 'list', data: [] } });
  for (const status of [401, 403, 404, 429, 500]) {
    const result = plugin.convertResponse({}, { status, body: 'private-upstream-body' });
    assert.equal(result.error.status, status);
    assert.equal(JSON.stringify(result).includes('private-upstream-body'), false);
  }
  assert.equal(plugin.convertResponse({}, { status: 302, body: '' }).error.status, 502);
  for (const body of ['{', '{}', 'null', '[]', '{"data":{}}']) {
    assert.throws(() => plugin.convertResponse({}, { status: 200, body }), /模型列表/);
  }
  assert.equal(plugin.convertRequest, undefined);
  assert.equal(plugin.convertStreamEvent, undefined);
  assert.ok(runNewAPIVideoPluginDryRun(plugin, fixtures[name]).includes('上游模型发现与契约过滤'));
  assert.throws(() => runNewAPIVideoPluginDryRun({ ...plugin, convertResponse: () => ({ body: { object: 'list', data: list } }) }, fixtures[name]), /模型/);
}
console.log('model listing routes, authentication, contract filtering, upstream errors and browser dry-run checks passed');
