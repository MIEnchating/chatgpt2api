import assert from "node:assert/strict";
import test from "node:test";
import { applyVideoFrameDefaults, getVideoModeMaterials, setVideoMaterialSupport, setVideoMaterialTransports, updateVideoMaterialRange } from "../src/lib/video-contract-editor.ts";

test("material transport selection follows upload, Base64, URL priority for every supported combination", () => {
  for (const methods of [["url"], ["base64"], ["multipart"], ["url", "base64"], ["url", "multipart"], ["base64", "multipart"], ["url", "base64", "multipart"]]) {
    const transport = { local_material: "url", multipart_file_field: "", multipart_repeatable: false, multipart_mixed_urls: false, create_path: "", query_path: "" };
    const next = setVideoMaterialTransports(transport, methods);
    const expected = ["multipart", "base64", "url"].filter(method => methods.includes(method));
    assert.deepEqual(next.material_transports, expected);
    assert.equal(next.local_material, expected[0]);
    if (expected[0] === "multipart") assert.equal(next.multipart_file_field, "input_reference[]");
    assert.equal(transport.local_material, "url");
  }
});

function mode(kind) {
  return {
    id: `${kind}-to-video`,
    label: kind === "text" ? "文生视频" : kind === "image" ? "首尾帧生成" : "参考素材生成",
    kind,
    request_value: `${kind}-to-video`,
    materials: {
      first_frame: { min: 0, max: 0 },
      last_frame: { min: 0, max: 0 },
      image: { min: 0, max: 0 },
      video: { min: 0, max: 0 },
      audio: { min: 0, max: 0 },
      total: { min: 0, max: 0 },
    },
  };
}

function generation() {
  return { selection: "infer", default_mode: "text-to-video", modes: [mode("text")] };
}

test("first-frame mode requires a first frame and lets the tail frame be configured independently", () => {
  let next = setVideoMaterialSupport(generation(), "first_frame", true);
  let imageMode = next.modes.find((item) => item.kind === "image");
  assert.deepEqual(imageMode.materials.first_frame, { min: 1, max: 1 });
  assert.deepEqual(imageMode.materials.last_frame, { min: 0, max: 1 });

  next = setVideoMaterialSupport(next, "last_frame", true);
  imageMode = next.modes.find((item) => item.kind === "image");
  assert.deepEqual(imageMode.materials.first_frame, { min: 1, max: 1 });
  assert.deepEqual(imageMode.materials.last_frame, { min: 0, max: 1 });

  imageMode.materials.first_frame.min = 0;
  next = updateVideoMaterialRange(imageMode, "first_frame", "min", 0);
  assert.equal(next.materials.first_frame.min, 1);

  next = updateVideoMaterialRange(imageMode, "last_frame", "min", 1);
  assert.deepEqual(next.materials.first_frame, { min: 1, max: 1 });
  assert.deepEqual(next.materials.last_frame, { min: 1, max: 1 });

  const withoutTail = setVideoMaterialSupport({ ...generation(), modes: [mode("text"), next] }, "last_frame", false);
  imageMode = withoutTail.modes.find((item) => item.kind === "image");
  assert.deepEqual(imageMode.materials.first_frame, { min: 1, max: 1 });
  assert.deepEqual(imageMode.materials.last_frame, { min: 0, max: 0 });
});

test("disabling first-frame generation removes its dependent tail-frame mode", () => {
  let next = setVideoMaterialSupport(generation(), "last_frame", true);
  assert.ok(next.modes.some((item) => item.kind === "image"));
  next = setVideoMaterialSupport(next, "first_frame", false);
  assert.equal(next.modes.some((item) => item.kind === "image"), false);
});

test("first-frame mode always exposes both frame controls, even while tail frame is disabled", () => {
  const imageMode = mode("image");
  imageMode.materials.first_frame = { min: 1, max: 1 };

  assert.deepEqual(getVideoModeMaterials(imageMode).map((item) => item.key), ["first_frame", "last_frame"]);
  assert.deepEqual(getVideoModeMaterials(mode("reference")), []);
});

test("editing an existing first-frame mode defaults tail uploads on without requiring them", () => {
  const imageMode = mode("image");
  imageMode.materials.first_frame = { min: 0, max: 1 };
  const next = applyVideoFrameDefaults({ selection: "infer", default_mode: imageMode.id, modes: [imageMode] });

  assert.deepEqual(next.modes[0].materials.first_frame, { min: 1, max: 1 });
  assert.deepEqual(next.modes[0].materials.last_frame, { min: 0, max: 1 });
});
