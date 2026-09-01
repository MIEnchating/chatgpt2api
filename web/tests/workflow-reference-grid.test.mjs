import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/app/workflows/creative-workflow-workspace.tsx", import.meta.url),
  "utf8",
);

test("workflow dialogs share one removable reference grid", () => {
  assert.match(source, /function WorkflowReferenceGrid\(/);
  assert.equal((source.match(/<WorkflowReferenceGrid /g) || []).length, 2);
  assert.equal((source.match(/onClick=\{\(\) => onRemove\(reference\.id\)\}/g) || []).length, 1);
  assert.match(source, /aria-label=\{`移除参考图 \$\{reference\.name\}`\}/);
  assert.match(source, /disabled=\{disabled\}[\s\S]*disabled:cursor-not-allowed disabled:opacity-50/);
  assert.match(source, /className="grid-cols-4" emptyMessage="未添加参考图" disabled=\{referenceBusy\}/);
  assert.match(source, /className="grid-cols-5" disabled=\{busy\} onRemove=\{onReferenceRemove\}/);
});
