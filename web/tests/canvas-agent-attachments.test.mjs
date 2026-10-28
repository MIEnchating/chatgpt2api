import assert from "node:assert/strict";
import { test } from "bun:test";
import { canvasAgentAttachment, canvasAgentSessionAttachments, hydrateCanvasAgentAttachment, uploadCanvasAgentAttachment } from "../src/app/canvas/agent/canvas-agent-attachments.ts";
import { canvasAgentAttachmentURLs } from "../src/app/canvas/agent/canvas-agent-reference.ts";
import { normalizeCanvasAgentAction } from "../src/app/canvas/agent/canvas-agent-tools.ts";
import { canvasGenerationReferenceImageURLs } from "../src/app/canvas/canvas-generation-context.ts";

test("asset selection produces a message attachment with durable storage, not a canvas node", () => {
  const attachment = canvasAgentAttachment({ kind: "image", title: "product.png", dataUrl: "/api/files/product/content", storageKey: "server:product", mimeType: "image/png" });
  assert.equal(attachment.source, "attachment");
  assert.equal(attachment.url, "/api/files/product/content");
  assert.equal(attachment.storageKey, "server:product");
  assert.equal(attachment.dataUrl, undefined);
  assert.equal(attachment.x, undefined);
  assert.notEqual(canvasAgentAttachment({ kind: "text", title: "brief", content: "hello" }).id, attachment.id);
});

test("unsupported and cancelled uploads do not reach storage", async () => {
  await assert.rejects(uploadCanvasAgentAttachment(new File(["text"], "file.txt", { type: "text/plain" }), new AbortController().signal), /请选择/);
  const controller = new AbortController();controller.abort();
  await assert.rejects(uploadCanvasAgentAttachment(new File([], "image.png", { type: "image/png" }), controller.signal), { name: "AbortError" });
  await assert.rejects(hydrateCanvasAgentAttachment({ id: "a", source: "attachment", type: "image", title: "image", url: "/image.png" }, controller.signal), { name: "AbortError" });
});

test("generation uses attachment URLs without adding source nodes and keeps references for manual generation", () => {
  const attachment = canvasAgentAttachment({ kind: "image", title: "image", dataUrl: "/uploaded.png" });
  const urls = canvasAgentAttachmentURLs([attachment, attachment, { id: "node", type: "image", title: "node", url: "/node.png" }], "image");
  assert.deepEqual(urls, ["/uploaded.png"]);
  assert.deepEqual(canvasGenerationReferenceImageURLs({ generation_reference_urls: urls }, ["/upstream.png"], 4), ["/upstream.png", "/uploaded.png"]);
  assert.deepEqual(canvasGenerationReferenceImageURLs({ url: "/result.png", generation_reference_urls: urls }, [], 4), ["/result.png"]);
});

test("image editing can reference attachments explicitly without fake source nodes", () => {
  const action = normalizeCanvasAgentAction("edit_image", { size: "1:1", count: 1, prompt: "Make it blue", sourceNodeIds: [], attachmentIds: ["attachment-product"] });
  assert.deepEqual(action.arguments.sourceNodeIds, []);
  assert.deepEqual(action.arguments.attachmentIds, ["attachment-product"]);
  assert.throws(() => normalizeCanvasAgentAction("edit_image", { size: "1:1", count: 1, prompt: "Make it blue", sourceNodeIds: [], attachmentIds: [] }), /缺少图片来源/);
  assert.throws(() => normalizeCanvasAgentAction("edit_image", { size: "1:1", count: 1, prompt: "Make it blue", sourceNodeIds: [], attachmentIds: "attachment-product" }), /attachmentIds/);
});

test("later turns can explicitly reuse earlier attachments with current metadata", () => {
  const first = canvasAgentAttachment({ kind: "image", title: "product", dataUrl: "/old-url", storageKey: "server:product" });
  const latest = { ...first, url: "/current-url" };
  const messages = [{ role: "user", references: [first, { id: "node", type: "image" }] }, { role: "assistant", references: [{ ...first, id: "invented" }] }];
  assert.deepEqual(canvasAgentSessionAttachments(messages, [latest]), [latest]);
  assert.deepEqual(canvasAgentAttachmentURLs(canvasAgentSessionAttachments(messages), "image"), ["/old-url"]);
  assert.deepEqual(canvasAgentSessionAttachments([]), []);
});
