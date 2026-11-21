import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROMPT_MARKET_SOURCES,
  fetchPromptMarketPrompts,
  fetchPromptMarketSourcePrompts,
  normalizePromptMarketSources,
  preparePromptMarketEntries,
  searchPromptMarketEntries,
} from "../src/app/image/banana-prompts.ts";

test("prompt search uses the displayed localization without changing the original favorite or the supplied references", () => {
  const original = {
    id: "portrait",
    source: "catalog",
    title: "Portrait card",
    prompt: "Generate a studio portrait",
    tags: ["人物", "工作", "人物", "   "],
    referenceImageUrls: ["https://example.test/reference.jpg"],
    localizations: {
      "zh-CN": { title: "工作间手办", prompt: "制作 Cozy 风格的模型", category: "模型" },
      en: { title: "Workshop figurine", prompt: "Build a model", category: "Models" },
    },
  };
  const entries = preparePromptMarketEntries([original]);
  assert.equal(entries[0].original, original);
  assert.equal(entries[0].localized.title, "工作间手办");
  assert.equal(entries[0].localized.referenceImageUrls, original.referenceImageUrls);
  assert.deepEqual(entries[0].tags, ["人物", "工作"]);
  assert.equal(searchPromptMarketEntries(entries, "   "), entries);
  assert.deepEqual(searchPromptMarketEntries(entries, " COZY "), entries);
  assert.deepEqual(searchPromptMarketEntries(entries, "工作间"), entries);
  for (const query of ["人物", "portrait", "figurine", "catalog"]) {
    assert.deepEqual(searchPromptMarketEntries(entries, query), []);
  }
});

test("prompt results follow the reference updated-at descending order", () => {
  const items = [
    { id: "old", created: "2026-04-22T00:00:00Z" },
    { id: "undated" },
    { id: "new-a", created: "2026-07-25T09:30:41.144Z" },
    { id: "new-b", created: "2026-07-25T09:30:41.144Z" },
    { id: "invalid", created: "invalid" },
  ].map((item) => ({ ...item, title: "Sample", prompt: "", tags: [] }));
  const entries = preparePromptMarketEntries(items);
  assert.deepEqual(searchPromptMarketEntries(entries, "sample").map(({ original }) => original.id), ["new-a", "new-b", "old", "undated", "invalid"]);
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

test("prompt market reuses one external load for matching source configurations", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify([{
      id: "cached-prompt",
      title: "Cached prompt",
      prompt: "Generate once",
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const sources = [
    ...DEFAULT_PROMPT_MARKET_SOURCES.map((source) => ({ ...source, enabled: false })),
    {
      id: "cache-test-source",
      label: "Cache test",
      url: "https://cache-test.example/prompts.json",
      format: "generic-json",
      enabled: true,
    },
  ];

  try {
    const [first, second] = await Promise.all([
      fetchPromptMarketPrompts(undefined, sources),
      fetchPromptMarketPrompts(undefined, sources),
    ]);
    const third = await fetchPromptMarketPrompts(undefined, sources);
    assert.equal(calls, 1);
    assert.equal(first.prompts[0].id, "cache-test-source:cached-prompt");
    assert.deepEqual(first.failedSources, []);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("disabled and successfully empty prompt sources produce an empty market", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json([]); };
  const disabled = DEFAULT_PROMPT_MARKET_SOURCES.map((source) => ({ ...source, enabled: false }));
  try {
    assert.deepEqual(await fetchPromptMarketPrompts(undefined, disabled), { prompts: [], failedSources: [] });
    assert.equal(calls, 0);
    assert.deepEqual(await fetchPromptMarketPrompts(undefined, [...disabled, {
      id: "empty-source", label: "Empty", url: "https://example.test/empty.json", format: "generic-json", enabled: true,
    }]), { prompts: [], failedSources: [] });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test("prompt market preserves available results and retries a failed source independently", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let failing = true;
  globalThis.fetch = async (url) => {
    const name = new URL(url).pathname.slice(1);
    calls.push(name);
    if (failing && name === "offline") return new Response(null, { status: 503 });
    return Response.json([{ id: "item", title: name, prompt: "Sample" }]);
  };
  const sources = [
    ...DEFAULT_PROMPT_MARKET_SOURCES.map((source) => ({ ...source, enabled: false })),
    ...["online", "offline"].map((id) => ({
      id, label: id.toUpperCase(), url: `https://retry-sources.example.test/${id}`, format: "generic-json", enabled: true,
    })),
  ];
  try {
    const first = await fetchPromptMarketPrompts(undefined, sources);
    assert.deepEqual(first.prompts.map(({ title }) => title), ["online"]);
    assert.deepEqual(first.failedSources, ["OFFLINE"]);
    failing = false;
    const second = await fetchPromptMarketPrompts(undefined, sources);
    assert.deepEqual(second.prompts.map(({ title }) => title), ["online", "offline"]);
    assert.deepEqual(second.failedSources, []);
    assert.deepEqual(calls, ["online", "offline", "offline"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("malformed prompt entries do not discard valid entries from the same source", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json([null, false, [], { id: "valid", title: "Valid", prompt: "Keep this prompt" }]);
  try {
    const prompts = await fetchPromptMarketSourcePrompts({
      id: "mixed-source", label: "Mixed", url: "https://example.test/mixed.json", format: "generic-json", enabled: true,
    });
    assert.deepEqual(prompts.map((prompt) => prompt.id), ["mixed-source:valid"]);
  } finally { globalThis.fetch = previousFetch; }
});

test("prompt market evicts old source configurations and aborts before starting a fetch", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json([{ id: "item", title: "Item", prompt: "Prompt" }]); };
  const configuration = (index) => [
    ...DEFAULT_PROMPT_MARKET_SOURCES.map((source) => ({ ...source, enabled: false })),
    { id: `bounded-${index}`, label: `Source ${index}`, url: `https://example.test/bounded-${index}.json`, format: "generic-json", enabled: true },
  ];
  try {
    for (let index = 0; index < 9; index += 1) await fetchPromptMarketPrompts(undefined, configuration(index));
    assert.equal(calls, 9);
    await fetchPromptMarketPrompts(undefined, configuration(8));
    assert.equal(calls, 9);
    await fetchPromptMarketPrompts(undefined, configuration(0));
    assert.equal(calls, 10);
    await assert.rejects(fetchPromptMarketPrompts(AbortSignal.abort(), configuration(10)), { name: "AbortError" });
    assert.equal(calls, 10);
  } finally { globalThis.fetch = previousFetch; }
});
