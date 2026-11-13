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
  removeScriptAsset,
  scriptMediaPlan,
  scriptMediaHasExistingResult,
  scriptMediaCanRetry,
  scriptCanGenerateMedia,
  scriptAssetConnections,
  scriptAssetPosition,
  reconcileScriptProject,
  reconcileScriptMediaDependencies,
  scriptProductionSummary,
  scriptMediaIssues,
  scriptMediaSelection,
  isCanvasScriptProject,
  detachScriptNodes,
  scriptAssetsToGenerate,
} from "../src/app/canvas/canvas-script.ts";

test("script edits retain authored prompts and invalidate dependent video and movie", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.merged_video_node_id = "movie";
  project.shots[0] = { ...project.shots[0], description: "Original", image_prompt: "Authored frame", video_prompt: "Authored movement", image_node_id: "frame", video_node_id: "clip" };
  const revised = updateScriptShot(project, project.shots[0].id, { description: "Revised" });
  assert.equal(revised.shots[0].image_prompt, "Authored frame");
  assert.equal(revised.shots[0].video_prompt, "Authored movement");
  assert.equal(revised.shots[0].image_prompt_outdated, true);
  assert.equal(revised.shots[0].video_prompt_outdated, true);
  assert.equal(revised.merged_video_outdated, true);
  const frameChanged = updateScriptShot(project, project.shots[0].id, { image_prompt: "Different frame" });
  assert.equal(frameChanged.shots[0].video_outdated, true);
  assert.equal(frameChanged.merged_video_outdated, true);
});

test("script reference slots follow in-place files and removed materials while retaining extra references", () => {
  for (const type of ["image", "video"]) {
    const project = createScriptProject();
    project.assets = [{ id: "hero", image_node_id: "hero" }, { id: "prop", image_node_id: "prop" }];
    Object.assign(project.shots[0], { asset_ids: ["hero", "prop"], [`${type}_node_id`]: "output" });
    const field = type === "image" ? "generation_reference_urls" : "generation_video_reference_image_urls";
    const previous = [{ id: "script", type: "script", script_project: project }, { id: "hero", type: "image", url: "/old.png" }, { id: "prop", type: "image", url: "/prop.png" }, { id: "output", type, [field]: ["/old.png", "/extra.png", "/prop.png"] }, { id: "unrelated", type, [field]: ["/old.png"] }];
    const next = structuredClone(previous);
    next[1].url = "/new.png";
    next[0].script_project.shots[0].asset_ids = ["hero"];
    const result = reconcileScriptMediaDependencies(next, previous);
    assert.deepEqual(result[3][field], ["/new.png", "/extra.png"]);
    assert.deepEqual(result[4][field], ["/old.png"]);
    assert.deepEqual(previous[3][field], ["/old.png", "/extra.png", "/prop.png"]);
    assert.deepEqual(reconcileScriptMediaDependencies(result, result), result);
  }
});

test("shared video references retain material roles still used by another shot", () => {
  const project = createScriptProject();
  project.assets = [{ id: "hero", image_node_id: "old" }, { id: "scene", image_node_id: "old" }];
  project.shots.forEach((shot, index) => Object.assign(shot, { asset_ids: [index ? "scene" : "hero"], video_node_id: "video" }));
  const previous = [{ id: "script", type: "script", script_project: project }, { id: "old", type: "image", url: "/old.png" }, { id: "new", type: "image", url: "/new.png" }, { id: "video", type: "video", generation_video_reference_image_urls: ["/old.png", "/extra.png"] }];
  const next = structuredClone(previous);
  next[0].script_project.assets[0].image_node_id = "new";
  const result = reconcileScriptMediaDependencies(next, previous);
  assert.deepEqual(result[3].generation_video_reference_image_urls, ["/new.png", "/old.png", "/extra.png"]);
});

