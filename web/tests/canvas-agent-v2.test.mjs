import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "bun:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { installVideoModelContracts } from "../src/lib/video-model-contracts.ts";

const originalWindow = globalThis.window;
beforeAll(() => {
  globalThis.window = { setTimeout, clearTimeout };
  installVideoModelContracts(structuredClone(contractDocument.contracts));
});
afterAll(() => {
  installVideoModelContracts([]);
  globalThis.window = originalWindow;
});

const { buildCanvasAgentContext, summarizeCanvasAgentTask, summarizeCanvasAgentNode, serializeCanvasAgentContext } = await import("../src/app/canvas/agent/canvas-agent-context.ts");
const { buildAllCanvasResourceReferences } = await import("../src/app/canvas/canvas-resources.ts");
const { arrangeCanvasAgentNodes, CANVAS_AGENT_PRIMARY_SCRIPT_NODE_SIZE, canvasAgentMediaLayoutSources, canvasAgentNodePosition, canvasAgentSourceNodeIDs, canvasAgentVideoDurationHint, canvasAgentVideoSupportsAudio, validateCanvasAgentVideoSeconds } = await import("../src/app/canvas/agent/canvas-agent-generation.ts");
const { isCanvasAgentSession, clearCanvasAgentSessionReferences, syncCanvasAgentSessions } = await import("../src/app/canvas/agent/canvas-agent-sessions.ts");
const { canvasAgentStarterLabel, canvasInsertPayloadFromMyAsset, canvasPendingAgentAssetNode, createCanvasPendingAgentAsset, defaultCanvasAgentStarterConfig, normalizeCanvasAgentConfig } = await import("../src/app/canvas/agent/canvas-agent-starter.ts");
const { buildCanvasAgentSkillPrompt } = await import("../src/app/canvas/agent/canvas-agent-skills.ts");
const { createCanvasAgentState } = await import("../src/app/canvas/agent/canvas-agent-runtime.ts");
const { abortCanvasAgentRun, beginCanvasAgentRunEpoch, claimCanvasAgentRun, createCanvasAgentRunLifecycle, invalidateCanvasAgentRunLifecycle, isCurrentCanvasAgentRun, mountCanvasAgentRunLifecycle, releaseCanvasAgentRun } = await import("../src/app/canvas/agent/canvas-agent-run-gate.ts");
const { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, isCanvasAgentMediaAction, canvasAgentActionLabel } = await import("../src/app/canvas/agent/canvas-agent-tools.ts");
const { CANVAS_AGENT_INTERACTION_PROMPT, canvasAgentMediaGenerationQuestion, canvasAgentQuestion, canvasAgentQuestionMediaChoice } = await import("../src/app/canvas/agent/canvas-agent-interaction.ts");
const { estimateCanvasAgentTokens } = await import("../src/app/canvas/agent/canvas-agent-memory.ts");

function context(state = createCanvasAgentState()) {
  return buildCanvasAgentContext({
    projectId: "project-1",
    projectTitle: "测试项目",
    nodes: [
      { id: "config-1", type: "config", x: -400, y: 0, width: 320, height: 240, scale_x: 1, scale_y: 1, title: "配置" },
      { id: "text-1", type: "text", x: 0, y: 0, width: 320, height: 240, scale_x: 1, scale_y: 1, title: "剧本", prompt: "第一幕" },
      { id: "image-1", type: "image", x: 400, y: 0, width: 320, height: 240, scale_x: 1, scale_y: 1, title: "角色", url: "/images/role.png", generation_status: "success" },
    ],
    connections: [{ id: "edge-1", from_node_id: "text-1", to_node_id: "image-1" }],
    selectedNodeIds: ["image-1"],
    generation: { textModel: "gpt-5", imageModel: "gpt-image-1", videoModel: "sora-2", audioModel: "gpt-4o-mini-tts", imageQuality: "high", imageSize: "16:9", videoQuality: "1080p", videoSize: "16:9", imageCount: 1, videoSeconds: 10, videoGenerateAudio: false, videoSupportsAudio: true, audioVoice: "alloy", audioLanguage: "", audioFormat: "mp3", audioSpeed: 1 },
    agentState: state,
  });
}

