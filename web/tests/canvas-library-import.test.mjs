import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/app/canvas/library-page.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const importBody = source.slice(source.indexOf("async function importProjects"), source.indexOf("async function renameProject"));

test("canvas import counts each imported project and refreshes the list even when a later one fails", () => {
  assert.match(importBody, /let imported = 0;/);
  assert.match(importBody, /await importCanvasProject\(project\);\n\s+imported \+= 1;/);
  const finallyBlock = importBody.slice(importBody.indexOf("} finally {"));
  assert.match(finallyBlock, /if \(imported\) \{[\s\S]*fetchCanvasDocument\(\)[\s\S]*setProjects\(/);
  assert.doesNotMatch(importBody.slice(0, importBody.indexOf("} finally {")), /fetchCanvasDocument\(\)/);
  assert.match(importBody, /已导入 \$\{imported\} 个画布，其余导入失败/);
});
