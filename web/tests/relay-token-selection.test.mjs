import assert from "node:assert/strict";
import test from "node:test";

import {
  relayTokenNameStorageKey,
  retainSelectedRelayTokenName,
} from "../src/lib/relay-token-selection.ts";

test("scopes relay token selections by provider and user", () => {
  const xiaoge = relayTokenNameStorageKey({ provider: "newapi", subjectId: "newapi:42" });
  const anotherUser = relayTokenNameStorageKey({ provider: "newapi", subjectId: "newapi:84" });
  assert.notEqual(xiaoge, anotherUser);
  assert.equal(xiaoge, "chatgpt2api:profile_relay_token_name:v2:newapi%3Anewapi%3A42");
});

test("does not select the first relay token when the user has not chosen one", () => {
  assert.equal(retainSelectedRelayTokenName("", ["image-key", "video-key"]), "");
});

test("keeps an explicitly selected relay token while it remains available", () => {
  assert.equal(retainSelectedRelayTokenName(" video-key ", ["image-key", "video-key"]), "video-key");
});

test("clears a relay token that is no longer available", () => {
  assert.equal(retainSelectedRelayTokenName("removed-key", ["image-key"]), "");
});
