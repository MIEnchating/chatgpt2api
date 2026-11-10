import assert from "node:assert/strict";
import test from "node:test";
import { buildCanvasGenerationContext } from "../src/app/canvas/canvas-generation-context.ts";
import { buildAllCanvasResourceReferences } from "../src/app/canvas/canvas-resources.ts";
import {
  createScriptProject,
  concatenateScriptPrompts,
  parseGeneratedScript,
  parseScriptPrompts,
  scriptProgress,
  updateScriptShot,
  scriptMediaPlan,
  scriptCanGenerateMedia,
  scriptAssetConnections,
  scriptAssetsToGenerate,
} from "../src/app/canvas/canvas-script.ts";

const generated = {
  assets: [{ id: "hero", kind: "character", name: "小雨", description: "红色雨衣" }],
  shots: [
    {
      seconds: 5,
      description: "小雨穿过雨中的街道",
      framing: "全景",
      lighting: "冷调",
      camera: "跟镜",
      sound: "雨声",
      asset_ids: ["hero"],
      dialogue: [{ kind: "dialogue", asset_id: "hero", text: "快到了" }],
    },
  ],
};
test("asset bindings repair direction and replacement removes only the old asset input", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  project.assets[0].image_node_id = "hero";
  const edges = [
    { id: "reverse", from_node_id: "script", to_node_id: "hero" },
    { id: "video", from_node_id: "script", to_node_id: "video" },
    { id: "ref-video", from_node_id: "hero", to_node_id: "video" },
  ];
  const fixed = scriptAssetConnections("script", project, undefined, edges);
  assert.deepEqual(fixed, [{ ...edges[0], from_node_id: "hero", to_node_id: "script" }, ...edges.slice(1)]);
  assert.deepEqual(scriptAssetConnections("script", project, project, fixed), fixed);
  const replaced = structuredClone(project);
  replaced.assets[0].image_node_id = "replacement";
  const updated = scriptAssetConnections("script", replaced, project, fixed);
  assert.deepEqual(updated.slice(0, 2), edges.slice(1));
  assert.equal(updated.at(-1).from_node_id, "replacement");
  assert.equal(updated.at(-1).to_node_id, "script");
  const duplicate = [...fixed, edges[0]];
  assert.deepEqual(scriptAssetConnections("script", project, project, duplicate), fixed);
  const replacedLegacy = scriptAssetConnections("script", replaced, project, edges);
  assert.deepEqual(replacedLegacy.slice(0, 2), edges.slice(1));
  assert.equal(replacedLegacy.at(-1).from_node_id, "replacement");
  replaced.shots[0].image_node_id = "hero";
  const shared = scriptAssetConnections("script", replaced, project, edges);
  assert.deepEqual(shared.slice(0, 3), edges);
  assert.deepEqual(edges[0], { id: "reverse", from_node_id: "script", to_node_id: "hero" });
});

test("batch assets skip finished images and existing tasks even if a stale selection includes them", () => {
  const project = createScriptProject();
  project.assets = ["done", "loading", "tracked", "new"].map((id) => ({ id, kind: "character", name: id, description: "设定", image_node_id: id }));
  const nodes = [
    { id: "done", type: "image", url: "/done.png" },
    { id: "loading", type: "image", generation_status: "loading" },
    { id: "tracked", type: "image", task_id: "paid-task", generation_status: "error" },
  ];
  assert.deepEqual(scriptAssetsToGenerate(project, nodes, project.assets.map((asset) => asset.id)).map((asset) => asset.id), ["new"]);
});
test("script generation preserves asset identity across shots and dialogue", () => {
  const project = parseGeneratedScript("```json\n" + JSON.stringify(generated) + "\n```");
  assert.equal(project.shots[0].asset_ids[0], project.assets[0].id);
  assert.equal(project.shots[0].dialogue[0].asset_id, project.assets[0].id);
  assert.equal(project.confirmed, false);
  assert.throws(() => parseGeneratedScript('{"shots":[]}'));
  assert.throws(() =>
    parseGeneratedScript(
      JSON.stringify({ ...generated, shots: [{ ...generated.shots[0], seconds: -1 }] }),
    ),
  );
});
test("script readiness requires confirmed shots, real asset images and both prompts", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  const shot = project.shots[0];
  assert.equal(scriptProgress(project, []).canGenerate, false);
  project.confirmed = true;
  Object.assign(shot, concatenateScriptPrompts(shot, project.assets));
  project.assets[0].image_node_id = "image-1";
  assert.equal(scriptProgress(project, []).canGenerate, false);
  assert.equal(
    scriptProgress(project, [{ id: "image-1", type: "image", url: "/api/files/image/content" }])
      .canGenerate,
    true,
  );
  assert.match(shot.video_prompt, /小雨：快到了/);
  assert.match(shot.image_prompt, /红色雨衣/);
  assert.match(shot.video_prompt, /跟镜/);
});
test("editing shot content invalidates stale prompts and confirmation; labels preserve them", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.shots[0].image_prompt = "image";
  project.shots[0].video_prompt = "video";
  project.shots[0].video_node_id = "original-video";
  project.shots[0].source_node_id = "original-storyboard";
  assert.equal(
    updateScriptShot(project, project.shots[0].id, { color: "#ef6b68" }).confirmed,
    true,
  );
  const edited = updateScriptShot(project, project.shots[0].id, { description: "新画面" });
  assert.equal(edited.confirmed, false);
  assert.equal(edited.shots[0].image_prompt, "");
  assert.equal(edited.shots[0].video_prompt, "");
  assert.equal(project.shots[0].image_prompt, "image");
  assert.equal(edited.shots[0].video_node_id, "original-video");
  assert.equal(edited.shots[0].source_node_id, "original-storyboard");
});

