import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasGenerationNeedsRecovery, canvasGenerationRecoveryTaskID } from "../src/app/canvas/canvas-generation-context.ts";
import * as videoModelCapabilities from "../src/lib/video-model-capabilities.ts";

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

test("canvas paste reads new system text after copying canvas nodes", async () => {
  const added = [], errors = [];
  const paste = callback("../src/app/canvas/page.tsx", "pasteSelected", {
    navigator: { clipboard: { read: async () => [{ types: ["text/plain"], getType: async () => new Blob(["fresh system text"]) }] } },
    canvasCenterPosition: () => ({ x: 100, y: 100 }), addNode: node => added.push(node), randomID: () => "new", createdAt: () => "now",
    toast: { success() {}, error: error => errors.push(error) }, normalizeCanvasClipboard: () => null,
  });
  await paste();
  assert.deepEqual(errors, []);
  assert.equal(added.length, 1);
  assert.equal(added[0].prompt, "fresh system text");
});

test("canvas native paste handles images without clipboard API permissions", async () => {
  const file = new File(["image"], "system.png", { type: "image/png" });
  let uploaded;
  const paste = callback("../src/app/canvas/page.tsx", "pasteSelected", {
    uploadImageFile: async image => { uploaded = image; }, canvasCenterPosition: () => ({ x: 0, y: 0 }),
    toast: { error: error => { throw new Error(error); } },
  });
  await paste({ clipboardData: { files: [file] } });
  assert.equal(uploaded, file);
});

test("converting a canvas sample preserves it and prevents duplicate pending finals", async () => {
  const sample = { id: "sample-node", type: "video", task_id: "owned-sample-task", url: "/sample.mp4", generation_video_draft: true, generation_status: "success", generation_video_resolution: "480p", generation_video_first_frame_node_id: "old-frame", generation_video_last_frame_url: "/old-last.png", generation_video_reference_urls: ["/old-ref.mp4"], x: 10, y: 10, width: 400, height: 225 };
  const nodesRef = { current: [sample] }, connectionsRef = { current: [] };
  let submitted = 0;
  const convert = callback("../src/app/canvas/page.tsx", "convertVideoDraft", {
    nodesRef, connectionsRef, nodeGenerationRunning: id => nodesRef.current.some(node => node.id === id && node.generation_status === "loading"),
    randomID: () => "final", createdAt: () => "now", replaceNodes: nodes => { nodesRef.current = nodes; }, replaceConnections: edges => { connectionsRef.current = edges; }, setSelectedNodeIDs() {}, pushHistory() {},
    runVideoGeneration: async id => { submitted++; nodesRef.current = nodesRef.current.map(node => node.id === id ? { ...node, generation_status: "loading" } : node); },
  });
  await convert(sample);
  await convert(sample);
  assert.equal(submitted, 1);
  assert.equal(nodesRef.current.length, 2);
  assert.equal(nodesRef.current[0], sample);
  assert.equal(nodesRef.current[1].generation_video_draft_source_task_id, "owned-sample-task");
  assert.equal(nodesRef.current[1].generation_video_resolution, "1080p");
  assert.equal(nodesRef.current[1].url, "");
  assert.equal(nodesRef.current[1].generation_video_first_frame_node_id, undefined);
  assert.equal(nodesRef.current[1].generation_video_last_frame_url, undefined);
  assert.deepEqual(nodesRef.current[1].generation_video_reference_urls, []);
  assert.equal(connectionsRef.current[0].from_node_id, sample.id);
});
