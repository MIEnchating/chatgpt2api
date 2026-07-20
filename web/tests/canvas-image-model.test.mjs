import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanvasImageModel } from "../src/app/canvas/canvas-image-model.ts";

test("canvas uses the configured default image model", () => {
  assert.equal(resolveCanvasImageModel("gpt-image-2", ["gpt-image-2"]), "gpt-image-2");
});

test("canvas skips auto and selects an actual image model", () => {
  assert.equal(resolveCanvasImageModel("auto", ["auto", "gpt-image-2"]), "gpt-image-2");
  assert.equal(resolveCanvasImageModel("", "auto,codex-gpt-image-2"), "codex-gpt-image-2");
});

test("canvas falls back when model configuration is empty", () => {
  assert.equal(resolveCanvasImageModel("", []), "gpt-image-2");
});
