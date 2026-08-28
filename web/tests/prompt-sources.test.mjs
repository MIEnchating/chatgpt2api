import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROMPT_MARKET_SOURCES,
  fetchPromptMarketSourcePrompts,
  normalizePromptMarketSources,
  promptMatchesKeyword,
  sortPromptMarketPrompts,
} from "../src/app/image/banana-prompts.ts";

test("prompt keyword search matches the reference title and prompt fields only", () => {
  const prompt = { title: "Portrait card", prompt: "Generate a studio portrait", tags: ["工作"] };
  assert.equal(promptMatchesKeyword(prompt, "port"), true);
  assert.equal(promptMatchesKeyword(prompt, "工作"), false);
  assert.equal(promptMatchesKeyword({ title: "工作间手办", prompt: "模型展示" }, "工作"), true);
});

test("prompt results follow the reference updated-at descending order", () => {
  const items = [
    { id: "old", created: "2026-04-22T00:00:00Z" },
    { id: "undated" },
    { id: "new-a", created: "2026-07-25T09:30:41.144Z" },
    { id: "new-b", created: "2026-07-25T09:30:41.144Z" },
  ];
  assert.deepEqual(sortPromptMarketPrompts(items).map((item) => item.id), ["new-a", "new-b", "old", "undated"]);
});

test("prompt source normalization fixes builtin order and appends custom sources", () => {
  const awesome = DEFAULT_PROMPT_MARKET_SOURCES.find((source) => source.id === "awesome-gpt-image");
  const normalized = normalizePromptMarketSources([
    {
      id: "gpt-image-2-prompts",
      label: "Retired source",
      url: "https://example.test/retired",
      format: "reference-project",
      enabled: true,
      builtin: true,
    },
    { ...awesome, label: "Stale name", url: "https://example.test/stale", homepage: undefined, enabled: false },
    {
      id: "custom-source",
      label: "Custom source",
      url: "https://example.test/prompts.json",
      homepage: "https://example.test/prompts",
      format: "generic-json",
      enabled: true,
    },
  ]);

  assert.deepEqual(normalized.slice(0, 7).map((source) => source.id), DEFAULT_PROMPT_MARKET_SOURCES.map((source) => source.id));
  assert.equal(normalized[0].id, "gpt-image-2-prompts");
  assert.equal(normalized.find((source) => source.id === "awesome-gpt-image").label, awesome.label);
  assert.equal(normalized.find((source) => source.id === "awesome-gpt-image").url, awesome.url);
  assert.equal(normalized.find((source) => source.id === "awesome-gpt-image").enabled, false);
  assert.equal(normalized.some((source) => source.id === "banana-prompt-quicker"), false);
  assert.equal(normalized.at(-1).homepage, "https://example.test/prompts");
});

test("custom prompt JSON supports the documented camelCase media fields", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      id: "product-photo-1",
      title: "Product photo",
      prompt: "Generate a professional product photo",
      description: "Studio sample",
      coverUrl: "https://cdn.example.test/cover.webp",
      referenceImageUrls: ["https://cdn.example.test/reference.png"],
      tags: ["product", "photography"],
    },
  ]), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const prompts = await fetchPromptMarketSourcePrompts({
      id: "custom-source",
      label: "Custom source",
      url: "https://example.test/prompts.json",
      homepage: "https://example.test",
      format: "generic-json",
      enabled: true,
    });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].preview, "https://cdn.example.test/cover.webp");
    assert.deepEqual(prompts[0].referenceImageUrls, ["https://cdn.example.test/reference.png"]);
    assert.equal(prompts[0].mode, undefined);
    assert.deepEqual(prompts[0].tags, ["product", "photography"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
