import { afterAll, describe, expect, mock, test } from "bun:test";

let verifySessionImplementation = async () => loginResponse();

mock.module("@/lib/api", () => ({
  verifySession: () => verifySessionImplementation(),
}));

afterAll(() => {
  mock.restore();
});

function loginResponse(overrides = {}) {
  return {
    credential_id: "credential-1",
    role: "user",
    subject_id: "newapi:42",
    username: "alice",
    name: "Alice",
    provider: "newapi",
    creation_concurrent_limit: 2,
    creation_rpm_limit: 10,
    menu_paths: ["/studio"],
    api_permissions: [],
    menus: [],
    ...overrides,
  };
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

describe("verified auth session cache", () => {
  test("does not cache a transient 503 and retries successfully", async () => {
    let calls = 0;
    verifySessionImplementation = async () => {
      calls += 1;
      if (calls === 1) {
        throw requestError(503, "service unavailable");
      }
      return loginResponse();
    };
    const session = await import("../src/lib/session.ts?transient-503");

    await expect(session.getVerifiedAuthSession()).rejects.toThrow("service unavailable");
    expect(session.getCachedAuthSession()).toBeUndefined();
    expect(await session.getVerifiedAuthSession()).toMatchObject({ key: "credential-1", subjectId: "newapi:42" });
    expect(calls).toBe(2);
  });

  test("does not cache a network failure and retries successfully", async () => {
    let calls = 0;
    verifySessionImplementation = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network unavailable");
      }
      return loginResponse();
    };
    const session = await import("../src/lib/session.ts?transient-network");

    await expect(session.getVerifiedAuthSession()).rejects.toThrow("network unavailable");
    expect(session.getCachedAuthSession()).toBeUndefined();
    expect(await session.getVerifiedAuthSession()).toMatchObject({ key: "credential-1" });
    expect(calls).toBe(2);
  });

  test("caches an explicit 401 as logged out", async () => {
    let calls = 0;
    verifySessionImplementation = async () => {
      calls += 1;
      throw requestError(401, "authorization is invalid");
    };
    const session = await import("../src/lib/session.ts?unauthorized-401");

    expect(await session.getVerifiedAuthSession()).toBeNull();
    verifySessionImplementation = async () => loginResponse();
    expect(await session.getVerifiedAuthSession()).toBeNull();
    expect(calls).toBe(1);
  });

  test("does not treat a 403 as an invalid session", async () => {
    let calls = 0;
    verifySessionImplementation = async () => {
      calls += 1;
      if (calls === 1) {
        throw requestError(403, "permission denied");
      }
      return loginResponse();
    };
    const session = await import("../src/lib/session.ts?forbidden-403");

    await expect(session.getVerifiedAuthSession()).rejects.toThrow("permission denied");
    expect(session.getCachedAuthSession()).toBeUndefined();
    expect(await session.getVerifiedAuthSession()).toMatchObject({ key: "credential-1" });
    expect(calls).toBe(2);
  });

  test("refreshes cached role and permission data from the server", async () => {
    let response = loginResponse();
    let calls = 0;
    verifySessionImplementation = async () => {
      calls += 1;
      return response;
    };
    const session = await import("../src/lib/session.ts?permission-refresh");

    expect(await session.getVerifiedAuthSession()).toMatchObject({ menuPaths: ["/studio"] });
    response = loginResponse({
      menu_paths: ["/assets"],
      api_permissions: ["get/api/profile/assets"],
    });

    expect(await session.refreshVerifiedAuthSession()).toMatchObject({
      menuPaths: ["/assets"],
      apiPermissions: ["get/api/profile/assets"],
    });
    expect(session.getCachedAuthSession()).toMatchObject({ menuPaths: ["/assets"] });
    expect(calls).toBe(2);
  });

  test("keeps the last verified session when a refresh fails transiently", async () => {
    let calls = 0;
    verifySessionImplementation = async () => {
      calls += 1;
      if (calls === 2) {
        throw requestError(503, "service unavailable");
      }
      return loginResponse();
    };
    const session = await import("../src/lib/session.ts?failed-refresh");

    expect(await session.getVerifiedAuthSession()).toMatchObject({ key: "credential-1" });
    await expect(session.refreshVerifiedAuthSession()).rejects.toThrow("service unavailable");
    expect(session.getCachedAuthSession()).toMatchObject({ key: "credential-1" });
    expect(calls).toBe(2);
  });
});
