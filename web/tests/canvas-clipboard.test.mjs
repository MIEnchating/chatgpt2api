import assert from "node:assert/strict";
import test from "node:test";

import { createScriptProject } from "../src/app/canvas/canvas-script.ts";
import { normalizeCanvasClipboard, remapCanvasNodeReferences } from "../src/app/canvas/canvas-clipboard.ts";
import { expandCanvasBatchNodeIDs, reconcileCanvasBatchesAfterRemoval } from "../src/app/canvas/canvas-batches.ts";
import { buildCanvasGenerationContext } from "../src/app/canvas/canvas-generation-context.ts";

function node(id, values = {}) {
  return { id, type: "image", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, ...values };
}

test("normalizes valid nodes and connections without changing their graph", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("a"), node("b", { type: "text", prompt: "想法" })],
    connections: [{ id: "a-b", from_node_id: "a", to_node_id: "b" }],
  });

  assert.deepEqual(result?.connections, [{ id: "a-b", from_node_id: "a", to_node_id: "b" }]);
  assert.equal(result?.nodes[1].prompt, "想法");
});

test("preserves generation configuration nodes in copied graphs", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("idea", { type: "text", prompt: "想法" }), node("config", { type: "config" })],
    connections: [{ id: "idea-config", from_node_id: "idea", to_node_id: "config" }],
  });
  assert.equal(result?.nodes[1].type, "config");
  assert.deepEqual(result?.connections, [{ id: "idea-config", from_node_id: "idea", to_node_id: "config" }]);
});

test("preserves video nodes and their generation settings in copied graphs", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("video", {
      type: "video",
      url: "/videos/example.mp4",
      generation_video_model: "sora-2",
      generation_video_size: "1280x720",
      generation_video_seconds: 8,
      generation_video_resolution: "1080p",
    })],
  });
  assert.equal(result?.nodes[0].type, "video");
  assert.equal(result?.nodes[0].url, "/videos/example.mp4");
  assert.equal(result?.nodes[0].generation_video_seconds, 8);
});

test("rejects removed parent ids because connections are the current graph source", () => {
  assert.equal(normalizeCanvasClipboard({
    nodes: [node("parent"), node("child", { parent_id: "parent" })],
    connections: [{ id: "parent-child", from_node_id: "parent", to_node_id: "child" }],
  }), null);
});

test("rejects fields outside the current clipboard schema", () => {
  assert.equal(normalizeCanvasClipboard({ nodes: [node("old", { legacy_state: true })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("a"), node("b")], connections: [{ id: "a-b", from_node_id: "a", to_node_id: "b", metadata: {} }] }), null);
  assert.equal(normalizeCanvasClipboard({ type: "other-canvas", nodes: [node("a")] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("a")], version: 1 }), null);
});

test("rejects malformed nodes instead of allowing invalid canvas state", () => {
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { width: 0 })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { type: "text", font_size: 40 })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { type: "video", generation_video_seconds: 0 })] }), null);
  assert.ok(normalizeCanvasClipboard({ nodes: [node("custom-size", { type: "video", generation_video_size: "800x600" })] }));
  assert.ok(normalizeCanvasClipboard({ nodes: [node("seedance", { type: "video", generation_video_resolution: "4k" })] }));
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { batch_child_ids: "child" })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { type: "config", composer_content: 42 })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { generation_model: 42 })] }), null);
});

test("rejects dangling, duplicate, and self connections", () => {
  const nodes = [node("a"), node("b")];
  assert.equal(normalizeCanvasClipboard({ nodes, connections: [{ id: "x", from_node_id: "a", to_node_id: "missing" }] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes, connections: [{ id: "x", from_node_id: "a", to_node_id: "b" }, { id: "x", from_node_id: "b", to_node_id: "a" }] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes, connections: [{ id: "x", from_node_id: "a", to_node_id: "a" }] }), null);
});

test("remaps batch ownership and copied prompt references", () => {
  const mapped = remapCanvasNodeReferences(node("config-copy", {
    type: "config",
    composer_content: "让 @[node:image-old] 参考 @[node:text-old]，保留 @[node:not-copied]",
    batch_child_ids: ["image-old", "not-copied"],
    batch_root_id: "root-old",
    batch_primary_id: "image-old",
  }), new Map([
    ["image-old", "image-new"],
    ["text-old", "text-new"],
    ["root-old", "root-new"],
  ]));
  assert.equal(mapped.composer_content, "让 @[node:image-new] 参考 @[node:text-new]，保留 @[node:not-copied]");
  assert.deepEqual(mapped.batch_child_ids, ["image-new"]);
  assert.equal(mapped.batch_root_id, "root-new");
  assert.equal(mapped.batch_primary_id, "image-new");
});

