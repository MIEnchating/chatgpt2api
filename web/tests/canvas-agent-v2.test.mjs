import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, mock, test } from "bun:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { installVideoModelContracts } from "../src/lib/video-model-contracts.ts";

const agentReplies = [];
const submittedInputs = [];
const cancelledTasks = [];
let taskCounter = 0;
let submitOverride;

const actualAPI = { ...await import("../src/lib/api.ts") };
mock.module("@/lib/api", () => ({
  ...actualAPI,
  isImageOutputFormat: (value) => ["png", "jpeg", "webp"].includes(value),
  isImageQuality: (value) => ["low", "medium", "high"].includes(value),
  cancelCreationTask: async (id) => {
    cancelledTasks.push(id);
    return { ok: true };
  },
  createChatGenerationTask: async (input) => {
    submittedInputs.push(input);
    if (submitOverride) return submitOverride(input);
    return { id: `agent-task-${++taskCounter}` };
  },

}));

const actualEvents = { ...await import("../src/lib/creation-task-events.ts") };
mock.module("@/lib/creation-task-events", () => ({
  ...actualEvents,
  waitForCreationTask: async (id, options) => {
    const reply = agentReplies.shift() || { text_response: "完成" };
    const taskStatus = typeof reply === "object" && reply.task_status ? reply.task_status : "success";
    if (taskStatus === "running") return new Promise((_, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    });
    return { id, status: taskStatus, error: typeof reply === "object" ? reply.error : undefined, data: taskStatus === "success" ? [typeof reply === "string" ? { text_response: reply } : reply] : [] };
  },
}));

const originalWindow = globalThis.window;
beforeAll(() => {
  globalThis.window = { setTimeout, clearTimeout };
  installVideoModelContracts(structuredClone(contractDocument.contracts));
});
afterAll(() => {
  mock.module("@/lib/api", () => actualAPI);
  mock.module("@/lib/creation-task-events", () => actualEvents);
  installVideoModelContracts([]);
  globalThis.window = originalWindow;
});

