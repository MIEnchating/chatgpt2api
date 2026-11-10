import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { AUTH_SESSION_CHANGE_EVENT } from "../src/lib/auth-session.ts";
import { RELAY_MODEL_CONFIG_CHANGED_EVENT } from "../src/lib/relay-token-models.ts";

const require = createRequire(import.meta.url);
const window = new EventTarget();
let preferenceRequests = 0;
const modelRequests = [];

function loadSource(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports,
    require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    ...globals,
  }, { filename: path });
  return exports;
}

const contracts = loadSource("../src/lib/video-model-contracts.ts", {}, { structuredClone });
const imageDefinitions = loadSource("../src/lib/image-model-definitions.ts");
const api = loadSource("../src/lib/api.ts", {
  "@/lib/request": {
    httpRequest: async (path) => {
      if (path === "/api/model-config") {
        return new Promise((resolve) => modelRequests.push(resolve));
      }
      assert.equal(path, "/api/profile/image-generation-preferences");
      preferenceRequests += 1;
      return {
        preferences: {
          default_image_model: `account-${preferenceRequests}`,
        },
      };
    },
  },
  "@/lib/video-model-contracts": contracts,
  "@/lib/image-model-definitions": imageDefinitions,
}, { window });

test("a previous account model response cannot replace the current contract registry", async () => {
  const oldRequest = api.fetchModelConfig();
  window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  const currentRequest = api.fetchModelConfig();
  modelRequests[1]({ config: { image_model_definitions: { current: { protocol: "xai-image" } }, video_model_contracts: [{ name: "current", models: ["current-video"], priority: 0 }] } });
  await currentRequest;
  modelRequests[0]({ config: { image_model_definitions: { old: { protocol: "google-gemini-image" } }, video_model_contracts: [{ name: "old", models: ["old-video"], priority: 0 }] } });
  await oldRequest;
  assert.deepEqual(Array.from(contracts.activeVideoModelContracts(), (contract) => contract.name), ["current"]);
  assert.equal(imageDefinitions.configuredImageModel("current").protocol, "xai-image");
  assert.equal(imageDefinitions.configuredImageModel("old"), undefined);
  window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  assert.equal(imageDefinitions.configuredImageModel("current"), undefined);
});

test("auth session changes invalidate account-scoped API caches", async () => {
  const first = await api.fetchImageGenerationPreferences();
  const cached = await api.fetchImageGenerationPreferences();

  assert.equal(first.preferences.default_image_model, "account-1");
  assert.equal(cached.preferences.default_image_model, "account-1");
  assert.equal(preferenceRequests, 1);

  window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  const refreshed = await api.fetchImageGenerationPreferences();

  assert.equal(refreshed.preferences.default_image_model, "account-2");
  assert.equal(preferenceRequests, 2);
});

test("only successful relay settings changes notify the model loader", async () => {
  const target = new EventTarget();
  let changes = 0;
  let fail = false;
  let config = { relay_base_url: "https://first.example", proxy: "", app_title: "Before" };
  target.addEventListener(RELAY_MODEL_CONFIG_CHANGED_EVENT, () => changes++);
  const isolated = loadSource("../src/lib/api.ts", {
    "@/lib/request": {
      httpRequest: async (path, options) => {
        assert.equal(path, "/api/settings");
        if (fail) throw new Error("save failed");
        if (options?.method === "POST") config = { ...options.body };
        return { config };
      },
    },
  }, { window: target, Event });

  await isolated.fetchSettingsConfig();
  await isolated.updateSettingsConfig({ ...config, app_title: "After" });
  assert.equal(changes, 0);
  await isolated.updateSettingsConfig({ ...config, relay_base_url: "https://second.example" });
  assert.equal(changes, 1);
  await isolated.updateSettingsConfig({ ...config });
  assert.equal(changes, 1);
  await isolated.updateSettingsConfig({ ...config, relay_database_password: "isolated-test-value" });
  assert.equal(changes, 2);
  fail = true;
  await assert.rejects(isolated.updateSettingsConfig({ ...config, relay_base_url: "https://failed.example" }));
  assert.equal(changes, 2);
});

test("custom interface saves identify the changed key and ignore late responses after an account change", async () => {
  const target = new EventTarget();
  const changes = [];
  let complete;
  target.addEventListener(RELAY_MODEL_CONFIG_CHANGED_EVENT, (event) => changes.push(event.detail.tokenName));
  const isolated = loadSource("../src/lib/api.ts", {
    "@/lib/request": {
      httpRequest: () => new Promise((resolve) => { complete = resolve; }),
    },
  }, { window: target, CustomEvent });
  const input = { protocol: "openai", name: "Test", base_url: "https://test.example", api_key: "", pricing_group: "" };
  const current = isolated.updateCustomRelayConfig("test-id", input);
  complete({ item: { token_name: "custom-key" } });
  await current;
  assert.deepEqual(changes, ["custom-key"]);

  const oldCustom = isolated.updateCustomRelayConfig("test-id", input);
  target.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  complete({ item: { token_name: "old-account-key" } });
  await oldCustom;
  assert.deepEqual(changes, ["custom-key"]);

  const oldSettings = isolated.updateSettingsConfig({ proxy: "", relay_base_url: "https://old.example" });
  target.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  complete({ config: { proxy: "", relay_base_url: "https://old.example" } });
  await oldSettings;
  assert.deepEqual(changes, ["custom-key"]);
});
