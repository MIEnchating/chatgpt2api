import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, mock, test } from "bun:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { installVideoModelContracts } from "../src/lib/video-model-contracts.ts";

const agentReplies = [];
const submittedInputs = [];
const cancelledTasks = [];
let taskCounter = 0;

mock.module("@/lib/api", () => ({
  isImageOutputFormat: (value) => ["png", "jpeg", "webp"].includes(value),
  isImageQuality: (value) => ["low", "medium", "high"].includes(value),
  cancelCreationTask: async (id) => {
    cancelledTasks.push(id);
    return { ok: true };
  },
  createChatGenerationTask: async (input) => {
    submittedInputs.push(input);
    return { id: `agent-task-${++taskCounter}` };
  },
  fetchCreationTasks: async () => {
    const reply = agentReplies.shift() || { text_response: "完成" };
    const taskStatus = typeof reply === "object" && reply.task_status ? reply.task_status : "success";
    return {
      items: [{ id: `agent-task-${taskCounter}`, status: taskStatus, error: typeof reply === "object" ? reply.error : undefined, data: taskStatus === "success" ? [typeof reply === "string" ? { text_response: reply } : reply] : [] }],
      missing_ids: [],
    };
  },
}));

const originalWindow = globalThis.window;
beforeAll(() => {
  globalThis.window = { setTimeout, clearTimeout };
  installVideoModelContracts(structuredClone(contractDocument.contracts));
});
afterAll(() => {
  installVideoModelContracts([]);
  globalThis.window = originalWindow;
});

const { buildCanvasAgentContext, summarizeCanvasAgentTask } = await import("../src/app/canvas/agent/canvas-agent-context.ts");
const { buildAllCanvasResourceReferences } = await import("../src/app/canvas/canvas-resources.ts");
const { arrangeCanvasAgentNodes, CANVAS_AGENT_PRIMARY_SCRIPT_NODE_SIZE, canvasAgentMediaLayoutSources, canvasAgentNodePosition, canvasAgentSourceNodeIDs, canvasAgentVideoDurationHint, canvasAgentVideoSupportsAudio, validateCanvasAgentVideoSeconds } = await import("../src/app/canvas/agent/canvas-agent-generation.ts");
const { clearCanvasAgentSessionReferences, syncCanvasAgentSessions } = await import("../src/app/canvas/agent/canvas-agent-sessions.ts");
const { canvasAgentStarterLabel, canvasInsertPayloadFromMyAsset, canvasPendingAgentAssetNode, createCanvasPendingAgentAsset, defaultCanvasAgentStarterConfig, normalizeCanvasAgentConfig, preferredCanvasAgentVideoSize } = await import("../src/app/canvas/agent/canvas-agent-starter.ts");
const { buildCanvasAgentSkillPrompt } = await import("../src/app/canvas/agent/canvas-agent-skills.ts");
const { runCanvasAgent, createCanvasAgentState } = await import("../src/app/canvas/agent/canvas-agent-runtime.ts");
const { abortCanvasAgentRun, beginCanvasAgentRunEpoch, claimCanvasAgentRun, createCanvasAgentRunLifecycle, invalidateCanvasAgentRunLifecycle, isCurrentCanvasAgentRun, mountCanvasAgentRunLifecycle, releaseCanvasAgentRun } = await import("../src/app/canvas/agent/canvas-agent-run-gate.ts");
const { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction } = await import("../src/app/canvas/agent/canvas-agent-tools.ts");

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

function run(overrides = {}) {
  return runCanvasAgent({
    model: "gpt-5",
    relayTokenName: "text-key",
    initialState: createCanvasAgentState(),
    protocolMessages: [],
    userText: "执行画布操作",
    references: [],
    getContext: context,
    executeAction: async () => ({ ok: true }),
    ...overrides,
  });
}

