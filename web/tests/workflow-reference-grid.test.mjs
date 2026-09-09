import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url),
  "utf8",
);

test("workflow dialogs share reference grids for templates and runtime inputs", () => {
  assert.match(source, /function WorkflowReferenceGrid\(/);
  assert.equal((source.match(/<WorkflowReferenceGrid /g) || []).length, 3);
  assert.equal((source.match(/onClick=\{\(\) => onRemove\(reference\.id\)\}/g) || []).length, 1);
  assert.match(source, /aria-label=\{`移除参考图 \$\{reference\.name\}`\}/);
  assert.match(source, /disabled=\{disabled\}[\s\S]*disabled:cursor-not-allowed disabled:opacity-50/);
  assert.match(source, /emptyMessage=\{workflow\.template_references\.length \? "请添加至少一张新产品实拍图" : "未添加产品参考图"\}/);
  assert.match(source, /className="grid-cols-5" disabled=\{busy\} onRemove=\{onReferenceRemove\}/);
  assert.match(source, /onMove=\{moveTemplateReference\}/);
});

test("workflow asset picker loads the complete visible asset library", () => {
  assert.match(source, /mergeAssetLibrary\(myAssets, sharedAssets, managedAssets\)/);
  assert.match(source, /fetchVisibleMyAssets\(sessionKey, controller\.signal\)/);
  assert.match(source, /scope: session\.role === "admin" \? "all" : "visible"/);
  assert.match(source, /fetchManagedImages\(/);
  assert.match(source, /assets=\{assetLibrary\}/);
  assert.match(source, /loading && !filtered\.length/);
  assert.match(source, /asset\.coverUrl \|\| asset\.url/);
  assert.match(source, /if \(open\) setQuery\(""\)/);
  assert.match(source, /key=\{assetListKey\(asset\)\}/);
});
