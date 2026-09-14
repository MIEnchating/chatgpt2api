import assert from "node:assert/strict";
import test from "node:test";

import { consumePromptForWorkbench, stagePromptForWorkbench } from "../src/app/prompt-library/prompt-handoff.ts";

function memorySessionStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("prompt library handoff preserves references and is consumed once", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { sessionStorage: memorySessionStorage() };
  try {
    stagePromptForWorkbench({
      id: "prompt-1",
      title: "产品摄影",
      preview: "https://example.test/preview.png",
      referenceImageUrls: ["https://example.test/reference.png"],
      prompt: "studio product photo",
      author: "author",
      mode: "edit",
      category: "摄影",
      tags: ["产品"],
      source: "test",
      sourceLabel: "Test",
      isNsfw: false,
    }, "session-a");
    const prompt = consumePromptForWorkbench("session-a");
    assert.equal(prompt?.prompt, "studio product photo");
    assert.deepEqual(prompt?.referenceImageUrls, ["https://example.test/reference.png"]);
    assert.equal(consumePromptForWorkbench("session-a"), null);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("prompt library handoff does not invent a generation mode", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { sessionStorage: memorySessionStorage() };
  try {
    stagePromptForWorkbench({
      id: "prompt-without-mode",
      title: "无模式提示词",
      preview: "https://example.test/cover.png",
      referenceImageUrls: [],
      prompt: "prompt text",
      author: "author",
      category: "摄影",
      tags: [],
      source: "test",
      sourceLabel: "Test",
      isNsfw: false,
    }, "session-a");
    assert.equal(consumePromptForWorkbench("session-a")?.mode, undefined);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("prompt library handoff cannot cross authenticated sessions", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { sessionStorage: memorySessionStorage() };
  try {
    stagePromptForWorkbench({
      id: "private-prompt",
      title: "账号 A 提示词",
      preview: "",
      referenceImageUrls: [],
      prompt: "account a content",
      author: "author",
      category: "摄影",
      tags: [],
      source: "test",
      sourceLabel: "Test",
      isNsfw: false,
    }, "session-a");

    assert.equal(consumePromptForWorkbench("session-b"), null);
    assert.equal(consumePromptForWorkbench("session-a"), null);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("prompt handoff reports blocked storage and quota exhaustion to its caller", () => {
  const previousWindow = globalThis.window;
  try {
    for (const browser of [
      { get sessionStorage() { throw new DOMException("Storage access denied", "SecurityError"); } },
      { sessionStorage: { setItem() { throw new DOMException("Storage is full", "QuotaExceededError"); } } },
    ]) {
      globalThis.window = browser;
      assert.equal(stagePromptForWorkbench({ id: "prompt", title: "Prompt", prompt: "Draw a product" }, "session-a"), false);
    }
  } finally {
    globalThis.window = previousWindow;
  }
});

test("unreadable handoffs do not interrupt workbench initialization", () => {
  const previousWindow = globalThis.window;
  try {
    for (const browser of [
      { get sessionStorage() { throw new DOMException("Storage access denied", "SecurityError"); } },
      { sessionStorage: { getItem() { throw new DOMException("Storage access denied", "SecurityError"); } } },
      { sessionStorage: { getItem: () => "{}", removeItem() { throw new DOMException("Storage access denied", "SecurityError"); } } },
    ]) {
      globalThis.window = browser;
      assert.equal(consumePromptForWorkbench("session-a"), null);
    }
  } finally {
    globalThis.window = previousWindow;
  }
});