test("replacing a shot frame updates video reference edges and invalidates existing clip", () => {
  const project = createScriptProject();
  Object.assign(project.shots[0], { image_node_id: "old-frame", video_node_id: "clip" });
  const revised = updateScriptShot(project, project.shots[0].id, { image_node_id: "new-frame" });
  assert.equal(revised.shots[0].video_outdated, true);
  const edges = scriptAssetConnections("script", revised, project, [
    { id: "frame-ref", from_node_id: "old-frame", to_node_id: "clip" },
    { id: "unrelated", from_node_id: "external", to_node_id: "clip" },
  ]);
  assert.ok(!edges.some(edge => edge.from_node_id === "old-frame" && edge.to_node_id === "clip"));
  assert.ok(edges.some(edge => edge.from_node_id === "new-frame" && edge.to_node_id === "clip"));
  assert.ok(edges.some(edge => edge.id === "unrelated"));
});

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

test("pending materials occupy the script input side without covering existing nodes", () => {
  const script = { id: "script", type: "script", x: 500, y: 80, width: 550, height: 600 };
  const image = { id: "pending", type: "image", width: 340, height: 340, generation_status: "loading" };
  const blocker = { id: "existing", type: "image", x: 40, y: 80, width: 340, height: 480 };
  const first = { ...image, ...scriptAssetPosition(script, image, [script, blocker]) };
  assert.ok(first.x + first.width < script.x);
  assert.ok(first.y > blocker.y + blocker.height);
  const secondImage = { ...image, id: "next", width: 190, height: 340 };
  const second = scriptAssetPosition(script, secondImage, [script, blocker, first]);
  assert.ok(second.x + secondImage.width < script.x);
  assert.ok(!(second.x < first.x + first.width && second.x + secondImage.width > first.x && second.y < first.y + first.height && second.y + secondImage.height > first.y));
  assert.deepEqual(scriptAssetPosition(script, first, [script, blocker, first]), { x: first.x, y: first.y });
  const project = createScriptProject();
  project.assets = [{ id: "hero", image_node_id: first.id }];
  const edges = scriptAssetConnections(script.id, project, undefined, []);
  assert.equal(edges[0].from_node_id, first.id);
  assert.equal(edges[0].to_node_id, script.id);
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
  assert.equal(edited.shots[0].image_prompt, "image");
  assert.equal(edited.shots[0].image_prompt_outdated, true);
  assert.equal(edited.shots[0].video_prompt, "video");
  assert.equal(edited.shots[0].video_prompt_outdated, true);
  assert.equal(project.shots[0].image_prompt, "image");
  assert.equal(edited.shots[0].video_node_id, "original-video");
  assert.equal(edited.shots[0].source_node_id, "original-storyboard");
});

