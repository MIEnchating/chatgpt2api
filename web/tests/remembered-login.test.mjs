import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRememberedLogin,
  getRememberedLogin,
  parseRememberedLogin,
  saveRememberedLogin,
} from "../src/lib/remembered-login.ts";
import { purgeDeprecatedBrowserPersistence } from "../src/lib/deprecated-browser-persistence.ts";

test("parses a remembered account without retaining the password", () => {
  assert.deepEqual(parseRememberedLogin('{"username":" alice ","password":"secret"}'), {
    username: "alice",
  });
});

test("rejects malformed or incomplete remembered login data", () => {
  assert.equal(parseRememberedLogin(null), null);
  assert.equal(parseRememberedLogin("not-json"), null);
  assert.deepEqual(parseRememberedLogin('{"username":"alice"}'), { username: "alice" });
  assert.equal(parseRememberedLogin('{"password":"secret"}'), null);
});

test("remembered login stores only the normalized username", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  try {
    saveRememberedLogin({ username: " alice ", password: "secret" });
    assert.deepEqual(getRememberedLogin(), { username: "alice" });
    assert.equal([...values.values()].some((value) => value.includes("secret")), false);
    clearRememberedLogin();
    assert.equal(getRememberedLogin(), null);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("unavailable browser storage never blocks authentication helpers or cleanup", () => {
  const previousWindow = globalThis.window;
  globalThis.window = Object.defineProperty({}, "localStorage", {
    get() {
      throw new Error("storage denied");
    },
  });
  try {
    assert.equal(getRememberedLogin(), null);
    assert.doesNotThrow(() => saveRememberedLogin({ username: "alice" }));
    assert.doesNotThrow(() => clearRememberedLogin());
    assert.doesNotThrow(() => purgeDeprecatedBrowserPersistence());
  } finally {
    globalThis.window = previousWindow;
  }
});
