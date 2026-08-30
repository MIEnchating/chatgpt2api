import { describe, expect, test } from "bun:test";

import {
  generationFrameAspectRatio,
  mediaAspectRatio,
  videoFrameMaxWidth,
} from "../src/lib/generation-frame-aspect.ts";

describe("generation result frame aspect ratio", () => {
  test("uses selected image dimensions for loading placeholders", () => {
    expect(generationFrameAspectRatio({ mode: "generate", size: "2048x1152" })).toBe("2048 / 1152");
    expect(generationFrameAspectRatio({
      mode: "generate",
      size: "auto",
      sizeSelection: { mode: "ratio", aspectRatio: "9:16" },
    })).toBe("9 / 16");
    expect(generationFrameAspectRatio({
      mode: "generate",
      size: "auto",
      sizeSelection: { mode: "custom", customWidth: "1200", customHeight: "1500" },
    })).toBe("1200 / 1500");
  });

  test("uses selected video ratio and keeps automatic fallbacks stable", () => {
    expect(generationFrameAspectRatio({ mode: "video", size: "720x1280" })).toBe("720 / 1280");
    expect(generationFrameAspectRatio({ mode: "video", size: "9:16" })).toBe("9 / 16");
    expect(generationFrameAspectRatio({ mode: "video", size: "adaptive" })).toBe("16 / 9");
    expect(generationFrameAspectRatio({ mode: "generate", size: "auto" })).toBe("1 / 1");
  });

  test("rejects invalid dimensions and keeps portrait video frames readable", () => {
    expect(mediaAspectRatio("0x720", "16 / 9")).toBe("16 / 9");
    expect(videoFrameMaxWidth("9 / 16")).toBe("420px");
    expect(videoFrameMaxWidth("1 / 1")).toBe("640px");
    expect(videoFrameMaxWidth("16 / 9")).toBe("960px");
  });
});
