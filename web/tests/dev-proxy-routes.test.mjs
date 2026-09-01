import assert from "node:assert/strict";
import test from "node:test";

import viteConfig from "../vite.config.ts";

test("development proxy forwards every generated media root", () => {
  const proxy = viteConfig.server?.proxy;
  const backendTarget = proxy?.["/api"]?.target;
  for (const path of ["/images", "/videos", "/audios"]) {
    const entry = proxy?.[path];
    assert.ok(entry, `missing Vite proxy for ${path}`);
    assert.equal(entry.target, backendTarget);
    assert.equal(entry.changeOrigin, true);
  }
});
