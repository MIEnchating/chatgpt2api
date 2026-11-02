import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/overlay-layers.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { overlayLayer, OVERLAY_LAYER } = exports;

test("tooltips stay above parameter popovers and selects at every modal depth", () => {
  let modal = 0;
  for (let depth = 0; depth < 5; depth++) {
    const popover = overlayLayer("popover", modal);
    const nestedPopover = overlayLayer("popover", popover);
    const select = overlayLayer("select", nestedPopover);
    const tooltip = overlayLayer("tooltip", nestedPopover);
    assert.ok(popover > modal);
    assert.ok(nestedPopover > popover);
    assert.ok(select > nestedPopover);
    assert.ok(tooltip > select);
    const nextModal = overlayLayer("modal", popover);
    assert.ok(nextModal - 1 > tooltip, "the next modal backdrop must cover background tooltips");
    assert.ok(OVERLAY_LAYER.notification > nextModal);
    modal = nextModal;
  }
});

test("custom portals and shared primitives cannot reintroduce global magic z-index values", () => {
  const root = new URL("../src/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter((file) => /\.(tsx|css)$/.test(file));
  for (const file of files) {
    const source = readFileSync(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /z-\[\d{3,}\]|zIndex:\s*\d{3,}|z-index:\s*\d{3,}/, `${file}: use the shared overlay layer policy`);
  }
});
