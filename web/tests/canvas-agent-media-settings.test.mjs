import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { installVideoModelContracts, videoModelContract } from "../src/lib/video-model-contracts.ts";
import { imageAdapterDefaults, installImageModelDefinitions } from "../src/lib/image-model-definitions.ts";
import { canvasAgentMediaCapabilities, resolveCanvasAgentMediaSettings } from "../src/app/canvas/agent/canvas-agent-media-settings.ts";
import { normalizeCanvasAgentAction } from "../src/app/canvas/agent/canvas-agent-tools.ts";
import { buildCanvasAgentSkillPrompt } from "../src/app/canvas/agent/canvas-agent-skills.ts";
import { canvasAgentVideoSupportsAudio } from "../src/app/canvas/agent/canvas-agent-generation.ts";

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

test("missing video contracts report unknown audio capability instead of silent-only", () => {
  const capabilities = canvasAgentMediaCapabilities("test-image", "unconfigured-video").video;
  assert.equal(capabilities.contractConfigured, false);
  assert.equal(capabilities.audioControl, "unknown");
  assert.equal(canvasAgentVideoSupportsAudio("unconfigured-video"), null);
  const result = resolveCanvasAgentMediaSettings(action("generate_video", { generateAudio: true }), "unconfigured-video", defaults);
  assert.equal(result.code, "video_contract_missing");
});

test("fixed audio is supported even without an audio request field", () => {
  const contract = videoModelContract("minimax-h3-768p");
  assert.equal(contract.request.generate_audio_field, "");
  assert.equal(canvasAgentMediaCapabilities("test-image", "minimax-h3-768p").video.audioControl, "always");
  assert.equal(canvasAgentVideoSupportsAudio("minimax-h3-768p"), true);
});

test("one Agent media capability or settings read copies only the selected contract once", () => {
  const clone = globalThis.structuredClone;
  let copies = 0;
  globalThis.structuredClone = (...args) => {
    if (args[0]?.capability && args[0]?.generation) copies++;
    return clone(...args);
  };
  let capabilities, settings, capabilityCopies, settingsCopies;
  try {
    capabilities = canvasAgentMediaCapabilities("test-image", "seedance2.0-A").video;
    capabilityCopies = copies;
    copies = 0;
    settings = resolveCanvasAgentMediaSettings(action("generate_video", { seconds: 10 }), "seedance2.0-A", defaults);
    settingsCopies = copies;
  } finally {
    globalThis.structuredClone = clone;
  }
  assert.deepEqual({ capabilityCopies, settingsCopies }, { capabilityCopies: 1, settingsCopies: 1 });
  assert.equal(settings.ok, true);
  assert.ok(capabilities.sizes.includes(settings.parameters.generation_video_size));
  capabilities.sizes.push("caller-size");
  capabilities.referenceMaterials.modes[0].label = "caller-label";
  const next = canvasAgentMediaCapabilities("test-image", "seedance2.0-A").video;
  assert.equal(next.sizes.includes("caller-size"), false);
  assert.notEqual(next.referenceMaterials.modes[0].label, "caller-label");
});

test("video model discovery and switching are exposed to both Agent engines", () => {
  assert.deepEqual(normalizeCanvasAgentAction("list_video_models", {}).arguments, {});
  assert.deepEqual(normalizeCanvasAgentAction("set_video_model", { model: "minimax-h3-768p" }).arguments, { model: "minimax-h3-768p" });
  assert.throws(() => normalizeCanvasAgentAction("set_video_model", { model: "" }));
  assert.throws(() => normalizeCanvasAgentAction("set_video_model", { model: "minimax-h3-768p", approved: true }));
});

test("Agent receives the selected video contract material transport and limits", () => {
  for (const model of ["seedance2.0-A", "minimax-h3-768p"]) {
    const contract = videoModelContract(model);
    const capabilities = canvasAgentMediaCapabilities("test-image", model).video;
    const materials = capabilities.referenceMaterials;
    assert.deepEqual(capabilities.parameters, contract.capability.parameters || []);
    assert.equal(capabilities.defaultMode, contract.generation.modes.find((mode) => mode.id === contract.generation.default_mode)?.kind || "text");
    assert.deepEqual(materials, {
      transport: contract.transport.local_material,
      transports: [contract.transport.local_material],
      multipartRepeatable: contract.transport.multipart_repeatable,
      multipartMixedURLs: contract.transport.multipart_mixed_urls,
      base64: false,
      dataURL: false,
      modes: contract.generation.modes,
    });
  }
});

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
  const video = action("generate_video", { size, resolution, seconds: 10, generateAudio: false });
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
  assert.match(poster, /【图片与视觉素材 Skill/);
  assert.doesNotMatch(poster, /【总创作流程 Skill|【视频.*Skill/);
  const promo = buildCanvasAgentSkillPrompt("intake", "制作十秒宣传视频", context);
  assert.match(promo, /【视频/);
  assert.match(promo, /不强制先生成图片/);
  const drama = buildCanvasAgentSkillPrompt("intake", "制作三集短剧，先做人设参考图再生成视频", context);
  assert.match(drama, /【图片与视觉素材 Skill/);
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
      assert.match(result.message, /合理默认显式填写/);
      assert.doesNotMatch(result.message, /先通过 ask_user_question/);
    }
  }
});

test("models with mandatory audio reject an explicit silent request", () => {
  const silent = action("generate_video", { generateAudio: false });
  assert.equal(resolveCanvasAgentMediaSettings(silent, "minimax-h3-768p", defaults).code, "video_audio_required");
  const audible = action("generate_video", { generateAudio: true });
  assert.equal(resolveCanvasAgentMediaSettings(audible, "minimax-h3-768p", defaults).ok, true);
});

test("silent-only video contracts reject an audible request", () => {
  assert.equal(resolveCanvasAgentMediaSettings(action("generate_video", { generateAudio: true }), "seedance2.0-A", defaults).code, "video_audio_unsupported");
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

 test("shared skills choose routine defaults and reserve questions for real decisions", () => {
 const context = { project: { id: "d", title: "test", nodeCount: 0, connectionCount: 0 }, agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }, selectedNodeIds: [], nodes: [], connections: [], tasks: [], generation: {} };
 const prompt = buildCanvasAgentSkillPrompt("intake", "继续生成有声短剧", context);
 for (const required of ["同阶段的必要缺口合并为一次提问", "每项用户请求最多发起一轮普通澄清", "后续阶段按合理默认直接执行", "不得再弹出“立即生成”授权问题", "技术错误或配置通知不得包装成问题卡", "已接受的限制不重复确认", "requiresUserReview=true"]) assert.ok(prompt.includes(required), required);
 for (const forbidden of ["缺失必须询问", "每次一个关键问题", "只问一个最阻塞的问题", "不能用默认秒数代替用户确认"]) assert.ok(!prompt.includes(forbidden), forbidden);
 });
