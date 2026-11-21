import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url),
  "utf8",
);
const referenceGridSource = readFileSync(new URL("../src/app/workflows/workflow-reference-grid.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../src/app/workflows/workflow-editor.tsx", import.meta.url), "utf8");
const agentSource = readFileSync(new URL("../src/app/workflows/workflow-agent-dialog.tsx", import.meta.url), "utf8");
const runnerSource = readFileSync(new URL("../src/app/workflows/workflow-runner.tsx", import.meta.url), "utf8");
const taskDialogsSource = readFileSync(new URL("../src/app/workflows/workflow-task-dialogs.tsx", import.meta.url), "utf8");

test("workflow dialogs share reference grids for templates and runtime inputs", () => {
  assert.match(referenceGridSource, /function WorkflowReferenceGrid\(/);
  assert.equal(((agentSource + editorSource + runnerSource + taskDialogsSource).match(/<WorkflowReferenceGrid\b/g) || []).length, 5);
  assert.equal((referenceGridSource.match(/onClick=\{\(\) => onRemove\(reference\.id\)\}/g) || []).length, 1);
  assert.match(referenceGridSource, /<AttachmentAction aria-label=\{`移除参考图 \$\{reference\.name\}`\} disabled=\{disabled\}/);
  assert.match(taskDialogsSource, /<WorkflowReferenceGrid references=\{items as WorkflowReference\[\]\} className="grid-cols-4" openOriginal/);
  assert.match(runnerSource, /emptyMessage=\{workflow\.template_references\.length \? "请添加至少一张新产品实拍图" : "未添加产品参考图"\}/);
  assert.match(agentSource, /className="grid-cols-5" disabled=\{busy\} onRemove=\{onReferenceRemove\}/);
  assert.match(editorSource, /onMove=\{moveTemplateReference\}/);
});

test("workflow asset picker loads the complete visible asset library", () => {
  assert.match(source, /mergeAssetLibrary\(myAssets, sharedAssets, managedAssets\)/);
  assert.match(source, /fetchVisibleMyAssets\(sessionKey, controller\.signal\)/);
  assert.match(source, /scope: session\.role === "admin" \? "all" : "visible"/);
  assert.match(source, /fetchManagedImages\(/);
  assert.match(source, /assets=\{assetLibrary\}/);
  assert.match(source, /loading && !filtered\.length/);
  assert.match(source, /asset\.coverUrl \|\| asset\.url/);
  assert.match(source, /\{assetPickerTarget \? <WorkflowAssetPicker/);
  assert.match(source, /key=\{assetListKey\(asset\)\}/);
});
