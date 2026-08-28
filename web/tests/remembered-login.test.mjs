import assert from "node:assert/strict";
import test from "node:test";

import { parseRememberedLogin } from "../src/lib/remembered-login.ts";

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
