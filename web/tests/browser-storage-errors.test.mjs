import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function source(path) {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function compile(code, dependencies) {
  const compiled = ts.transpile(code, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
}

const imageSource = source("../src/app/image/page.tsx");
const imageStorageFunctions = imageSource.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["getStoredComposerMode", "readImageWorkbenchStorage", "writeImageWorkbenchStorage"].includes(node.name?.text));
assert.equal(imageStorageFunctions.length, 3);

function imageStorage(browser) {
  return compile(`${imageStorageFunctions.map((node) => node.getText(imageSource)).join("\n")}\nreturn { getStoredComposerMode, readImageWorkbenchStorage, writeImageWorkbenchStorage };`, {
    window: browser,
    COMPOSER_MODE_STORAGE_KEY: "mode",
  });
}

const canvasSource = source("../src/app/canvas/page.tsx");
let canvasStorageEffect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(canvasSource) === "useEffect"
    && node.arguments[0]?.getText(canvasSource).includes("window.localStorage.setItem(SIDE_PANEL_STORAGE_KEY")) {
    canvasStorageEffect = node.arguments[0].getText(canvasSource);
  }
  ts.forEachChild(node, visit);
}
visit(canvasSource);
assert.ok(canvasStorageEffect);

test("blocked browser storage does not prevent workbench mode initialization or preference updates", () => {
  const browser = { get localStorage() { throw new DOMException("Storage access denied", "SecurityError"); } };
  const storage = imageStorage(browser);
  assert.equal(storage.getStoredComposerMode(), "image");
  assert.equal(storage.readImageWorkbenchStorage("conversation"), null);
  assert.doesNotThrow(() => storage.writeImageWorkbenchStorage("mode", "video"));
  assert.doesNotThrow(() => storage.writeImageWorkbenchStorage("conversation", null));
});

test("workbench preferences retain their values when browser storage is available", () => {
  const values = new Map();
  const storage = imageStorage({ localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  } });
  storage.writeImageWorkbenchStorage("mode", "video");
  storage.writeImageWorkbenchStorage("conversation", "conversation-a");
  assert.equal(storage.getStoredComposerMode(), "video");
  assert.equal(storage.readImageWorkbenchStorage("conversation"), "conversation-a");
  storage.writeImageWorkbenchStorage("conversation", null);
  assert.equal(storage.readImageWorkbenchStorage("conversation"), null);
});

test("quota exhaustion does not interrupt image mode changes or canvas panel changes", () => {
  const browser = { localStorage: { setItem() { throw new DOMException("Storage is full", "QuotaExceededError"); } } };
  assert.doesNotThrow(() => imageStorage(browser).writeImageWorkbenchStorage("mode", "video"));
  const persistPanel = compile(`return (${canvasStorageEffect});`, {
    window: browser,
    SIDE_PANEL_STORAGE_KEY: "panel",
    sidePanel: { open: true, tab: "assets" },
  });
  assert.doesNotThrow(persistPanel);
});

test("canvas panel changes persist through the current browser storage API", () => {
  const values = new Map();
  const panel = { open: true, tab: "assets" };
  const persistPanel = compile(`return (${canvasStorageEffect});`, {
    window: { localStorage: { setItem: (key, value) => values.set(key, value) } },
    SIDE_PANEL_STORAGE_KEY: "panel",
    sidePanel: panel,
  });
  persistPanel();
  assert.deepEqual(JSON.parse(values.get("panel")), panel);
});