test("removing a material invalidates referenced shots and preserves unrelated prompts", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.assets = ["hero", "unused"].map((id) => ({ id, kind: "character", name: id, description: "Reference", image_node_id: `${id}-image` }));
  project.shots.forEach((shot, index) => Object.assign(shot, { description: `Scene ${index}`, image_prompt: "Image", video_prompt: "Video", video_node_id: `video-${index}` }));
  project.shots[0].asset_ids = ["hero"];
  project.shots[0].dialogue = [{ kind: "dialogue", asset_id: "hero", text: "Hello" }];
  const unusedRemoved = removeScriptAsset(project, "unused");
  assert.equal(unusedRemoved.confirmed, true);
  assert.equal(unusedRemoved.shots[0].video_prompt, "Video");
  assert.equal(unusedRemoved.shots[0].video_outdated, false);
  const next = removeScriptAsset(project, "hero");
  assert.equal(next.confirmed, false);
  assert.deepEqual(next.assets.map((asset) => asset.id), ["unused"]);
  assert.deepEqual(next.shots[0].asset_ids, []);
  assert.deepEqual(next.shots[0].dialogue, [{ kind: "dialogue", asset_id: "", text: "Hello" }]);
  assert.equal(next.shots[0].image_prompt, "Image");
  assert.equal(next.shots[0].image_prompt_outdated, true);
  assert.equal(next.shots[0].video_prompt, "Video");
  assert.equal(next.shots[0].video_prompt_outdated, true);
  assert.equal(next.shots[0].video_outdated, true);
  assert.equal(next.shots[0].video_node_id, "video-0");
  assert.equal(next.shots[1].video_prompt, "Video");
  assert.equal(next.shots[1].video_outdated, false);
  assert.equal(project.assets.length, 2);
  assert.equal(project.shots[0].video_prompt, "Video");
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
  image.generation_status = "success";
  assert.deepEqual(scriptProgress(project, [image]).steps, [true, true, false]);

  project.shots[0].image_prompt = "主角在雨中";
  assert.deepEqual(scriptProgress(project, [image]).steps, [true, true, false]);
  project.shots[0].video_prompt = "主角向前走";
  const progress = scriptProgress(project, [image]);
  assert.deepEqual(progress.steps, [true, true, true]);
  assert.equal(progress.complete, 3);
  assert.equal(progress.canGenerate, true);
  assert.deepEqual(scriptProgress({ ...project, step: 0 }, [image]).steps, progress.steps);
  assert.deepEqual(scriptProgress(project, []).steps, [true, false, false]);

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

test("agent-delivered linked videos complete script milestones only after script confirmation", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  project.assets[0].image_node_id = "hero-image";
  project.shots[0].video_node_id = "shot-video";
  const nodes = [
    { id: "hero-image", type: "image", url: "/assets/hero.png" },
    { id: "shot-video", type: "video", prompt: "主角穿过雨中的街道", generation_status: "success", url: "/videos/shot.mp4" },
  ];
  const before = structuredClone({ project, nodes });
  const progress = scriptProgress(project, nodes);
  assert.deepEqual(progress.steps, [false, false, false]);
  assert.equal(progress.readyShots, 1);
  assert.equal(progress.complete, 0);
  assert.equal(progress.canGenerate, false);
  assert.equal(scriptCanGenerateMedia(project, "image", nodes), false);
  assert.equal(scriptCanGenerateMedia(project, "video", nodes), false);
  assert.deepEqual({ project, nodes }, before);

  assert.deepEqual(scriptProgress(project, [nodes[0]]).steps, [false, false, false]);
  assert.deepEqual(scriptProgress(project, [nodes[0], { ...nodes[1], type: "image" }]).steps, [false, false, false]);
  assert.deepEqual(scriptProgress(project, [nodes[0], { ...nodes[1], url: "", generation_status: "error" }]).steps, [false, false, false]);
  assert.deepEqual(scriptProgress(project, [nodes[1]]).steps, [false, false, false]);
  project.confirmed = true;
  assert.deepEqual(scriptProgress(project, [nodes[1]]).steps, [true, false, false]);
  assert.deepEqual(scriptProgress(project, nodes).steps, [true, true, true]);
  assert.equal(scriptProgress(project, nodes).complete, 3);
  project.shots.push({ ...project.shots[0], id: "unbound", video_node_id: "" });
  assert.deepEqual(scriptProgress(project, nodes).steps, [true, true, false]);
});