describe("canvas agent v2 tool contract", () => {

  test("merges script videos without a model call or new media generation approval", () => {
    const action = normalizeCanvasAgentAction("merge_script_videos", { scriptNodeId: "script-1" });
    assert.deepEqual(action.arguments, { scriptNodeId: "script-1" });
    assert.equal(isCanvasAgentMediaAction(action), false);
    assert.equal(canvasAgentActionLabel(action), "正在合并分镜视频");
    assert.throws(() => normalizeCanvasAgentAction("merge_script_videos", {}));
    assert.throws(() => normalizeCanvasAgentAction("merge_script_videos", { scriptNodeId: " " }));
    assert.throws(() => normalizeCanvasAgentAction("merge_script_videos", { scriptNodeId: "script-1", urls: ["https://example.test/clip.mp4"] }));
  });

  test("preserves workflow variable controls and explicit clearing when saving", () => {
    const variables = [
      { key: "style", label: "风格", required: true, type: "select", options: ["写实", "插画"], defaultValue: "写实", placeholder: "选择风格" },
      { key: "notes", label: "备注", required: false, type: "textarea", options: [], defaultValue: "", placeholder: "" },
    ];
    const args = { name: "模板", promptTemplate: "{{style}} {{notes}}", variables, mode: "single_image" };
    assert.deepEqual(normalizeCanvasAgentAction("save_workflow", args).arguments.variables, variables);
  });

  test("preserves script ownership on media creation and workflow steps", () => {
    for (const [name, args] of [
      ["generate_image", { prompt: "角色设定图", size: "1:1", count: 1, sourceNodeIds: [], scriptNodeId: "script", assetId: "hero" }],
      ["edit_image", { prompt: "角色设定图", size: "1:1", count: 1, sourceNodeIds: ["reference"], scriptNodeId: "script", assetId: "hero" }],
      ["generate_video", { prompt: "打开门", size: "16:9", seconds: 5, generateAudio: false, sourceNodeIds: [], scriptNodeId: "script", shotId: "shot" }],
      ["create_text_node", { title: "镜头", content: "打开门", sourceNodeIds: [], scriptNodeId: "script", shotId: "shot" }],
    ]) {
      const normalized = normalizeCanvasAgentAction(name, args).arguments;
      assert.equal(normalized.scriptNodeId, "script");
      assert.equal(normalized.assetId, args.assetId);
      assert.equal(normalized.shotId, args.shotId);
    }
    const step = { key: "hero", type: "image", title: "角色", prompt: "角色设定图", dependsOn: [], sourceNodeIds: [], attachmentIds: [], size: "1:1", count: 1, scriptNodeId: "script", assetId: "hero" };
    assert.deepEqual(normalizeCanvasAgentAction("create_canvas_workflow", { steps: [step] }).arguments.steps, [step]);
  });

  test("updates existing media inputs without requiring a new title or exposing task fields", () => {
    const args = { nodeId: "original-video", prompt: "原位修正镜头", generation: { size: "9:16", seconds: 5, generateAudio: false, referenceMode: "reference" }, sourceNodeIds: ["hero", "scene"], attachmentIds: [] };
    assert.deepEqual(normalizeCanvasAgentAction("update_node", args).arguments, args);
    assert.deepEqual(normalizeCanvasAgentAction("update_node", { nodeId: "original-video", sourceNodeIds: [] }).arguments.sourceNodeIds, []);
    assert.throws(() => normalizeCanvasAgentAction("update_node", { nodeId: "original-video" }));
    for (const field of ["taskId", "status", "url", "generation_status", "owner_id"]) {
      assert.throws(() => normalizeCanvasAgentAction("update_node", { ...args, [field]: "forged" }));
    }
    assert.throws(() => normalizeCanvasAgentAction("update_node", { ...args, generation: { referenceMode: "invalid" } }));
  });

  test("normalizes typed video contract parameters for creation, edits, and workflows", () => {
    const entries = [
      { name: "seed", value: 0 },
      { name: "watermark", value: false },
      { name: "callback_url", value: "https://example.test/callback" },
    ];
    const expected = { seed: 0, watermark: false, callback_url: "https://example.test/callback" };
    assert.deepEqual(normalizeCanvasAgentAction("generate_video", { prompt: "move", sourceNodeIds: [], size: "16:9", seconds: 5, generateAudio: false, videoParameters: entries }).arguments.videoParameters, expected);
    assert.deepEqual(normalizeCanvasAgentAction("update_node", { nodeId: "video", generation: { videoParameters: entries } }).arguments.generation.videoParameters, expected);
    const step = { key: "shot", type: "video", title: "shot", prompt: "move", dependsOn: [], sourceNodeIds: [], attachmentIds: [], videoParameters: entries };
    assert.deepEqual(normalizeCanvasAgentAction("create_canvas_workflow", { steps: [step] }).arguments.steps[0].videoParameters, expected);
    assert.throws(() => normalizeCanvasAgentAction("generate_video", { prompt: "move", sourceNodeIds: [], size: "16:9", seconds: 5, generateAudio: false, videoParameters: [entries[0], entries[0]] }), /重复/);
  });

  test("structured scripts expose their storyboard only when read explicitly", () => {
    const project = { step: 2, confirmed: true, assets: [], shots: [{ id: "s1", seconds: 5, description: "关门", video_node_id: "existing-video" }] };
    const node = { id: "script-1", type: "script", prompt: "原故事", script_project: project };
    assert.equal(summarizeCanvasAgentNode(node).scriptProject, undefined);
    assert.deepEqual(summarizeCanvasAgentNode(node, true).scriptProject, project);
    assert.equal(normalizeCanvasAgentAction("query_canvas_nodes", { type: "script" }).arguments.type, "script");
    assert.deepEqual(normalizeCanvasAgentAction("update_script_node", { nodeId: "script-1", scriptProject: project }).arguments.scriptProject, project);
    assert.throws(() => normalizeCanvasAgentAction("update_script_node", { nodeId: "script-1", scriptProject: { ...project, shots: [{ ...project.shots[0], video_node_id: ["fake"] }] } }));
  });

  test("confirming a read script sends its fingerprint without retransmitting authored content", () => {
    const args = { nodeId: "script-1", confirmationFingerprint: "a".repeat(64) };
    assert.deepEqual(normalizeCanvasAgentAction("confirm_script_node", args).arguments, args);
    assert.throws(() => normalizeCanvasAgentAction("confirm_script_node", { nodeId: "script-1" }));
    assert.throws(() => normalizeCanvasAgentAction("confirm_script_node", { ...args, confirmationFingerprint: "stale" }));
    for (const field of ["scriptProject", "content", "quality_review"]) assert.throws(() => normalizeCanvasAgentAction("confirm_script_node", { ...args, [field]: {} }));
  });

  test("claims one panel run synchronously until its controller is released", () => {
    const slot = { current: null };
    const first = claimCanvasAgentRun(slot);
    assert.ok(first instanceof AbortController);
    assert.equal(claimCanvasAgentRun(slot), null);
    assert.equal(releaseCanvasAgentRun(slot, new AbortController()), false);
    assert.equal(claimCanvasAgentRun(slot), null);
    assert.equal(releaseCanvasAgentRun(slot, first), true);

    const second = claimCanvasAgentRun(slot);
    assert.ok(second instanceof AbortController);
    assert.notEqual(second, first);
    assert.equal(releaseCanvasAgentRun(slot, first), false);
    assert.equal(claimCanvasAgentRun(slot), null);
    assert.equal(releaseCanvasAgentRun(slot, second), true);
  });

  test("aborts the active panel run without releasing or replacing its ownership", () => {
    const slot = { current: null };
    const controller = claimCanvasAgentRun(slot);
    assert.ok(controller instanceof AbortController);
    assert.equal(abortCanvasAgentRun(slot), true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(slot.current, controller);
    assert.equal(claimCanvasAgentRun(slot), null);
    assert.equal(releaseCanvasAgentRun(slot, controller), true);
    assert.equal(abortCanvasAgentRun(slot), false);
  });

  test("invalidates every callback from an unmounted Agent run", () => {
    const lifecycle = createCanvasAgentRunLifecycle();
    mountCanvasAgentRunLifecycle(lifecycle);
    const firstEpoch = beginCanvasAgentRunEpoch(lifecycle);
    assert.equal(isCurrentCanvasAgentRun(lifecycle, firstEpoch), true);

    invalidateCanvasAgentRunLifecycle(lifecycle);
    assert.equal(isCurrentCanvasAgentRun(lifecycle, firstEpoch), false);

    mountCanvasAgentRunLifecycle(lifecycle);
    const secondEpoch = beginCanvasAgentRunEpoch(lifecycle);
    assert.equal(isCurrentCanvasAgentRun(lifecycle, firstEpoch), false);
    assert.equal(isCurrentCanvasAgentRun(lifecycle, secondEpoch), true);
  });

  test("Agent configuration stores runtime preferences without fixed media parameters", () => {
    const defaults = { contextWindowTokens: 457_000, autoGenerateMedia: true, textApiMode: "responses", textReasoningEnabled: false, textStreaming: true, activeSkillIds: [] };
    assert.deepEqual(defaultCanvasAgentStarterConfig(), defaults);
    assert.equal(normalizeCanvasAgentConfig(JSON.parse(JSON.stringify({ contextWindowTokens: 128_000 }))).contextWindowTokens, 128_000);
    for (const contextWindowTokens of [0, 1, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "457000", undefined]) {
      assert.equal(normalizeCanvasAgentConfig({ contextWindowTokens }).contextWindowTokens, 457_000);
    }
    assert.equal(normalizeCanvasAgentConfig({ autoGenerateMedia: false }).autoGenerateMedia, false);
    assert.deepEqual(normalizeCanvasAgentConfig({ imageQuality: "high", imageSize: "1:1", videoQuality: "720p", videoSize: "16:9" }), defaults);
    for (const textStreaming of [undefined, false, true, "true"]) {
      assert.equal(normalizeCanvasAgentConfig({ textStreaming }).textStreaming, textStreaming === undefined || textStreaming === true);
    }
    for (const [textApiMode, expected] of [[undefined, "responses"], ["responses", "responses"], ["chat", "chat"]]) {
      assert.equal(normalizeCanvasAgentConfig({ textApiMode }).textApiMode, expected);
    }
  });

  test("canvas Agent settings survive document serialization independently", () => {
    const first = { textModel: "text-a", imageModel: "image-a", videoModel: "video-a", codexModel: "codex-a", codexEffort: "high", textStreaming: false };
    const second = { textModel: "text-b", imageModel: "image-b", videoModel: "video-b", codexModel: "codex-b", codexEffort: "low", textStreaming: true };
    for (const settings of [first, second]) {
      const restored = normalizeCanvasAgentConfig(JSON.parse(JSON.stringify(normalizeCanvasAgentConfig(settings))));
      for (const [key, value] of Object.entries(settings)) assert.equal(restored[key], value);
    }
  });

  test("matches the reference starter asset labels, payloads, ids, metadata, and centered placement", () => {
    const imagePayload = canvasInsertPayloadFromMyAsset({
      id: "asset-image",
      kind: "image",
      title: "角色图",
      url: "/images/role.png",
      storageKey: "server:image-1",
      mimeType: "image/png",
      bytes: 1200,
      width: 1000,
      height: 500,
      tags: [],
      visibility: "private",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const image = createCanvasPendingAgentAsset(imagePayload, canvasAgentStarterLabel("image", []));
    const video = createCanvasPendingAgentAsset({ kind: "video", url: "/videos/shot.mp4", title: "镜头", storageKey: "server:video-1", width: 1920, height: 1080, bytes: 2400, mimeType: "video/mp4", durationMs: 8200 }, "视频1");
    const audio = createCanvasPendingAgentAsset({ kind: "audio", url: "/audio/voice.mp3", title: "旁白", storageKey: "server:audio-1", bytes: 800, mimeType: "audio/mpeg", durationMs: 6100 }, "音频1");
    assert.equal(image.reference.id, image.nodeId);
    assert.equal(image.reference.label, "图片1");
    assert.equal(canvasAgentStarterLabel("image", [image, video, audio]), "图片2");
    const nodes = [image, video, audio].map((asset, index, items) => canvasPendingAgentAssetNode(asset, index, items.length, { x: 800, y: 400 }, "2026-01-01T00:00:00Z"));
    assert.deepEqual({ id: nodes[0].id, x: nodes[0].x, y: nodes[0].y, width: nodes[0].width, height: nodes[0].height }, { id: image.nodeId, x: 120, y: 240, width: 640, height: 320 });
    assert.deepEqual({ id: nodes[1].id, x: nodes[1].x, width: nodes[1].width, height: nodes[1].height }, { id: video.nodeId, x: 590, width: 420, height: 236.25 });
    assert.deepEqual({ id: nodes[2].id, x: nodes[2].x, y: nodes[2].y }, { id: audio.nodeId, x: 990, y: 320 });
    assert.equal(nodes[0].storage_key, "server:image-1");
    assert.equal(nodes[0].mime_type, "image/png");
    assert.equal(nodes[1].duration_ms, 8200);
    assert.equal(nodes[2].duration_ms, 6100);
  });

  test("normalizes the reference tool names and rejects unknown tools", () => {
    assert.equal(CANVAS_AGENT_TOOLS[0].type, "function");
    assert.equal(CANVAS_AGENT_TOOLS[0].function.parameters.type, "object");
    assert.equal(CANVAS_AGENT_TOOLS[0].function.parameters.additionalProperties, false);
    assert.deepEqual(normalizeCanvasAgentAction("create_connection", { fromNodeId: "text-1", toNodeId: "image-1" }, "call-1"), {
      id: "call-1",
      name: "create_connection",
      arguments: { fromNodeId: "text-1", toNodeId: "image-1" },
    });
    assert.throws(() => normalizeCanvasAgentAction("run_shell", {}), /不允许/);
    assert.throws(() => normalizeCanvasAgentAction("edit_image", { prompt: "修改", sourceNodeIds: [], size: "1:1", count: 1 }), /图片来源/);
    const generatedID = normalizeCanvasAgentAction("get_canvas_summary", {}).id;
    assert.match(generatedID, /^[\w-]{21}$/);
  });

  test("plan explanation is optional while plan steps remain required", () => {
    const steps = [{ id: "brief", title: "确认需求", status: "in_progress" }];
    for (const args of [{ steps }, { explanation: "", steps }, { explanation: "  ", steps }]) {
      assert.deepEqual(normalizeCanvasAgentAction("update_plan", args, "plan").arguments, { explanation: "", steps });
    }
    assert.throws(() => normalizeCanvasAgentAction("update_plan", {}), /steps/);
    assert.throws(() => normalizeCanvasAgentAction("update_plan", { explanation: 42, steps }), /explanation/);
  });

  test("exposes and normalizes workflow tools", () => {
    const names = new Set(CANVAS_AGENT_TOOLS.map((tool) => tool.function.name));
    for (const name of ["list_workflows", "get_workflow", "save_workflow", "run_saved_workflow", "create_canvas_workflow", "run_canvas_workflow"]) {
      assert.equal(names.has(name), true, name);
    }
    assert.deepEqual(normalizeCanvasAgentAction("list_workflows", { keyword: "广告" }, "list"), {
      id: "list", name: "list_workflows", arguments: { keyword: "广告" },
    });
    assert.deepEqual(normalizeCanvasAgentAction("run_canvas_workflow", { nodeIds: ["node-1", "node-1", "node-2"] }, "run"), {
      id: "run", name: "run_canvas_workflow", arguments: { nodeIds: ["node-1", "node-2"] },
    });
    assert.throws(() => normalizeCanvasAgentAction("get_workflow", {}), /workflowId/);
    assert.throws(() => normalizeCanvasAgentAction("run_canvas_workflow", { nodeIds: [] }), /nodeIds/);
  });

  test("preserves workflow review purpose on user questions", () => {
    const question = canvasAgentQuestion(normalizeCanvasAgentAction("ask_user_question", {
      question: "确认系列提示词后开始生成？",
      reason: "需要先审核每张图片的提示词。",
      options: ["确认审核并生成", "暂不生成，保留提示词"],
      kind: "confirmation",
      purpose: "workflow_review",
    }, "review-call"), "制作系列广告");
    assert.equal(question.purpose, "workflow_review");
  });

  test("media confirmation recommends generating and clearly states how many nodes are ready", () => {
    const question = canvasAgentMediaGenerationQuestion("media-review", 3);
    assert.equal(question.reason, "已准备 3 个待生成节点；确认后将开始生成。");
    assert.deepEqual(question.options, ["立即生成", "暂不生成，继续规划"]);
    assert.equal(canvasAgentQuestionMediaChoice(question, question.options[0]), "generate");
    assert.equal(canvasAgentQuestionMediaChoice(question, question.options[1]), "defer");
  });

  test("question instructions require explicit user submission", () => {
    assert.match(CANVAS_AGENT_INTERACTION_PROMPT, /选项文字末尾标注“（推荐）”/);
    assert.match(CANVAS_AGENT_INTERACTION_PROMPT, /没有推荐时不添加标签/);
    assert.match(CANVAS_AGENT_INTERACTION_PROMPT, /点选选项表示用户立即提交该答案并继续/);
    assert.match(CANVAS_AGENT_INTERACTION_PROMPT, /输入框和“发送”按钮仅用于自定义回复/);
    assert.match(CANVAS_AGENT_INTERACTION_PROMPT, /不得因沉默、等待或超时自动选择推荐项/);
    assert.doesNotMatch(CANVAS_AGENT_INTERACTION_PROMPT, /10 秒倒计时/);
  });

  test("prioritizes selected and connected nodes and routes full reference skills", () => {
    const built = context();
    assert.deepEqual(built.nodes.map((node) => node.id), ["text-1", "image-1", "config-1"]);
    const prompt = buildCanvasAgentSkillPrompt("references", "制作角色四视图和分镜拼图", built);
    assert.match(prompt, /视频角色四视图设定表/);
    assert.match(prompt, /分镜拼图与视频转译/);
    assert.match(prompt, /当前真实画布上下文 JSON/);
    assert.doesNotMatch(prompt, /【严格工具协议】/);
  });

  test("storyboard production uses structured shots and keeps grids opt-in", () => {
    const prompt = buildCanvasAgentSkillPrompt("storyboard", "完整制作60秒有声短剧，每镜一张分镜图，不要宫格", context());
    for (const rule of ["镜头直接保存在 scriptProject.shots", "普通分镜默认每镜一张单幅画面", "只有用户明确要求宫格、拼图或多面板", "单幅分镜不是宫格", "用户明确委托自主创作并完整制作", "读取已保存的脚本", "内容未变时调用 confirm_script_node"]) assert.ok(prompt.includes(rule), rule);
    for (const obsolete of ["每个计划视频片段/镜头节点生成一张拼图", "必须包含当前镜头文本 nodeId", "退出：真实镜头文本节点已创建", "完整项目默认先建立真实镜头节点", "检测到分镜拼图标题或用户明确说分镜/宫格/storyboard 时"]) assert.ok(!prompt.includes(obsolete), obsolete);
    const grid = buildCanvasAgentSkillPrompt("storyboard", "为这一镜生成2×2分镜拼图", context());
    assert.match(grid, /网格布局/);
    assert.match(grid, /不要跨格、合并格或改变格子大小/);
  });

  test("returns the reference media task summary contract", () => {
    assert.deepEqual(summarizeCanvasAgentTask({
      id: "video-1",
      type: "video",
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      scale_x: 1,
      scale_y: 1,
      url: "/videos/result.mp4",
      task_id: "task-1",
      generation_status: "loading",
      generation_progress: 42,
    }), {
      type: "video",
      status: "loading",
      taskId: "task-1",
      progress: 42,
      error: undefined,
      mediaUrl: "/videos/result.mp4",
    });
  });

  test("labels every available Agent resource in canvas order", () => {
    const references = buildAllCanvasResourceReferences([
      { id: "image-1", type: "image", title: "角色", url: "/images/one.png" },
      { id: "empty-image", type: "image", title: "空图片" },
      { id: "panorama-1", type: "panorama", title: "场景", url: "/images/panorama.png" },
      { id: "video-1", type: "video", title: "镜头", url: "/video/one.mp4" },
      { id: "audio-1", type: "audio", title: "旁白", url: "/audio/one.mp3" },
      { id: "text-1", type: "text", title: "剧本", prompt: "第一幕" },
    ]);
    assert.deepEqual(references.map(({ nodeID, kind, label, active }) => ({ nodeID, kind, label, active })), [
      { nodeID: "image-1", kind: "image", label: "图片1", active: true },
      { nodeID: "panorama-1", kind: "image", label: "图片2", active: true },
      { nodeID: "video-1", kind: "video", label: "视频1", active: true },
      { nodeID: "audio-1", kind: "audio", label: "音频1", active: true },
      { nodeID: "text-1", kind: "text", label: "文本1", active: true },
    ]);
  });

  test("uses message references only when sourceNodeIds is omitted", () => {
    assert.deepEqual(canvasAgentSourceNodeIDs({}, ["image-1", "text-1", "image-1"]), ["image-1", "text-1"]);
    assert.deepEqual(canvasAgentSourceNodeIDs({ sourceNodeIds: [] }, ["image-1"]), []);
    assert.deepEqual(canvasAgentSourceNodeIDs({ sourceNodeIds: [" image-2 ", "image-2"] }, ["image-1"]), ["image-2"]);
  });

  test("uses the shared video model contract for Agent duration and audio", () => {
    assert.deepEqual(canvasAgentVideoDurationHint("minimax-h3-768p"), { values: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], range: "可选 4、5、6、7、8、9、10、11、12、13、14、15 秒" });
    assert.match(validateCanvasAgentVideoSeconds("minimax-h3-768p", 3), /仅支持 4、5、6、7、8、9、10、11、12、13、14、15 秒/);
    assert.equal(validateCanvasAgentVideoSeconds("minimax-h3-768p", 8), "");
    assert.match(validateCanvasAgentVideoSeconds("kling-3.0/video", 8), /未配置启用的视频模型契约/);
    assert.equal(canvasAgentVideoSupportsAudio("minimax-h3-768p"), true);
    assert.equal(canvasAgentVideoSupportsAudio("kling-3.0/video"), null);
  });

  test("matches the reference Agent node placement and primary script dimensions", () => {
    assert.deepEqual(CANVAS_AGENT_PRIMARY_SCRIPT_NODE_SIZE, { width: 550, height: 600 });
    const nodes = [
      { id: "text-1", type: "text", x: 20, y: 40, width: 340, height: 240, scale_x: 1, scale_y: 1 },
      { id: "config-1", type: "config", x: 900, y: 40, width: 440, height: 240, scale_x: 1, scale_y: 1 },
    ];
    assert.deepEqual(canvasAgentNodePosition({ width: 340, height: 240 }, [], nodes, { x: 500, y: 400 }), { x: 456, y: 40 });
    assert.deepEqual(canvasAgentMediaLayoutSources("image", nodes, [nodes[0]]), []);
    assert.deepEqual(canvasAgentMediaLayoutSources("audio", nodes, [nodes[0]]).map((node) => node.id), ["text-1"]);
    assert.deepEqual(canvasAgentMediaLayoutSources("video", nodes, []).map((node) => node.id), ["text-1"]);
  });

  test("uses reference width-aware four-column arrangement and moves grouped children", () => {
    const nodes = [
      { id: "wide", type: "text", x: 10, y: 20, width: 500, height: 160, scale_x: 1, scale_y: 1 },
      { id: "small", type: "image", x: 800, y: 60, width: 200, height: 300, scale_x: 1, scale_y: 1 },
      { id: "third", type: "video", x: 1200, y: 80, width: 420, height: 236, scale_x: 1, scale_y: 1 },
      { id: "fourth", type: "audio", x: 1700, y: 100, width: 340, height: 160, scale_x: 1, scale_y: 1 },
      { id: "group", type: "group", x: 2200, y: 500, width: 760, height: 480, scale_x: 1, scale_y: 1 },
      { id: "child", type: "text", x: 2240, y: 550, width: 340, height: 240, scale_x: 1, scale_y: 1, group_id: "group" },
    ];
    const arranged = arrangeCanvasAgentNodes(nodes, ["wide", "small", "third", "fourth", "group"]);
    const byID = new Map(arranged.nodes.map((node) => [node.id, node]));
    assert.deepEqual({ x: byID.get("small").x, y: byID.get("small").y }, { x: 582, y: 20 });
    assert.deepEqual({ x: byID.get("group").x, y: byID.get("group").y }, { x: 10, y: 392 });
    assert.deepEqual({ x: byID.get("child").x, y: byID.get("child").y }, { x: 50, y: 442 });
    assert.deepEqual(arranged.arrangedNodeIDs, ["wide", "small", "third", "fourth", "group"]);
  });

  test("restores interrupted turns and refreshes only saved reference content", () => {
    const sessions = syncCanvasAgentSessions([{
      id: "session-1",
      title: "测试",
      messages: [{
        id: "message-1",
        role: "assistant",
        text: "",
        status: "running",
        activity: "正在执行",
        references: [{ id: "image-1", type: "image", title: "旧标题", url: "/old.png" }],
      }],
      agentState: createCanvasAgentState(),
      protocolMessages: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }], [{ id: "image-1", type: "image", x: 0, y: 0, width: 320, height: 240, scale_x: 1, scale_y: 1, title: "新标题", url: "/new.png", mime_type: "image/png" }], true);
    const message = sessions[0].messages[0];
    assert.equal(message.status, "waiting");
    assert.equal(message.activity, undefined);
    assert.match(message.text, /恢复上次执行/);
    assert.equal(sessions[0].resumeAssistantMessageId, "message-1");
    assert.equal(message.references[0].title, "旧标题");
    assert.equal(message.references[0].url, "/new.png");
    assert.equal(message.references[0].dataUrl, undefined);
  });

  test("unchanged session synchronization preserves history identities and refreshes only changed references", () => {
    const image = { id: "image", type: "image", url: "/first.png", mime_type: "image/png" };
    const session = {
      id: "history", title: "历史", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      messages: [
        { id: "plain", role: "user", text: "保留原消息" },
        { id: "reference", role: "user", text: "参考图", references: [{ id: image.id, type: "image", title: "原素材", url: image.url, mimeType: image.mime_type }] },
      ],
      agentState: createCanvasAgentState(), protocolMessages: [],
    };
    assert.equal(syncCanvasAgentSessions([session], [image])[0], session);
    assert.equal(syncCanvasAgentSessions([session], [{ ...image, title: "新节点名称" }])[0], session);
    assert.equal(syncCanvasAgentSessions([session], [image], true)[0], session);
    const changed = syncCanvasAgentSessions([session], [{ ...image, url: "/second.png" }])[0];
    assert.notEqual(changed, session);
    assert.equal(changed.messages[0], session.messages[0]);
    assert.notEqual(changed.messages[1], session.messages[1]);
    assert.equal(changed.messages[1].references[0].url, "/second.png");
    assert.equal(session.messages[1].references[0].url, "/first.png");
    assert.equal(syncCanvasAgentSessions([changed], [{ ...image, url: "/second.png" }])[0], changed);
  });

  test("unchanged history synchronization avoids reading or copying validated message bodies", () => {
    let bodyReads = 0;
    const session = {
      id: "history", title: "历史", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      messages: Array.from({ length: 2000 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? "assistant" : "user", status: "success", get text() { bodyReads++; return "完整旧记录"; } })),
      agentState: createCanvasAgentState(), protocolMessages: [],
    };
    for (const restore of [false, true]) {
      assert.equal(syncCanvasAgentSessions([session], [], restore)[0], session);
      assert.equal(bodyReads, 0, "node synchronization must reuse already validated unchanged message content");
    }
  });

  test("deleting unrelated nodes keeps unchanged conversations, messages and references intact", () => {
    let bodyReads = 0;
    const reference = { id: "retained", type: "image", title: "原图", url: "/original.png", storageKey: "original-file" };
    const session = {
      id: "history", title: "历史", createdAt: "now", updatedAt: "now",
      messages: Array.from({ length: 2000 }, (_, index) => ({ id: `message-${index}`, role: "user", get text() { bodyReads++; return "保留原消息"; }, ...(index === 0 ? { references: [reference] } : {}) })),
      agentState: createCanvasAgentState(), protocolMessages: [],
    };
    const [unchanged] = clearCanvasAgentSessionReferences([session], new Set(["unrelated"]));
    assert.equal(unchanged, session);
    assert.equal(unchanged.messages, session.messages);
    assert.equal(bodyReads, 0, "deleting a canvas node must not rebuild unrelated history");
    const [changed] = clearCanvasAgentSessionReferences([session], new Set([reference.id]));
    assert.notEqual(changed, session);
    assert.notEqual(changed.messages[0], session.messages[0]);
    for (let index = 1; index < session.messages.length; index++) assert.equal(changed.messages[index], session.messages[index]);
    assert.equal(bodyReads, 1, "only the affected message needs a new value");
    assert.equal(reference.url, "/original.png", "the original transcript must remain untouched");
    assert.equal(clearCanvasAgentSessionReferences([changed], new Set([reference.id]))[0], changed, "repeated clearing must preserve unchanged history");
  });

  test("node replacement and deletion preserve independent attachments sharing a node ID", () => {
    for (const type of ["image", "video", "audio", "text"]) {
      const attachment = { id: "shared", type, title: "上传附件", source: "attachment", ...(type === "text" ? { text: "原附件正文" } : { url: "/attachment", storageKey: "attachment-file", dataUrl: "data:original", mimeType: "original/type" }) };
      const bound = { ...attachment, source: undefined, title: "节点引用" };
      const session = { id: "s", title: "历史", messages: [{ id: "a", role: "user", text: "上传", references: [attachment] }, { id: "b", role: "user", text: "节点", references: [bound] }], agentState: createCanvasAgentState(), protocolMessages: [], createdAt: "now", updatedAt: "now" };
      const before = structuredClone(session);
      const [synchronized] = syncCanvasAgentSessions([session], [{ id: "shared", type, url: "/replacement", storage_key: "replacement-file", mime_type: "replacement/type", prompt: "新节点正文" }]);
      assert.equal(synchronized.messages[0], session.messages[0], "node synchronization must not rewrite an upload");
      assert.equal(synchronized.messages[0].references[0], attachment);
      assert.notEqual(synchronized.messages[1], session.messages[1]);
      assert.equal(type === "text" ? synchronized.messages[1].references[0].text : synchronized.messages[1].references[0].url, type === "text" ? "新节点正文" : "/replacement");
      const [cleared] = clearCanvasAgentSessionReferences([session], new Set(["shared"]));
      assert.equal(cleared.messages[0], session.messages[0], "node deletion must not clear an upload");
      assert.deepEqual(cleared.messages[0].references[0], attachment);
      assert.equal(cleared.messages[1].references[0].url, undefined);
      assert.equal(cleared.messages[1].references[0].storageKey, undefined);
      assert.deepEqual(session, before);
    }
  });

  test("clears stored media content when a referenced node is deleted", () => {
    const sessions = clearCanvasAgentSessionReferences([{
      id: "session-1",
      title: "测试",
      messages: [{
        id: "message-1",
        role: "user",
        text: "查看 图片1",
        status: "success",
        references: [{ id: "image-1", type: "image", title: "角色", label: "图片1", dataUrl: "data:image/png;base64,AAAA", url: "/images/one.png", storageKey: "server:image-1" }],
      }],
      agentState: createCanvasAgentState(),
      protocolMessages: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }], new Set(["image-1"]));
    assert.deepEqual(sessions[0].messages[0].references[0], {
      id: "image-1",
      type: "image",
      title: "角色",
      label: "图片1",
      dataUrl: undefined,
      url: undefined,
      storageKey: undefined,
    });
  });
});

describe("canvas agent v2 runtime", () => {
});

describe("canvas agent reliability and memory", () => {
  test("rejects wrong parameter types and unknown fields without coercion", () => {
    for (const args of [{ prompt: "draw", sourceNodeIds: [], count: "2" }, { prompt: "draw", sourceNodeIds: [12] }, { prompt: "draw", sourceNodeIds: [], surprise: true }, { prompt: "draw", sourceNodeIds: [], count: 1.5 }, { prompt: "draw" }]) {
      assert.throws(() => normalizeCanvasAgentAction("generate_image", args));
    }
  });

  test("selected Skills replace default workflow instructions and include attachment names", () => {
    const prompt = buildCanvasAgentSkillPrompt("script", "写剧本", context(), [{ id: "skill-1", name: "只写诗", content: "只输出四行诗", description: "", scope: "personal", enabled: true, revision: 1, updated_at: "", file_paths: ["references/style.md"] }], "已确认意象：海");
    assert.match(prompt, /只输出四行诗/);
    assert.match(prompt, /references\/style.md/);
    assert.match(prompt, /已确认意象：海/);
    assert.doesNotMatch(prompt, /【总创作流程/);
  });
});

const productReferences = (count) => Array.from({ length: count }, (_, index) => ({
  id: `product-${index}`, type: "image", title: `产品角度 ${index}`, label: `图片${index + 1}`, dataUrl: `data:image/png;base64,${index}`,
}));

const { resolveCanvasAgentQuestion } = await import("../src/app/canvas/agent/canvas-agent-interaction.ts");
const questionArguments = { question: "这组海报采用哪种风格？", reason: "风格会影响整组图片的一致性。", options: ["纪实摄影", "手绘插画"], kind: "clarification" };

test("node details expose the complete script while summaries indicate omitted content", () => {
  const prompt = "开场".repeat(3000) + "片尾必须保留的对白";
  const node = { id: "long-script", type: "text", title: "长剧本", prompt };
  assert.equal(summarizeCanvasAgentNode(node).prompt, undefined);
  assert.equal(summarizeCanvasAgentNode(node).text, undefined);
  assert.equal(summarizeCanvasAgentNode(node).detailsOmitted, true);
  assert.equal(summarizeCanvasAgentNode(node, true).text, prompt);
  assert.equal(summarizeCanvasAgentNode(node, true).detailsOmitted, undefined);
});

test("model context contains a bounded index and preserves approved IDs without repeated bodies or configuration", () => {
  const state = { ...createCanvasAgentState(), approvedNodeIds: ["node-119"], approvedPlan: "保留已确认的交付要求", completedTaskIds: Array(1000).fill("old-task") };
  const value = buildCanvasAgentContext({
    projectId: "project", projectTitle: "Example", agentState: state,
    nodes: Array.from({ length: 120 }, (_, i) => ({ id: `node-${i}`, type: "text", title: `正文 ${i}`, prompt: "长正文".repeat(10000) })),
    connections: [{ id: "edge", from_node_id: "node-0", to_node_id: "node-1" }],
    selectedNodeIds: ["node-119"], generation: { imageModel: "test-image", capabilities: { image: { sizes: ["1:1"] } } },
  });
  const text = serializeCanvasAgentContext(value);
  const sent = JSON.parse(text);
  assert.equal(sent.nodes.length, 40);
  assert.equal(sent.nodes[0].id, "node-119");
  assert.equal(sent.omittedNodeCount, 80);
  assert.deepEqual(sent.agentState.approvedNodeIds, ["node-119"]);
  assert.equal(sent.agentState.approvedPlan, state.approvedPlan);
  assert.doesNotMatch(text, /长正文|old-task|capabilities|connections/);
  assert.equal(summarizeCanvasAgentNode({ id: "n", type: "text", prompt: "完整正文" }, true).text, "完整正文");
});


test("video durations honor contract ranges instead of only the default duration", () => {
  const contracts = structuredClone(contractDocument.contracts);
  const ranged = { ...structuredClone(contracts[0]), name: "Range test", models: ["range-test"] };
  ranged.capability.seconds_range = { min: 2, max: 90, step: 2 };
  ranged.capability.default_seconds = 10;
  installVideoModelContracts([...contracts, ranged]);
  try {
    assert.equal(validateCanvasAgentVideoSeconds("range-test", 40), "");
    assert.match(validateCanvasAgentVideoSeconds("range-test", 41), /步长 2/);
    assert.match(validateCanvasAgentVideoSeconds("range-test", 92), /最多 90/);
    assert.match(canvasAgentVideoDurationHint("range-test").range, /2 秒起/);
    assert.deepEqual(canvasAgentVideoDurationHint("range-test").secondsRange, { min: 2, max: 90, step: 2 });
    assert.equal(normalizeCanvasAgentAction("generate_video", { prompt: "长片段", sourceNodeIds: [], size: "16:9", generateAudio: false, seconds: 40 }).arguments.seconds, 40);
    const args = { prompt: "长片段", sourceNodeIds: [], size: "16:9", generateAudio: false, seconds: 4500 };
    delete ranged.capability.seconds_range.max;
    installVideoModelContracts([...contracts, ranged]);
    assert.equal(validateCanvasAgentVideoSeconds("range-test", 4500), "");
    assert.equal(normalizeCanvasAgentAction("generate_video", args).arguments.seconds, 4500);
    assert.equal(normalizeCanvasAgentAction("update_node", { nodeId: "video", generation: { seconds: 4500 } }).arguments.generation.seconds, 4500);
    assert.throws(() => normalizeCanvasAgentAction("generate_video", { ...args, seconds: -1 }), /seconds/);
    assert.throws(() => normalizeCanvasAgentAction("generate_video", { ...args, seconds: Number.MAX_SAFE_INTEGER + 1 }), /seconds/);
  } finally { installVideoModelContracts(contracts); }
});


test("SDK context estimates survive session reload and reject malformed counters", () => {
  const session = { id: "s", title: "对话", createdAt: "now", updatedAt: "now", messages: [], agentState: createCanvasAgentState(), protocolMessages: [], contextUsage: { model: "test", usedTokens: 36560, maxTokens: 365600, compacting: false, basis: "compression-budget" } };
  const restored = JSON.parse(JSON.stringify(session));
  assert.equal(isCanvasAgentSession(restored), true);
  assert.deepEqual(syncCanvasAgentSessions([restored], [])[0].contextUsage, session.contextUsage);
  for (const patch of [
    { usedTokens: -1 }, { usedTokens: 0.5 }, { usedTokens: Infinity }, { usedTokens: Number.MAX_SAFE_INTEGER + 1 },
    { maxTokens: 0 }, { maxTokens: "365600" }, { compacting: "false" }, { basis: "model-window" }, { model: null },
  ]) assert.equal(isCanvasAgentSession({ ...session, contextUsage: { ...session.contextUsage, ...patch } }), false);
});

test("persisted sessions reject malformed nested values before rendering", () => {
  const session = { id: "s", title: "对话", createdAt: "now", updatedAt: "now", messages: [{ id: "u", role: "user", text: "创作" }], agentState: createCanvasAgentState(), protocolMessages: [{ role: "user", content: "创作" }] };
  assert.equal(isCanvasAgentSession(session), true);
  for (const mutate of [
    (s) => { s.agentState.pendingTaskIds = null; },
    (s) => { s.agentState.plan = { explanation: "计划", steps: "bad" }; },
    (s) => { s.agentState.pendingQuestion = { id: "q", question: "方向？", reason: "影响结果", request: "创作", kind: "clarification", options: 4 }; },
    (s) => { s.messages[0].references = [{ id: "x", title: "图片", type: "image", text: {} }]; },
    (s) => { s.protocolMessages = [{ role: "assistant", toolCalls: {} }]; },
    (s) => { s.protocolMessages = [{ role: "user", content: [null] }]; },
    (s) => { s.activeSkillIds = {}; },
  ]) { const invalid = structuredClone(session); mutate(invalid); assert.equal(isCanvasAgentSession(invalid), false, JSON.stringify(invalid)); }
});

function savedMediaRun() {
  const calls = ["正面", "斜前方", "背面"].map((title, index) => ({ id: `saved-edit-${index}`, name: "edit_image", arguments: { title, prompt: "产品白底图", size: "1:1", count: 1, sourceNodeIds: [], attachmentIds: ["product-photo"] } }));
  const protocolMessages = [{ role: "user", content: "三张产品白底图" }, { role: "assistant", toolCalls: calls }, ...calls.map((call, index) => ({ role: "tool", name: call.name, toolCallId: call.id, content: JSON.stringify({ ok: true, submitted: false, nodeId: `existing-${index}`, status: "idle" }) }))];
  const plan = { explanation: "", steps: [{ id: "white", title: "生成三张白底图", status: "in_progress" }, { id: "review", title: "核对成图", status: "pending" }] };
  return { calls, protocolMessages, initialState: { ...createCanvasAgentState(), plan } };
}

function mediaContext(state, autoGenerateMedia = true) {
  const result = context(state);
  return { ...result, generation: { ...result.generation, autoGenerateMedia } };
}

test("repeated media calls resume their existing node instead of replaying creation", async () => {
  const { executeCanvasAgentResumedAction } = await import("../src/app/canvas/agent/canvas-agent-execution.ts");
  const saved = savedMediaRun();
  const action = normalizeCanvasAgentAction("edit_image", saved.calls[0].arguments, "repeat");
  const executed = [];
  const result = await executeCanvasAgentResumedAction(saved.protocolMessages, action, async (next) => {
    executed.push(next);
    return { ok: true, nodeId: next.arguments.nodeId, status: "success" };
  });
  assert.deepEqual(executed.map(({ name, arguments: args }) => ({ name, args })), [{ name: "generate_node", args: { nodeId: "existing-0" } }]);
  assert.equal(result.nodeId, "existing-0");
});

test("direct creation intent in a clarification answer grants this run's media authorization", async () => {
  const { resumeCanvasAgentMedia } = await import("../src/app/canvas/agent/canvas-agent-runtime.ts");
  const question = { id: "clarification", question: "制作方向？", reason: "确认故事基调", options: [], kind: "clarification", request: "制作短剧" };
  const protocolMessages = [
    { role: "assistant", toolCalls: [{ id: question.id, name: "ask_user_question", arguments: { question: question.question, reason: question.reason, options: [], kind: question.kind } }] },
  ];
  const result = await resumeCanvasAgentMedia({
    initialState: { ...createCanvasAgentState(), pendingQuestion: question }, protocolMessages,
    userText: "直接制作一段短剧", getContext: (state) => mediaContext(state, false),
    executeAction: async () => ({ ok: true }),
  });
  assert.equal(result.mediaGenerationChoice, "generate");
  assert.equal(result.initialState.pendingQuestion, undefined);
  assert.equal(result.initialState.mediaGenerationDeferred, false);
  assert.ok(result.protocolMessages.some((message) => message.role === "user" && /明确授权立即生成/.test(message.content)));
});

test("only active assistant turns are marked for automatic restoration", () => {
  const base = { id: "session", title: "Test", agentState: createCanvasAgentState(), protocolMessages: [], createdAt: "now", updatedAt: "now" };
  for (const status of ["thinking", "running", "waiting", "success", "error"]) {
    const session = { ...base, messages: [{ id: "user", role: "user", text: "Create" }, { id: "assistant", role: "assistant", text: "", status }] };
    const restored = syncCanvasAgentSessions([session], [], true)[0];
    assert.equal(restored.resumeAssistantMessageId, ["thinking", "running"].includes(status) ? "assistant" : undefined);
    assert.ok(isCanvasAgentSession(restored));
  }
});

test("batch deletion carries the full explicit node list and rejects ambiguous scope", () => {
 assert.deepEqual(normalizeCanvasAgentAction("delete_node", {nodeIds:["audio-one","audio-two"]}, "batch").arguments,{nodeIds:["audio-one","audio-two"]});
 for(const args of [{},{nodeIds:[]},{nodeIds:["one","one"]},{nodeId:"one",nodeIds:["two"]}]) {
  assert.throws(()=>normalizeCanvasAgentAction("delete_node",args,"batch"));
 }
});
