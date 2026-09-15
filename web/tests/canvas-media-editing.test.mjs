import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasVideoFrameTime, validateCanvasAudioTrim, extractCanvasAudio } from "../src/app/canvas/canvas-media-editing.ts";
import { canvasNodeTreeRows } from "../src/app/canvas/canvas-node-tree.ts";

test("video frame timestamps stay inside the decodable duration", () => {
  assert.equal(canvasVideoFrameTime(12, "first", 5), 0);
  assert.equal(canvasVideoFrameTime(12, "last", 5), 11.999);
  assert.equal(canvasVideoFrameTime(12, "current", 4.2), 4.2);
  assert.equal(canvasVideoFrameTime(12, "current", 99), 11.999);
  assert.equal(canvasVideoFrameTime(12, "current", -1), 0);
  assert.throws(() => canvasVideoFrameTime(Infinity, "last", 0));
});

test("audio trimming validates minimum duration and source boundaries", () => {
  validateCanvasAudioTrim({ start: 0.25, end: 0.75 }, 1);
  for (const trim of [{ start: 0.5, end: 0.9 }, { start: -1, end: 1 }, { start: 0, end: 2 }, { start: NaN, end: 1 }]) assert.throws(() => validateCanvasAudioTrim(trim, 1));
});

function pcmWav() {
  const samples = 8000;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, index < 4000 ? 1000 : -1000, true);
  return new Blob([buffer], { type: "audio/wav" });
}

test("audio extraction writes a durable WAV containing the selected interval", async () => {
  const result = await extractCanvasAudio(pcmWav(), { start: 0.5, end: 1 }, new AbortController().signal);
  assert.equal(result.duration, 0.5);
  assert.equal(result.blob.type, "audio/wav");
  const { Input, ALL_FORMATS, BlobSource, AudioSampleSink } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    assert.ok(Math.abs(await track.computeDuration() - 0.5) < 0.002);
    const sample = await new AudioSampleSink(track).getSample(0);
    const data = new Float32Array(sample.numberOfFrames);
    sample.copyTo(data, { planeIndex: 0, format: "f32-planar" });
    assert.ok(data.length > 0);
    assert.ok(data[0] < 0, "Trim must start in the second half of the source audio");
    sample.close();
  } finally { input.dispose(); }
});

test("media conversion respects an already cancelled canvas operation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractCanvasAudio(pcmWav(), undefined, controller.signal), { name: "AbortError" });
});

test("the node tree keeps matching children under their groups and supports collapse", () => {
  const nodes = [{ id: "a", type: "image", group_id: "group" }, { id: "free", type: "text" }, { id: "group", type: "group" }, { id: "b", type: "audio", group_id: "group" }];
  assert.deepEqual(canvasNodeTreeRows(nodes, nodes, new Set()).map(({ node, depth }) => [node.id, depth]), [["free", 0], ["group", 0], ["a", 1], ["b", 1]]);
  assert.deepEqual(canvasNodeTreeRows(nodes, [nodes[3]], new Set()).map(({ node }) => node.id), ["group", "b"]);
  const collapsed = canvasNodeTreeRows(nodes, nodes, new Set(["group"]));
  assert.deepEqual(collapsed.map(({ node }) => node.id), ["free", "group"]);
  assert.equal(collapsed[1].hasChildren, true);
  assert.equal(canvasNodeTreeRows([{ id: "orphan", group_id: "missing", type: "image" }], [{ id: "orphan" }], new Set())[0].depth, 0);
});

function pageHandler(name, dependencies) {
  const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const visit = (node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node; ts.forEachChild(node, visit); };
  visit(source);
  const code = ts.transpileModule(`const handler = ${declaration.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn handler;`)(...Object.values(dependencies));
}

function mediaHarness({ convert, upload } = {}) {
  const nodesRef = { current: [{ id: "video", type: "video", url: "/video.mp4", x: 0, y: 0, width: 100, height: 100 }] };
  const connectionsRef = { current: [] };
  const documentRef = { current: { id: "project" } };
  const canvasOperationEpochRef = { current: 0 };
  const mediaOperationsRef = { current: new Map() };
  const session = { key: "account" };
  const errors = [];
  let history = 0;
  let uploads = 0;
  const dependencies = {
    nodesRef, connectionsRef, documentRef, canvasOperationEpochRef, mediaOperationsRef,
    hostRef: { current: null }, mountedRef: { current: true }, session, getCachedAuthSession: () => session,
    window: new EventTarget(), AUTH_SESSION_CHANGE_EVENT: "session", CSS: { escape: (value) => value },
    toast: { loading: () => 1, success() {}, dismiss() {}, error: (error) => errors.push(error) },
    canvasMediaBlob: async () => new Blob(),
    extractCanvasAudio: convert || (async () => ({ blob: pcmWav(), duration: 1 })),
    uploadMediaBlob: async (...args) => { uploads++; return upload ? upload(...args) : { url: "/api/files/output/content", storageKey: "server:output", mimeType: "audio/wav" }; },
    CANVAS_NODE_DEFAULT_SIZE: { audio: { width: 340, height: 120 } },
    getNextDirectorOutputY: () => 0, randomID: () => "output", createdAt: () => "now", preferredCanvasAudioParameters: () => ({}),
    setMediaBusyNodeIDs() {}, setSelectedNodeIDs() {}, setSelectedConnectionID() {}, setPanelNodeID() {}, setAudioTrimNodeID() {},
    replaceNodes: (nodes) => { nodesRef.current = nodes; }, replaceConnections: (connections) => { connectionsRef.current = connections; },
    pushHistory: () => history++,
  };
  return { run: () => pageHandler("editCanvasMedia", dependencies)("video", "extract-audio"), nodesRef, connectionsRef, documentRef, canvasOperationEpochRef, mediaOperationsRef, session, errors, history: () => history, uploads: () => uploads };
}

test("media editing persists its output and commits the child and edge together", async () => {
  const harness = mediaHarness();
  await harness.run();
  assert.equal(harness.nodesRef.current.length, 2);
  assert.equal(harness.nodesRef.current[1].storage_key, "server:output");
  assert.equal(harness.connectionsRef.current[0].from_node_id, "video");
  assert.equal(harness.connectionsRef.current[0].to_node_id, harness.nodesRef.current[1].id);
  assert.equal(harness.history(), 1);
  assert.equal(harness.mediaOperationsRef.current.size, 0);
});

for (const stale of ["undo", "switch", "delete", "session"]) test(`a delayed media conversion cannot upload or commit after ${stale}`, async () => {
  let resume;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const harness = mediaHarness({ convert: () => { started(); return new Promise((resolve) => { resume = resolve; }); } });
  const running = harness.run();
  await ready;
  if (stale === "undo") harness.canvasOperationEpochRef.current++;
  if (stale === "switch") harness.documentRef.current.id = "another";
  if (stale === "delete") harness.nodesRef.current = [];
  if (stale === "session") harness.session.key = "another";
  resume({ blob: pcmWav(), duration: 1 });
  await running;
  assert.equal(harness.uploads(), 0);
  assert.equal(harness.history(), 0);
  assert.equal(harness.connectionsRef.current.length, 0);
  assert.deepEqual(harness.errors, []);
});

test("failed media uploads leave no placeholder or dangling edge", async () => {
  const harness = mediaHarness({ upload: async () => { throw new Error("upload failed"); } });
  await harness.run();
  assert.equal(harness.nodesRef.current.length, 1);
  assert.equal(harness.connectionsRef.current.length, 0);
  assert.equal(harness.history(), 0);
  assert.deepEqual(harness.errors, ["upload failed"]);
});
