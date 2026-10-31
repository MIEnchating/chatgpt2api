import assert from 'node:assert/strict';
import test from 'node:test';
import { blockNetworkAPIs } from '../src/lib/newapi-video-plugin-dry-run-isolation.ts';

const names = ['XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport'];

test('dry-run worker scope loses every network entry point and cannot get them back', () => {
  const scope = Object.fromEntries(names.map((name) => [name, class {}]));
  const fetchStub = () => 'network';
  scope.fetch = fetchStub;
  blockNetworkAPIs(scope);
  for (const name of names) assert.equal(scope[name], undefined, name);
  assert.throws(() => { scope.WebSocket = class {}; }, TypeError);
  assert.throws(() => Object.defineProperty(scope, 'XMLHttpRequest', { value: class {} }), TypeError);
  scope.fetch = () => 'restored';
  assert.equal(scope.fetch(), 'restored');
});
