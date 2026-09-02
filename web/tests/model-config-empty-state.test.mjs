import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveConfiguredModel } from "../src/lib/model-config-selection.ts";

const profileSource = readFileSync(new URL("../src/app/profile/page.tsx", import.meta.url), "utf8");
const librarySource = readFileSync(new URL("../src/app/canvas/library-page.tsx", import.meta.url), "utf8");

test("an explicit empty configured list never restores a preferred or compatibility model", () => {
  assert.equal(resolveConfiguredModel([], "saved-model", "server-default", "compatibility-default"), "");
});

test("profile applies successful model configuration independently and clears stale defaults", () => {
  assert.match(profileSource, /Promise\.allSettled\(\[fetchImageGenerationPreferences\(\), fetchModelConfig\(\)\]\)/);
  for (const kind of ["text", "image", "video", "audio"]) {
    assert.match(profileSource, new RegExp(`default_${kind}_model: resolveConfiguredModel\\(configuredModels\\.${kind}, current\\.default_${kind}_model, config\\.default_${kind}_model\\)`));
  }
  assert.match(profileSource, /modelConfigResult\.status === "fulfilled"/);
  assert.doesNotMatch(profileSource, /config\.(?:text|image|video|audio)_models\?\.\[0\]/);
});

test("empty profile model selectors stay controlled and disabled", () => {
  assert.match(profileSource, /const current = resolveConfiguredModel\(options, preferences\[field\], defaultModel\)/);
  assert.match(profileSource, /<Select value=\{current\} disabled=\{isLoading \|\| options\.length === 0\}/);
  assert.doesNotMatch(profileSource, /value=\{options\.includes\(current\) \? current : undefined\}/);
});

test("canvas Agent uses only configured models and cannot start without its text model", () => {
  assert.doesNotMatch(librarySource, /DEFAULT_IMAGE_MODEL/);
  assert.match(librarySource, /const imageModel = resolveConfiguredModel\(\s*configuredImageModels,/);
  assert.match(librarySource, /setAgentTextModel\(textModel\);\s*setAgentImageModel\(imageModel\);\s*setAgentVideoModel\(videoModel\);/);
  assert.match(librarySource, /if \(!prompt \|\| !agentTextModel \|\| busy \|\| uploadingAsset\) return;/);
  assert.match(librarySource, /disabled=\{!agentPrompt\.trim\(\) \|\| !agentTextModel \|\| uploadingAsset \|\| busy\}/);
});

test("canvas Agent clears models on a successful empty response but preserves them on fetch failure", () => {
  assert.match(librarySource, /setAgentImageModel\(imageModel\)/);
  assert.match(librarySource, /setAgentVideoModel\(videoModel\)/);
  assert.match(librarySource, /\.catch\(\(\) => undefined\)/);
  assert.doesNotMatch(librarySource, /\.catch\(\(\) => \{[\s\S]*?setAgent(?:Text|Image|Video)Model\(""\)/);
  assert.match(librarySource, /AgentStarterParameterMenu disabled=\{!agentImageModel\}/);
  assert.match(librarySource, /AgentStarterParameterMenu disabled=\{!agentVideoModel\}/);
});
