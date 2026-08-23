import assert from "node:assert/strict";
import test from "node:test";

import { isPublicReferenceURL, MAX_PUBLIC_REFERENCE_URL_LENGTH } from "../src/lib/public-reference-url.ts";

test("accepts public media reference URLs", () => {
  assert.equal(isPublicReferenceURL("https://cdn.example.com/video.mp4?signature=abc"), true);
  assert.equal(isPublicReferenceURL("http://8.8.8.8/audio.mp3"), true);
});

test("rejects local, private, inline, and credentialed references", () => {
  for (const value of [
    "data:video/mp4;base64,AAAA",
    "http://localhost/video.mp4",
    "http://127.0.0.1/video.mp4",
    "http://10.0.0.8/video.mp4",
    "http://192.168.1.8/video.mp4",
    "http://[::1]/video.mp4",
    "https://user:pass@cdn.example.com/video.mp4",
    "/video.mp4",
  ]) {
    assert.equal(isPublicReferenceURL(value), false, value);
  }
});

test("enforces the upstream URL length limit", () => {
  const prefix = "https://cdn.example.com/";
  assert.equal(isPublicReferenceURL(prefix + "a".repeat(MAX_PUBLIC_REFERENCE_URL_LENGTH - prefix.length)), true);
  assert.equal(isPublicReferenceURL(prefix + "a".repeat(MAX_PUBLIC_REFERENCE_URL_LENGTH - prefix.length + 1)), false);
});
