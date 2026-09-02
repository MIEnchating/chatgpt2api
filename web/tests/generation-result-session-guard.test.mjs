import assert from "node:assert/strict";
import { afterAll, beforeEach, mock, test } from "bun:test";

let currentSessionKey = "session-a";
let switchSessionAfterUpload = false;
let uploadCalls = 0;
let upsertCalls = 0;

mock.module("@/lib/authenticated-image", () => ({
  isManagedImageURL: () => false,
}));

mock.module("@/lib/my-assets", () => ({
  upsertMyAsset: async () => {
    upsertCalls += 1;
    throw new Error("stale session must not upsert an asset");
  },
}));

mock.module("@/lib/session", () => ({
  AUTH_SESSION_CHANGE_EVENT: "chatgpt2api:auth-session-change",
  getCachedAuthSession: () => ({ key: currentSessionKey }),
}));

mock.module("@/services/file-storage", () => ({
  uploadAssetMediaFile: async () => {
    uploadCalls += 1;
    if (switchSessionAfterUpload) currentSessionKey = "session-b";
    return {
      url: "/api/files/audio-a/content",
      storageKey: "server:audio-a",
      bytes: 5,
      mimeType: "audio/mpeg",
    };
  },
}));

mock.module("@/services/image-storage", () => ({
  uploadImage: async () => {
    uploadCalls += 1;
    throw new Error("audio regression must not upload through image storage");
  },
}));

const { persistCreationTaskOutputs } = await import(
  "../src/services/generation-result-storage.ts?session-guard-regression"
);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  currentSessionKey = "session-a";
  switchSessionAfterUpload = false;
  uploadCalls = 0;
  upsertCalls = 0;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function audioTask(id) {
  return {
    id,
    status: "success",
    output_type: "audio",
    data: [{
      type: "audio",
      audio_url: "https://media.example/result.mp3",
      mime_type: "audio/mpeg",
    }],
  };
}

function assertSessionAbort(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

test("A to B after download does not upload or upsert under B", async () => {
  const failures = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal instanceof AbortSignal, true);
    return {
      ok: true,
      status: 200,
      blob: async () => {
        currentSessionKey = "session-b";
        return new Blob(["audio"], { type: "audio/mpeg" });
      },
    };
  };

  await assert.rejects(
    persistCreationTaskOutputs(audioTask("download-switch"), {
      expectedSessionKey: "session-a",
      onError: (failure) => failures.push(failure),
    }),
    assertSessionAbort,
  );

  assert.equal(uploadCalls, 0);
  assert.equal(upsertCalls, 0);
  assert.deepEqual(failures, []);
});

test("A to B after upload does not upsert under B", async () => {
  const failures = [];
  switchSessionAfterUpload = true;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal instanceof AbortSignal, true);
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob(["audio"], { type: "audio/mpeg" }),
    };
  };

  await assert.rejects(
    persistCreationTaskOutputs(audioTask("upload-switch"), {
      expectedSessionKey: "session-a",
      onError: (failure) => failures.push(failure),
    }),
    assertSessionAbort,
  );

  assert.equal(uploadCalls, 1);
  assert.equal(upsertCalls, 0);
  assert.deepEqual(failures, []);
});