const { buildCanvasAgentContext, summarizeCanvasAgentTask, summarizeCanvasAgentNode } = await import("../src/app/canvas/agent/canvas-agent-context.ts");
const { buildAllCanvasResourceReferences } = await import("../src/app/canvas/canvas-resources.ts");
const { arrangeCanvasAgentNodes, CANVAS_AGENT_PRIMARY_SCRIPT_NODE_SIZE, canvasAgentMediaLayoutSources, canvasAgentNodePosition, canvasAgentSourceNodeIDs, canvasAgentVideoDurationHint, canvasAgentVideoSupportsAudio, validateCanvasAgentVideoSeconds } = await import("../src/app/canvas/agent/canvas-agent-generation.ts");
const { isCanvasAgentSession, canCreateCanvasAgentSession, MAX_CANVAS_AGENT_SESSIONS, clearCanvasAgentSessionReferences, syncCanvasAgentSessions } = await import("../src/app/canvas/agent/canvas-agent-sessions.ts");
const { canvasAgentStarterLabel, canvasInsertPayloadFromMyAsset, canvasPendingAgentAssetNode, createCanvasPendingAgentAsset, defaultCanvasAgentStarterConfig, normalizeCanvasAgentConfig } = await import("../src/app/canvas/agent/canvas-agent-starter.ts");
const { buildCanvasAgentSkillPrompt } = await import("../src/app/canvas/agent/canvas-agent-skills.ts");
const { runCanvasAgent, createCanvasAgentState } = await import("../src/app/canvas/agent/canvas-agent-runtime.ts");
const { abortCanvasAgentRun, beginCanvasAgentRunEpoch, claimCanvasAgentRun, createCanvasAgentRunLifecycle, invalidateCanvasAgentRunLifecycle, isCurrentCanvasAgentRun, mountCanvasAgentRunLifecycle, releaseCanvasAgentRun } = await import("../src/app/canvas/agent/canvas-agent-run-gate.ts");
const { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction } = await import("../src/app/canvas/agent/canvas-agent-tools.ts");
const { requestCanvasAgentTurn } = await import("../src/app/canvas/agent/canvas-agent-request.ts");
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
  test("submits unique tasks when randomUUID is unavailable on an HTTP origin", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      const input = { model: "gpt-5", relayTokenName: "text-key", prompt: "plan", systemPrompt: "plan", messages: [], tools: [] };
      const first = await requestCanvasAgentTurn(input);
      const second = await requestCanvasAgentTurn(input);
      assert.equal(first.content, "完成");
      assert.equal(second.content, "完成");
      const ids = submittedInputs.slice(-2).map((item) => item.clientTaskId);
      assert.ok(ids.every((id) => /^canvas-agent-[\w-]+$/.test(id)));
      assert.notEqual(ids[0], ids[1]);
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
      else delete crypto.randomUUID;
    }
  });

  test("cancels a planning task acknowledged after the run was stopped", async () => {
    let resolveSubmission;
    submitOverride = () => new Promise((resolve) => { resolveSubmission = resolve; });
    const controller = new AbortController();
    try {
      const pending = requestCanvasAgentTurn({ model: "gpt-5", relayTokenName: "text-key", prompt: "plan", systemPrompt: "plan", messages: [], tools: [], signal: controller.signal });
      controller.abort();
      resolveSubmission({ id: "late-planning-task" });
      await assert.rejects(pending, { name: "AbortError" });
      assert.ok(cancelledTasks.includes("late-planning-task"));
    } finally {
      submitOverride = undefined;
    }
  });

  test("keeps submission cancellation recognizable as AbortError", async () => {
    const controller = new AbortController();
    submitOverride = async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); };
    try {
      await assert.rejects(requestCanvasAgentTurn({ model: "gpt-5", relayTokenName: "text-key", prompt: "plan", systemPrompt: "plan", messages: [], tools: [], signal: controller.signal }), { name: "AbortError" });
    } finally {
      submitOverride = undefined;
    }
  });

  test("does not submit planning work for an already stopped run", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = submittedInputs.length;
    await assert.rejects(requestCanvasAgentTurn({ model: "gpt-5", relayTokenName: "text-key", prompt: "plan", systemPrompt: "plan", messages: [], tools: [], signal: controller.signal }), { name: "AbortError" });
    assert.equal(submittedInputs.length, before);
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
    assert.ok(checkpoints.some((checkpoint) => checkpoint.protocolMessages.some((message) => message.role === "tool" && JSON.parse(message.content).code === "execution_not_started")));
    assert.ok(checkpoints.at(-1).protocolMessages.some((message) => message.role === "tool" && JSON.parse(message.content).nodeCount === 2));
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

  test("preserves complete tool pairs beyond 120 messages while inside the token budget", async () => {
    const submissionOffset = submittedInputs.length;
    const history = [
      { role: "assistant", content: "old assistant", toolCalls: [{ id: "old-call", name: "get_canvas_summary", arguments: {} }] },
      { role: "tool", content: "{}", toolCallId: "old-call", name: "get_canvas_summary" },
      ...Array.from({ length: 118 }, (_, index) => ({ role: "user", content: `history-${index}` })),
    ];
    agentReplies.push({ text_response: "完成" });
    await run({ protocolMessages: history, userText: "读取画布" });
    const sentProtocol = submittedInputs[submissionOffset].messages.slice(1);
    assert.equal(sentProtocol.length, 121);
    assert.equal(sentProtocol[0].role, "assistant");
    assert.equal(sentProtocol[1].tool_call_id, "old-call");
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
        { name: "generate_video", arguments: { size: "16:9", seconds: 10, generateAudio: false, prompt: "镜头", sourceNodeIds: [] } },
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

  test("cancelled media tasks leave the Agent pending queue", async () => {
    agentReplies.push(toolReply([{ name: "get_media_task_status", arguments: { nodeId: "video-node" } }]), { text_response: "已停止" });
    const result = await run({
      initialState: { ...createCanvasAgentState(), pendingTaskIds: ["cancelled-video", "still-running"] },
      executeAction: async () => ({ ok: true, taskId: "cancelled-video", status: "cancelled" }),
    });
    assert.deepEqual(result.state.pendingTaskIds, ["still-running"]);
    assert.deepEqual(result.state.completedTaskIds, []);
  });

  test("runs a pure media batch concurrently", async () => {
    agentReplies.push(
      toolReply([
        { name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "A", sourceNodeIds: [] } },
        { name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "B", sourceNodeIds: [] } },
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

describe("canvas agent reliability and memory", () => {
  test("rejects wrong parameter types and unknown fields without coercion", () => {
    for (const args of [{ prompt: "draw", sourceNodeIds: [], count: "2" }, { prompt: "draw", sourceNodeIds: [12] }, { prompt: "draw", sourceNodeIds: [], surprise: true }, { prompt: "draw", sourceNodeIds: [], count: 1.5 }, { prompt: "draw" }]) {
      assert.throws(() => normalizeCanvasAgentAction("generate_image", args));
    }
  });

  test("does not execute any action until a malformed batch is corrected", async () => {
    const executed = [];
    const offset = submittedInputs.length;
    agentReplies.push({ tool_calls: [
      { id: "valid", type: "function", function: { name: "create_text_node", arguments: '{"title":"draft","content":"full script"}' } },
      { id: "invalid", type: "function", function: { name: "arrange_nodes", arguments: '{"nodeIds":[' } },
    ] }, toolReply([{ name: "create_text_node", arguments: { title: "draft", content: "full script" } }]), "完成");
    await run({ executeAction: async (action) => { executed.push(action.name); return { ok: true }; } });
    assert.deepEqual(executed, ["create_text_node"]);
    const correction = submittedInputs[offset + 1].messages.filter((message) => message.role === "tool");
    assert.equal(correction.length, 2);
    assert.ok(correction.every((message) => JSON.parse(message.content).code === "invalid_tool_arguments"));
  });

  test("limits correction to one attempt without submitting side effects", async () => {
    let executed = false;
    const malformed = { tool_calls: [{ id: "bad", function: { name: "generate_image", arguments: "[1]" } }] };
    agentReplies.push(malformed, malformed);
    await assert.rejects(run({ executeAction: async () => { executed = true; return { ok: true }; } }), /仍无效/);
    assert.equal(executed, false);
  });

  test("refuses truncated output and more than twelve actions per batch", async () => {
    let executed = 0;
    agentReplies.push(toolReply(Array.from({ length: 13 }, () => ({ name: "get_canvas_summary" }))), { finish_reason: "length", text_response: "cut off" });
    await assert.rejects(run({ executeAction: async () => { executed += 1; return { ok: true }; } }), /截断/);
    assert.equal(executed, 0);
  });

  test("returns a result for suppressed arrangement calls so protocol pairs stay complete", async () => {
    agentReplies.push(toolReply([{ name: "arrange_nodes", arguments: {} }, { name: "get_canvas_summary" }]), "已读取");
    const executed = [];
    const result = await run({ userText: "看看画布", executeAction: async (action) => { executed.push(action.name); return { ok: true }; } });
    assert.deepEqual(executed, ["get_canvas_summary"]);
    const messages = result.protocolMessages.filter((message) => message.role === "tool");
    assert.equal(messages.length, 2);
    assert.equal(JSON.parse(messages[0].content).code, "action_not_requested");
  });

  test("passes streaming and protocol choices through every planning and tool turn", async () => {
    for (const apiMode of [undefined, "chat", "responses"]) {
      for (const stream of [undefined, false, true]) {
        const offset = submittedInputs.length;
        agentReplies.push(toolReply([{ name: "get_canvas_summary" }]), "你好");
        await run({ userText: "你好", apiMode, reasoningEnabled: true, stream });
        assert.equal(submittedInputs.length - offset, 2);
        for (const input of submittedInputs.slice(offset)) {
          assert.equal(input.apiMode, apiMode ?? "responses");
          assert.equal(input.reasoningEnabled, true);
          assert.equal(input.stream, stream === true);
        }
      }
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

test("replays Responses reasoning items with function call outputs", async () => {
  const offset = submittedInputs.length;
  const responseItems = [{ type: "reasoning", id: "r1", encrypted_content: "opaque-context", summary: [] }, { type: "function_call", id: "f1", call_id: "native-call-1", name: "get_canvas_summary", arguments: "{}" }];
  agentReplies.push({ ...toolReply([{ name: "get_canvas_summary" }]), response_items: responseItems }, { text_response: "完成", response_items: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "完成" }] }] });
  const result = await run({ apiMode: "responses" });
  const replayed = submittedInputs[offset + 1].messages.find((message) => message.role === "assistant");
  assert.deepEqual(replayed.response_items, responseItems);
  assert.deepEqual(result.protocolMessages.find((message) => message.role === "assistant").responseItems, responseItems);
});

test("compacts long history before requesting a planning turn and persists the checkpoint", async () => {
  const offset = submittedInputs.length;
  const history = [
    { role: "user", content: "已确认红色产品".repeat(25000) },
    { role: "assistant", content: "已记录" },
  ];
  const checkpoints = [];
  // Summarization is chunked, then the next planning turn returns normally.
  submitOverride = async (input) => {
    if (input.prompt === "整理对话记忆") agentReplies.push("用户已确认红色产品");
    else agentReplies.push("收到");
    return { id: `agent-task-${++taskCounter}` };
  };
  try {
    const result = await run({ stream: true, protocolMessages: history, userText: "继续说明", onCheckpoint: (value) => checkpoints.push(value) });
    assert.equal(result.contextCheckpoint, "用户已确认红色产品");
    assert.ok(submittedInputs.slice(offset).every((input) => input.stream === true));
    const planning = submittedInputs.slice(offset).find((input) => input.prompt === "继续说明");
    assert.match(planning.messages[0].content, /用户已确认红色产品/);
    assert.equal(result.protocolMessages.length, 2);
    assert.ok(checkpoints.some((value) => value.contextCheckpoint === "用户已确认红色产品"));
    assert.equal(history[0].content.length, "已确认红色产品".length * 25000);
  } finally { submitOverride = undefined; }
});

const productReferences = (count) => Array.from({ length: count }, (_, index) => ({
  id: `product-${index}`, type: "image", title: `产品角度 ${index}`, label: `图片${index + 1}`, dataUrl: `data:image/png;base64,${index}`,
}));

test("analyzes all images in batches before executing the requested workflow in both APIs", async () => {
  for (const apiMode of ["chat", "responses"]) {
    const offset = submittedInputs.length;
    const seen = [];
    const events = [];
    const checkpoints = [];
    let planned = 0;
    const executed = [];
    submitOverride = async (input) => {
      if (input.prompt === "分批分析创作资料") {
        assert.deepEqual(input.tools, []);
        const batch = input.messages.at(-1).content;
        for (const [index, part] of batch.entries()) {
          if (part.type !== "image_url") continue;
          const number = Number(part.image_url.url.split(",")[1]);
          assert.ok(batch[index - 1].text.includes(`节点 product-${number}（`));
          seen.push(number);
        }
        agentReplies.push(`保留原产品结构，先白底后宣传；已分析节点 ${seen.map((id) => `product-${id}`).join("、")}`);
      } else {
        assert.equal(seen.length, 28);
        planned += 1;
        agentReplies.push(planned === 1 ? toolReply([{ name: "edit_image", arguments: { size: "1:1", count: 1, prompt: "白底产品图，保留结构", sourceNodeIds: ["product-0", "product-27"] } }]) : "白底图任务已提交");
      }
      return { id: `agent-task-${++taskCounter}` };
    };
    try {
      const result = await run({ apiMode, stream: true, userText: "先做产品白底图，再做宣传图", references: productReferences(28),
        onEvent: (value) => events.push(value), onCheckpoint: (value) => checkpoints.push(value),
        executeAction: async (action) => { executed.push(action); return { ok: true, taskId: "white-background", status: "loading" }; },
      });
      assert.deepEqual(seen, Array.from({ length: 28 }, (_, index) => index));
      assert.equal(executed.length, 1);
      assert.deepEqual(executed[0].arguments.sourceNodeIds, ["product-0", "product-27"]);
      assert.deepEqual(result.state.pendingTaskIds, ["white-background"]);
      assert.ok(events.some((event) => /分批分析/.test(event.label)));
      assert.ok(checkpoints.some((checkpoint) => JSON.stringify(checkpoint.protocolMessages).includes("已分析节点")));
      assert.doesNotMatch(JSON.stringify(result.protocolMessages), /base64/);
      const requests = submittedInputs.slice(offset);
      assert.ok(requests.every((request) => request.apiMode === apiMode && request.stream === true));
      const planning = requests.filter((request) => request.tools.length);
      assert.equal(planning.length, 2);
      assert.ok(planning.every((request) => estimateCanvasAgentTokens({ messages: request.messages, tools: request.tools }) < 64_000 / 1.15));
      for (const reference of productReferences(28)) assert.ok(JSON.stringify(planning[0].messages).includes(`节点 ${reference.id}（`));
    } finally { submitOverride = undefined; }
  }
});

test("automatically splits a single oversized text request and keeps its final constraints", async () => {
  const offset = submittedInputs.length;
  const fragments = [];
  const userText = "请制作产品白底图；" + "功能资料🙂".repeat(20_000) + "最后要求：不得改变门的方向";
  submitOverride = async (input) => {
    if (input.prompt === "分批分析创作资料") {
      fragments.push(...input.messages.at(-1).content.map((part) => part.text));
      agentReplies.push("制作产品白底图，不得改变门的方向");
    } else agentReplies.push("需要哪个尺寸？");
    return { id: `agent-task-${++taskCounter}` };
  };
  try {
    const result = await run({ userText });
    assert.equal(fragments.join(""), userText);
    assert.match(result.protocolMessages[0].content, /不得改变门的方向/);
    const planning = submittedInputs.slice(offset).find((request) => request.tools.length);
    assert.ok(planning.prompt.length < 1_000);
    assert.ok(estimateCanvasAgentTokens(planning.messages) < 64_000 / 1.15);
  } finally { submitOverride = undefined; }
});

test("failed image analysis preserves original references and never executes canvas actions", async () => {
  const references = productReferences(20);
  const before = structuredClone(references);
  const checkpoints = [];
  let executed = 0;
  let analyzed = 0;
  submitOverride = async () => {
    analyzed += 1;
    if (analyzed === 2) throw new Error("analysis unavailable");
    agentReplies.push("第一批结果");
    return { id: `agent-task-${++taskCounter}` };
  };
  try {
    await assert.rejects(run({ references, onCheckpoint: (value) => checkpoints.push(value), executeAction: async () => { executed += 1; return { ok: true }; } }), /analysis unavailable/);
    assert.equal(executed, 0);
    assert.equal(checkpoints.length, 1);
    for (const reference of references) assert.ok(checkpoints[0].protocolMessages[0].content.includes(`节点 ${reference.id}（`));
    assert.deepEqual(references, before);
  } finally { submitOverride = undefined; }
});

test("model context rejection reduces the batch size and resumes without replaying actions", async () => {
  let plans = 0;
  let analyses = 0;
  let executed = 0;
  submitOverride = async (input) => {
    if (input.prompt === "分批分析创作资料") {
      analyses += 1;
      agentReplies.push("图片 product-0 至 product-5 的产品资料，保留外观");
    } else {
      plans += 1;
      if (plans === 1) throw new Error("maximum context length exceeded");
      agentReplies.push(plans === 2 ? toolReply([{ name: "get_canvas_summary" }]) : "分析完成");
    }
    return { id: `agent-task-${++taskCounter}` };
  };
  try {
    const result = await run({ references: productReferences(6), executeAction: async () => { executed += 1; return { ok: true }; } });
    assert.ok(analyses > 1);
    assert.equal(plans, 3);
    assert.equal(executed, 1);
    assert.equal(result.reply, "分析完成");
  } finally { submitOverride = undefined; }
});

test("large tool results are summarized while retaining native call/result pairs", async () => {
  let plans = 0;
  let analyzed = 0;
  submitOverride = async (input) => {
    if (input.prompt === "分批分析创作资料") {
      analyzed += 1;
      agentReplies.push("get_canvas_summary 返回真实产品节点 product-1，尚未生成媒体");
    } else {
      plans += 1;
      if (plans === 2) {
        const call = input.messages.find((message) => message.tool_calls?.length);
        const result = input.messages.find((message) => message.role === "tool");
        assert.equal(result.tool_call_id, call.tool_calls[0].id);
        assert.match(result.content, /product-1/);
      }
      agentReplies.push(plans === 1 ? toolReply([{ name: "get_canvas_summary" }]) : "已读取");
    }
    return { id: `agent-task-${++taskCounter}` };
  };
  try {
    await run({ executeAction: async () => ({ ok: true, nodes: [{ id: "product-1", text: "产品详情".repeat(20_000) }] }) });
    assert.ok(analyzed > 1);
    assert.equal(plans, 2);
  } finally { submitOverride = undefined; }
});

test("compacts completed actions in the current turn and continues without submitting them twice", async () => {
  let plans = 0;
  let summaries = 0;
  const executed = [];
  submitOverride = async (input) => {
    if (input.prompt === "整理对话记忆") {
      summaries += 1;
      agentReplies.push("已创建 node-0 到 node-9 十个文本节点；不要重复创建，下一步检查结果");
    } else {
      plans += 1;
      if (plans === 2) {
        assert.match(input.messages[0].content, /已创建 node-0/);
        assert.ok(!input.messages.some((message) => message.role === "tool"));
      }
      agentReplies.push(plans === 1 ? toolReply(Array.from({ length: 10 }, (_, index) => ({ name: "create_text_node", arguments: { title: `说明 ${index}`, content: "产品要求".repeat(1_500) } }))) : "十个文本节点已创建");
    }
    return { id: `agent-task-${++taskCounter}` };
  };
  try {
    const result = await run({ executeAction: async (action) => { executed.push(action); return { ok: true, nodeId: `node-${executed.length - 1}` }; } });
    assert.equal(executed.length, 10);
    assert.ok(summaries > 0);
    assert.equal(plans, 2);
    assert.match(result.contextCheckpoint, /已创建 node-0/);
  } finally { submitOverride = undefined; }
});

test("analysis rejects truncated output and tool calls without committing a partial summary", async () => {
  for (const reply of [{ finish_reason: "length", text_response: "半段摘要" }, toolReply([{ name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "错误执行", sourceNodeIds: [] } }])]) {
    const checkpoints = [];
    let executed = 0;
    agentReplies.push(reply);
    await assert.rejects(run({ references: productReferences(20), onCheckpoint: (value) => checkpoints.push(value), executeAction: async () => { executed += 1; return { ok: true }; } }), /分批分析未完整返回/);
    assert.equal(executed, 0);
    assert.equal(checkpoints.length, 1);
    assert.doesNotMatch(checkpoints[0].protocolMessages[0].content, /半段摘要/);
  }
});

test("cancelling image analysis stops the entire workflow before canvas execution", async () => {
  const controller = new AbortController();
  let executed = 0;
  const cancelledOffset = cancelledTasks.length;
  agentReplies.push({ task_status: "running" });
  const pending = run({ signal: controller.signal, references: productReferences(20), executeAction: async () => { executed += 1; return { ok: true }; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(executed, 0);
  assert.equal(cancelledTasks.length, cancelledOffset + 1);
});

test("large saved plans are reduced for planning without rewriting the approved source", async () => {
  const state = { ...createCanvasAgentState(), approvedPlan: "已确认的方案".repeat(20_000) + "产品必须朝左" };
  let plans = 0;
  let analyses = 0;
  submitOverride = async (input) => {
    if (input.prompt === "分批分析创作资料") {
      analyses += 1;
      agentReplies.push("已确认：产品必须朝左");
    } else {
      plans += 1;
      assert.match(input.messages[0].content, /产品必须朝左/);
      assert.ok(estimateCanvasAgentTokens(input.messages) < 64_000 / 1.15);
      agentReplies.push(plans === 1 ? toolReply([{ name: "get_canvas_summary" }]) : "已检查方案");
    }
    return { id: `agent-task-${++taskCounter}` };
  };
  try {
    const result = await run({ initialState: state });
    assert.ok(analyses > 1);
    assert.equal(plans, 2);
    assert.equal(result.state.approvedPlan, state.approvedPlan);
  } finally { submitOverride = undefined; }
});

test("message image attachments reach the model without claiming to be canvas nodes", async () => {
  const offset = submittedInputs.length;
  agentReplies.push("图片包含产品外观。");
  const attachment = { id: "attachment-product", source: "attachment", type: "image", title: "product.png", url: "/api/files/product/content", storageKey: "server:product", dataUrl: "data:image/png;base64,AAAA" };
  await run({ userText: "描述这张图片", references: [attachment] });
  const user = submittedInputs[offset].messages.findLast((message) => message.role === "user");
  assert.ok(user.content.some((part) => part.type === "image_url" && part.image_url.url === attachment.dataUrl));
  const captions = user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(captions, /消息附件/);
  assert.doesNotMatch(captions, /节点 attachment-product/);
  const saved = { ...attachment, dataUrl: undefined };
  const session = { id: "attachment-session", messages: [{ id: "user-upload", role: "user", text: "描述这张图片", references: [saved] }] };
  assert.deepEqual(syncCanvasAgentSessions([session], [])[0].messages[0].references, [saved]);
});

const { resolveCanvasAgentQuestion } = await import("../src/app/canvas/agent/canvas-agent-interaction.ts");
const questionArguments = { question: "这组海报采用哪种风格？", reason: "风格会影响整组图片的一致性。", options: ["纪实摄影", "手绘插画"], kind: "clarification" };

test("human input pauses the entire batch before any canvas side effects", async () => {
  const offset = submittedInputs.length;
  const executed = [];
  const checkpoints = [];
  agentReplies.push(toolReply([
    { id: "write-before-question", name: "create_text_node", arguments: { title: "过早执行", content: "不应该出现" } },
    { id: "question-1", name: "ask_user_question", arguments: questionArguments },
    { id: "write-after-question", name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "不应该生成", sourceNodeIds: [] } },
  ]));
  const result = await run({ userText: "制作一组海报", executeAction: async (action) => { executed.push(action); return { ok: true }; }, onCheckpoint: (value) => checkpoints.push(structuredClone(value)) });
  assert.equal(submittedInputs.length - offset, 1);
  assert.deepEqual(executed, []);
  assert.equal(result.state.pendingQuestion.id, "question-1");
  assert.equal(result.reply, questionArguments.question);
  const outputs = result.protocolMessages.filter((item) => item.role === "tool");
  assert.equal(outputs.length, 2);
  assert.ok(outputs.every((item) => JSON.parse(item.content).code === "awaiting_user"));
  assert.deepEqual(checkpoints.at(-1).state.pendingQuestion, result.state.pendingQuestion);
});

test("saved questions resume with a tool answer in Chat and Responses without replaying prior actions", async () => {
  for (const apiMode of ["chat", "responses"]) {
    const executed = [];
    const responseItems = [{ type: "reasoning", id: "ask-reasoning", encrypted_content: "opaque", summary: [] }, { type: "function_call", id: "ask-item", call_id: "ask-style", name: "ask_user_question", arguments: JSON.stringify(questionArguments) }];
    agentReplies.push(toolReply([{ id: "already-written", name: "create_text_node", arguments: { title: "需求", content: "海报" } }]), { ...toolReply([{ id: "ask-style", name: "ask_user_question", arguments: questionArguments }]), response_items: responseItems });
    const paused = await run({ apiMode, executeAction: async (action) => { executed.push(action.id); return { ok: true, nodeId: "created-node" }; } });
    const stored = JSON.parse(JSON.stringify(paused));
    const offset = submittedInputs.length;
    agentReplies.push(toolReply([{ id: "after-answer", name: "create_text_node", arguments: { title: "风格", content: "手绘插画" } }]), "已按手绘插画保存方案");
    const result = await run({ apiMode, initialState: stored.state, protocolMessages: stored.protocolMessages, userText: "手绘插画", executeAction: async (action) => { executed.push(action.id); return { ok: true }; } });
    assert.deepEqual(executed, ["already-written", "after-answer"]);
    assert.equal(result.state.pendingQuestion, undefined);
    const request = submittedInputs[offset];
    const answer = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "ask-style");
    assert.deepEqual(JSON.parse(answer.content), { ok: true, answer: "手绘插画" });
    assert.ok(request.messages.indexOf(answer) < request.messages.findLastIndex((message) => message.role === "user"));
    assert.deepEqual(request.messages.find((message) => message.tool_calls?.some((call) => call.id === "ask-style")).response_items, responseItems);
    assert.equal(result.protocolMessages.filter((message) => message.role === "tool" && message.toolCallId === "ask-style").length, 1);
  }
});

test("question cancellation and stale answers cannot silently grant permission", async () => {
  agentReplies.push(toolReply([{ id: "confirm-1", name: "ask_user_question", arguments: { ...questionArguments, kind: "confirmation" } }]));
  const paused = await run();
  const offset = submittedInputs.length;
  assert.throws(() => resolveCanvasAgentQuestion(paused.state, paused.protocolMessages, "  "), /回答/);
  const cancelled = resolveCanvasAgentQuestion(paused.state, paused.protocolMessages, "", true);
  assert.equal(cancelled.state.pendingQuestion, undefined);
  assert.equal(JSON.parse(cancelled.protocolMessages.at(-1).content).code, "user_cancelled");
  assert.throws(() => resolveCanvasAgentQuestion(paused.state, cancelled.protocolMessages, "同意"), /状态已变化/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run({ initialState: paused.state, protocolMessages: paused.protocolMessages, userText: "同意", signal: controller.signal }), { name: "AbortError" });
  assert.equal(submittedInputs.length, offset);
  assert.ok(paused.state.pendingQuestion);
});

test("structured plans validate nested arguments and persist without invoking canvas tools", async () => {
  const plan = { explanation: "先定稿再生成", steps: [{ id: "script", title: "确认剧本", status: "in_progress" }, { id: "images", title: "生成分镜", status: "pending" }] };
  assert.throws(() => normalizeCanvasAgentAction("update_plan", { ...plan, steps: [{ ...plan.steps[0], unexpected: true }] }), /未知工具参数/);
  assert.throws(() => normalizeCanvasAgentAction("update_plan", { ...plan, steps: [plan.steps[0], plan.steps[0]] }), /不得重复/);
  assert.throws(() => normalizeCanvasAgentAction("update_plan", { ...plan, steps: plan.steps.map((step) => ({ ...step, status: "in_progress" })) }), /最多一个/);
  assert.throws(() => normalizeCanvasAgentAction("ask_user_question", { ...questionArguments, options: ["重复", "重复"] }), /不得重复/);
  assert.throws(() => normalizeCanvasAgentAction("ask_user_question", { ...questionArguments, question: "" }), /不能为空/);
  const checkpoints = [];
  agentReplies.push(toolReply([{ id: "plan", name: "update_plan", arguments: plan }]), "已列出执行步骤");
  const result = await run({ executeAction: async () => { throw new Error("plan must stay in the runtime"); }, onCheckpoint: (value) => checkpoints.push(structuredClone(value)) });
  assert.deepEqual(result.state.plan, plan);
  assert.deepEqual(checkpoints.at(-1).state.plan, plan);
  assert.equal(JSON.parse(result.protocolMessages.find((message) => message.role === "tool").content).ok, true);
});

test("a failed structural action prevents dependent actions in the same batch", async () => {
  const executed = [];
  agentReplies.push(toolReply([
    { id: "failed-script", name: "create_text_node", arguments: { title: "剧本", content: "正文" } },
    { id: "dependent-image", name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "基于剧本", sourceNodeIds: [] } },
  ]), "剧本未保存，请处理后继续");
  const result = await run({ executeAction: async (action) => { executed.push(action.id); return { ok: false, code: "storage_failed" }; } });
  assert.deepEqual(executed, ["failed-script"]);
  assert.equal(JSON.parse(result.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === "dependent-image").content).code, "dependency_failed");
});

test("stopping a sequential batch saves completed results and does not start its remaining tools", async () => {
  const controller = new AbortController();
  const checkpoints = [];
  const executed = [];
  const offset = submittedInputs.length;
  agentReplies.push(toolReply([
    { id: "saved-script", name: "create_text_node", arguments: { title: "剧本", content: "正文" } },
    { id: "unstarted-image", name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "分镜", sourceNodeIds: [] } },
  ]));
  await assert.rejects(run({
    signal: controller.signal,
    executeAction: async (action) => {
      const saved = checkpoints.at(-1).protocolMessages;
      assert.ok(saved.some((message) => message.role === "tool" && message.toolCallId === action.id && JSON.parse(message.content).code === "execution_unknown"));
      executed.push(action.id);
      return { ok: true, nodeId: "script-created" };
    },
    onCheckpoint: (value) => {
      checkpoints.push(structuredClone(value));
      if (value.protocolMessages.some((message) => message.role === "tool" && JSON.parse(message.content).nodeId === "script-created")) controller.abort();
    },
  }), { name: "AbortError" });
  assert.deepEqual(executed, ["saved-script"]);
  assert.equal(submittedInputs.length - offset, 1);
  const outputs = checkpoints.at(-1).protocolMessages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
  assert.equal(outputs[0].nodeId, "script-created");
  assert.equal(outputs[1].code, "execution_not_started");
});

test("parallel cancellation keeps completed task IDs and ignores late settlements", async () => {
  const controller = new AbortController();
  const checkpoints = [];
  let settleLate;
  agentReplies.push(toolReply([
    { id: "submitted-image", name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "第一张", sourceNodeIds: [] } },
    { id: "unknown-image", name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "第二张", sourceNodeIds: [] } },
  ]));
  await assert.rejects(run({
    signal: controller.signal,
    executeAction: async (action) => action.id === "submitted-image"
      ? { ok: true, nodeId: "image-saved", taskId: "media-running", status: "loading" }
      : new Promise((resolve) => { settleLate = resolve; }),
    onCheckpoint: (value) => {
      checkpoints.push(structuredClone(value));
      if (value.state.pendingTaskIds.includes("media-running")) controller.abort();
    },
  }), { name: "AbortError" });
  const saved = structuredClone(checkpoints.at(-1));
  assert.deepEqual(saved.state.pendingTaskIds, ["media-running"]);
  assert.equal(JSON.parse(saved.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === "unknown-image").content).code, "execution_unknown");
  const count = checkpoints.length;
  settleLate({ ok: true, nodeId: "late-node", taskId: "late-task", status: "success" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(checkpoints.length, count);
  assert.deepEqual(checkpoints.at(-1), saved);
});

test("interrupted checkpoints restore paired calls in Chat and Responses without replaying a batch", async () => {
  const controller = new AbortController();
  let runningCheckpoint;
  let refreshCheckpoint;
  agentReplies.push(toolReply([
    { id: "unknown-script", name: "create_text_node", arguments: { title: "剧本", content: "正文" } },
    { id: "unstarted-dependent", name: "generate_image", arguments: { size: "1:1", count: 1, prompt: "分镜", sourceNodeIds: [] } },
  ]));
  await assert.rejects(run({
    signal: controller.signal,
    onCheckpoint: (value) => { runningCheckpoint = structuredClone(value); },
    executeAction: async () => {
      refreshCheckpoint = structuredClone(runningCheckpoint);
      controller.abort();
      return new Promise(() => {});
    },
  }), { name: "AbortError" });
  for (const apiMode of ["chat", "responses"]) {
    const offset = submittedInputs.length;
    const restored = syncCanvasAgentSessions([{
      id: "interrupted", title: "中断的对话", messages: [{ id: "reply", role: "assistant", text: "", status: "running" }],
      agentState: refreshCheckpoint.state, protocolMessages: refreshCheckpoint.protocolMessages,
    }], [], true)[0];
    assert.equal(restored.messages[0].status, "waiting");
    const executed = [];
    agentReplies.push(toolReply([{ id: "check-current-canvas", name: "get_canvas_summary" }]), "已核对画布");
    await run({ apiMode, initialState: restored.agentState, protocolMessages: restored.protocolMessages, userText: "继续", executeAction: async (action) => { executed.push(action.id); return { ok: true }; } });
    assert.deepEqual(executed, ["check-current-canvas"]);
    const messages = submittedInputs[offset].messages;
    const calls = messages.filter((message) => message.tool_calls).flatMap((message) => message.tool_calls);
    assert.ok(calls.length >= 2);
    for (const call of calls) assert.equal(messages.filter((message) => message.role === "tool" && message.tool_call_id === call.id).length, 1);
    assert.equal(JSON.parse(messages.find((message) => message.tool_call_id === "unknown-script").content).code, "execution_unknown");
    assert.equal(JSON.parse(messages.find((message) => message.tool_call_id === "unstarted-dependent").content).code, "execution_not_started");
  }
});

test("node details expose the complete script while summaries indicate omitted content", () => {
  const prompt = "开场".repeat(3000) + "片尾必须保留的对白";
  const node = { id: "long-script", type: "text", title: "长剧本", prompt };
  assert.equal(summarizeCanvasAgentNode(node).prompt.length, 4000);
  assert.equal(summarizeCanvasAgentNode(node).detailsOmitted, true);
  assert.equal(summarizeCanvasAgentNode(node, true).text, prompt);
  assert.equal(summarizeCanvasAgentNode(node, true).detailsOmitted, undefined);
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

test("missing delivery parameters stop the batch before any generation executes", async () => {
  const executed = [];
  agentReplies.push(toolReply([{ id: "missing", name: "generate_video", arguments: { prompt: "宣传片", sourceNodeIds: [] } }]), toolReply([{ id: "ask", name: "ask_user_question", arguments: { question: "宣传视频要多长、什么比例和声音？", reason: "交付参数尚未明确", options: [], kind: "clarification" } }]));
  const result = await run({ userText: "制作宣传视频", executeAction: async (action) => { executed.push(action); return { ok: true }; } });
  assert.deepEqual(executed, []);
  assert.equal(result.state.pendingQuestion.id, "ask");
  assert.match(result.reply, /比例和声音/);
});

test("retry keeps the existing user turn and reuses completed node operations", async () => {
  for (const apiMode of ["chat", "responses"]) {
    const call = { id: "saved", name: "create_text_node", arguments: { title: "方案", content: "正文" } };
    const history = [{ role: "user", content: "创建方案" }, { role: "assistant", toolCalls: [call] }, { role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ ok: true, nodeId: "existing" }) }];
    const offset = submittedInputs.length;
    agentReplies.push(toolReply([{ ...call, id: "repeated" }]), "已恢复原任务");
    const result = await run({ apiMode, resume: true, userText: "创建方案", protocolMessages: history, executeAction: async () => { throw new Error("must not repeat completed writes"); } });
    assert.equal(submittedInputs[offset].messages.filter((message) => message.role === "user").length, 1);
    assert.equal(result.protocolMessages.filter((message) => message.role === "user").length, 1);
    assert.equal(JSON.parse(result.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === "repeated").content).nodeId, "existing");
  }
});

test("three saved image edits stay waiting for manual generation instead of completing the plan", async () => {
  const { canvasAgentWaitingReason } = await import("../src/app/canvas/agent/canvas-agent-runtime.ts");
  const initialState = { ...createCanvasAgentState(), plan: { explanation: "", steps: [{ id: "white", title: "三视角白底图", status: "in_progress" }, { id: "review", title: "核对成图", status: "pending" }] } };
  const calls = ["正面", "斜前方", "背面"].map((title, index) => ({ id: `edit-${index}`, name: "edit_image", arguments: { title, prompt: "产品白底图，保留机身标识，不加文案", size: "1:1", count: 1, sourceNodeIds: [], attachmentIds: ["product-photo"] } }));
  agentReplies.push(toolReply(calls), "三个节点已保存，等待手动生成");
  const offset = submittedInputs.length;
  const result = await run({ initialState, executeAction: async (action) => ({ ok: true, submitted: false, nodeId: action.id, status: "idle" }) });
  assert.equal(result.waiting, true);
  assert.equal(submittedInputs.length - offset, 2);
  assert.equal(canvasAgentWaitingReason(result.state, result.protocolMessages), "待手动生成 · 3 个节点");
  assert.equal(canvasAgentWaitingReason(result.state, result.protocolMessages, calls.map((call) => ({ id: call.id, status: "success" }))), "");
});

test("an early final reply continues an unfinished plan and preserves completed operations", async () => {
  const plan = { explanation: "", steps: [{ id: "draft", title: "整理需求", status: "completed" }, { id: "write", title: "写入方案", status: "in_progress" }] };
  agentReplies.push(toolReply([{ id: "plan", name: "update_plan", arguments: plan }]), "需求已整理", toolReply([{ id: "write", name: "create_text_node", arguments: { title: "方案", content: "最终方案" } }, { id: "finish", name: "update_plan", arguments: { ...plan, steps: plan.steps.map((step) => ({ ...step, status: "completed" })) } }]), "方案已写入");
  const executed = [];
  const result = await run({ executeAction: async (action) => { executed.push(action.id); return { ok: true, nodeId: "plan-node" }; } });
  assert.deepEqual(executed, ["write"]);
  assert.equal(result.waiting, false);
  assert.ok(result.state.plan.steps.every((step) => step.status === "completed"));
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

test("resume submits the three saved nodes before planning and waits for all real results", async () => {
  const saved = savedMediaRun();
  const completions = new Map();
  const checkpoints = [];
  const offset = submittedInputs.length;
  const executed = [];
  agentReplies.push(toolReply([{ id: "review", name: "get_node", arguments: { nodeId: "existing-0" } }]), toolReply([{ id: "complete", name: "update_plan", arguments: { ...saved.initialState.plan, steps: saved.initialState.plan.steps.map((item) => ({ ...item, status: "completed" })) } }]), "三张白底图已生成并核对");
  const pending = run({ ...saved, resume: true, getContext: mediaContext, onCheckpoint: (value) => checkpoints.push(structuredClone(value)), executeAction: async (action) => {
    executed.push(action);
    if (action.name === "generate_node") return new Promise((resolve) => completions.set(action.arguments.nodeId, resolve));
    return { ok: true, nodeId: "existing-0", status: "success" };
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(executed.map((action) => action.arguments.nodeId), ["existing-0", "existing-1", "existing-2"]);
  assert.equal(submittedInputs.length, offset);
  for (let index = 0; index < 2; index++) completions.get(`existing-${index}`)({ ok: true, submitted: true, nodeId: `existing-${index}`, taskId: `media-${index}`, status: "success" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(submittedInputs.length, offset);
  completions.get("existing-2")({ ok: true, submitted: true, nodeId: "existing-2", taskId: "media-2", status: "success" });
  const result = await pending;
  assert.equal(result.waiting, false);
  assert.deepEqual(result.state.pendingTaskIds, []);
  assert.deepEqual(result.state.completedTaskIds, ["media-0", "media-1", "media-2"]);
  assert.ok(result.state.plan.steps.every((item) => item.status === "completed"));
  assert.equal(result.protocolMessages.filter((message) => message.role === "user").length, 1);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.state.completedTaskIds.length === 2));
  const resumedCalls = result.protocolMessages.filter((message) => message.role === "assistant").flatMap((message) => message.toolCalls || []).filter((call) => call.name === "generate_node");
  assert.equal(resumedCalls.length, 3);
  assert.ok(resumedCalls.every((call) => result.protocolMessages.some((message) => message.role === "tool" && message.toolCallId === call.id)));
});

test("retrying a manual run respects the disabled generation setting", async () => {
  const saved = savedMediaRun();
  agentReplies.push("自动生成关闭，请开启后继续");
  const result = await run({ ...saved, resume: true, getContext: (state) => mediaContext(state, false), executeAction: async () => { throw new Error("must not generate while disabled"); } });
  assert.equal(result.waiting, true);
  assert.deepEqual(result.state.completedTaskIds, []);
});

test("deferring media continues independent writing, preserves nodes and records the user's choice", async () => {
  const saved = savedMediaRun();
  const executed = [];
  const plan = { explanation: "先完成文案，成图和审核暂缓", steps: [
    ...saved.initialState.plan.steps.map((step) => ({ ...step, status: "deferred" })),
    { id: "copy", title: "整理后续文案", status: "completed" },
  ] };
  agentReplies.push(toolReply([{ id: "write-copy", name: "create_text_node", arguments: { title: "宣传文案", content: "后续文案与提示词" } }]), toolReply([{ id: "deferred-plan", name: "update_plan", arguments: plan }]), "文案已整理，图片和成图审核暂缓。");
  const result = await run({ ...saved, resume: true, mediaGenerationChoice: "defer", getContext: mediaContext, executeAction: async (action) => { executed.push(action); return { ok: true, nodeId: "copy-node" }; } });
  assert.deepEqual(executed.map((action) => action.name), ["create_text_node"]);
  assert.equal(result.state.mediaGenerationDeferred, true);
  assert.equal(result.waiting, false);
  assert.deepEqual(result.state.plan.steps.map((step) => step.status), ["deferred", "deferred", "completed"]);
  assert.match(result.protocolMessages.findLast((message) => message.role === "user").content, /暂不生成，继续规划/);
  assert.deepEqual(result.protocolMessages.filter((message) => message.role === "tool" && message.name === "edit_image"), saved.protocolMessages.filter((message) => message.role === "tool"));
});

test("persisted media deferral blocks generation even after retries and global setting changes", async () => {
  const saved = savedMediaRun();
  agentReplies.push(toolReply([{ id: "unwanted-generation", name: "generate_node", arguments: { nodeId: "existing-0" } }]), "图片仍暂缓，可以继续修改文案。");
  const result = await run({ ...saved, initialState: { ...saved.initialState, mediaGenerationDeferred: true, plan: undefined }, resume: true, getContext: mediaContext, executeAction: async () => { throw new Error("deferral must prevent all media side effects"); } });
  assert.equal(result.state.mediaGenerationDeferred, true);
  const blocked = result.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === "unwanted-generation");
  assert.equal(JSON.parse(blocked.content).code, "media_generation_deferred");
  assert.equal(result.waiting, false);
});

test("explicit generation resumes deferred nodes without requiring global auto generation", async () => {
  const saved = savedMediaRun();
  const executed = [];
  agentReplies.push("已有图片已生成。");
  const result = await run({ ...saved, initialState: { ...saved.initialState, mediaGenerationDeferred: true, plan: undefined }, resume: true, mediaGenerationChoice: "generate", getContext: (state) => mediaContext(state, false), executeAction: async (action) => {
    executed.push(action);
    return { ok: true, submitted: true, nodeId: action.arguments.nodeId, status: "success" };
  } });
  assert.equal(result.state.mediaGenerationDeferred, false);
  assert.deepEqual(executed.map((action) => [action.name, action.arguments.nodeId]), [0, 1, 2].map((index) => ["generate_node", `existing-${index}`]));
  assert.match(result.protocolMessages.findLast((message) => message.role === "user").content, /立即生成已有待处理节点/);
  assert.equal(result.waiting, false);
});

test("explicit generation authorization clears an old deferral on a resumed run", async () => {
  const saved = savedMediaRun();
  const checkpoints = [];
  const executed = [];
  const result = await run({
    ...saved,
    initialState: { ...saved.initialState, mediaGenerationDeferred: true },
    resume: true,
    mediaGenerationChoice: "generate",
    getContext: (state) => mediaContext(state, false),
    onCheckpoint: (checkpoint) => checkpoints.push(structuredClone(checkpoint)),
    executeAction: async (action) => { executed.push(action); return { ok: true, submitted: true, nodeId: action.arguments.nodeId, status: "success" }; },
  });
  assert.equal(result.state.mediaGenerationDeferred, false);
  assert.deepEqual(executed.map((action) => action.arguments.nodeId), ["existing-0", "existing-1", "existing-2"]);
  assert.equal(checkpoints.at(-1).state.mediaGenerationDeferred, false);
  assert.ok(result.protocolMessages.some((message) => message.role === "user" && /明确授权立即生成/.test(String(message.content))));
});

test("a new explicit generation message submits deferred nodes with global auto generation disabled", async () => {
  const saved = savedMediaRun();
  const executed = [];
  agentReplies.push("三张图片已提交并完成。");
  const result = await run({
    ...saved,
    initialState: { ...saved.initialState, mediaGenerationDeferred: true },
    resume: false,
    userText: "你帮我生成吧",
    getContext: (state) => mediaContext(state, false),
    executeAction: async (action) => { executed.push(action); return { ok: true, submitted: true, nodeId: action.arguments.nodeId, status: "success" }; },
  });
  assert.equal(result.state.mediaGenerationDeferred, false);
  assert.deepEqual(executed.map((action) => action.arguments.nodeId), ["existing-0", "existing-1", "existing-2"]);
  assert.match(JSON.stringify(submittedInputs.at(-1).messages), /用户本轮明确授权生成/);
});

test("confirming generation in a pending question clears the deferral and resumes existing nodes", async () => {
  const saved = savedMediaRun();
  const question = { id: "media-confirmation", name: "ask_user_question", arguments: { question: "要立即生成这些图片吗？", reason: "需要确认是否提交任务", options: ["立即生成", "暂不生成"], kind: "confirmation", purpose: "media_generation" } };
  const protocolMessages = [...saved.protocolMessages, { role: "assistant", toolCalls: [question] }];
  const initialState = {
    ...saved.initialState,
    mediaGenerationDeferred: true,
    pendingQuestion: { id: question.id, question: question.arguments.question, reason: question.arguments.reason, options: question.arguments.options, kind: question.arguments.kind, purpose: question.arguments.purpose, request: "制作三张白底产品图" },
  };
  const executed = [];
  agentReplies.push(
    toolReply([{ id: "complete-plan", name: "update_plan", arguments: { ...saved.initialState.plan, steps: saved.initialState.plan.steps.map((step) => ({ ...step, status: "completed" })) } }]),
    "三张白底图已完成。",
  );
  const result = await run({ ...saved, initialState, protocolMessages, userText: "立即生成", mediaGenerationChoice: "generate", getContext: (state) => mediaContext(state, false), executeAction: async (action) => {
    executed.push(action);
    return { ok: true, submitted: true, nodeId: action.arguments.nodeId, status: "success" };
  } });
  assert.deepEqual(executed.map((action) => [action.name, action.arguments.nodeId]), [0, 1, 2].map((index) => ["generate_node", `existing-${index}`]));
  assert.equal(result.state.mediaGenerationDeferred, false);
  assert.equal(result.state.pendingQuestion, undefined);
  assert.match(result.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === question.id).content, /立即生成/);
  assert.equal(result.waiting, false);
});

test("media deferral cannot mark nonexistent outputs as completed or conceal running tasks", async () => {
  const saved = savedMediaRun();
  agentReplies.push(toolReply([{ id: "false-completion", name: "update_plan", arguments: { ...saved.initialState.plan, steps: saved.initialState.plan.steps.map((step) => ({ ...step, status: "completed" })) } }]), "生成步骤仍暂缓。", "生成步骤仍暂缓。");
  const result = await run({ ...saved, resume: true, mediaGenerationChoice: "defer", getContext: mediaContext, executeAction: async () => { throw new Error("no external actions expected"); } });
  assert.equal(JSON.parse(result.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === "false-completion").content).code, "media_not_finished");
  assert.ok(result.state.plan.steps.some((step) => step.status !== "completed"));
  const { canvasAgentWaitingReason } = await import("../src/app/canvas/agent/canvas-agent-runtime.ts");
  assert.equal(canvasAgentWaitingReason(result.state, result.protocolMessages, [{ id: "existing-0", status: "loading" }]), "等待生成结果 · 1 个节点");
});

test("resumed generation failures cannot complete the plan or duplicate existing nodes", async () => {
  const saved = savedMediaRun();
  const executed = [];
  agentReplies.push(toolReply([{ id: "premature-complete", name: "update_plan", arguments: { ...saved.initialState.plan, steps: saved.initialState.plan.steps.map((item) => ({ ...item, status: "completed" })) } }]), "图片生成失败，原节点已保留");
  const result = await run({ ...saved, resume: true, getContext: mediaContext, executeAction: async (action) => {
    executed.push(action);
    return { ok: false, submitted: true, nodeId: action.arguments.nodeId, taskId: `failed-${action.arguments.nodeId}`, status: "error", message: "生成服务失败" };
  } });
  assert.equal(result.waiting, true);
  assert.equal(executed.length, 3);
  assert.ok(executed.every((action) => action.name === "generate_node"));
  assert.deepEqual(result.state.plan, saved.initialState.plan);
  assert.deepEqual(result.state.pendingTaskIds, []);
  assert.equal(JSON.parse(result.protocolMessages.find((message) => message.role === "tool" && message.toolCallId === "premature-complete").content).code, "media_not_finished");
});

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

test("stopping saved-node recovery preserves checkpoints and does not start a model turn", async () => {
  const controller = new AbortController();
  const checkpoints = [];
  const offset = submittedInputs.length;
  const pending = run({ ...savedMediaRun(), resume: true, signal: controller.signal, getContext: mediaContext,
    onCheckpoint: (value) => checkpoints.push(structuredClone(value)), executeAction: async () => new Promise(() => {}) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, /已停止/);
  assert.equal(submittedInputs.length, offset);
  assert.ok(checkpoints.at(-1).protocolMessages.filter((message) => message.role === "tool").every((message) => JSON.parse(message.content)));
  assert.deepEqual(checkpoints.at(-1).state.completedTaskIds, []);
});

test("a second retry only regenerates the failed saved node", async () => {
  const saved = savedMediaRun();
  agentReplies.push("第三张失败，可以重试");
  const first = await run({ ...saved, resume: true, getContext: mediaContext, executeAction: async (action) => ({
    ok: action.arguments.nodeId !== "existing-2", submitted: true, nodeId: action.arguments.nodeId,
    taskId: `first-${action.arguments.nodeId}`, status: action.arguments.nodeId === "existing-2" ? "error" : "success",
  }) });
  assert.equal(first.waiting, true);
  const executed = [];
  agentReplies.push(toolReply([{ id: "complete-retry", name: "update_plan", arguments: { ...saved.initialState.plan, steps: saved.initialState.plan.steps.map((step) => ({ ...step, status: "completed" })) } }]), "三张图已完成");
  const result = await run({ resume: true, initialState: first.state, protocolMessages: first.protocolMessages, getContext: mediaContext, executeAction: async (action) => {
    executed.push(action);
    return { ok: true, submitted: true, nodeId: action.arguments.nodeId, taskId: "retried-third", status: "success" };
  } });
  assert.deepEqual(executed.map((action) => [action.name, action.arguments.nodeId]), [["generate_node", "existing-2"]]);
  assert.equal(result.waiting, false);
  assert.deepEqual(result.state.pendingTaskIds, []);
  assert.deepEqual(result.state.completedTaskIds, ["first-existing-0", "first-existing-1", "retried-third"]);
  assert.equal(result.protocolMessages.filter((message) => message.role === "user").length, 1);
});

test("a model task is saved before submission and reuses its saved ID on recovery", async () => {
  const input = { model: "gpt-5", relayTokenName: "text-key", prompt: "plan", systemPrompt: "plan", messages: [], tools: [] };
  const order = [];
  let savedID;
  submitOverride = async (request) => {
    assert.equal(request.clientTaskId, savedID);
    order.push("submit");
    return { id: savedID };
  };
  try {
    await requestCanvasAgentTurn({ ...input, onTaskCreated: async (id) => { savedID = id; order.push("save"); } });
    const original = savedID;
    await requestCanvasAgentTurn({ ...input, taskId: original, onTaskCreated: async (id) => { assert.equal(id, original); order.push("save"); } });
    assert.deepEqual(order, ["save", "submit", "save", "submit"]);
    assert.equal(new Set(submittedInputs.slice(-2).map((request) => request.clientTaskId)).size, 1);
  } finally { submitOverride = undefined; }
});

test("failed checkpoint persistence prevents model submission", async () => {
  const before = submittedInputs.length;
  await assert.rejects(requestCanvasAgentTurn({ model: "gpt-5", relayTokenName: "text-key", prompt: "plan", systemPrompt: "plan", messages: [], tools: [], onTaskCreated: async () => { throw new Error("save failed"); } }), /save failed/);
  assert.equal(submittedInputs.length, before);
});

test("leaving a canvas keeps a pending model task alive for restoration", async () => {
  const controller = new AbortController();
  let checkpoint;
  const offset = submittedInputs.length;
  const cancelled = cancelledTasks.length;
  agentReplies.push({ task_status: "running" });
  const pending = run({ signal: controller.signal, onCheckpoint: (value) => { checkpoint = structuredClone(value); } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(submittedInputs.length, offset + 1);
  assert.equal(checkpoint.state.pendingModelTaskId, submittedInputs[offset].clientTaskId);
  controller.abort("canvas-detached");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelledTasks.length, cancelled);
  agentReplies.push("已接回原对话");
  const restored = await run({ resume: true, initialState: checkpoint.state, protocolMessages: checkpoint.protocolMessages });
  assert.equal(submittedInputs[offset + 1].clientTaskId, submittedInputs[offset].clientTaskId);
  assert.equal(restored.state.pendingModelTaskId, undefined);
  assert.equal(restored.protocolMessages.filter((message) => message.role === "user").length, 1);
});

test("detaching before submission acknowledgement does not cancel the acknowledged task", async () => {
  let acknowledge;
  const controller = new AbortController();
  const cancelled = cancelledTasks.length;
  submitOverride = () => new Promise((resolve) => { acknowledge = resolve; });
  try {
    const pending = requestCanvasAgentTurn({ model: "gpt-5", relayTokenName: "text-key", prompt: "plan", systemPrompt: "plan", messages: [], tools: [], signal: controller.signal });
    controller.abort("canvas-detached");
    acknowledge({ id: "persisted-during-refresh" });
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(cancelledTasks.length, cancelled);
  } finally { submitOverride = undefined; }
});

test("a running media checkpoint restores its original node without repeating creation", async () => {
  const controller = new AbortController();
  let checkpoint;
  let persisted;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  agentReplies.push(toolReply([{ id: "image-call", name: "generate_image", arguments: { prompt: "A red cup", title: "Cup", size: "1:1", count: 1, sourceNodeIds: [] } }]));
  const pending = run({
    signal: controller.signal,
    getContext: (state) => ({ ...context(state), generation: { ...context(state).generation, autoGenerateMedia: true } }),
    onCheckpoint: (value) => { checkpoint = structuredClone(value); },
    persist: async () => { persisted = structuredClone(checkpoint); },
    executeAction: async (action, progress) => {
      assert.equal(action.name, "generate_image");
      progress({ ok: true, submitted: true, nodeId: "original-image", taskId: "original-task", status: "loading" });
      persisted = structuredClone(checkpoint);
      started();
      return new Promise(() => {});
    },
  });
  await ready;
  assert.equal(persisted.state.pendingModelTaskId, undefined);
  assert.deepEqual(persisted.state.pendingTaskIds, ["original-task"]);
  controller.abort("canvas-detached");
  await assert.rejects(pending, { name: "AbortError" });
  const executed = [];
  agentReplies.push("已读取原节点结果");
  const restored = await run({ resume: true, initialState: persisted.state, protocolMessages: persisted.protocolMessages,
    getContext: (state) => ({ ...context(state), generation: { ...context(state).generation, autoGenerateMedia: true } }),
    executeAction: async (action) => { executed.push(action); return { ok: true, submitted: true, nodeId: "original-image", taskId: "original-task", status: "success" }; },
  });
  assert.deepEqual(executed.map((action) => [action.name, action.arguments.nodeId]), [["generate_node", "original-image"]]);
  assert.deepEqual(restored.state.pendingTaskIds, []);
  assert.deepEqual(restored.state.completedTaskIds, ["original-task"]);
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

test("execution trace preserves commentary and reports actual tool progress before completion", async () => {
  const trace = [];
  let savedProgress = false;
  agentReplies.push(toolReply([{ id: "trace-image", name: "generate_image", arguments: { title: "杯子", prompt: "红色杯子", size: "1:1", count: 1, sourceNodeIds: [] } }], "我先创建图片节点，再等待生成结果。"), "图片已完成。");
  const result = await run({
    onTrace: (entry) => trace.push(structuredClone(entry)),
    onCheckpoint: () => { savedProgress = trace.some((entry) => entry.type === "operation" && entry.nodeId === "cup"); },
    executeAction: async (_action, onProgress) => {
      assert.equal(trace[0].type, "text");
      assert.equal(trace.at(-1).status, "running");
      onProgress({ ok: true, nodeId: "cup", taskId: "cup-task", status: "running", submitted: true });
      assert.equal(savedProgress, true);
      assert.equal(trace.at(-1).label, "图片节点已创建");
      return { ok: true, nodeId: "cup", taskId: "cup-task", status: "success", submitted: true };
    },
  });
  assert.equal(trace.at(-1).status, "success");
  assert.equal(new Set(trace.filter((entry) => entry.type === "operation").map((entry) => entry.id)).size, 1);
  assert.equal(trace[0].text, "我先创建图片节点，再等待生成结果。");
  assert.equal(result.reply, "图片已完成。");
});

test("execution trace records failed operations without claiming success", async () => {
  const trace = [];
  agentReplies.push(toolReply([{ id: "trace-failed", name: "get_canvas_summary", arguments: {} }]), "读取失败。");
  await run({ onTrace: (entry) => trace.push(entry), executeAction: async () => { throw new Error("读取服务暂不可用"); } });
  assert.equal(trace.at(-1).status, "error");
  assert.match(trace.at(-1).detail, /读取服务暂不可用/);
});
