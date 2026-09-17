import assert from "node:assert/strict";
import test from "node:test";
import { imageAdapterDefaults, installImageModelDefinitions } from "../src/lib/image-model-definitions.ts";
import {
  imageModelRoute, imageReferenceImageLimit, imageOutputCountLimit,
  supportsImageResolution, supportsImageAspectRatio, supportsImageQualityValue,
  supportsImageMask, supportsImageStreaming, supportsImageExactDimensions, supportsImageEditing,
} from "../src/lib/image-model-capabilities.ts";

test("configured protocols and capabilities apply to arbitrary aliases and override built-in names", () => {
  try {
    for (const protocol of ["google-gemini-image", "xai-image", "openai-image"]) {
      const definition = { ...imageAdapterDefaults(protocol), aspect_ratios: ["7:3"], resolutions: ["4k"], max_reference_images: 7, max_output_count: 3, quality_values: [], streaming: false };
      installImageModelDefinitions({ "custom-alias": definition, "gemini-3.1-flash-image": definition, "nano-banana-pro": definition });
      for (const name of ["custom-alias", "gemini-3.1-flash-image", "nano-banana-pro"]) {
        assert.equal(imageModelRoute(name), protocol);
        assert.equal(imageReferenceImageLimit(name), 7);
        assert.equal(imageOutputCountLimit(name), 3);
        assert.equal(supportsImageAspectRatio(name, "7:3"), true);
        assert.equal(supportsImageAspectRatio(name, "1:1"), false);
        assert.equal(supportsImageResolution(name, "4k"), true);
        assert.equal(supportsImageResolution(name, "2k"), false);
        assert.equal(supportsImageResolution(name, "auto"), true);
        assert.equal(supportsImageQualityValue(name, "high"), false);
        assert.equal(supportsImageStreaming(name), false);
        assert.equal(supportsImageMask(name), protocol === "openai-image");
        assert.equal(supportsImageExactDimensions(name), protocol === "openai-image");
        assert.equal(supportsImageEditing(name), true);
      }
    }
  } finally { installImageModelDefinitions(); }
  assert.equal(imageModelRoute("custom-alias"), "openai-image");
  assert.equal(imageModelRoute("gemini-3.1-flash-image"), "google-gemini-image");
});
