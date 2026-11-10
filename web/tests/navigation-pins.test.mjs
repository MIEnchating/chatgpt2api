import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function pins(browser) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL("../src/lib/navigation-pins.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, window: browser });
  return exports;
}

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const available = ["/users", "/rbac", "/logs"];

test("navigation pins retain order, survive reload, and remain separate for each account", () => {
  const localStorage = storage();
  const first = pins({ localStorage });
  first.writeNavigationPins("account-a", ["/logs", "/rbac"]);
  first.writeNavigationPins("account-b", ["/users"]);
  const reloaded = pins({ localStorage });
  assert.deepEqual([...reloaded.readNavigationPins("account-a", available)], ["/logs", "/rbac"]);
  assert.deepEqual([...reloaded.readNavigationPins("account-b", available)], ["/users"]);
  first.writeNavigationPins("account-a", []);
  assert.deepEqual([...reloaded.readNavigationPins("account-a", available)], []);
});

test("navigation pins never reveal unavailable routes or duplicate stored entries", () => {
  const localStorage = storage();
  const api = pins({ localStorage });
  api.writeNavigationPins("account", ["/logs", "/logs", "/users", "https://example.test", null, 42]);
  assert.deepEqual([...api.readNavigationPins("account", ["/logs"])], ["/logs"]);
  assert.deepEqual([...api.readNavigationPins("new-account", ["/rbac"])], []);
});

test("invalid or blocked storage leaves navigation usable", () => {
  for (const raw of ["{", "null", "{}", '"/logs"']) {
    const api = pins({ localStorage: { getItem: () => raw } });
    assert.deepEqual([...api.readNavigationPins("account", ["/rbac"])], []);
  }
  const api = pins({ get localStorage() { throw new Error("blocked"); } });
  assert.deepEqual([...api.readNavigationPins("account", ["/rbac"])], []);
  assert.doesNotThrow(() => api.writeNavigationPins("account", ["/logs"]));
});
