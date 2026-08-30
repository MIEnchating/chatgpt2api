import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERRUPTED_CANVAS_GENERATION_ERROR,
  PENDING_CANVAS_GENERATION_RECOVERY_ERROR,
  buildCanvasGenerationContext,
  buildCanvasImageReferencePrompt,
  canvasGenerationCount,
  canvasGenerationModel,
  canvasGenerationNeedsRecovery,
  canvasGenerationRecoveryTaskID,
  canvasGenerationReferenceImageURLs,
  canvasGenerationRequestSize,
  canvasURLIsStaleBlob,
  canvasVideoGenerationReferences,
  findCanvasRetryConfigurationNode,
  markCanvasGenerationRecoveryPending,
  restoreInterruptedCanvasGenerations,
} from "../src/app/canvas/canvas-generation-context.ts";

function node(id, type, values = {}) {
  return { id, type, x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, ...values };
}

test("reference image prompts use the same numbered labels as the canvas", () => {
  assert.equal(buildCanvasImageReferencePrompt("  让图片1参考图片2的配色  ", 2), "参考图片编号：图片1、图片2。请按这些编号理解提示词中的图片引用。\n\n让图片1参考图片2的配色");
  assert.equal(buildCanvasImageReferencePrompt("  原始提示词  ", 0), "原始提示词");
  assert.equal(buildCanvasImageReferencePrompt("", 1), "参考图片编号：图片1。请按这些编号理解提示词中的图片引用。\n\n");
});

test("video frame bindings become ordinary image references when named frames are unsupported", () => {
  const context = {
    referenceImageURLs: ["https://cdn.example.com/reference.png"],
    firstFrameURL: "https://cdn.example.com/first.png",
    lastFrameURL: "https://cdn.example.com/last.png",
  };
  assert.deepEqual(canvasVideoGenerationReferences(context, ["https://cdn.example.com/configured.png"], true), {
    referenceImageURLs: ["https://cdn.example.com/configured.png", "https://cdn.example.com/reference.png"],
    firstFrameURL: "https://cdn.example.com/first.png",
    lastFrameURL: "https://cdn.example.com/last.png",
  });
  assert.deepEqual(canvasVideoGenerationReferences(context, ["https://cdn.example.com/reference.png"], false), {
    referenceImageURLs: [
      "https://cdn.example.com/reference.png",
      "https://cdn.example.com/first.png",
      "https://cdn.example.com/last.png",
    ],
    firstFrameURL: "",
    lastFrameURL: "",
  });
});

test("tool-specific and retry generation force a single output", () => {
  assert.equal(canvasGenerationCount("gpt-image-2", 10, undefined, false), 10);
  assert.equal(canvasGenerationCount("gpt-image-2", 10, 1, false), 1);
  assert.equal(canvasGenerationCount("gpt-image-2", 10, 8, true), 1);
  assert.equal(canvasGenerationCount("gemini-3.1-flash-image", 20, undefined, false), 15);
});

test("canvas retries retain the model that created the failed node", () => {
  const failed = node("failed", "image", { generation_model: "gemini-3.1-flash-image" });
  const legacy = node("legacy", "image");
  const configuration = node("config", "config", { generation_model: "gpt-image-2" });

  assert.equal(canvasGenerationModel("grok-imagine-image", failed, null, true), "gemini-3.1-flash-image");
  assert.equal(canvasGenerationModel("grok-imagine-image", legacy, configuration, true), "gpt-image-2");
  assert.equal(canvasGenerationModel("grok-imagine-image", failed, null, false), "gemini-3.1-flash-image");
  assert.equal(canvasGenerationModel("grok-imagine-image", legacy, null, false), "grok-imagine-image");
});

