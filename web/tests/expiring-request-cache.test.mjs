import { describe, expect, test } from "bun:test";

import { createExpiringRequestCache } from "../src/lib/expiring-request-cache.ts";

describe("expiring request cache", () => {
  test("merges concurrent loads and reuses the cached value", async () => {
    const cache = createExpiringRequestCache(30_000);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { value: calls };
    };

    const [first, second] = await Promise.all([cache.get(load), cache.get(load)]);
    const third = await cache.get(load);

    expect(calls).toBe(1);
    expect(first).toEqual({ value: 1 });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test("does not let an older response overwrite a stored value", async () => {
    const cache = createExpiringRequestCache(30_000);
    let resolveOld;
    const oldRequest = cache.get(() => new Promise((resolve) => {
      resolveOld = resolve;
    }));

    cache.store("new");
    resolveOld("old");
    expect(await oldRequest).toBe("old");
    expect(await cache.get(async () => "unexpected")).toBe("new");
  });

  test("clear invalidates both cached and in-flight requests", async () => {
    const cache = createExpiringRequestCache(30_000);
    let resolveOld;
    const oldRequest = cache.get(() => new Promise((resolve) => {
      resolveOld = resolve;
    }));

    cache.clear();
    expect(await cache.get(async () => "fresh")).toBe("fresh");
    resolveOld("old");
    await oldRequest;
    expect(await cache.get(async () => "unexpected")).toBe("fresh");
  });

  test("clear invalidates a pending mutation response", async () => {
    const cache = createExpiringRequestCache(30_000);
    const storeOldResponse = cache.beginStore();

    cache.clear();
    storeOldResponse("old-account");

    expect(await cache.get(async () => "new-account")).toBe("new-account");
  });

  test("a newer mutation prevents an older response from overwriting the cache", async () => {
    const cache = createExpiringRequestCache(30_000);
    const storeFirstResponse = cache.beginStore();
    const storeSecondResponse = cache.beginStore();

    storeSecondResponse("second");
    storeFirstResponse("first");

    expect(await cache.get(async () => "unexpected")).toBe("second");
  });
});
