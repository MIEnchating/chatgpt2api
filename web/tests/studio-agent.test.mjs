import { test, expect } from "bun:test";
import { conversationComposerMode, normalizeStudioAgent, studioAgentTurnResult } from "../src/lib/studio-agent.ts";

test("each conversation restores its own media choice including empty conversations", () => {
  expect(conversationComposerMode({ composerMode: "video", turns: [{ mode: "generate" }] })).toBe("video");
  expect(conversationComposerMode({ composerMode: "image", turns: [{ mode: "video" }] })).toBe("image");
  expect(conversationComposerMode({ composerMode: "video", turns: [] })).toBe("video");
  expect(conversationComposerMode({ turns: [{ mode: "video" }] })).toBe("video");
  expect(conversationComposerMode(null)).toBe("image");
});

test("Agent execution identity survives persistence without introducing credential fields", () => {
  expect(normalizeStudioAgent({ runId: "run", model: "text", tokenName: "key", apiKey: "private" })).toEqual({ runId: "run", model: "text", tokenName: "key" });
  expect(normalizeStudioAgent({ model: "text" })).toBeUndefined();
});

test("Agent video parameters preserve explicit false and task outputs retain their IDs", () => {
  const turn = { id: "turn", mode: "video", videoGenerateAudio: true, videoWatermark: true, size: "9:16", count: 1 };
  const image = { id: "image", taskId: "paid-task", status: "success", videoUrl: "https://example.test/result.mp4" };
  const next = studioAgentTurnResult(turn, { settings: { size: "16:9", seconds: 8, generate_audio: false, watermark: false }, tasks: [], text: "完成" }, [image]);
  expect(next.size).toBe("16:9"); expect(next.videoSeconds).toBe(8);
  expect(next.videoGenerateAudio).toBe(false); expect(next.videoWatermark).toBe(false);
  expect(next.images[0]).toEqual(image); expect(next.images[1].text_response).toBe("完成");
  expect(next.status).toBe("success");
});

test("a conversational answer can complete without submitting paid media", () => {
  const next = studioAgentTurnResult({ id: "turn", mode: "generate" }, { settings: {}, tasks: [], text: "建议用横版" }, []);
  expect(next.status).toBe("message"); expect(next.images).toHaveLength(1);
});


test("result parameters come from the actual submission rather than later unused edits", () => {
  const turn = { id: "turn", mode: "generate", size: "1024x1024", sizeSelection: { mode: "auto" }, quality: "low", outputFormat: "png" };
  const result = { settings: { size: "1024x1024", quality: "low" }, tasks: [{ id: "paid", settings: { size: "1536x1024", quality: "high", output_format: "jpeg", output_compression: 0 } }], text: "完成" };
  const next = studioAgentTurnResult(turn, result, [{ id: "image", taskId: "paid", status: "success" }]);
  expect(next.size).toBe("1536x1024"); expect(next.sizeSelection).toBeUndefined();
  expect(next.quality).toBe("high"); expect(next.outputFormat).toBe("jpeg"); expect(next.outputCompression).toBe(0);
});