test("canvas generation preserves the shared reference-project size contract", () => {
  assert.equal(canvasGenerationRequestSize("gemini-3.1-flash-image", "1:8", "4k"), "1:8");
  assert.equal(canvasGenerationRequestSize("gemini-3.1-flash-lite-image", "1:8", "auto"), "1:8");
  assert.equal(canvasGenerationRequestSize("gpt-image-2", "1:8", "4k"), "1:8");
  assert.equal(canvasGenerationRequestSize("grok-imagine-image", "16:9", "auto"), "16:9");
  assert.equal(canvasGenerationRequestSize("gpt-image-2", "1024x768", "auto"), "1024x768");
  assert.equal(canvasGenerationRequestSize("codex-gpt-image-2", "1024x768", "auto"), "1024x768");
});

test("generation context appends direct upstream text in connection order", () => {
  const nodes = [
    node("target", "image"),
    node("first", "text", { prompt: "第一段" }),
    node("second", "text", { prompt: "第二段" }),
    node("indirect", "text", { prompt: "不应读取" }),
  ];
  const connections = [
    { id: "first-target", from_node_id: "first", to_node_id: "target" },
    { id: "second-target", from_node_id: "second", to_node_id: "target" },
    { id: "indirect-first", from_node_id: "indirect", to_node_id: "first" },
  ];

  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "当前提示词"), {
    prompt: "当前提示词\n\n第一段\n\n第二段",
    referenceImageURLs: [],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 2,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
  });
});

test("generation context collects direct upstream images and ignores their prompts", () => {
  const nodes = [
    node("target", "image"),
    node("image-a", "image", { url: "/images/a.png", prompt: "图片自身提示词" }),
    node("image-b", "image", { url: "/images/b.png" }),
  ];
  const connections = [
    { id: "a-target", from_node_id: "image-a", to_node_id: "target" },
    { id: "b-target", from_node_id: "image-b", to_node_id: "target" },
  ];

  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "修改图片"), {
    prompt: "修改图片",
    referenceImageURLs: ["/images/a.png", "/images/b.png"],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 0,
    imageCount: 2,
    videoCount: 0,
    audioCount: 0,
  });
});

test("blank upstream image nodes are not coerced into text inputs", () => {
  const nodes = [
    node("target", "image"),
    node("blank-image", "image", { prompt: "赛博朋克夜景" }),
  ];
  const connections = [{ id: "blank-target", from_node_id: "blank-image", to_node_id: "target" }];

  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "增加雨雾"), {
    prompt: "增加雨雾",
    referenceImageURLs: [],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 0,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
  });
});

test("generation context preserves the caller prompt without direct upstream inputs", () => {
  const nodes = [node("target", "image"), node("other", "text", { prompt: "无关内容" })];
  assert.deepEqual(buildCanvasGenerationContext("target", nodes, [], "  当前提示词  "), {
    prompt: "  当前提示词  ",
    referenceImageURLs: [],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 0,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
  });
});

test("plain configuration composer content preserves caller whitespace", () => {
  const nodes = [node("config", "config", { composer_content: "  保留空白  " })];
  assert.equal(buildCanvasGenerationContext("config", nodes, [], "  保留空白  ").prompt, "  保留空白  ");
});

test("a blank generation node can use connected text without duplicating it", () => {
  const nodes = [node("idea", "text", { prompt: "一只白猫" }), node("target", "image", { prompt: "" })];
  const connections = [{ id: "idea-target", from_node_id: "idea", to_node_id: "target" }];
  assert.equal(buildCanvasGenerationContext("target", nodes, connections, "").prompt, "\n\n一只白猫");
});

test("a generation configuration combines connected text with additional instructions and keeps image inputs", () => {
  const nodes = [
    node("config", "config", { prompt: "补充柔和光线" }),
    node("idea", "text", { prompt: "一只白猫" }),
    node("reference", "image", { url: "/images/reference.png" }),
  ];
  const connections = [
    { id: "idea-config", from_node_id: "idea", to_node_id: "config" },
    { id: "reference-config", from_node_id: "reference", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, "补充柔和光线"), {
    prompt: "补充柔和光线\n\n一只白猫",
    referenceImageURLs: ["/images/reference.png"],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 1,
    imageCount: 1,
    videoCount: 0,
    audioCount: 0,
  });
});

