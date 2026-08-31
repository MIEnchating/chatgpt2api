import { describe, expect, test } from "bun:test";

import { createStorageProviderClient } from "../src/services/storage-provider.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("storage provider cache", () => {
  test("retries after an initial request failure", async () => {
    let calls = 0;
    const client = createStorageProviderClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return { config: { mode: "server_local" } };
    });

    await expect(client.fetchStorageConfig()).rejects.toThrow("temporary failure");
    expect(await client.fetchStorageConfig()).toEqual({ mode: "server_local" });
    expect(calls).toBe(2);
  });

  test("reloads cached values after invalidation", async () => {
    let calls = 0;
    const client = createStorageProviderClient(async () => ({
      config: { mode: `mode-${++calls}` },
    }));

    expect((await client.fetchStorageConfig()).mode).toBe("mode-1");
    client.invalidate();
    expect((await client.fetchStorageConfig()).mode).toBe("mode-2");
  });

  test("does not expose or cache a response from an invalidated scope", async () => {
    const oldResponse = deferred();
    let calls = 0;
    const client = createStorageProviderClient(async () => {
      calls += 1;
      if (calls === 1) return oldResponse.promise;
      return { config: { mode: "new-account" } };
    });

    const oldScopeRequest = client.fetchStorageConfig();
    client.invalidate();
    const newScopeRequest = client.fetchStorageConfig();
    expect(await newScopeRequest).toEqual({ mode: "new-account" });

    oldResponse.resolve({ config: { mode: "old-account" } });
    expect(await oldScopeRequest).toEqual({ mode: "new-account" });
    expect(await client.fetchStorageConfig()).toEqual({ mode: "new-account" });
    expect(calls).toBe(2);
  });

  test("does not cache a delayed provider update after scope invalidation", async () => {
    const updateResponse = deferred();
    let getCalls = 0;
    const client = createStorageProviderClient(async (path, options) => {
      if (options?.method === "POST") return updateResponse.promise;
      expect(path).toBe("/api/profile/storage-provider");
      getCalls += 1;
      return { provider: { s3: { name: "new-account" } } };
    });

    const update = client.updateUserStorageProviders({ s3: { name: "old-account" } });
    client.invalidate();
    updateResponse.resolve({ provider: { s3: { name: "old-account" } } });

    expect(await update).toEqual({ s3: { name: "new-account" } });
    expect(await client.fetchUserStorageProviders()).toEqual({ s3: { name: "new-account" } });
    expect(getCalls).toBe(1);
  });
});