test("script step completion follows confirmed content, asset files and synthesized prompts", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  project.step = 2;
  assert.deepEqual(scriptProgress(project, []).steps, [false, false, false]);
  project.confirmed = true;
  assert.deepEqual(scriptProgress(project, []).steps, [true, false, false]);

  project.assets[0].image_node_id = "hero-image";
  const image = { id: "hero-image", type: "image", generation_status: "loading" };
  assert.deepEqual(scriptProgress(project, [image]).steps, [true, false, false]);
  image.url = "/api/files/hero/content";
  assert.deepEqual(scriptProgress(project, [image]).steps, [true, true, false]);

  project.shots[0].image_prompt = "主角在雨中";
  assert.deepEqual(scriptProgress(project, [image]).steps, [true, true, false]);
  project.shots[0].video_prompt = "主角向前走";
  const progress = scriptProgress(project, [image]);
  assert.deepEqual(progress.steps, [true, true, true]);
  assert.equal(progress.complete, 3);
  assert.equal(progress.canGenerate, true);
  assert.deepEqual(scriptProgress({ ...project, step: 0 }, [image]).steps, progress.steps);
  assert.deepEqual(scriptProgress(project, []).steps, [true, false, true]);

  const edited = updateScriptShot(project, project.shots[0].id, { description: "新剧情" });
  assert.deepEqual(scriptProgress(edited, [image]).steps, [false, false, false]);
});

test("asset-free scripts complete preparation after confirmation, empty scripts complete nothing", () => {
  const project = createScriptProject();
  assert.deepEqual(scriptProgress(project, []).steps, [false, false, false]);
  project.confirmed = true;
  assert.deepEqual(scriptProgress(project, []).steps, [true, true, false]);
  project.shots = [];
  const progress = scriptProgress(project, []);
  assert.deepEqual(progress.steps, [false, false, false]);
  assert.equal(progress.complete, 0);
  assert.equal(progress.canGenerate, false);
});

test("agent-delivered linked videos complete script milestones without duplicated prompts or manual confirmation", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  project.assets[0].image_node_id = "hero-image";
  project.shots[0].video_node_id = "shot-video";
  const nodes = [
    { id: "hero-image", type: "image", url: "/assets/hero.png" },
    { id: "shot-video", type: "video", prompt: "主角穿过雨中的街道", generation_status: "success", url: "/videos/shot.mp4" },
  ];
  const before = structuredClone({ project, nodes });
  const progress = scriptProgress(project, nodes);
  assert.deepEqual(progress.steps, [true, true, true]);
  assert.equal(progress.readyShots, 1);
  assert.equal(progress.complete, 3);
  assert.equal(progress.canGenerate, false);
  assert.equal(scriptCanGenerateMedia(project, "image", nodes), false);
  assert.equal(scriptCanGenerateMedia(project, "video", nodes), false);
  assert.deepEqual({ project, nodes }, before);

  assert.deepEqual(scriptProgress(project, [nodes[0]]).steps, [false, false, false]);
  assert.deepEqual(scriptProgress(project, [nodes[0], { ...nodes[1], type: "image" }]).steps, [false, false, false]);
  assert.deepEqual(scriptProgress(project, [nodes[0], { ...nodes[1], url: "", generation_status: "error" }]).steps, [false, false, false]);
  assert.deepEqual(scriptProgress(project, [nodes[1]]).steps, [true, false, true]);
  project.shots.push({ ...project.shots[0], id: "unbound", video_node_id: "" });
  assert.deepEqual(scriptProgress(project, nodes).steps, [false, false, false]);
});

