import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROMPT_MARKET_SOURCES } from "../src/app/image/banana-prompts.ts";
import { fetchReferencePromptSource } from "../src/app/image/reference-prompt-sources.ts";

test("default prompt sources match the configured source order", () => {
  assert.deepEqual(DEFAULT_PROMPT_MARKET_SOURCES.map((source) => source.id), [
    "gpt-image-2-prompts",
    "awesome-gpt-image",
    "awesome-gpt4o-image-prompts",
    "xianyu-awesome-gptimage2",
    "youmind-gpt-image-2",
    "youmind-nano-banana-pro",
    "davidwu-gpt-image2-prompts",
  ]);
  assert.deepEqual(DEFAULT_PROMPT_MARKET_SOURCES.map((source) => source.label), [
    "GPT Image 2 Prompts",
    "Awesome GPT Image",
    "Awesome GPT4o Image Prompts",
    "Xianyu Awesome GPT Image 2",
    "YouMind GPT Image 2",
    "YouMind Nano Banana Pro",
    "awesome-gpt-image2-prompts",
  ]);
  assert.ok(DEFAULT_PROMPT_MARKET_SOURCES.every((source) => source.enabled && source.builtin));
  assert.ok(DEFAULT_PROMPT_MARKET_SOURCES.every((source) => source.format === "reference-project"));
});

test("Freestylefly JSON maps cover and metadata without inventing a reference", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://raw.example.test/data/cases.json");
    return new Response(JSON.stringify({ cases: [{
      id: 529,
      title: "广告海报",
      prompt: "premium campaign poster",
      image: "/images/case529.jpg",
      category: "Posters & Typography",
      styles: ["Poster", "Realistic"],
      scenes: ["Commerce"],
      sourceLabel: "@creator",
      sourceUrl: "https://x.com/creator/status/1",
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const prompts = await fetchReferencePromptSource({ id: "freestylefly-gpt-image-2", label: "Freestylefly", url: "https://raw.example.test", format: "reference-project", enabled: true, builtin: true });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].preview, "https://raw.example.test/images/case529.jpg");
    assert.deepEqual(prompts[0].referenceImageUrls, []);
    assert.equal(prompts[0].mode, undefined);
    assert.equal(prompts[0].author, "@creator");
    assert.deepEqual(prompts[0].tags, ["Poster", "Realistic", "Commerce"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reference-project JSON source keeps its image as a cover without inventing a reference", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://raw.example.test/prompts.json");
    return new Response(JSON.stringify([{ id: 7, title_cn: "产品摄影", category_cn: "电商", prompt: "studio product photo", author: "tester", needs_ref: true, image: "images/7.webp" }]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const prompts = await fetchReferencePromptSource({ id: "davidwu-gpt-image2-prompts", label: "David", url: "https://raw.example.test", format: "reference-project", enabled: true, builtin: true });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].title, "产品摄影");
    assert.equal(prompts[0].prompt, "studio product photo");
    assert.equal(prompts[0].preview, "https://raw.example.test/images/7.webp");
    assert.deepEqual(prompts[0].referenceImageUrls, []);
    assert.equal(prompts[0].mode, undefined);
    assert.ok(prompts[0].tags.includes("需要参考图"));
    assert.ok(prompts[0].tags.includes("tester"));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reference-project Markdown resolves parent-relative images from the repository root", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestURL = String(url);
    if (requestURL.endsWith("/data/ingested_tweets.json")) {
      return new Response(JSON.stringify({ records: [{
        title: "Portrait sample",
        tweet_url: "https://x.com/example/status/1",
        image_dir: "images/portrait_case1",
        category: "Portrait Cases",
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const markdown = requestURL.endsWith("/cases/portrait.md")
      ? `### Case 1: [Portrait sample](https://x.com/example/status/1)\n<img src="../images/portrait_case1/output.jpg">\n\n**Prompt:**\n\n\`\`\`\nportrait prompt\n\`\`\``
      : "";
    return new Response(markdown, { status: 200, headers: { "Content-Type": "text/plain" } });
  };

  try {
    const [prompt] = await fetchReferencePromptSource({
      id: "gpt-image-2-prompts",
      label: "Tiger",
      url: "https://raw.example.test/repository/main",
      format: "reference-project",
      enabled: true,
      builtin: true,
    });
    assert.equal(prompt.preview, "https://raw.example.test/repository/main/images/portrait_case1/output.jpg");
    assert.deepEqual(prompt.referenceImageUrls, []);
    assert.equal(prompt.mode, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
