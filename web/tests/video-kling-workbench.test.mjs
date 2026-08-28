import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultVideoElementList,
  defaultVideoMultiPrompts,
  moveVideoElementReference,
  normalizeVideoElementList,
  normalizeVideoMultiPromptDuration,
  normalizeVideoMultiPrompts,
  videoElementListToRequest,
  videoMultiPromptsToRequest,
} from "../src/lib/video-kling-workbench.ts";

test("matches the reference Kling defaults", () => {
  assert.deepEqual(defaultVideoMultiPrompts(), [{ prompt: "", duration: "1" }]);
  assert.deepEqual(defaultVideoElementList(), [{ name: "", description: "", references: [] }]);
});

test("clamps structured shot durations to 1-15 seconds", () => {
  assert.equal(normalizeVideoMultiPromptDuration(""), "1");
  assert.equal(normalizeVideoMultiPromptDuration(-2), "1");
  assert.equal(normalizeVideoMultiPromptDuration(6.9), "6");
  assert.equal(normalizeVideoMultiPromptDuration(30), "15");
  assert.deepEqual(normalizeVideoMultiPrompts([{ prompt: "镜头一", duration: 3 }]), [{ prompt: "镜头一", duration: "3" }]);
  assert.deepEqual(videoMultiPromptsToRequest([{ prompt: "镜头一", duration: "3" }]), [{ prompt: "镜头一", duration: 3 }]);
});

test("limits Kling elements to three and references to four", () => {
  const references = Array.from({ length: 6 }, (_, index) => ({
    id: `ref-${index}`,
    kind: index === 4 ? "audio" : index === 3 ? "video" : "image",
    name: `素材 ${index}`,
    type: "",
    url: `https://cdn.example.com/${index}.png`,
  }));
  const elements = Array.from({ length: 5 }, (_, index) => ({ name: `元素 ${index}`, description: "描述", references }));
  const normalized = normalizeVideoElementList(elements);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].references.length, 4);
  assert.deepEqual(videoElementListToRequest(normalized)[0], {
    name: "元素 0",
    description: "描述",
    references: [
      { kind: "image", url: "https://cdn.example.com/0.png" },
      { kind: "image", url: "https://cdn.example.com/1.png" },
      { kind: "image", url: "https://cdn.example.com/2.png" },
      { kind: "video", url: "https://cdn.example.com/3.png" },
    ],
  });
});

test("moves element references without mutating the source list", () => {
  const source = [
    { id: "a", kind: "image", name: "A", type: "image/png", url: "https://cdn.example.com/a.png" },
    { id: "b", kind: "video", name: "B", type: "video/mp4", url: "https://cdn.example.com/b.mp4" },
  ];
  const moved = moveVideoElementReference(source, 1, -1);
  assert.deepEqual(moved.map((item) => item.id), ["b", "a"]);
  assert.deepEqual(source.map((item) => item.id), ["a", "b"]);
  assert.equal(moveVideoElementReference(source, 0, -1), source);
});