test("detaches batch links that point outside the copied graph", () => {
  const mapped = remapCanvasNodeReferences(node("child-copy", { batch_root_id: "outside" }), new Map());
  assert.equal(mapped.batch_root_id, undefined);
});

test("deleting a pasted batch cannot remove the original children", () => {
  const originals = [node("root", { batch_child_ids: ["a", "b"], batch_primary_id: "a" }), node("a", { batch_root_id: "root" }), node("b", { batch_root_id: "root" })];
  const ids = new Map(originals.map((item) => [item.id, `${item.id}-copy`]));
  const copies = originals.map((item) => remapCanvasNodeReferences({ ...item, id: ids.get(item.id) }, ids));
  const allNodes = [...originals, ...copies];
  const removed = expandCanvasBatchNodeIDs(new Set(["root-copy"]), allNodes);
  assert.deepEqual([...removed], ["root-copy", "a-copy", "b-copy"]);
  assert.deepEqual(reconcileCanvasBatchesAfterRemoval(allNodes, removed), originals);
});

test("remaps copied video frame and audio clone node bindings", () => {
  const mapped = remapCanvasNodeReferences(node("video-copy", {
    type: "video",
    generation_video_first_frame_node_id: "first-old",
    generation_video_last_frame_node_id: "last-old",
    generation_audio_mimo_voice_clone_node_id: "audio-old",
  }), new Map([
    ["first-old", "first-new"],
    ["last-old", "last-new"],
    ["text-old", "text-new"],
    ["image-old", "image-new"],
    ["video-old", "video-new"],
    ["audio-old", "audio-new"],
  ]));
  assert.equal(mapped.generation_video_first_frame_node_id, "first-new");
  assert.equal(mapped.generation_video_last_frame_node_id, "last-new");
  assert.equal(mapped.generation_audio_mimo_voice_clone_node_id, "audio-new");
});

test("preserves valid groups and remaps membership when pasted", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("group", { type: "group", width: 400, height: 300 }), node("child", { group_id: "group" })],
  });
  assert.equal(result?.nodes[1].group_id, "group");
  const mapped = remapCanvasNodeReferences(result.nodes[1], new Map([["group", "group-copy"]]));
  assert.equal(mapped.group_id, "group-copy");
});

test("rejects dangling and nested group membership", () => {
  assert.equal(normalizeCanvasClipboard({ nodes: [node("child", { group_id: "missing" })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("group", { type: "group", group_id: "other" }), node("other", { type: "group" })] }), null);
});

test("copied configurations keep their generated prompt and image inputs", () => {
  const originals = [
    node("image", { url: "/image.png" }),
    node("text", { type: "text", prompt: "Original prompt" }),
    node("config", { type: "config", composer_content: "@[node:text] @[node:image]" }),
  ];
  const idMap = new Map(originals.map((item) => [item.id, `${item.id}-copy`]));
  const copied = originals.map((item) => remapCanvasNodeReferences({ ...item, id: idMap.get(item.id) }, idMap));
  const config = copied[2];
  const context = buildCanvasGenerationContext(config.id, copied, [
    { id: "text-input", from_node_id: "text-copy", to_node_id: "config-copy" },
    { id: "image-input", from_node_id: "image-copy", to_node_id: "config-copy" },
  ], config.composer_content);
  assert.match(context.prompt, /Original prompt/);
  assert.deepEqual(context.referenceImageURLs, ["/image.png"]);
});

test("clipboard accepts the current automatic video duration value", () => {
  assert.equal(normalizeCanvasClipboard({ nodes: [node("video", { type: "video", generation_video_seconds: -1 })] })?.nodes[0].generation_video_seconds, -1);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("video", { type: "video", generation_video_seconds: -2 })] }), null);
});

test("script clipboard remaps asset images and rejects malformed script projects", () => {
  const script = { ...node("script-1"), type: "script", script_project: { step: 0, confirmed: false, shots: [], assets: [{ id: "hero", kind: "character", name: "小雨", description: "红雨衣", image_node_id: "image-1" }] } };
  assert.ok(normalizeCanvasClipboard({ nodes: [script], connections: [] }));
  const remapped = remapCanvasNodeReferences(script, new Map([["image-1", "image-copy"]]));
  assert.equal(remapped.script_project.assets[0].image_node_id, "image-copy");
  assert.equal(script.script_project.assets[0].image_node_id, "image-1");
  assert.equal(normalizeCanvasClipboard({ nodes: [{ ...script, script_project: { step: 0 } }], connections: [] }), null);
});


