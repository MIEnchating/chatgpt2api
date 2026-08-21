import assert from "node:assert/strict";
import test from "node:test";

import { parseRememberedLogin } from "../src/lib/remembered-login.ts";

test("parses a complete remembered login", () => {
  assert.deepEqual(parseRememberedLogin('{"username":" alice ","password":"secret"}'), {
    username: "alice",
    password: "secret",
  });
});

test("rejects malformed or incomplete remembered login data", () => {
  assert.equal(parseRememberedLogin(null), null);
  assert.equal(parseRememberedLogin("not-json"), null);
  assert.equal(parseRememberedLogin('{"username":"alice","password":""}'), null);
});
