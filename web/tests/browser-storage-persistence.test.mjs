import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("account creation preferences do not use browser storage", async () => {
  const [imagePage, workflowRuntime, canvasDefaults] = await Promise.all([
    source("../src/app/image/page.tsx"),
    source("../src/app/workflows/workflow-runtime.ts"),
    source("../src/app/canvas/canvas-image-parameter-defaults.ts"),
  ]);
  assert.doesNotMatch(imagePage, /image_last_|image_generation_snap_to_multiple_16/);
  assert.doesNotMatch(workflowRuntime, /localStorage|sessionStorage/);
  assert.doesNotMatch(canvasDefaults, /localStorage|sessionStorage/);
  assert.match(imagePage, /updateCreationWorkbenchPreferences/);
});

test("assets use account-scoped server storage with in-memory request deduplication", async () => {
  const [assets, assetsHook, promptPulls] = await Promise.all([
    source("../src/lib/my-assets.ts"),
    source("../src/app/assets/use-my-assets.ts"),
    source("../src/app/settings/components/use-prompt-source-pulls.ts"),
  ]);
  assert.doesNotMatch(`${assets}\n${assetsHook}`, /localStorage|sessionStorage|yunmian:my-assets/);
  assert.match(assets, /assetCache/);
  assert.match(assets, /assetRequests/);
  assert.match(assets, /scope: string/);
  assert.doesNotMatch(promptPulls, /localStorage|sessionStorage|prompt-source-pull-states|prompt-source-last-run/);
  assert.doesNotMatch(promptPulls, /setInterval|prompt-source-pulls/);
  assert.match(promptPulls, /fetchPromptMarketSourcePrompts/);
});

test("remembered login storage never contains a password field", async () => {
  const [rememberedLogin, cleanup] = await Promise.all([
    source("../src/lib/remembered-login.ts"),
    source("../src/lib/deprecated-browser-persistence.ts"),
  ]);
  assert.doesNotMatch(rememberedLogin, /password/);
  assert.match(cleanup, /getRememberedLogin/);
  assert.match(cleanup, /yunmian:my-assets:/);
});
