import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  relayTokenNameForModel,
  relayTokenRouteForModel,
  relayTokenNamesFromPreferences,
  relayTokenPreferenceField,
  retainSelectedRelayTokenNames,
} from "../src/lib/relay-token-selection.ts";

const relayTokenSelectionSource = await readFile(new URL("../src/lib/relay-token-selection.ts", import.meta.url), "utf8");
const relayTokenPreferencesSource = await readFile(new URL("../src/lib/relay-token-preferences.tsx", import.meta.url), "utf8");

test("relay token selections use account preferences instead of browser storage", () => {
  assert.doesNotMatch(relayTokenSelectionSource, /localStorage|sessionStorage/);
  assert.doesNotMatch(relayTokenPreferencesSource, /localStorage|sessionStorage/);
  assert.match(relayTokenPreferencesSource, /updateRelayTokenPreferences/);
});

test("maps account relay token preferences by media kind", () => {
  assert.deepEqual(relayTokenNamesFromPreferences({
    default_text_relay_token_names: [" text-key ", "text-key"],
    default_image_relay_token_names: ["image-key"],
    default_video_relay_token_names: ["video-key-1", "video-key-2"],
    default_audio_relay_token_names: ["audio-key"],
  }), {
    text: ["text-key"],
    image: ["image-key"],
    video: ["video-key-1", "video-key-2"],
    audio: ["audio-key"],
  });
});

test("maps each relay token kind to its account preference field", () => {
  assert.equal(relayTokenPreferenceField("text"), "default_text_relay_token_names");
  assert.equal(relayTokenPreferenceField("image"), "default_image_relay_token_names");
  assert.equal(relayTokenPreferenceField("video"), "default_video_relay_token_names");
  assert.equal(relayTokenPreferenceField("audio"), "default_audio_relay_token_names");
});

test("does not select relay tokens when the user has not chosen any", () => {
  assert.deepEqual(retainSelectedRelayTokenNames([], ["image-key", "video-key"]), []);
});

test("keeps explicitly selected relay tokens in selection order while they remain available", () => {
  assert.deepEqual(retainSelectedRelayTokenNames([" video-key ", "image-key"], ["image-key", "video-key"]), ["video-key", "image-key"]);
});

test("clears a relay token that is no longer available", () => {
  assert.deepEqual(retainSelectedRelayTokenNames(["removed-key", "image-key"], ["image-key"]), ["image-key"]);
});

test("routes a model to the first selected key that exposes it", () => {
  const modelsByToken = {
    key1: ["model-a"],
    key2: ["model-a", "model-b"],
  };
  assert.equal(relayTokenNameForModel(["key1", "key2"], "model-a", modelsByToken), "key1");
  assert.equal(relayTokenNameForModel(["key1", "key2"], "model-b", modelsByToken), "key2");
  assert.equal(relayTokenNameForModel(["key1", "key2"], "model-c", modelsByToken), "");
});

test("distinguishes missing keys, model probe failures, and unsupported models", () => {
  const modelsByToken = { key1: ["model-a"], key2: [] };
  assert.equal(relayTokenRouteForModel(["key1"], "model-a", modelsByToken, [], false).status, "loading");
  assert.equal(relayTokenRouteForModel([], "model-a", modelsByToken, [], true).status, "missing-selection");
  assert.equal(relayTokenRouteForModel(["key2"], "model-a", modelsByToken, ["key2"], true).status, "model-list-error");
  assert.equal(relayTokenRouteForModel(["key1"], "model-b", modelsByToken, [], true).status, "model-unavailable");
  assert.deepEqual(relayTokenRouteForModel(["key1", "key2"], "model-a", modelsByToken, ["key2"], true), { status: "ready", tokenName: "key1" });
});
