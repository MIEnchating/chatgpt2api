import assert from "node:assert/strict";
import test from "node:test";
import { groupModelsByFamily, resolveModelGroupConfig, renameModelGroup } from "../src/lib/model-groups.ts";

test("groups model families without changing model identities or order", () => {
  const options = ["gpt-image-2", "gemini-3-image", "GPT-image-3", "vendor/model", "other"].map((value) => ({ value }));
  assert.deepEqual(groupModelsByFamily(options), [
    { name: "GPT", options: [options[0], options[2]] },
    { name: "GEMINI", options: [options[1]] },
    { name: "VENDOR", options: [options[3]] },
    { name: "OTHER", options: [options[4]] },
  ]);
});

test("groups video families and applies overrides and group order", () => {
  const options = ["doubao-seedance-1", "jimeng-video-3", "minimax-h3-768p", "hailuo-02", "custom-model", "ch1308-sd-2.0-720p", "minimax H3"].map((value) => ({ value }));
  const groups = groupModelsByFamily(options, { overrides: { "custom-model": "MiniMax / 海螺" }, order: ["MiniMax / 海螺", "即梦 / Seedance"] });
  assert.deepEqual(groups, [
    { name: "MiniMax / 海螺", options: [options[2], options[3], options[4], options[6]] },
    { name: "即梦 / Seedance", options: [options[0], options[1], options[5]] },
  ]);
});

test("filtered model pickers use the same default family order as settings", () => {
  const models = ["gpt-6.1-sol", "gemini-3-image", "grok-imagine-image", "gpt-image-2"];
  const config = resolveModelGroupConfig(models);
  const images = models.slice(1).map((value) => ({ value }));
  assert.deepEqual(groupModelsByFamily(images, config).map((group) => group.name), ["GPT", "GEMINI", "GROK"]);
  const sorted = resolveModelGroupConfig(models, { overrides: {}, order: ["GROK", "GPT"] });
  assert.deepEqual(groupModelsByFamily(images, sorted).map((group) => group.name), ["GROK", "GPT", "GEMINI"]);
});

test("renaming a family updates all members and preserves its position", () => {
  const models = ["gpt-6.1-sol", "gemini-3-image", "gpt-image-2", "custom-image", "grok-image"];
  const config = { overrides: { "custom-image": "GPT", "grok-image": "其他图片" }, order: ["GEMINI", "GPT", "其他图片"] };
  const renamed = renameModelGroup(models, config, "GPT", " OpenAI ");
  assert.deepEqual(renamed, {
    overrides: { "gpt-6.1-sol": "OpenAI", "gpt-image-2": "OpenAI", "custom-image": "OpenAI", "grok-image": "其他图片" },
    order: ["GEMINI", "OpenAI", "其他图片"],
  });
  assert.equal(config.overrides["custom-image"], "GPT");
  assert.deepEqual(config.order, ["GEMINI", "GPT", "其他图片"]);
  assert.deepEqual(groupModelsByFamily(models.map((value) => ({ value })), renamed)[1].options.map(({ value }) => value), [models[0], models[2], models[3]]);
});

test("renaming to an existing family merges members without duplicate order entries", () => {
  const models = ["gpt-image-2", "gemini-3-image", "grok-image"];
  const config = { overrides: {}, order: ["GPT", "GEMINI", "GROK"] };
  const renamed = renameModelGroup(models, config, "GPT", "GEMINI");
  assert.deepEqual(renamed.order, ["GEMINI", "GROK"]);
  assert.deepEqual(groupModelsByFamily(models.map((value) => ({ value })), renamed)[0].options.map(({ value }) => value), models.slice(0, 2));
  assert.deepEqual(renameModelGroup(models, config, "GPT", "  "), config);
  assert.deepEqual(renameModelGroup(models, config, "GPT", "GPT"), config);
});
