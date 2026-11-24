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
  assert.match(profileSource, /<ModelPicker id=\{fieldId\} label=\{label\} value=\{current\} options=\{options\} disabled=\{isLoading\}/);
  assert.doesNotMatch(profileSource, /value=\{options\.includes\(current\) \? current : undefined\}/);
});

test("canvas Agent uses only configured models and cannot start without its text model", () => {
  assert.doesNotMatch(librarySource, /DEFAULT_IMAGE_MODEL/);
  assert.match(librarySource, /if \(!prompt \|\| !agentTextModel \|\| busy \|\| uploadingAsset\) return;/);
  assert.match(librarySource, /disabled=\{\(!agentPrompt\.trim\(\) && !pendingAssets\.length\) \|\| !agentTextModel \|\| uploadingAsset \|\| busy\}/);
});

test("canvas Agent only enables submission with a model confirmed after opening the dialog", () => {
  assert.match(librarySource, /if \(!agentStarterOpen\) return;[\s\S]{0,300}setAgentModels\(emptyAgentModels\)/);
  assert.match(librarySource, /agentModels\.text\.includes\(agentConfig\.textModel/);
  assert.match(librarySource, /\.catch\(\(error\) => \{ if \(active\) setAgentModelError/);
  assert.match(librarySource, /onClick=\{\(\) => setAgentModelAttempt\(\(n\) => n \+ 1\)\}/);
});
