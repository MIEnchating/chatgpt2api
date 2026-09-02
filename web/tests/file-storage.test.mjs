import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectVideoBlobMetadata,
  VIDEO_METADATA_TIMEOUT_MS,
} from "../src/services/file-storage.ts";

function createInspectionHarness({ duration = 3.25, height = 720, width = 1280 } = {}) {
  const calls = {
    clearedTimeouts: [],
    load: 0,
    removedAttributes: [],
    revokedURLs: [],
    timeoutCallback: null,
    timeoutDelayMs: 0,
  };
  const video = {
    duration,
    preload: "",
    src: "",
    videoHeight: height,
    videoWidth: width,
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
    createVideoElement: () => video,
    createObjectURL: () => "blob:uploaded-video",
    revokeObjectURL: (url) => calls.revokedURLs.push(url),
    scheduleTimeout(callback, delayMs) {
      calls.timeoutCallback = callback;
      calls.timeoutDelayMs = delayMs;
      return timeoutHandle;
    },
    clearScheduledTimeout: (handle) => calls.clearedTimeouts.push(handle),
  };
  return { calls, environment, timeoutHandle, video };
}

function assertReleased(harness) {
  assert.deepEqual(harness.calls.clearedTimeouts, [harness.timeoutHandle]);
  assert.deepEqual(harness.calls.removedAttributes, ["src"]);
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:uploaded-video"]);
  assert.equal(harness.video.onloadedmetadata, null);
  assert.equal(harness.video.onerror, null);
}

test("uploaded video metadata uses the local blob and releases browser resources", async () => {
  const harness = createInspectionHarness();
  const pending = inspectVideoBlobMetadata({ size: 2048 }, harness.environment);

  assert.equal(harness.video.preload, "metadata");
  assert.equal(harness.video.src, "blob:uploaded-video");
  harness.video.onloadedmetadata();

  assert.deepEqual(await pending, { width: 1280, height: 720, durationMs: 3250 });
  assertReleased(harness);
});

test("uploaded video metadata times out without leaving the upload pending", async () => {
  const harness = createInspectionHarness();
  const pending = inspectVideoBlobMetadata({ size: 1024 }, harness.environment);
  const lateMetadataHandler = harness.video.onloadedmetadata;

  assert.equal(harness.calls.timeoutDelayMs, VIDEO_METADATA_TIMEOUT_MS);
  harness.calls.timeoutCallback();

  assert.deepEqual(await pending, {});
  assertReleased(harness);

  lateMetadataHandler();
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:uploaded-video"]);
});

test("uploaded video metadata decode errors release resources without fabricating dimensions", async () => {
  const harness = createInspectionHarness();
  const pending = inspectVideoBlobMetadata({ size: 1024 }, harness.environment);

  harness.video.onerror();

  assert.deepEqual(await pending, {});
  assertReleased(harness);
});

test("media-element cleanup failures cannot leave metadata inspection pending", async () => {
  const harness = createInspectionHarness();
  harness.video.load = () => {
    harness.calls.load += 1;
    throw new Error("media element already detached");
  };
  const pending = inspectVideoBlobMetadata({ size: 1024 }, harness.environment);

  harness.video.onerror();

  assert.deepEqual(await pending, {});
  assertReleased(harness);
});

test("all video cleanup failures leave metadata inspection settled", async () => {
  const harness = createInspectionHarness();
  harness.environment.clearScheduledTimeout = () => {
    throw new Error("timer already cleared");
  };
  harness.video.removeAttribute = () => {
    throw new Error("video element already detached");
  };
  harness.environment.revokeObjectURL = () => {
    throw new Error("object URL already revoked");
  };
  const pending = inspectVideoBlobMetadata({ size: 1024 }, harness.environment);

  assert.doesNotThrow(() => harness.video.onerror());
  assert.deepEqual(await pending, {});
  assert.equal(harness.video.onloadedmetadata, null);
  assert.equal(harness.video.onerror, null);
});

test("video timer setup failures still release browser resources", async () => {
  const harness = createInspectionHarness();
  harness.environment.scheduleTimeout = () => {
    throw new Error("timer unavailable");
  };

  assert.deepEqual(
    await inspectVideoBlobMetadata({ size: 1024 }, harness.environment),
    {},
  );
  assert.deepEqual(harness.calls.removedAttributes, ["src"]);
  assert.equal(harness.calls.load, 1);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:uploaded-video"]);
  assert.equal(harness.video.onloadedmetadata, null);
  assert.equal(harness.video.onerror, null);
});
