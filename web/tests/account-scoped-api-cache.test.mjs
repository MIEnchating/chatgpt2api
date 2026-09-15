import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { AUTH_SESSION_CHANGE_EVENT } from "../src/lib/auth-session.ts";

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
}, { window });

test("a previous account model response cannot replace the current contract registry", async () => {
  const oldRequest = api.fetchModelConfig();
  window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
  const currentRequest = api.fetchModelConfig();
  modelRequests[1]({ config: { video_model_contracts: [{ name: "current", models: ["current-video"], priority: 0 }] } });
  await currentRequest;
  modelRequests[0]({ config: { video_model_contracts: [{ name: "old", models: ["old-video"], priority: 0 }] } });
  await oldRequest;
  assert.deepEqual(Array.from(contracts.activeVideoModelContracts(), (contract) => contract.name), ["current"]);
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
