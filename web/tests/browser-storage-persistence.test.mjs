import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("account creation preferences do not use browser storage", async () => {
  const [imagePage, workflowRuntime, canvasDefaults, canvasPage, workflowWorkspace] = await Promise.all([
    source("../src/app/image/page.tsx"),
    source("../src/app/workflows/workflow-runtime.ts"),
    source("../src/app/canvas/canvas-image-parameter-defaults.ts"),
    source("../src/app/canvas/page.tsx"),
    source("../src/app/workflows/creative-workflow-workspace.tsx"),
  ]);
  assert.doesNotMatch(imagePage, /image_last_|image_generation_snap_to_multiple_16/);
  assert.doesNotMatch(workflowRuntime, /localStorage|sessionStorage/);
  assert.doesNotMatch(canvasDefaults, /localStorage|sessionStorage/);
  assert.match(imagePage, /updateCreationWorkbenchPreferences/);
  assert.match(imagePage, /image_model: imageModel/);
  assert.match(imagePage, /video_model: videoModel/);
  assert.match(imagePage, /workbench\.image_model \|\| imageGenerationPreferences\.default_image_model/);
  assert.match(imagePage, /resolveConfiguredVideoModel\([\s\S]*?workbench\.video_model,[\s\S]*?default_video_model,[\s\S]*?config\.default_video_model/);
  assert.match(canvasPage, /function updateNodeGenerationParameters[\s\S]*?pushHistory\(\);/);
  assert.match(workflowWorkspace, /onModelChange=\{\(model\) => patchConfig\(\{ model, image_model: model \}\)\}/);
  assert.match(workflowWorkspace, /saveWorkflow\(normalizeWorkflow\(workflow, models, preferences\)\)/);
});

test("assets use account-scoped server storage with in-memory request deduplication", async () => {
  const [assets, assetsHook, generatedAssets, promptPulls] = await Promise.all([
    source("../src/lib/my-assets.ts"),
    source("../src/lib/use-my-assets.ts"),
    source("../src/services/generation-result-storage.ts"),
    source("../src/app/settings/components/use-prompt-source-pulls.ts"),
  ]);
  assert.doesNotMatch(`${assets}\n${assetsHook}`, /localStorage|sessionStorage|yunmian:my-assets/);
  assert.match(assets, /assetCache/);
  assert.match(assets, /assetRequests/);
  assert.match(assets, /scope: string/);
  assert.doesNotMatch(assets, /key\.endsWith\(":own"\)\) assetCache\.set/);
  assert.match(assets, /key\.endsWith\(":own"\) \|\| key\.endsWith\(":visible"\)/);
  assert.match(assetsHook, /activeScopeRef\.current !== scope/);
  assert.match(assetsHook, /setAssets\(\[\]\)/);
  assert.match(generatedAssets, /registrationKey = `\$\{asset\.id\}:\$\{asset\.storageKey/);
  assert.match(generatedAssets, /MAX_REGISTERED_GENERATED_ASSETS = 512/);
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

test("account-scoped API caches are invalidated across login boundaries", async () => {
	const api = await source("../src/lib/api.ts");
	assert.match(api, /function clearAccountScopedAPICaches\(\)/);
	assert.match(api, /imageGenerationPreferencesCache\.clear\(\)/);
	assert.match(api, /modelConfigCache\.clear\(\)/);
	assert.match(api, /grokTTSVoiceRequests\.clear\(\)/);
	assert.match(api, /login[\s\S]*?clearAccountScopedAPICaches\(\)/);
	assert.match(api, /logout[\s\S]*?clearAccountScopedAPICaches\(\)/);
	assert.match(api, /grokTTSVoiceRequests\.get\(requestKey\) === request/);
});
