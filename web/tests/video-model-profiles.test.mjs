import assert from "node:assert/strict";
import test from "node:test";
import document from "../../docs/examples/dramaya-grok-video-contract.json" with { type: "json" };
import { activeVideoModelContracts, installVideoModelContracts, videoModelContract, resolveVideoModelContract } from "../src/lib/video-model-contracts.ts";
import { videoResolutionOptions, videoWorkbenchRatioForSize } from "../src/lib/video-model-capabilities.ts";
import { normalizeVideoRequest } from "../src/lib/video-request-normalizer.ts";

test("one Dramaya contract exposes independent Grok model capabilities", () => {
  const previous = activeVideoModelContracts();
  try {
    installVideoModelContracts([document.contracts[0].contract]);
    assert.equal(activeVideoModelContracts().length, 1);
    assert.deepEqual(videoResolutionOptions("grok-imagine-video"), ["480p", "720p"]);
    assert.deepEqual(videoResolutionOptions("grok-imagine-video-1.5"), ["480p", "720p", "1080p"]);
    assert.equal(videoModelContract("grok-imagine-video").capability.references.image, 0);
    assert.equal(videoModelContract("grok-imagine-video-1.5").capability.references.image, 1);
    const options = { referenceMode: "reference", referenceImageURLs: ["https://media.example/image.png"] };
    assert.throws(() => normalizeVideoRequest({ model: "grok-imagine-video", ...options }), /不支持|不能使用|最多/);
    const request = normalizeVideoRequest({ model: "grok-imagine-video-1.5", resolution: "1080p", ...options });
    assert.equal(request.resolution, "1080p");
    assert.equal(request.seconds, 8);
    assert.throws(() => normalizeVideoRequest({ model: "grok-imagine-video-1.5", ...options, referenceImageURLs: [...options.referenceImageURLs, "https://media.example/second.png"] }), /最多/);
    const exposed = videoModelContract("grok-imagine-video-1.5");
    exposed.capability.resolutions.push("4K");
    exposed.generation.modes[0].label = "mutated";
    assert.equal(videoModelContract("grok-imagine-video-1.5").capability.resolutions.includes("4K"), false);
    assert.equal(videoModelContract("grok-imagine-video-1.5").generation.modes[0].label, "文生视频");
  } finally {
    installVideoModelContracts(previous);
  }
});

test("model profiles replace complete capabilities and preserve the shared protocol", () => {
  const contract = structuredClone(document.contracts[0].contract);
  const resolved = resolveVideoModelContract(contract, " GROK-IMAGINE-VIDEO-1.5 ");
  assert.deepEqual(resolved.request, contract.request);
  assert.deepEqual(resolved.polling, contract.polling);
  assert.equal(resolved.model_profiles, undefined);
  assert.deepEqual(resolved.capability, contract.model_profiles[1].capability);
  assert.equal(contract.model_profiles.length, 2);
});

test("video ratio labels preserve all declared Grok ratios", () => {
  for (const ratio of document.contracts[0].contract.capability.sizes) assert.equal(videoWorkbenchRatioForSize(ratio), ratio);
});
