import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_REFERENCE_METADATA_TIMEOUT_MS,
  inspectAudioReferenceFile,
} from "../src/lib/audio-reference-file.ts";

function createInspectionHarness(duration = 3.25) {
  const calls = {
    clearedTimeouts: [],
    load: 0,
    removedAttributes: [],
    revokedURLs: [],
    timeoutCallback: null,
    timeoutDelayMs: 0,
  };
  const audio = {
    duration,
    preload: "",
    src: "",
    onerror: null,
    onloadedmetadata: null,
    load() {
      calls.load += 1;
    },
    removeAttribute(name) {
      calls.removedAttributes.push(name);
      if (name === "src") this.src = "";
    },
  };
  const timeoutHandle = { id: "metadata-timeout" };
  const environment = {
    createAudioElement: () => audio,
    createObjectURL: () => "blob:audio-reference",
    revokeObjectURL: (url) => calls.revokedURLs.push(url),
    scheduleTimeout(callback, delayMs) {
      calls.timeoutCallback = callback;
      calls.timeoutDelayMs = delayMs;
      return timeoutHandle;
    },
    clearScheduledTimeout: (handle) => calls.clearedTimeouts.push(handle),
  };
  return { audio, calls, environment, timeoutHandle };
}

test("audio reference metadata resolves and releases browser resources", async () => {
  const harness = createInspectionHarness();
  const pending = inspectAudioReferenceFile({ size: 2048 }, harness.environment);

  assert.equal(harness.audio.preload, "metadata");
  assert.equal(harness.audio.src, "blob:audio-reference");
  harness.audio.onloadedmetadata();

  assert.deepEqual(await pending, { durationMs: 3250, bytes: 2048 });
  assert.deepEqual(harness.calls.clearedTimeouts, [harness.timeoutHandle]);
  assert.deepEqual(harness.calls.removedAttributes, ["src"]);
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:audio-reference"]);
  assert.equal(harness.audio.onloadedmetadata, null);
  assert.equal(harness.audio.onerror, null);
});

test("audio reference metadata times out and releases browser resources", async () => {
  const harness = createInspectionHarness();
  const pending = inspectAudioReferenceFile({ size: 1024 }, harness.environment);
  const lateMetadataHandler = harness.audio.onloadedmetadata;

  assert.equal(harness.calls.timeoutDelayMs, AUDIO_REFERENCE_METADATA_TIMEOUT_MS);
  harness.calls.timeoutCallback();

  await assert.rejects(pending, /读取参考音频信息超时/);
  assert.deepEqual(harness.calls.clearedTimeouts, [harness.timeoutHandle]);
  assert.deepEqual(harness.calls.removedAttributes, ["src"]);
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:audio-reference"]);

  lateMetadataHandler();
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:audio-reference"]);
});

test("audio reference metadata rejects decoding errors and releases browser resources", async () => {
  const harness = createInspectionHarness();
  const pending = inspectAudioReferenceFile({ size: 1024 }, harness.environment);

  harness.audio.onerror();

  await assert.rejects(pending, /请确认文件编码可用/);
  assert.deepEqual(harness.calls.clearedTimeouts, [harness.timeoutHandle]);
  assert.deepEqual(harness.calls.removedAttributes, ["src"]);
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:audio-reference"]);
});

test("audio cleanup failures cannot replace a successful metadata result", async () => {
  const harness = createInspectionHarness();
  harness.environment.clearScheduledTimeout = () => {
    throw new Error("timer already cleared");
  };
  harness.audio.removeAttribute = () => {
    throw new Error("audio element already detached");
  };
  harness.environment.revokeObjectURL = () => {
    throw new Error("object URL already revoked");
  };
  const pending = inspectAudioReferenceFile({ size: 2048 }, harness.environment);

  assert.doesNotThrow(() => harness.audio.onloadedmetadata());
  assert.deepEqual(await pending, { durationMs: 3250, bytes: 2048 });
  assert.equal(harness.audio.onloadedmetadata, null);
  assert.equal(harness.audio.onerror, null);
});

test("audio timer setup failures still release browser resources", async () => {
  const harness = createInspectionHarness();
  harness.environment.scheduleTimeout = () => {
    throw new Error("timer unavailable");
  };
  const pending = inspectAudioReferenceFile({ size: 2048 }, harness.environment);

  await assert.rejects(pending, /请确认文件编码可用/);
  assert.deepEqual(harness.calls.removedAttributes, ["src"]);
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:audio-reference"]);
  assert.equal(harness.audio.onloadedmetadata, null);
  assert.equal(harness.audio.onerror, null);
});