test("copies all script media bindings and detaches references outside the copied graph", () => {
  const project = { ...createScriptProject(), step: 2, confirmed: true, assets: [{ id: "hero", kind: "character", name: "Hero", description: "Reference", image_node_id: "hero-image" }],
    shots: [{ ...createScriptProject().shots[0], id: "shot", source_node_id: "text", image_node_id: "image", video_node_id: "video" }],
    merged_video_node_id: "movie", merged_video_fingerprint: "fingerprint" };
  const original = node("script", { type: "script", script_project: project });
  const copied = remapCanvasNodeReferences(original, new Map(["hero-image", "text", "image", "video", "movie"].map((id) => [id, `${id}-copy`])));
  assert.equal(copied.script_project.assets[0].image_node_id, "hero-image-copy");
  assert.equal(copied.script_project.shots[0].source_node_id, "text-copy");
  assert.equal(copied.script_project.shots[0].image_node_id, "image-copy");
  assert.equal(copied.script_project.shots[0].video_node_id, "video-copy");
  assert.equal(copied.script_project.merged_video_node_id, "movie-copy");
  const detached = remapCanvasNodeReferences(original, new Map()).script_project;
  assert.equal(detached.assets[0].image_node_id, "");
  assert.equal(detached.shots[0].video_node_id, undefined);
  assert.equal(detached.merged_video_fingerprint, undefined);
  const removed = reconcileCanvasBatchesAfterRemoval([original, node("video")], new Set(["video"]));
  assert.equal(removed[0].script_project.shots[0].video_node_id, "");
  assert.equal(project.shots[0].video_node_id, "video");
});

test("partial script copies invalidate only shots that lose their material images", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.assets = [{ id: "hero", kind: "character", name: "Hero", description: "Reference", image_node_id: "hero-image" }];
  project.shots.forEach((shot, index) => Object.assign(shot, { description: `Scene ${index}`, image_prompt: "Image", video_prompt: "Video", video_node_id: `video-${index}` }));
  project.shots[0].dialogue = [{ kind: "dialogue", asset_id: "hero", text: "Hello" }];
  const original = node("script", { type: "script", script_project: project });
  const idMap = new Map(["video-0", "video-1"].map((id) => [id, `${id}-copy`]));
  const partial = remapCanvasNodeReferences(original, idMap).script_project;
  assert.equal(partial.confirmed, false);
  assert.equal(partial.assets[0].image_node_id, "");
  assert.equal(partial.shots[0].video_node_id, "video-0-copy");
  assert.equal(partial.shots[0].video_outdated, true);
  assert.equal(partial.shots[0].image_prompt, "Image");
  assert.equal(partial.shots[0].image_prompt_outdated, true);
  assert.equal(partial.shots[0].video_prompt, "Video");
  assert.equal(partial.shots[0].video_prompt_outdated, true);
  assert.equal(partial.shots[1].video_outdated, false);
  assert.equal(partial.shots[1].video_prompt, "Video");
  idMap.set("hero-image", "hero-image-copy");
  const complete = remapCanvasNodeReferences(original, idMap).script_project;
  assert.equal(complete.confirmed, true);
  assert.equal(complete.shots[0].video_prompt, "Video");
  assert.equal(Boolean(complete.shots[0].video_outdated), false);
  assert.equal(project.confirmed, true);
  assert.equal(project.shots[0].video_prompt, "Video");
});

test("production export retains actual metadata, freshness, and quality review without reviving missing references",()=>{
 const project=createScriptProject();project.merged_video_node_id="movie";project.merged_video_outdated=true;
 project.shots[0].video_node_id="clip";project.shots[0].video_outdated=true;project.shots[0].video_prompt_outdated=true;
 project.shots[0].quality_review={media_url:"/clip.mp4",continuity:"passed",dialogue:"needs_fix",speaker:"unchecked",lip_sync:"unchecked",notes:"Check final line"};
 const nodes=[node("script",{type:"script",script_project:project}),node("clip",{type:"video",url:"/clip.mp4",media_metadata:{width:768,height:1376,duration_ms:15000,has_audio:true}}),node("movie",{type:"video",url:"/movie.mp4",media_metadata:{width:768,height:1376,duration_ms:60000,has_audio:true},media_silent_clips:1})];
 const restored=normalizeCanvasClipboard(JSON.parse(JSON.stringify({nodes,connections:[]})));
 assert.deepEqual(restored.nodes[0].script_project,project);assert.deepEqual(restored.nodes[1].media_metadata,nodes[1].media_metadata);
 const map=new Map([["script","new-script"],["clip","new-clip"],["movie","new-movie"]]);
 const copy=remapCanvasNodeReferences(restored.nodes[0],map);
 assert.equal(copy.script_project.merged_video_node_id,"new-movie");assert.equal(copy.script_project.shots[0].video_node_id,"new-clip");assert.equal(copy.script_project.shots[0].video_prompt_outdated,true);assert.deepEqual(copy.script_project.shots[0].quality_review,project.shots[0].quality_review);
 nodes[1].media_metadata.duration_ms=-1;assert.equal(normalizeCanvasClipboard({nodes,connections:[]}),null);
});