test("a node connected to a configuration uses the configuration's other inputs", () => {
  const nodes = [
    node("source", "image", { url: "/images/source.png" }),
    node("config", "config"),
    node("idea", "text", { prompt: "保留暖色调" }),
    node("reference", "image", { url: "/images/reference.png" }),
    node("direct", "text", { prompt: "不应读取自己的直接上游" }),
  ];
  const connections = [
    { id: "direct-source", from_node_id: "direct", to_node_id: "source" },
    { id: "source-config", from_node_id: "source", to_node_id: "config" },
    { id: "idea-config", from_node_id: "idea", to_node_id: "config" },
    { id: "reference-config", from_node_id: "reference", to_node_id: "config" },
  ];

  assert.deepEqual(buildCanvasGenerationContext("source", nodes, connections, "修改主体"), {
    prompt: "修改主体\n\n保留暖色调",
    referenceImageURLs: ["/images/reference.png"],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 1,
    imageCount: 1,
    videoCount: 0,
    audioCount: 0,
  });
});

test("explicit configuration references select connected text and media", () => {
  const nodes = [
    node("config", "config", { composer_content: "让 @[node:image-b] 参考 @[node:text-a]" }),
    node("text-a", "text", { prompt: "保留主体" }),
    node("image-a", "image", { url: "/images/a.png" }),
    node("image-b", "image", { url: "/images/b.png" }),
  ];
  const connections = [
    { id: "a-config", from_node_id: "image-a", to_node_id: "config" },
    { id: "text-config", from_node_id: "text-a", to_node_id: "config" },
    { id: "b-config", from_node_id: "image-b", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, "让 @[node:image-b] 参考 @[node:text-a]"), {
    prompt: "让 图片1 参考 【文本1】\n\n【文本1】\n保留主体",
    referenceImageURLs: ["/images/b.png"],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 1,
    imageCount: 1,
    videoCount: 0,
    audioCount: 0,
  });
});

test("plain composer content uses only explicitly referenced connected resources", () => {
  const nodes = [
    node("config", "config", { composer_content: "只生成一张极简海报" }),
    node("image", "image", { url: "/images/reference.png" }),
    node("text", "text", { prompt: "来自文字节点" }),
  ];
  const connections = [
    { id: "image-config", from_node_id: "image", to_node_id: "config" },
    { id: "text-config", from_node_id: "text", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, "只生成一张极简海报"), {
    prompt: "只生成一张极简海报",
    referenceImageURLs: [],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 0,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
  });
});

test("an explicitly cleared composer does not restore deleted connected resources", () => {
  const nodes = [
    node("config", "config", { composer_content: "" }),
    node("image", "image", { url: "/images/reference.png" }),
    node("text", "text", { prompt: "来自文字节点" }),
  ];
  const connections = [
    { id: "image-config", from_node_id: "image", to_node_id: "config" },
    { id: "text-config", from_node_id: "text", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, ""), {
    prompt: "",
    referenceImageURLs: [],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: [],
    referenceAudioURLs: [],
    textCount: 0,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
  });
});

test("a populated source image replaces upstream image references", () => {
  assert.deepEqual(canvasGenerationReferenceImageURLs(node("target", "image", { url: "/images/source.png" }), ["/images/upstream-a.png", "/images/upstream-b.png"], 4), ["/images/source.png"]);
  assert.deepEqual(canvasGenerationReferenceImageURLs(node("target", "image"), ["a", "b", "c"], 2), ["a", "b"]);
});

