import assert from "node:assert/strict";
import test from "node:test";
import { imageModelRoute, imageOutputCountLimit, imageReferenceImageLimit, supportsImageExactDimensions, supportsStructuredImageParameters, supportsImageQualityValue } from "../src/lib/image-model-capabilities.ts";
import { imageWorkbenchReferenceImageLimit, imageWorkbenchQualityOptions } from "../src/lib/image-options.ts";
import { imageGenerationRequestOptions, imageOutputSupportsStreaming, normalizeImageGenerationOptions } from "../src/lib/image-generation-options.ts";

test("GPT Image 2.6 models expose the Images contract", () => {
  for (const model of ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]) {
    assert.equal(imageModelRoute(model), "openai-image");
    assert.equal(imageOutputCountLimit(model), 10);
    assert.equal(imageReferenceImageLimit(model), 16);
    assert.equal(imageWorkbenchReferenceImageLimit(model), 16);
    assert.equal(supportsImageQualityValue(model, "xhigh"), true);
    assert.equal(supportsImageQualityValue(model, "max"), true);
    assert.equal(imageWorkbenchQualityOptions(model).some((option) => option.value === "max"), true);
    assert.equal(supportsImageExactDimensions(model), true);
    assert.equal(supportsStructuredImageParameters(model), true);
    const options = { complexity: "low", frame_count: 9, frame_duration_ms: 200 };
    assert.deepEqual(imageGenerationRequestOptions(model, "gif", options, false), options);
    assert.deepEqual(imageGenerationRequestOptions(model, "png", options, false), { complexity: "low" });
    assert.throws(() => imageGenerationRequestOptions(model, "gif", options, true));
    assert.throws(() => imageGenerationRequestOptions(model, "jpeg", { background: "transparent" }, false));
    assert.throws(() => imageGenerationRequestOptions(model, "png", { markup: "data:image/png;base64,aA==" }, false));
  }
  assert.equal(supportsImageQualityValue("gpt-image-2", "max"), false);
  assert.equal(imageOutputSupportsStreaming("gif"), false);
  assert.equal(imageOutputSupportsStreaming("svg"), false);
  assert.equal(imageOutputSupportsStreaming("png"), true);
  assert.throws(() => imageGenerationRequestOptions("gpt-image-2", "svg", {}, false));
});

test("saved options retain supported values without carrying arbitrary fields", () => {
  assert.deepEqual(normalizeImageGenerationOptions({ complexity: "medium", background: "transparent", injected: "x", frame_count: 17, frame_duration_ms: 0, markup: "https://example.com/private" }), { complexity: "medium", background: "transparent" });
});
