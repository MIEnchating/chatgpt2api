import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { installVideoModelContracts } from "../src/lib/video-model-contracts.ts";
import { imageAdapterDefaults, installImageModelDefinitions } from "../src/lib/image-model-definitions.ts";
import { canvasAgentMediaCapabilities, resolveCanvasAgentMediaSettings } from "../src/app/canvas/agent/canvas-agent-media-settings.ts";
import { normalizeCanvasAgentAction } from "../src/app/canvas/agent/canvas-agent-tools.ts";
import { buildCanvasAgentSkillPrompt } from "../src/app/canvas/agent/canvas-agent-skills.ts";

beforeAll(() => {
  installVideoModelContracts(structuredClone(contractDocument.contracts));
  installImageModelDefinitions({ "test-image": imageAdapterDefaults("openai-image"), "test-gemini": imageAdapterDefaults("google-gemini-image") });
});
afterAll(() => {
  installVideoModelContracts([]);
  installImageModelDefinitions({});
});

const defaults = { generation_size: "1:1", generation_quality: "low" };
const action = (name, args) => normalizeCanvasAgentAction(name, { prompt: "按需求创作", sourceNodeIds: [], size: "1:1", ...(name === "generate_video" ? { seconds: 10, generateAudio: false } : { count: 1 }), ...args });

test("each image can choose its own dimensions and quality without changing shared defaults", () => {
  const poster = resolveCanvasAgentMediaSettings(action("generate_image", { size: "9:16", quality: "high", count: 1 }), "test-image", defaults);
  const sheet = resolveCanvasAgentMediaSettings(action("edit_image", { sourceNodeIds: ["character"], size: "16:9", quality: "medium" }), "test-image", defaults);
  assert.deepEqual(poster, { ok: true, parameters: { generation_size: "9:16", generation_quality: "high" } });
  assert.deepEqual(sheet, { ok: true, parameters: { generation_size: "16:9", generation_quality: "medium" } });
  assert.deepEqual(defaults, { generation_size: "1:1", generation_quality: "low" });
});

test("unsupported image quality and dimensions return actionable errors before node creation", () => {
  assert.throws(() => action("generate_image", { quality: "ultra" }), /不是允许的值/);
  const unsupported = resolveCanvasAgentMediaSettings(action("generate_image", { quality: "high" }), "test-gemini", defaults);
  assert.equal(unsupported.code, "unsupported_image_quality");
  assert.deepEqual(unsupported.supported, []);
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_image", { size: "not-a-size" }), "test-image", defaults).code, "unsupported_image_size");
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_image", { size: "1024x1536" }), "test-image", defaults).ok, true);
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_image", { size: "1024x1536" }), "test-gemini", defaults).ok, true);
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_image", { size: "9:16", resolution: "2k" }), "test-gemini", defaults).parameters.generation_resolution, "2k");
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_image", { resolution: "99k" }), "test-gemini", defaults).code, "unsupported_image_resolution");
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_image", {}), "test-gemini", defaults).parameters.generation_quality, "");
});

test("video tools preserve requested resolution and choose only supported model settings", () => {
  const capability = canvasAgentMediaCapabilities("test-image", "seedance2.0-A").video;
  assert.ok(capability.sizes.length);
  assert.ok(capability.resolutions.length);
  const size = capability.sizes.at(-1);
  const resolution = capability.resolutions.at(-1);
  const video = action("generate_video", { size, resolution, seconds: 10, generateAudio: true });
  assert.equal(video.arguments.resolution, resolution);
  assert.deepEqual(resolveCanvasAgentMediaSettings(video, "seedance2.0-A", defaults), { ok: true, parameters: { generation_video_size: size, generation_video_resolution: resolution } });
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_video", { size: "not-a-size" }), "seedance2.0-A", defaults).code, "unsupported_video_size");
  const error = resolveCanvasAgentMediaSettings(action("generate_video", { resolution: "99k" }), "seedance2.0-A", defaults);
  assert.equal(error.code, "unsupported_video_resolution");
  assert.deepEqual(error.supported, capability.resolutions);
});

test("technical defaults remain optional while delivery parameters are explicit", () => {
  assert.deepEqual(resolveCanvasAgentMediaSettings(action("generate_image", {}), "test-image", defaults), { ok: true, parameters: defaults });
  const video = resolveCanvasAgentMediaSettings(action("generate_video", {}), "seedance2.0-A", defaults);
  assert.equal(video.ok, true);
  assert.ok(canvasAgentMediaCapabilities("test-image", "seedance2.0-A").video.sizes.includes(video.parameters.generation_video_size));
  assert.equal(video.parameters.generation_size, undefined);
});

test("static advertising avoids film planning while promotional video and drama receive the relevant skills", () => {
  const context = { project: { id: "test", title: "test", nodeCount: 0, connectionCount: 0 }, agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }, selectedNodeIds: [], nodes: [], connections: [], tasks: [], generation: {} };
  const poster = buildCanvasAgentSkillPrompt("intake", "制作一张竖版平面广告海报", context);
  assert.match(poster, /【图片与视觉资产 Skill/);
  assert.doesNotMatch(poster, /【总创作流程 Skill|【视频.*Skill/);
  const promo = buildCanvasAgentSkillPrompt("intake", "制作十秒宣传视频", context);
  assert.match(promo, /【视频/);
  assert.match(promo, /不强制先生成图片/);
  const drama = buildCanvasAgentSkillPrompt("intake", "制作三集短剧，先做人设参考图再生成视频", context);
  assert.match(drama, /【图片与视觉资产 Skill/);
  assert.match(drama, /【视频/);
  assert.match(drama, /按实际依赖组合/);
});


test("missing delivery parameters cannot fall through to model defaults", () => {
  for (const name of ["generate_image", "edit_image", "generate_video"]) {
    const required = name === "generate_video" ? ["size", "seconds", "generateAudio"] : ["size", "count"];
    for (const field of required) {
      const args = { prompt: "生成", sourceNodeIds: ["image"], size: "1:1", ...(name === "generate_video" ? { seconds: 10, generateAudio: false } : { count: 1 }) };
      delete args[field];
      assert.throws(() => normalizeCanvasAgentAction(name, args), new RegExp(field));
      const result = resolveCanvasAgentMediaSettings({ name, arguments: args }, "test-image", defaults);
      assert.equal(result.code, "missing_media_parameters");
      assert.deepEqual(result.supported.missing, [field]);
      assert.match(result.message, /ask_user_question/);
    }
  }
});

test("models with mandatory audio reject an explicit silent request", () => {
  const silent = action("generate_video", { generateAudio: false });
  assert.equal(resolveCanvasAgentMediaSettings(silent, "minimax-h3-768p", defaults).code, "video_audio_required");
  const audible = action("generate_video", { generateAudio: true });
  assert.equal(resolveCanvasAgentMediaSettings(audible, "minimax-h3-768p", defaults).ok, true);
});


test("image reference limits match the configured image model", () => {
  assert.equal(canvasAgentMediaCapabilities("test-image", "").image.maxReferenceImages, 4);
  assert.equal(canvasAgentMediaCapabilities("test-gemini", "").image.maxReferenceImages, 14);
});

test("image counts above the model limit are rejected instead of silently clamped", () => {
  const model = "test-gemini";
  const max = canvasAgentMediaCapabilities(model, "").image.maxCount;
  assert.equal(resolveCanvasAgentMediaSettings({ name: "generate_image", arguments: { size: "1:1", count: max + 1 } }, model, defaults).code, "unsupported_image_count");
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_image", { count: max }), model, defaults).ok, true);
});