test("generation context collects connected video and audio references in connection order", () => {
  const nodes = [
    node("target", "video"),
    node("direct", "video", { url: "https://cdn.example.com/direct.mp4" }),
    node("voice", "audio", { url: "https://cdn.example.com/voice.mp3" }),
  ];
  const connections = [
    { id: "direct-target", from_node_id: "direct", to_node_id: "target" },
    { id: "voice-target", from_node_id: "voice", to_node_id: "target" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "镜头平移"), {
    prompt: "镜头平移",
    referenceImageURLs: [],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: ["https://cdn.example.com/direct.mp4"],
    referenceAudioURLs: ["https://cdn.example.com/voice.mp3"],
    textCount: 0,
    imageCount: 0,
    videoCount: 1,
    audioCount: 1,
  });
});

test("configuration references select only explicitly mentioned video and audio inputs", () => {
  const nodes = [
    node("config", "config", { composer_content: "让 @[node:video-b] 跟随 @[node:audio-a]" }),
    node("video-a", "video", { url: "https://cdn.example.com/a.mp4" }),
    node("video-b", "video", { url: "https://cdn.example.com/b.mp4" }),
    node("audio-a", "audio", { url: "https://cdn.example.com/a.mp3" }),
    node("audio-b", "audio", { url: "https://cdn.example.com/b.mp3" }),
  ];
  const connections = [
    { id: "video-a-config", from_node_id: "video-a", to_node_id: "config" },
    { id: "audio-b-config", from_node_id: "audio-b", to_node_id: "config" },
    { id: "video-b-config", from_node_id: "video-b", to_node_id: "config" },
    { id: "audio-a-config", from_node_id: "audio-a", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, nodes[0].composer_content), {
    prompt: "让 视频1 跟随 音频1",
    referenceImageURLs: [],
    firstFrameURL: null,
    lastFrameURL: null,
    referenceVideoURLs: ["https://cdn.example.com/b.mp4"],
    referenceAudioURLs: ["https://cdn.example.com/a.mp3"],
    textCount: 0,
    imageCount: 0,
    videoCount: 1,
    audioCount: 1,
  });
});

test("a video node connected to a configuration uses the configuration's other media inputs", () => {
  const nodes = [
    node("source", "video"),
    node("config", "config"),
    node("reference-video", "video", { url: "https://cdn.example.com/reference.mp4" }),
    node("reference-audio", "audio", { url: "https://cdn.example.com/reference.mp3" }),
  ];
  const connections = [
    { id: "source-config", from_node_id: "source", to_node_id: "config" },
    { id: "video-config", from_node_id: "reference-video", to_node_id: "config" },
    { id: "audio-config", from_node_id: "reference-audio", to_node_id: "config" },
  ];
  const context = buildCanvasGenerationContext("source", nodes, connections, "延续动作");
  assert.deepEqual(context.referenceVideoURLs, ["https://cdn.example.com/reference.mp4"]);
  assert.deepEqual(context.referenceAudioURLs, ["https://cdn.example.com/reference.mp3"]);
});

test("video node bindings resolve frames and generic connected resources", () => {
  const nodes = [
    node("target", "video", {
      generation_video_first_frame_node_id: "first",
      generation_video_last_frame_node_id: "last",
    }),
    node("first", "image", { url: "/images/first.png" }),
    node("last", "image", { url: "/images/last.png" }),
    node("character", "image", { url: "/images/character.png" }),
    node("ordinary", "image", { url: "/images/ordinary.png" }),
    node("shot", "text", { prompt: "镜头缓慢推进" }),
    node("ordinary-text", "text", { prompt: "电影光影" }),
    node("element-image", "image", { url: "/images/element.png" }),
    node("element-video", "video", { url: "/videos/element.mp4" }),
    node("element-audio", "audio", { url: "/audios/element.mp3" }),
  ];
  const connections = nodes.slice(1).map((input) => ({ id: `${input.id}-target`, from_node_id: input.id, to_node_id: "target" }));
  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "主提示词"), {
    prompt: "主提示词\n\n镜头缓慢推进\n\n电影光影",
    referenceImageURLs: ["/images/character.png", "/images/ordinary.png", "/images/element.png"],
    firstFrameURL: "/images/first.png",
    lastFrameURL: "/images/last.png",
    referenceVideoURLs: ["/videos/element.mp4"],
    referenceAudioURLs: ["/audios/element.mp3"],
    textCount: 2,
    imageCount: 5,
    videoCount: 1,
    audioCount: 1,
  });
});

