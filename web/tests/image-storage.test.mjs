import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGE_METADATA_TIMEOUT_MS,
  inspectImageBlobMetadata,
  uploadImageToServer,
} from "../src/services/image-storage.ts";

function createMetadataHarness({ height = 720, width = 1280 } = {}) {
  const calls = {
    clearedTimeouts: [],
    removedAttributes: [],
    revokedURLs: [],
    timeoutCallback: null,
    timeoutDelayMs: 0,
  };
  const image = {
    naturalHeight: height,
    naturalWidth: width,
    onerror: null,
    onload: null,
    src: "",
    removeAttribute(name) {
      calls.removedAttributes.push(name);
      if (name === "src") this.src = "";
    },
  };
  const timeoutHandles = [];
  const environment = {
    createImageElement: () => image,
    createObjectURL: () => "blob:uploaded-image",
    revokeObjectURL: (url) => calls.revokedURLs.push(url),
    scheduleTimeout(callback, delayMs) {
      calls.timeoutCallback = callback;
      calls.timeoutDelayMs = delayMs;
      const handle = { id: `metadata-timeout-${timeoutHandles.length + 1}` };
      timeoutHandles.push(handle);
      return handle;
    },
    clearScheduledTimeout: (handle) => calls.clearedTimeouts.push(handle),
  };
  return { calls, environment, image, timeoutHandles };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function assertReleased(harness, clearedTimeoutCount = 1) {
  assert.deepEqual(
    harness.calls.clearedTimeouts,
    harness.timeoutHandles.slice(0, clearedTimeoutCount),
  );
  assert.deepEqual(harness.calls.removedAttributes, ["src"]);
  assert.deepEqual(harness.calls.revokedURLs, ["blob:uploaded-image"]);
  assert.equal(harness.image.onload, null);
  assert.equal(harness.image.onerror, null);
}

test("image bitmap metadata closes the decoded bitmap without creating a Blob URL", async () => {
  const harness = createMetadataHarness();
  let bitmapClosed = 0;
  let objectURLsCreated = 0;
  harness.environment.createImageBitmap = async () => ({
    width: 1920,
    height: 1080,
    close: () => {
      bitmapClosed += 1;
    },
  });
  harness.environment.createObjectURL = () => {
    objectURLsCreated += 1;
    return "blob:unexpected-fallback";
  };

  assert.deepEqual(
    await inspectImageBlobMetadata(new Blob(["image"]), harness.environment),
    { width: 1920, height: 1080 },
  );
  assert.equal(bitmapClosed, 1);
  assert.equal(objectURLsCreated, 0);
  assert.deepEqual(harness.calls.clearedTimeouts, [harness.timeoutHandles[0]]);
});

test("image bitmap decode rejection falls back to the Image decoder", async () => {
  const harness = createMetadataHarness();
  const fallbackStarted = createDeferred();
  harness.environment.createImageBitmap = async () => {
    throw new Error("bitmap decode unavailable");
  };
  harness.environment.createObjectURL = () => {
    fallbackStarted.resolve();
    return "blob:uploaded-image";
  };

  const pending = inspectImageBlobMetadata(new Blob(["image"]), harness.environment);
  await fallbackStarted.promise;
  assert.equal(harness.image.src, "blob:uploaded-image");
  harness.image.onload();

  assert.deepEqual(await pending, { width: 1280, height: 720 });
  assertReleased(harness, 2);
});

test("a timed-out bitmap is closed when it resolves after Image fallback starts", async () => {
  const harness = createMetadataHarness();
  const bitmapStarted = createDeferred();
  const bitmapResult = createDeferred();
  const bitmapClosed = createDeferred();
  const fallbackStarted = createDeferred();
  let bitmapCloseCount = 0;
  harness.environment.createImageBitmap = () => {
    bitmapStarted.resolve();
    return bitmapResult.promise;
  };
  harness.environment.createObjectURL = () => {
    fallbackStarted.resolve();
    return "blob:uploaded-image";
  };

  const pending = inspectImageBlobMetadata(new Blob(["image"]), harness.environment);
  await bitmapStarted.promise;
  const triggerBitmapTimeout = harness.calls.timeoutCallback;
  triggerBitmapTimeout();
  await fallbackStarted.promise;

  assert.equal(harness.image.src, "blob:uploaded-image");
  bitmapResult.resolve({
    width: 1920,
    height: 1080,
    close() {
      bitmapCloseCount += 1;
      bitmapClosed.resolve();
    },
  });
  await bitmapClosed.promise;
  assert.equal(bitmapCloseCount, 1);

  harness.image.onload();
  assert.deepEqual(await pending, { width: 1280, height: 720 });
  assertReleased(harness, 2);
});

test("image metadata fallback releases its Blob URL after decoding", async () => {
  const harness = createMetadataHarness();
  const pending = inspectImageBlobMetadata(new Blob(["image"]), harness.environment);

  assert.equal(harness.image.src, "blob:uploaded-image");
  assert.equal(harness.calls.timeoutDelayMs, IMAGE_METADATA_TIMEOUT_MS);
  harness.image.onload();

  assert.deepEqual(await pending, { width: 1280, height: 720 });
  assertReleased(harness);
});

test("image metadata fallback times out and ignores late decoder events", async () => {
  const harness = createMetadataHarness();
  const pending = inspectImageBlobMetadata(new Blob(["image"]), harness.environment);
  const lateLoadHandler = harness.image.onload;

  harness.calls.timeoutCallback();

  await assert.rejects(pending, /读取图片尺寸超时/);
  assertReleased(harness);

  lateLoadHandler();
  assert.deepEqual(harness.calls.revokedURLs, ["blob:uploaded-image"]);
});

test("image metadata fallback releases resources after a decode error", async () => {
  const harness = createMetadataHarness();
  const pending = inspectImageBlobMetadata(new Blob(["image"]), harness.environment);

  harness.image.onerror();

  await assert.rejects(pending, /读取图片尺寸失败/);
  assertReleased(harness);
});

test("a metadata failure cannot create an untracked remote image", async () => {
  const calls = [];
  const decodeError = new Error("cannot decode image");
  const environment = {
    inspectMetadata: async () => {
      calls.push("inspect");
      throw decodeError;
    },
    uploadObject: async () => {
      calls.push("upload");
      throw new Error("upload must not run");
    },
  };

  await assert.rejects(
    uploadImageToServer(new Blob(["invalid"]), "invalid.png", environment),
    (error) => error === decodeError,
  );
  assert.deepEqual(calls, ["inspect"]);
});

test("successful image upload keeps the existing result contract", async () => {
  const calls = [];
  const blob = new Blob(["image"], { type: "image/webp" });
  const environment = {
    inspectMetadata: async () => {
      calls.push("inspect");
      return { width: 640, height: 360 };
    },
    uploadObject: async (_blob, filename, fallbackMessage) => {
      calls.push("upload");
      assert.equal(filename, "example.webp");
      assert.equal(fallbackMessage, "服务端图片上传失败");
      return {
        url: "/api/files/image/content",
        storageKey: "server:image",
        width: 0,
        height: 0,
        bytes: 0,
        mimeType: "",
      };
    },
  };

  assert.deepEqual(await uploadImageToServer(blob, "example.webp", environment), {
    url: "/api/files/image/content",
    storageKey: "server:image",
    width: 640,
    height: 360,
    bytes: blob.size,
    mimeType: "image/webp",
  });
  assert.deepEqual(calls, ["inspect", "upload"]);
});
