import assert from "node:assert/strict";
import test from "node:test";

import { panoramaProxyURL } from "../src/app/canvas/canvas-panorama.ts";

test("panorama proxy keeps bracketed IPv6 loopback hosts direct", () => {
  assert.equal(panoramaProxyURL("http://[::1]:8080/panorama.png", "app.example.com"), "http://[::1]:8080/panorama.png");
  assert.equal(panoramaProxyURL("http://[2001:db8::1]/panorama.png", "app.example.com"), `/api/proxy-image?url=${encodeURIComponent("http://[2001:db8::1]/panorama.png")}`);
});
