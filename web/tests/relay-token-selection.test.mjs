import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  relayTokenNamesFromPreferences,
  relayTokenPreferenceField,
  retainSelectedRelayTokenName,
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
    default_text_relay_token_name: " text-key ",
    default_image_relay_token_name: "image-key",
    default_video_relay_token_name: "video-key",
    default_audio_relay_token_name: "audio-key",
  }), {
    text: "text-key",
    image: "image-key",
    video: "video-key",
    audio: "audio-key",
  });
});

test("maps each relay token kind to its account preference field", () => {
  assert.equal(relayTokenPreferenceField("text"), "default_text_relay_token_name");
  assert.equal(relayTokenPreferenceField("image"), "default_image_relay_token_name");
  assert.equal(relayTokenPreferenceField("video"), "default_video_relay_token_name");
  assert.equal(relayTokenPreferenceField("audio"), "default_audio_relay_token_name");
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