test("script media planning reuses completed, in-flight and failed task identities", () => {
  const project = createScriptProject();
  project.shots = ["complete", "running", "failed", "idle", "new"].map((id) => ({
    ...project.shots[0], id, ...(id === "new" ? {} : { video_node_id: id }),
  }));
  const nodes = [
    { id: "complete", type: "video", url: "/videos/existing.mp4", task_id: "paid-complete", generation_status: "success" },
    { id: "running", type: "video", task_id: "paid-running", generation_status: "loading" },
    { id: "failed", type: "video", task_id: "paid-failed", generation_status: "error" },
    { id: "idle", type: "video", generation_status: "idle" },
  ];
  const original = structuredClone(nodes);
  const plan = scriptMediaPlan(project, "video", nodes);
  assert.deepEqual(plan.missing.map((shot) => shot.id), ["new"]);
  assert.deepEqual(plan.complete.map((node) => node.id), ["complete"]);
  assert.deepEqual(plan.tracked.map((node) => node.task_id), ["paid-running", "paid-failed"]);
  assert.deepEqual(plan.ready.map((node) => node.id), ["idle"]);
  assert.deepEqual(nodes, original);
  assert.deepEqual(scriptMediaPlan(structuredClone(project), "video", structuredClone(nodes)), plan);
});

test("a removed or mismatched bound medium is not silently recreated", () => {
  const project = createScriptProject();
  project.shots[0].video_node_id = "removed";
  assert.throws(() => scriptMediaPlan(project, "video", []), /已删除/);
  assert.throws(() => scriptMediaPlan(project, "video", [{ id: "removed", type: "image" }]), /类型/);
});

test("existing video configuration can resume without rebuilding script prompts or unused asset images", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.assets = [{ id: "prop", kind: "prop", name: "钥匙", description: "已保存在原视频提示词内", image_node_id: "" }];
  project.shots.forEach((shot, i) => { shot.video_node_id = `video-${i}`; });
  const nodes = project.shots.map((shot, i) => ({ id: shot.video_node_id, type: "video", prompt: `Original video prompt ${i}`, task_id: `original-task-${i}` }));
  const before = structuredClone({ project, nodes });
  assert.equal(scriptProgress(project, nodes).canGenerate, false);
  assert.equal(scriptCanGenerateMedia(project, "video", nodes), true);
  assert.equal(scriptCanGenerateMedia(project, "image", nodes), false);
  assert.equal(scriptCanGenerateMedia(project, "video", nodes.slice(1)), false);
  assert.equal(scriptCanGenerateMedia({ ...project, confirmed: false }, "video", nodes), false);
  assert.deepEqual({ project, nodes }, before);
});

test("converting a text script preserves connected story input and resource references", () => {
  const original = { id: "main", type: "text", title: "正式稿", prompt: "不可丢失的完整故事" };
  const target = { id: "target", type: "image", prompt: "镜头画面" };
  const edges = [{ id: "existing-edge", from_node_id: "main", to_node_id: "target" }];
  const before = buildCanvasGenerationContext("target", [original, target], edges, target.prompt);
  const converted = { ...original, type: "script", script_project: createScriptProject() };
  const after = buildCanvasGenerationContext("target", [converted, target], edges, target.prompt);
  assert.deepEqual(after, before);
  assert.match(after.prompt, /不可丢失的完整故事/);
  assert.ok(buildAllCanvasResourceReferences([converted, target]).some((ref) => ref.nodeID === "main" && ref.kind === "text" && ref.text === original.prompt));
});
test("synthesis validates complete and unique shot IDs before replacing prompts", () => {
  const project = createScriptProject();
  const ids = project.shots.map((shot) => shot.id);
  const shots = ids.map((id) => ({ id, image_prompt: "图片", video_prompt: "运动" }));
  assert.equal(
    parseScriptPrompts(JSON.stringify({ shots }), project, ids).shots[0].video_prompt,
    "运动",
  );
  assert.throws(() =>
    parseScriptPrompts(JSON.stringify({ shots: [shots[0], shots[0]] }), project, ids),
  );
  assert.throws(() =>
    parseScriptPrompts(JSON.stringify({ shots: shots.slice(0, 1) }), project, ids),
  );
  assert.throws(() =>
    parseScriptPrompts(JSON.stringify({ shots: [{ ...shots[0], video_prompt: "" }] }), project, [
      ids[0],
    ]),
  );
});

test("scripts can be created and generated on HTTP pages without crypto.randomUUID", () => {
  const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  try {
    const project = createScriptProject();
    assert.equal(project.shots.length, 2);
    assert.notEqual(project.shots[0].id, project.shots[1].id);
    const generatedProject = parseGeneratedScript(JSON.stringify(generated));
    assert.ok(generatedProject.assets[0].id);
    assert.equal(generatedProject.shots[0].dialogue[0].asset_id, generatedProject.assets[0].id);
  } finally {
    if (original) Object.defineProperty(crypto, "randomUUID", original);
    else delete crypto.randomUUID;
  }
});
