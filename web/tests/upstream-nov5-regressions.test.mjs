import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function callback(path, name, context) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export /, "");
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = `const ${name} = ${node.initializer.getText(source)};`;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, `Missing ${name}`);
  const code = ts.transpile(expression.replaceAll("import.meta.url", JSON.stringify(new URL(path, import.meta.url).href)), { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(context), `${code}\nreturn ${name};`)(...Object.values(context));
}

test("canvas batch uploads preserve every media type and chosen upload destination", async () => {
  const calls = [];
  const batchUploadRef = { current: false };
  const context = {
    batchUploadRef, uploadingNodeID: "", documentRef: { current: { id: "project" } }, canvasOperationEpochRef: { current: 1 },
    isCanvasAudioFile: file => file.type.startsWith("audio/"),
    uploadImageFile: async (...args) => { calls.push(["image", ...args]); },
    uploadVideoFile: async (...args) => { calls.push(["video", ...args]); },
    uploadAudioFile: async (...args) => { calls.push(["audio", ...args]); },
    toast: { error: message => { throw new Error(message); } },
  };
  const upload = callback("../src/app/canvas/page.tsx", "uploadCanvasFiles", context);
  const files = ["image/png", "video/mp4", "audio/mpeg", "image/webp"].map((type, index) => ({ type, name: String(index) }));
  await upload(files, { x: 10, y: 20 }, "", true);
  assert.deepEqual(calls.map(call => [call[0], call[1].name, call[4]]), [["image", "0", true], ["video", "1", true], ["audio", "2", true], ["image", "3", true]]);
  assert.deepEqual(calls.map(call => call[3]), [{ x: 10, y: 20 }, { x: 450, y: 20 }, { x: 890, y: 20 }, { x: 10, y: 420 }]);
  assert.equal(batchUploadRef.current, false);
});

test("changing project stops remaining batch uploads and releases the upload lock", async () => {
  const documentRef = { current: { id: "first" } }, batchUploadRef = { current: false };
  let calls = 0;
  const upload = callback("../src/app/canvas/page.tsx", "uploadCanvasFiles", {
    documentRef, batchUploadRef, uploadingNodeID: "", canvasOperationEpochRef: { current: 1 },
    isCanvasAudioFile: () => false,
    uploadImageFile: async () => { calls++; documentRef.current.id = "second"; },
  });
  await upload([{ type: "image/png" }, { type: "image/png" }], { x: 0, y: 0 });
  assert.equal(calls, 1);
  assert.equal(batchUploadRef.current, false);
});
