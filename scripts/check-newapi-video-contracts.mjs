import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Run against a pinned, locally checked-out New API source tree. These hooks
// only construct requests; no credentials or paid upstream calls are used.
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/check-newapi-video-contracts.mjs /path/to/new-api");
const cases = JSON.parse(await readFile(new URL("../internal/httpapi/testdata/newapi-video-contract-cases.json", import.meta.url), "utf8"));
const modules = new Map();
for (const item of cases) {
  if (!modules.has(item.plugin)) {
    const source = await readFile(resolve(checkout, "plugins/tasks", item.plugin, "plugin.js"), "utf8");
    modules.set(item.plugin, await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`));
  }
  const plugin = modules.get(item.plugin);
  const ctx = { model: item.input.model, upstreamModel: item.upstream_model || item.input.model, body: { kind: "json", value: item.request } };
  assert.ok(plugin.meta.models.includes(ctx.upstreamModel), `Unknown plugin model: ${ctx.upstreamModel}`);
  const decoded = plugin.protocols.openai_video.decodeRequest(ctx);
  const outbound = plugin.buildSubmitRequest({
    model: ctx.model, upstreamModel: ctx.upstreamModel, action: decoded.action,
    requestBody: decoded.requestBody, baseUrl: "https://vendor.example", apiKey: "test-only",
  });
  assert.equal(outbound.body.model, ctx.upstreamModel);
  assert.equal(outbound.body.duration, item.input.seconds);
  assert.equal(outbound.body.resolution, item.input.resolution);
  assert.equal(outbound.body.generate_audio, item.input.generate_audio);
  if (item.plugin === "doubao") {
    assert.equal(outbound.body.ratio, item.input.size);
    assert.equal(outbound.body.watermark, item.input.watermark);
    assert.deepEqual(outbound.body.content, [
      ...(item.request.metadata.content || []), { type: "text", text: item.input.prompt },
    ]);
    assert.equal(outbound.body.reference_image_urls, undefined);
  } else {
    assert.equal(outbound.body.prompt, item.input.prompt);
    assert.equal(outbound.body.aspect_ratio, item.input.size);
    if (item.input.first_frame_url) assert.equal(outbound.body.image.url, item.input.first_frame_url);
    if (item.input.last_frame_url) assert.equal(outbound.body.last_frame.url, item.input.last_frame_url);
    if (item.input.reference_image_urls) assert.deepEqual(outbound.body.reference_images.map((image) => image.url), item.input.reference_image_urls);
  }
  console.log(`PASS ${item.name}`);
}
console.log(`Verified New API commit ${execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()}`);