function toolReply(calls, textResponse = "") {
  return {
    text_response: textResponse,
    tool_calls: calls.map((call, index) => ({
      id: call.id || `native-call-${index + 1}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
    })),
  };
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

  test("normalizes empty Agent parameters to visible generation defaults", () => {
    assert.deepEqual(defaultCanvasAgentStarterConfig(), {
      imageQuality: "",
      imageSize: "1:1",
      videoQuality: "",
      videoSize: "16:9",
    });
    assert.deepEqual(normalizeCanvasAgentConfig(
      { imageQuality: "", imageSize: "auto", videoQuality: "", videoSize: "" },
      { imageQuality: "", imageSize: "1:1", videoQuality: "720p", videoSize: "16:9" },
      { imageQuality: ["", "low", "medium", "high"], imageSize: ["1:1", "16:9", "9:16"], videoQuality: ["720p", "1080p"], videoSize: ["16:9", "9:16"] },
    ), { imageQuality: "", imageSize: "1:1", videoQuality: "720p", videoSize: "16:9" });
    assert.equal(preferredCanvasAgentVideoSize(["1:1", "16:9", "9:16"], "1:1"), "16:9");
    assert.equal(preferredCanvasAgentVideoSize(["1024x1024", "1280x720", "720x1280"], "1024x1024"), "1280x720");
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
    assert.throws(() => normalizeCanvasAgentAction("edit_image", { prompt: "修改", sourceNodeIds: [] }), /图片来源/);
    const generatedID = normalizeCanvasAgentAction("get_canvas_summary", {}).id;
    assert.match(generatedID, /^[\w-]{21}$/);
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
    assert.match(message.text, /页面关闭而中断/);
    assert.equal(message.references[0].title, "旧标题");
    assert.equal(message.references[0].url, undefined);
    assert.equal(message.references[0].dataUrl, "/new.png");
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
  test("round-trips native tool calls, tool messages, and reasoning content", async () => {
    const submissionOffset = submittedInputs.length;
    agentReplies.push(
      {
        text_response: "",
        reasoning_content: "先读取画布",
        tool_calls: [{ id: "native-read-1", type: "function", function: { name: "get_canvas_summary", arguments: "{}" } }],
      },
      { text_response: "已根据真实画布继续" },
    );
    const executed = [];
    const result = await run({ executeAction: async (action) => {
      executed.push(action.name);
      return { ok: true, nodeCount: 2 };
    } });

    assert.deepEqual(executed, ["get_canvas_summary"]);
    assert.equal(result.reply, "已根据真实画布继续");
    const protocol = result.protocolMessages;
    const assistant = protocol.find((message) => message.role === "assistant" && message.toolCalls?.length);
    assert.equal(assistant?.reasoningContent, "先读取画布");
    assert.equal(assistant?.toolCalls?.[0].id, "native-read-1");
    assert.equal(protocol.find((message) => message.role === "tool")?.toolCallId, "native-read-1");

    const secondRequest = submittedInputs[submissionOffset + 1];
    assert.equal(secondRequest.tools[0].type, "function");
    assert.equal(secondRequest.toolChoice, "auto");
    assert.equal(secondRequest.messages.find((message) => message.role === "assistant")?.reasoning_content, "先读取画布");
    assert.equal(secondRequest.messages.find((message) => message.role === "tool")?.tool_call_id, "native-read-1");
  });

  test("returns real tool results to the next model turn", async () => {
    agentReplies.push(
      toolReply([{ id: "read-1", name: "get_canvas_summary" }]),
      { text_response: "已读取真实画布" },
    );
    const executed = [];
    const checkpoints = [];
    const result = await run({
      executeAction: async (action) => {
        executed.push(action.name);
        return { ok: true, nodeCount: 2 };
      },
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });
    assert.deepEqual(executed, ["get_canvas_summary"]);
    assert.equal(result.reply, "已读取真实画布");
    assert.equal(checkpoints.length, 1);
    assert.match(JSON.stringify(result.protocolMessages), /nodeCount/);
  });

  test("prepends the configured text system prompt to the Agent skills", async () => {
    const submissionOffset = submittedInputs.length;
    agentReplies.push({ text_response: "完成" });
    await run({ configuredSystemPrompt: "保持品牌语气" });
    const systemMessage = submittedInputs[submissionOffset].messages[0];
    assert.equal(systemMessage.role, "system");
    assert.match(systemMessage.content, /^保持品牌语气\n\n【Agent 公共执行手册】/);
  });

  test("trims protocol history and never starts a request with an orphan tool message", async () => {
    const submissionOffset = submittedInputs.length;
    const history = [
      { role: "assistant", content: "old assistant", toolCalls: [{ id: "old-call", name: "get_canvas_summary", arguments: {} }] },
      { role: "tool", content: "{}", toolCallId: "old-call", name: "get_canvas_summary" },
      ...Array.from({ length: 118 }, (_, index) => ({ role: "user", content: `history-${index}` })),
    ];
    agentReplies.push({ text_response: "完成" });
    await run({ protocolMessages: history, userText: "读取画布" });
    const sentProtocol = submittedInputs[submissionOffset].messages.slice(1);
    assert.equal(sentProtocol.length, 119);
    assert.notEqual(sentProtocol[0].role, "tool");
  });

  test("removes inline image data before persisting protocol messages", async () => {
    agentReplies.push({ text_response: "完成" });
    const result = await run({
      userText: "查看这张图",
      references: [{ id: "image-1", type: "image", title: "角色", dataUrl: "data:image/png;base64,AAAA" }],
    });
    const persistedUser = result.protocolMessages.find((message) => message.role === "user");
    assert.equal(typeof persistedUser?.content, "string");
    assert.doesNotMatch(String(persistedUser?.content), /base64/);
    assert.match(String(persistedUser?.content), /节点 image-1/);
  });

  test("updates persisted Agent phase and pending task state from real tool results", async () => {
    agentReplies.push(
      toolReply([
        { name: "set_agent_state", arguments: { phase: "video", approvedNodeIds: ["text-1"] } },
        { name: "generate_video", arguments: { prompt: "镜头", sourceNodeIds: [] } },
      ]),
      { text_response: "视频任务已提交" },
    );
    const result = await run({ executeAction: async (action) => action.name === "generate_video"
      ? { ok: true, taskId: "video-task-1", status: "loading" }
      : { ok: true } });
    assert.equal(result.state.phase, "video");
    assert.deepEqual(result.state.approvedNodeIds, ["text-1"]);
    assert.deepEqual(result.state.pendingTaskIds, ["video-task-1"]);
  });

  test("runs a pure media batch concurrently", async () => {
    agentReplies.push(
      toolReply([
        { name: "generate_image", arguments: { prompt: "A", sourceNodeIds: [] } },
        { name: "generate_image", arguments: { prompt: "B", sourceNodeIds: [] } },
      ]),
      { text_response: "两项已提交" },
    );
    let active = 0;
    let maximum = 0;
    await run({ executeAction: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ok: true, status: "success" };
    } });
    assert.equal(maximum, 2);
  });

  test("runs structural actions sequentially", async () => {
    agentReplies.push(
      toolReply([
        { name: "create_text_node", arguments: { title: "A", content: "A", sourceNodeIds: [] } },
        { name: "create_text_node", arguments: { title: "B", content: "B", sourceNodeIds: [] } },
      ]),
      { text_response: "文本已创建" },
    );
    let active = 0;
    let maximum = 0;
    await run({ executeAction: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true };
    } });
    assert.equal(maximum, 1);
  });

  test("honors an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run({ signal: controller.signal }), (error) => error?.name === "AbortError");
  });

  test("cancels a submitted internal task when the run is aborted", async () => {
    const controller = new AbortController();
    const cancelledOffset = cancelledTasks.length;
    agentReplies.push({ task_status: "running" });
    const pending = run({ signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.equal(cancelledTasks.length, cancelledOffset + 1);
  });

  test("stops after twelve tool turns", async () => {
    for (let index = 0; index < 12; index += 1) agentReplies.push(toolReply([{ name: "get_canvas_summary" }]));
    let executions = 0;
    const result = await run({ executeAction: async () => { executions += 1; return { ok: true }; } });
    assert.equal(executions, 12);
    assert.match(result.reply, /步数上限/);
  });
});
