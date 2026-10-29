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
const { isCanvasAgentSession, canCreateCanvasAgentSession, MAX_CANVAS_AGENT_SESSIONS, clearCanvasAgentSessionReferences, syncCanvasAgentSessions } = await import("../src/app/canvas/agent/canvas-agent-sessions.ts");
const { canvasAgentStarterLabel, canvasInsertPayloadFromMyAsset, canvasPendingAgentAssetNode, createCanvasPendingAgentAsset, defaultCanvasAgentStarterConfig, normalizeCanvasAgentConfig } = await import("../src/app/canvas/agent/canvas-agent-starter.ts");
const { buildCanvasAgentSkillPrompt } = await import("../src/app/canvas/agent/canvas-agent-skills.ts");
const { createCanvasAgentState } = await import("../src/app/canvas/agent/canvas-agent-runtime.ts");
const { abortCanvasAgentRun, beginCanvasAgentRunEpoch, claimCanvasAgentRun, createCanvasAgentRunLifecycle, invalidateCanvasAgentRunLifecycle, isCurrentCanvasAgentRun, mountCanvasAgentRunLifecycle, releaseCanvasAgentRun } = await import("../src/app/canvas/agent/canvas-agent-run-gate.ts");
const { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction } = await import("../src/app/canvas/agent/canvas-agent-tools.ts");
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
    const defaults = { autoGenerateMedia: true, textApiMode: "responses", textReasoningEnabled: false, textStreaming: false, activeSkillIds: [] };
    assert.deepEqual(defaultCanvasAgentStarterConfig(), defaults);
    assert.equal(normalizeCanvasAgentConfig({ autoGenerateMedia: false }).autoGenerateMedia, false);
    assert.deepEqual(normalizeCanvasAgentConfig({ imageQuality: "high", imageSize: "1:1", videoQuality: "720p", videoSize: "16:9" }), defaults);
    for (const textStreaming of [undefined, false, true, "true"]) {
      assert.equal(normalizeCanvasAgentConfig({ textStreaming }).textStreaming, textStreaming === true);
    }
    for (const [textApiMode, expected] of [[undefined, "responses"], ["responses", "responses"], ["chat", "chat"]]) {
      assert.equal(normalizeCanvasAgentConfig({ textApiMode }).textApiMode, expected);
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
    assert.match(CANVAS_AGENT_INTERACTION_PROMPT, /点选选项只会填入回答框/);
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
    assert.equal(canvasAgentVideoSupportsAudio("kling-3.0/video"), false);
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

test("the session limit prevents creating an unsaveable 25th conversation", () => {
  assert.equal(MAX_CANVAS_AGENT_SESSIONS, 24);
  assert.equal(canCreateCanvasAgentSession(Array(23).fill({})), true);
  assert.equal(canCreateCanvasAgentSession(Array(24).fill({})), false);
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
    assert.equal(normalizeCanvasAgentAction("generate_video", { prompt: "长片段", sourceNodeIds: [], size: "16:9", generateAudio: false, seconds: 40 }).arguments.seconds, 40);
    const args = { prompt: "长片段", sourceNodeIds: [], size: "16:9", generateAudio: false, seconds: 4500 };
    delete ranged.capability.seconds_range.max;
    installVideoModelContracts([...contracts, ranged]);
    assert.equal(validateCanvasAgentVideoSeconds("range-test", 4500), "");
    assert.equal(normalizeCanvasAgentAction("generate_video", args).arguments.seconds, 4500);
    assert.throws(() => normalizeCanvasAgentAction("generate_video", { ...args, seconds: -1 }), /seconds/);
    assert.throws(() => normalizeCanvasAgentAction("generate_video", { ...args, seconds: Number.MAX_SAFE_INTEGER + 1 }), /seconds/);
  } finally { installVideoModelContracts(contracts); }
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

test("only active assistant turns are marked for automatic restoration", () => {
  const base = { id: "session", title: "Test", agentState: createCanvasAgentState(), protocolMessages: [], createdAt: "now", updatedAt: "now" };
  for (const status of ["thinking", "running", "waiting", "success", "error"]) {
    const session = { ...base, messages: [{ id: "user", role: "user", text: "Create" }, { id: "assistant", role: "assistant", text: "", status }] };
    const restored = syncCanvasAgentSessions([session], [], true)[0];
    assert.equal(restored.resumeAssistantMessageId, ["thinking", "running"].includes(status) ? "assistant" : undefined);
    assert.ok(isCanvasAgentSession(restored));
  }
});
