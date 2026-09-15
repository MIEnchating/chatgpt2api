"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { flushChanges } = require("../src/flush-changes.cjs");

function renderer(dispatchEvent) {
  return { isDestroyed: () => false, webContents: { executeJavaScript(script) { return Promise.resolve(vm.runInNewContext(script, { window: { dispatchEvent }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } })); } } };
}

test("leaving waits for all renderer saves without exposing privileged APIs", async () => {
  let finish;
  let saved = false;
  const pending = new Promise((resolve) => { finish = resolve; });
  const window = renderer((event) => { assert.equal(event.type, "chatgpt2api:flush-before-leave"); event.detail.push(pending); });
  const flush = flushChanges([window]).then(() => { saved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, false);
  finish();
  await flush;
  assert.equal(saved, true);
  await flushChanges([renderer(() => {})]);
});

test("save failure or timeout prevents a successful close", async () => {
  await assert.rejects(flushChanges([renderer((event) => event.detail.push(Promise.reject(new Error("save failed"))))]), /save failed/);
  await assert.rejects(flushChanges([renderer((event) => event.detail.push(new Promise(() => {})))], 5), /保存画布超时/);
  await flushChanges([{ isDestroyed: () => true }]);
});