test("exclude-upstream-text keeps connected text out of the prompt without hiding its count", () => {
  const nodes = [
    node("target", "video", { exclude_upstream_text: true }),
    node("text", "text", { prompt: "不拼接" }),
  ];
  const connections = [{ id: "text-target", from_node_id: "text", to_node_id: "target" }];
  const context = buildCanvasGenerationContext("target", nodes, connections, "主提示词");
  assert.equal(context.prompt, "主提示词");
  assert.equal(context.textCount, 1);
});

test("loading nodes become retryable after the canvas reloads", () => {
  const loading = node("loading", "image", { generation_status: "loading" });
  const success = node("success", "image", { generation_status: "success" });
  assert.deepEqual(restoreInterruptedCanvasGenerations([loading, success]), [
    { ...loading, generation_status: "error", generation_error: INTERRUPTED_CANVAS_GENERATION_ERROR },
    success,
  ]);
});

test("temporary synchronization failures remain recoverable without overwriting completed images", () => {
  const loading = node("loading", "image", { task_id: "task-1", generation_status: "loading" });
  const completed = node("completed", "image", { task_id: "task-1", generation_status: "success", url: "/images/final.png" });
  const unrelated = node("unrelated", "image", { task_id: "task-2", generation_status: "loading" });
  const pending = markCanvasGenerationRecoveryPending([loading, completed, unrelated], "task-1");

  assert.deepEqual(pending, [
    { ...loading, generation_status: "error", generation_error: PENDING_CANVAS_GENERATION_RECOVERY_ERROR },
    completed,
    unrelated,
  ]);
  assert.equal(canvasGenerationNeedsRecovery(pending[0]), true);
  assert.equal(canvasGenerationNeedsRecovery(pending[1]), false);
  assert.equal(canvasGenerationNeedsRecovery({ ...loading, generation_status: "error", generation_error: "上游拒绝请求" }), false);
});

test("successful nodes with serialized blob URLs recover their durable task output", () => {
  const stale = node("stale", "image", { task_id: "task-image", generation_status: "success", url: "blob:http://example.test/expired" });
  const durable = { ...stale, url: "/images/final.png" };
  assert.equal(canvasURLIsStaleBlob(stale.url), true);
  assert.equal(canvasGenerationNeedsRecovery(stale), true);
  assert.equal(canvasGenerationNeedsRecovery(durable), false);
});

test("audio task metadata participates in reload recovery", () => {
  const audio = node("audio", "audio", { audio_task_id: "audio-task", generation_status: "loading" });
  assert.equal(canvasGenerationRecoveryTaskID(audio), "audio-task");
  assert.equal(canvasGenerationNeedsRecovery(audio), true);
  assert.equal(markCanvasGenerationRecoveryPending([audio], "audio-task")[0].generation_error, PENDING_CANVAS_GENERATION_RECOVERY_ERROR);
});

test("retry fallback finds the nearest upstream generation configuration", () => {
  const nodes = [node("config", "config"), node("root", "image"), node("child", "image")];
  const connections = [
    { id: "config-root", from_node_id: "config", to_node_id: "root" },
    { id: "root-child", from_node_id: "root", to_node_id: "child" },
  ];
  assert.equal(findCanvasRetryConfigurationNode("child", nodes, connections)?.id, "config");
  assert.equal(findCanvasRetryConfigurationNode("config", nodes, connections), null);
});