test("synthesized prompts complete the final step only after confirmation and material preparation", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  Object.assign(project.shots[0], concatenateScriptPrompts(project.shots[0], project.assets));
  project.assets[0].image_node_id = "hero-image";
  const image = { id: "hero-image", type: "image", url: "/hero.png", generation_status: "success" };
  const before = structuredClone(project);
  assert.deepEqual(scriptProgress(project, [image]).steps, [false, false, false]);
  assert.equal(scriptProgress(project, [image]).readyShots, 1);
  assert.deepEqual(project, before);
  project.confirmed = true;
  for (const nodes of [[], [{ ...image, generation_status: "loading" }], [{ ...image, generation_status: "error" }]]) {
    const progress = scriptProgress(project, nodes);
    assert.deepEqual(progress.steps, [true, false, false]);
    assert.equal(progress.complete, 1);
    assert.equal(progress.readyShots, 1);
    assert.equal(progress.canGenerate, false);
  }
  assert.deepEqual(scriptProgress(project, [image]).steps, [true, true, true]);
  assert.equal(scriptProgress(project, [image]).canGenerate, true);
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

test("blank bound media nodes are generated in place instead of treated as replacements", () => {
  assert.equal(scriptMediaHasExistingResult(undefined), false);
  assert.equal(scriptMediaHasExistingResult({ id: "blank", type: "image", generation_status: "idle" }), false);
  assert.equal(scriptMediaHasExistingResult({ id: "failed", type: "image", generation_status: "error" }), false);
  assert.equal(scriptMediaHasExistingResult({ id: "completed", type: "image", generation_status: "success" }), true);
  assert.equal(scriptMediaHasExistingResult({ id: "running", type: "video", generation_status: "loading" }), true);
  assert.equal(scriptMediaHasExistingResult({ id: "tracked", type: "video", task_id: "task", generation_status: "error" }), true);
  assert.equal(scriptMediaHasExistingResult({ id: "retained", type: "image", url: "/old.png", generation_status: "error" }), true);
});

test("script media retry waits until persisted task recovery has settled", () => {
  assert.equal(scriptMediaCanRetry(undefined), false);
  assert.equal(scriptMediaCanRetry({ id: "idle", type: "video", generation_status: "idle" }), false);
  assert.equal(scriptMediaCanRetry({ id: "failed", type: "video", generation_status: "error", generation_error: "provider failed" }), true);
  assert.equal(scriptMediaCanRetry({ id: "pending", type: "video", task_id: "task", generation_status: "error", generation_error: "暂时无法同步后台任务，重新进入画布后将继续恢复。" }), false);
  assert.equal(scriptMediaCanRetry({ id: "interrupted", type: "image", task_id: "task", generation_status: "error", generation_error: "页面刷新后生成已中断，请重新生成。" }), false);
});

test("a shared output is outdated if any linked shot marks it for update", () => {
  const base = createScriptProject().shots[0];
  const nodes = [{ id: "shared", type: "video", url: "/shared.mp4", generation_status: "success" }];
  for (const shots of [
    [{ ...base, id: "current", video_node_id: "shared" }, { ...base, id: "stale", video_node_id: "shared", video_outdated: true }],
    [{ ...base, id: "stale", video_node_id: "shared", video_outdated: true }, { ...base, id: "current", video_node_id: "shared" }],
  ]) {
    const plan = scriptMediaPlan({ ...createScriptProject(), confirmed: true, shots }, "video", nodes);
    assert.deepEqual(plan.outdated.map((node) => node.id), ["shared"]);
    assert.deepEqual(plan.complete, []);
  }
});

test("media checks still validate assets for an already linked output", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.assets = [{ id: "hero", kind: "character", name: "Hero", description: "", image_node_id: "" }];
  project.shots = [{ ...project.shots[0], video_node_id: "shared", video_prompt: "move", asset_ids: ["hero"] }];
  const nodes = [{ id: "shared", type: "video", url: "/shared.mp4", generation_status: "success" }];
  assert.deepEqual(scriptMediaIssues(project, "video", nodes), ["第 1 镜的素材「Hero」尚未准备完成"]);
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

test("recovered prompt synthesis marks retained media outdated", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.shots = [{
    ...project.shots[0],
    image_node_id: "image-1",
    video_node_id: "video-1",
    image_prompt: "旧图片提示词",
    video_prompt: "旧视频提示词",
  }];
  const next = parseScriptPrompts(JSON.stringify({ shots: [{
    id: project.shots[0].id,
    image_prompt: "新图片提示词",
    video_prompt: "新视频提示词",
  }] }), project, [project.shots[0].id]);
  assert.equal(next.shots[0].image_outdated, true);
  assert.equal(next.shots[0].video_outdated, true);
  assert.equal(next.confirmed, true);
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


test("replacing a material refreshes shot inputs and marks retained results outdated", () => {
  const previous = parseGeneratedScript(JSON.stringify(generated));
  previous.confirmed = true;
  previous.assets[0].image_node_id = "old-ref";
  previous.shots[0] = { ...previous.shots[0], video_node_id: "video", image_prompt: "image", video_prompt: "video" };
  const next = structuredClone(previous);
  next.assets[0].image_node_id = "new-ref";
  const reconciled = reconcileScriptProject(next, previous);
  assert.equal(reconciled.confirmed, false);
  assert.equal(reconciled.shots[0].video_outdated, true);
  assert.equal(reconciled.shots[0].video_prompt, "video");
  assert.equal(reconciled.shots[0].video_prompt_outdated, true);
  const edges = scriptAssetConnections("script", reconciled, previous, [
    { id: "old-input", from_node_id: "old-ref", to_node_id: "script" },
    { id: "old-shot", from_node_id: "old-ref", to_node_id: "video" },
    { id: "extra", from_node_id: "external", to_node_id: "video" },
  ]);
  assert.ok(!edges.some((edge) => edge.from_node_id === "old-ref"));
  assert.ok(edges.some((edge) => edge.from_node_id === "new-ref" && edge.to_node_id === "video"));
  assert.ok(edges.some((edge) => edge.id === "extra"));
  assert.deepEqual(scriptAssetConnections("script", reconciled, reconciled, edges), edges);
});

test("shared shot outputs retain the union of every linked material input", () => {
  const project = createScriptProject();
  project.assets = [
    { id: "hero", kind: "character", name: "Hero", description: "", image_node_id: "hero-new" },
    { id: "room", kind: "scene", name: "Room", description: "", image_node_id: "room-new" },
  ];
  project.shots = [
    { ...project.shots[0], id: "one", asset_ids: ["hero"], video_node_id: "shared" },
    { ...project.shots[0], id: "two", asset_ids: ["room"], video_node_id: "shared" },
  ];
  const previous = structuredClone(project);
  previous.assets[0].image_node_id = "hero-old";
  previous.assets[1].image_node_id = "room-old";
  const edges = [
    { id: "script-output", from_node_id: "script", to_node_id: "shared" },
    { id: "hero-old", from_node_id: "hero-old", to_node_id: "shared" },
    { id: "room-old", from_node_id: "room-old", to_node_id: "shared" },
  ];
  const next = scriptAssetConnections("script", project, previous, edges);
  assert.deepEqual(next.filter((edge) => edge.to_node_id === "shared").map((edge) => edge.from_node_id).sort(), ["hero-new", "room-new", "script"]);
});

test("editing completed shots cannot silently confirm or resubmit outdated results", () => {
  const project = createScriptProject();
  project.shots = [{ ...project.shots[0], description: "old", video_node_id: "video", image_prompt: "old", video_prompt: "old" }];
  project.confirmed = true;
  const nodes = [{ id: "video", type: "video", url: "/old.mp4", generation_status: "success" }];
  const edited = updateScriptShot(project, project.shots[0].id, { description: "new" });
  assert.deepEqual(scriptProgress(edited, nodes).steps, [false, false, false]);
  assert.equal(edited.shots[0].video_outdated, true);
  const plan = scriptMediaPlan({ ...edited, confirmed: true }, "video", nodes);
  assert.equal(plan.complete.length, 0);
  assert.equal(plan.outdated.length, 1);
  assert.equal(plan.ready.length, 0);
  assert.equal(reconcileScriptProject(edited, edited).shots[0].video_outdated, true);
  const replacement = reconcileScriptProject({ ...edited, shots: [{ ...edited.shots[0], video_node_id: "new-video" }] }, edited);
  assert.equal(replacement.shots[0].video_outdated, false);
});

test("material readiness excludes partial and failed previews, and preflight is scoped to referenced assets", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  project.confirmed = true;
  Object.assign(project.shots[0], concatenateScriptPrompts(project.shots[0], project.assets));
  project.assets[0].image_node_id = "hero";
  const image = { id: "hero", type: "image", url: "/preview.png", generation_status: "loading" };
  for (const status of ["loading", "error"]) {
    image.generation_status = status;
    assert.equal(scriptProgress(project, [image]).readyAssets, 0);
    assert.ok(scriptMediaIssues(project, "video", [image]).length);
  }
  image.generation_status = "success";
  project.assets.push({ id: "unused", kind: "prop", name: "Unused", description: "unused", image_node_id: "" });
  assert.deepEqual(scriptMediaIssues(project, "video", [image]), []);
  assert.equal(scriptCanGenerateMedia(project, "video", [image]), true);
  project.shots[0].asset_ids = [];
  assert.ok(scriptMediaIssues(project, "video", []).length, "dialogue-only references must be checked");
});

test("regenerating a script retains stable material and shot bindings or rejects lossy output", () => {
  const previous = parseGeneratedScript(JSON.stringify(generated));
  previous.assets[0].image_node_id = "hero-image";
  previous.shots[0].video_node_id = "shot-video";
  const output = { assets: previous.assets.map(({ image_node_id, ...asset }) => asset), shots: previous.shots.map((shot) => ({ ...shot, description: "Changed scene" })) };
  const updated = parseGeneratedScript(JSON.stringify(output), previous);
  assert.equal(updated.assets[0].image_node_id, "hero-image");
  assert.equal(updated.shots[0].video_node_id, "shot-video");
  assert.equal(updated.shots[0].video_outdated, true);
  assert.throws(() => parseGeneratedScript(JSON.stringify(generated), previous), /保留/);
  assert.equal(previous.shots[0].video_outdated, undefined);
});

test("regenerating unchanged dialogue preserves prompts and media freshness", () => {
  const previous = parseGeneratedScript(JSON.stringify(generated));
  previous.confirmed = true;
  previous.shots[0].video_node_id = "video";
  previous.shots[0].image_prompt = "Image prompt";
  previous.shots[0].video_prompt = "Video prompt";
  const updated = parseGeneratedScript(JSON.stringify(previous), previous);
  assert.equal(updated.shots[0].video_node_id, "video");
  assert.equal(updated.shots[0].video_outdated, false);
  assert.equal(updated.shots[0].image_prompt, "Image prompt");
  assert.equal(updated.shots[0].video_prompt, "Video prompt");
});

test("dialogue identity changes preserve confirmation but content changes invalidate media", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  project.confirmed = true;
  Object.assign(project.shots[0], { image_prompt: "Image", video_prompt: "Video", video_node_id: "video" });
  const line = project.shots[0].dialogue[0];
  for (const patch of [{ id: "new-id" }, { text: "New words" }, { kind: "narration" }, { asset_id: "" }]) {
    const next = updateScriptShot(project, project.shots[0].id, { dialogue: [{ ...line, ...patch }] });
    const identityOnly = "id" in patch;
    assert.equal(next.confirmed, identityOnly);
    assert.equal(next.shots[0].video_outdated, !identityOnly);
    assert.equal(next.shots[0].video_prompt, "Video");
    assert.equal(next.shots[0].video_prompt_outdated, !identityOnly);
  }
  const removed = updateScriptShot(project, project.shots[0].id, { dialogue: [] });
  assert.equal(removed.confirmed, false);
  assert.equal(removed.shots[0].video_outdated, true);
});

test("generated shot IDs must be unique before assigning canvas IDs", () => {
  const shot = { ...generated.shots[0], id: "duplicate" };
  assert.throws(() => parseGeneratedScript(JSON.stringify({ ...generated, shots: [shot, shot] })), /编号重复/);
  const previous = parseGeneratedScript(JSON.stringify(generated));
  const newShot = { ...previous.shots[0], id: "new-shot" };
  assert.throws(() => parseGeneratedScript(JSON.stringify({ assets: previous.assets, shots: [...previous.shots, newShot, newShot] }), previous), /编号重复/);
  const distinct = parseGeneratedScript(JSON.stringify({ ...generated, shots: [shot, { ...shot, id: "different" }] }));
  assert.equal(distinct.shots.length, 2);
  assert.notEqual(distinct.shots[0].id, distinct.shots[1].id);
});

test("removing linked media detaches only removed references and permits replacement", () => {
  const project = parseGeneratedScript(JSON.stringify(generated));
  project.shots[0].video_node_id = "video";
  project.shots[0].image_node_id = "image";
  project.merged_video_node_id = "movie";
  project.merged_video_fingerprint = "fingerprint";
  const next = detachScriptNodes(project, new Set(["video", "movie"]));
  assert.equal(next.shots[0].video_node_id, "");
  assert.equal(next.shots[0].image_node_id, "image");
  assert.equal(next.merged_video_fingerprint, undefined);
  assert.equal(scriptMediaPlan(next, "video", []).missing.length, 1);
});


test("explicit regeneration creates only the selected replacement and preserves other results", () => {
  const project = createScriptProject();
  project.confirmed = true;
  project.shots.forEach((shot, i) => Object.assign(shot, { description: `Scene ${i}`, image_prompt: "Image", video_prompt: "Video", video_node_id: `video-${i}`, video_outdated: true }));
  const nodes = project.shots.map((shot) => ({ id: shot.video_node_id, type: "video", url: "/old.mp4", generation_status: "success" }));
  const selected = scriptMediaSelection(project, "video", [project.shots[1].id], true);
  assert.equal(selected.shots.length, 1);
  assert.equal(selected.shots[0].video_node_id, "");
  assert.deepEqual(scriptMediaIssues(selected, "video", nodes), []);
  assert.equal(scriptMediaPlan(selected, "video", nodes).missing.length, 1);
  assert.equal(project.shots[1].video_node_id, "video-1");
  assert.equal(project.shots[0].video_outdated, true);
  selected.shots[0].video_prompt = "";
  assert.ok(scriptMediaIssues(selected, "video", nodes).length);
});

test("script serialization retains outdated flags and rejects non-boolean state", () => {
  const project = createScriptProject();
  project.shots[0].video_outdated = true;
  assert.equal(isCanvasScriptProject(JSON.parse(JSON.stringify(project))), true);
  project.shots[0].video_outdated = "true";
  assert.equal(isCanvasScriptProject(project), false);
});

test("in-place media replacement invalidates existing downstream media but layout and first results do not", () => {
  const project = createScriptProject();
  project.assets = [{ id:"hero",kind:"character",name:"Hero",description:"",image_node_id:"asset" }];
  project.merged_video_node_id="movie";
  project.shots[0]={...project.shots[0],asset_ids:["hero"],image_node_id:"frame",video_node_id:"clip"};
  const before=[{id:"script",type:"script",script_project:project},{id:"asset",type:"image",url:"/asset.png"},{id:"frame",type:"image",url:"/frame.png"},{id:"clip",type:"video",url:"/clip.mp4"}];
  const next=structuredClone(before);next[1].url="/new.png";
  const revised=reconcileScriptMediaDependencies(next,before)[0].script_project;
  assert.equal(revised.shots[0].image_outdated,true);
  assert.equal(revised.shots[0].video_outdated,true);
  assert.equal(revised.merged_video_outdated,true);
  assert.equal(before[0].script_project.shots[0].video_outdated,undefined);
  const moved=structuredClone(before);moved[1].x=200;
  assert.equal(reconcileScriptMediaDependencies(moved,before)[0],moved[0]);
  delete before[3].url;
  assert.equal(Boolean(reconcileScriptMediaDependencies(next,before)[0].script_project.shots[0].video_outdated),false);
});

test("quality and actual runtime remain separate from task success and request duration", () => {
 const project=createScriptProject();project.shots=project.shots.slice(0,1);project.shots[0].video_node_id="clip";
 const nodes=[{id:"clip",type:"video",url:"/one.mp4",generation_status:"success",duration_ms:99999,generation_video_seconds:15,media_metadata:{width:768,height:1376,duration_ms:15020,has_audio:true}}];
 let summary=scriptProductionSummary(project,nodes);
 assert.equal(summary.actualSeconds,15.02);assert.equal(summary.reviewed,0);assert.equal(summary.delivered,1);
 project.shots[0].quality_review={media_url:"/one.mp4",continuity:"passed",dialogue:"passed",speaker:"passed",lip_sync:"passed",notes:"Reviewed playback"};
 assert.equal(scriptProductionSummary(project,nodes).reviewed,0, "the prior four checks do not certify text on screen");
 project.shots[0].quality_review.text_on_screen="needs_fix";
 assert.equal(scriptProductionSummary(project,nodes).needsFix,1);
 project.shots[0].quality_review.text_on_screen="passed";
 assert.equal(scriptProductionSummary(project,nodes).reviewed,1);
 nodes[0].generation_status="error";
 assert.equal(scriptProductionSummary(project,nodes).reviewed,0);
 nodes[0].generation_status="success";
 nodes[0].url="/replacement.mp4";
 assert.equal(scriptProductionSummary(project,nodes).reviewed,0);
 assert.equal(isCanvasScriptProject(project),true);
 project.shots[0].quality_review.text_on_screen="pretend_passed";
 assert.equal(isCanvasScriptProject(project),false);
});

test("production review prioritizes current failures and excludes replaced or outdated records", () => {
 const project=createScriptProject();
 project.shots=[0,1,2].map(i=>({...project.shots[0],id:`shot-${i}`,video_node_id:`clip-${i}`}));
 const nodes=project.shots.map((shot,i)=>({id:shot.video_node_id,type:"video",url:`/clip-${i}.mp4`,generation_status:"success"}));
 const review=i=>({media_url:nodes[i].url,continuity:"passed",dialogue:"passed",speaker:"passed",lip_sync:"passed",text_on_screen:"passed",notes:"Automated review fixture"});
 project.shots[0].quality_review=review(0);
 project.shots[1].quality_review={...review(1),text_on_screen:"needs_fix"};
 let summary=scriptProductionSummary(project,nodes);
 assert.equal(summary.reviewed,1);assert.equal(summary.needsFix,1);assert.equal(summary.unchecked,1);
 assert.equal(summary.reviewStatus,"needs_fix");assert.equal(summary.reviewLabel,"验收需修复 1/3");
 nodes[1].url="/replacement.mp4";
 summary=scriptProductionSummary(project,nodes);
 assert.equal(summary.needsFix,0);assert.equal(summary.unchecked,2);assert.equal(summary.reviewStatus,"unchecked");assert.equal(summary.reviewLabel,"验收通过 1/3");
 nodes[1].url=project.shots[1].quality_review.media_url;project.shots[1].video_outdated=true;
 assert.equal(scriptProductionSummary(project,nodes).needsFix,0);
 project.shots.forEach((shot,i)=>{shot.video_outdated=false;shot.quality_review=review(i);});
 summary=scriptProductionSummary(project,nodes);
 assert.equal(summary.reviewStatus,"passed");assert.equal(summary.reviewLabel,"镜头验收通过");
 project.shots=[];
 assert.equal(scriptProductionSummary(project,nodes).reviewStatus,"unchecked");
});

test("editing unsubmitted media requires prompt review without replacing the empty nodes", () => {
  for (const status of ["idle", "loading", "error", "success"]) {
    const project = createScriptProject();
    project.confirmed = true;
    project.shots = [{ ...project.shots[0], description: "Before", image_node_id: "frame", video_node_id: "clip", image_prompt: "Frame", video_prompt: "Clip" }];
    const before = [{ id: "script", type: "script", script_project: project }, ...["frame", "clip"].map(id => ({ id, type: id === "frame" ? "image" : "video", generation_status: status, task_id: status === "error" ? id + "-task" : undefined }))];
    const next = structuredClone(before);
    next[0].script_project = updateScriptShot(next[0].script_project, project.shots[0].id, { description: "After" });
    const revised = reconcileScriptMediaDependencies(next, before)[0].script_project;
    assert.equal(revised.shots[0].image_outdated, status !== "idle", status);
    assert.equal(revised.shots[0].video_outdated, status !== "idle", status);
    assert.equal(revised.shots[0].image_prompt_outdated, true);
    assert.equal(revised.confirmed, false);
  }
});

test("replacing a media file clears its inherited measurements but layout retains them", () => {
  const previous = [{id:"clip",type:"video",url:"/old.mp4",media_metadata:{width:768,height:1376,duration_ms:15020,has_audio:true},media_silent_clips:1,media_probe_error:"Old error"}];
  const moved = structuredClone(previous);moved[0].x=200;
  assert.deepEqual(reconcileScriptMediaDependencies(moved,previous)[0].media_metadata,previous[0].media_metadata);
  const replaced = structuredClone(previous);replaced[0].url="/new.mp4";
  const actual = reconcileScriptMediaDependencies(replaced,previous)[0];
  assert.equal(actual.media_metadata,undefined);
  assert.equal(actual.media_probe_error,undefined);
  assert.equal(actual.media_silent_clips,undefined);
  assert.equal(previous[0].media_metadata.duration_ms,15020);
});
