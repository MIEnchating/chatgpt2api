import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasTextGenerationPlan } from "../src/app/canvas/canvas-text-generation.ts";
import { applyCanvasTaskImage } from "../src/app/canvas/canvas-task-results.ts";

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

test("text regeneration updates the current node while config nodes create outputs", () => {
  const node = { type: "text", prompt: "Original", composer_content: "Make shorter" };
  const overwrite = canvasTextGenerationPlan(node);
  assert.equal(overwrite.createsChildNodes, false);
  assert.match(overwrite.requestPrompt, /Original/);
  assert.match(overwrite.requestPrompt, /Make shorter/);
  assert.equal(canvasTextGenerationPlan({ type: "config", generation_count: 3 }).createsChildNodes, true);
});

test("successive generated images retain the node's longest edge across aspect changes", () => {
  let node = { id: "result", type: "image", x: 0, y: 0, width: 640, height: 360 };
  for (const [width, height] of [[900, 1600], [1600, 900], [900, 1600]]) {
    node = applyCanvasTaskImage(node, { url: "result.png", width, height }, "task");
    assert.equal(Math.max(node.width, node.height), 640);
    assert.equal(node.width / node.height, width / height);
    assert.equal(node.x + node.width / 2, 320);
    assert.equal(node.y + node.height / 2, 180);
  }
});

test("media loading rejects old URLs and corrects a frame even when metadata was already known", () => {
  const nodesRef = { current: [{ id: "node", type: "video", url: "/new.mp4", x: 0, y: 0, width: 400, height: 400, natural_width: 1600, natural_height: 900 }] };
  let saves = 0;
  const onLoad = callback("../src/app/canvas/page.tsx", "handleNodeMediaLoad", {
    nodesRef, replaceNodes: nodes => { nodesRef.current = nodes; }, scheduleSave: () => saves++,
  });
  onLoad("node", 900, 1600, undefined, "/old.mp4");
  assert.equal(saves, 0);
  onLoad("node", 1600, 900, undefined, "/new.mp4");
  assert.equal(nodesRef.current[0].width, 400);
  assert.equal(nodesRef.current[0].height, 225);
  assert.equal(saves, 1);
  onLoad("node", 1600, 900, undefined, "/new.mp4");
  assert.equal(saves, 1);
  nodesRef.current[0].free_resize = true;
  nodesRef.current[0].width = 500;
  onLoad("node", 900, 1600, undefined, "/new.mp4");
  assert.equal(nodesRef.current[0].width, 500);
  assert.equal(nodesRef.current[0].height, 225);
});

test("video sound defaults respect explicit node choices and model audio support", () => {
  for (const control of ["toggle", "always", "unsupported"]) {
    const parameters = callback("../src/app/canvas/page.tsx", "canvasVideoParameters", {
      videoSizeOptions: () => ["16:9"], resolveVideoSeconds: () => 5, videoResolutionOptions: () => ["720p"],
      videoDefaultSize: () => "16:9", videoDefaultResolution: () => "720p", videoAudioControl: () => control,
    });
    assert.equal(parameters({ generation_video_audio: true }).generation_video_audio, control !== "unsupported");
    assert.equal(parameters({ generation_video_audio: false }).generation_video_audio, control === "always");
  }
});

test("video retries update the failed node even after switching to new-node regeneration", async () => {
  for (const retry of [false, true]) {
    const source = { id: "video", type: "video", url: "/previous.mp4", generation_status: "error", prompt: "Scene", x: 0, y: 0, width: 400, height: 225 };
    const stopped = new Error("Stop before submitting a task");
    let resultNodes;
    const runVideo = callback("../src/app/canvas/page.tsx", "runVideoGeneration", {
      documentRef: { current: { id: "project" } }, canvasOperationEpochRef: { current: 0 },
      nodesRef: { current: [source] }, activeGenerationsRef: { current: new Set() }, runningNodeID: "",
      canvasVideoParameters: () => ({ generation_video_model: "model", generation_video_size: "16:9", generation_video_reference_urls: [], generation_video_reference_image_urls: [], generation_video_reference_audio_urls: [] }),
      videoModels: ["model"], nextTokenNameForModel: () => "channel",
      connectionsRef: { current: [] },
      buildCanvasGenerationContext: () => ({ prompt: "Scene", referenceImageURLs: [], referenceVideoURLs: [], referenceAudioURLs: [] }),
      applyCameraPrompt: text => text, supportsVideoFrameReferences: () => false,
      canvasVideoGenerationReferences: () => ({ referenceImageURLs: [] }),
      supportsVideoMultimodalReferences: () => false, videoMultimodalReferenceLimits: () => ({ video: 0, audio: 0 }),
      videoRequiresReferenceImage: () => false, randomID: () => "new", session: { key: "session" },
      imageGenerationPreferences: { node_regenerate_behavior: "new-node" }, registerActiveGeneration: () => ({}),
      canvasNodeSizeFromRatio: () => ({ width: 400, height: 225 }), CANVAS_NODE_DEFAULT_SIZE: { video: { width: 400, height: 225 } },
      buildVideoNode: () => ({ type: "video" }), historyRef: { current: [] },
      replaceNodes: nodes => { resultNodes = nodes; throw stopped; },
    });
    const runGeneration = callback("../src/app/canvas/page.tsx", "runGeneration", {
      nodesRef: { current: [source] }, runVideoGeneration: runVideo,
    });
    await assert.rejects(runGeneration(source.id, undefined, retry), error => error === stopped);
    assert.equal(resultNodes.length, retry ? 1 : 2);
    const result = resultNodes.at(-1);
    assert.equal(result.id, retry ? source.id : "video-new");
    assert.equal(result.generation_status, "loading");
    if (retry) assert.equal(result.url, source.url);
  }
});
