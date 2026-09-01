import { describe, expect, test } from "bun:test";

import {
  imageTurnReferenceValidationError,
  imageTurnUsesReferenceImages,
} from "../src/lib/image-turn-validation.ts";

function turn(mode, referenceCount) {
  return {
    mode,
    referenceImages: Array.from({ length: referenceCount }, (_, index) => ({
      name: `reference-${index}.png`,
      type: "image/png",
      dataUrl: `data:image/png;base64,${index}`,
    })),
  };
}

describe("image turn reference validation", () => {
  test("generation and video turns do not require image references", () => {
    expect(imageTurnUsesReferenceImages("generate")).toBe(false);
    expect(imageTurnUsesReferenceImages("video")).toBe(false);
    expect(imageTurnReferenceValidationError(turn("generate", 0))).toBe("");
    expect(imageTurnReferenceValidationError(turn("video", 0))).toBe("");
  });

  test("reference modes reject a missing reference", () => {
    expect(imageTurnUsesReferenceImages("image")).toBe(true);
    expect(imageTurnUsesReferenceImages("edit")).toBe(true);
    expect(imageTurnReferenceValidationError(turn("image", 0)))
      .toBe("未找到可用的参考图");
  });

  test("reference modes preserve the current unrestricted workbench contract", () => {
    expect(imageTurnReferenceValidationError(turn("image", 1))).toBe("");
    expect(imageTurnReferenceValidationError(turn("edit", 11))).toBe("");
  });
});
