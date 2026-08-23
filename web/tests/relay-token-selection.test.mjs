import assert from "node:assert/strict";
import test from "node:test";

import {
  getStoredRelayTokenName,
  relayTokenNameStorageKey,
  retainSelectedRelayTokenName,
  storeRelayTokenName,
} from "../src/lib/relay-token-selection.ts";

function installLocalStorage(t) {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, String(value)),
    },
  };
  t.after(() => {
    delete globalThis.window;
  });
  return values;
}

test("scopes relay token selections by provider and user", () => {
  const xiaoge = relayTokenNameStorageKey({ provider: "newapi", subjectId: "newapi:42" }, "image");
  const anotherUser = relayTokenNameStorageKey({ provider: "newapi", subjectId: "newapi:84" }, "image");
  assert.notEqual(xiaoge, anotherUser);
  assert.equal(xiaoge, "chatgpt2api:profile_relay_token_name:v3:newapi%3Anewapi%3A42:image");
});

test("keeps image and video relay token selections separate", () => {
  const identity = { provider: "newapi", subjectId: "newapi:42" };
  assert.notEqual(
    relayTokenNameStorageKey(identity, "image"),
    relayTokenNameStorageKey(identity, "video"),
  );
});

test("stores image and video selections independently", (t) => {
  installLocalStorage(t);
  const identity = { provider: "newapi", subjectId: "newapi:42" };
  storeRelayTokenName(identity, "image", "image-key");
  storeRelayTokenName(identity, "video", "video-key");
  assert.equal(getStoredRelayTokenName(identity, "image"), "image-key");
  assert.equal(getStoredRelayTokenName(identity, "video"), "video-key");
});

test("uses the previous single selection until each kind is explicitly saved", (t) => {
  const values = installLocalStorage(t);
  const identity = { provider: "newapi", subjectId: "newapi:42" };
  values.set("chatgpt2api:profile_relay_token_name:v2:newapi%3Anewapi%3A42", "legacy-key");
  storeRelayTokenName(identity, "image", "image-key");
  assert.equal(getStoredRelayTokenName(identity, "image"), "image-key");
  assert.equal(getStoredRelayTokenName(identity, "video"), "legacy-key");
});

test("an explicitly cleared kind does not fall back to the previous single selection", (t) => {
  const values = installLocalStorage(t);
  const identity = { provider: "newapi", subjectId: "newapi:42" };
  values.set("chatgpt2api:profile_relay_token_name:v2:newapi%3Anewapi%3A42", "legacy-key");
  storeRelayTokenName(identity, "video", "");
  assert.equal(getStoredRelayTokenName(identity, "video"), "");
  assert.equal(getStoredRelayTokenName(identity, "image"), "legacy-key");
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
