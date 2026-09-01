import assert from "node:assert/strict";
import test from "node:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };

import {
  activeVideoModelContracts,
  applyVideoContractForcedValues,
  installVideoModelContracts,
  videoContractMaterialError,
  videoContractUIState,
  videoModelContract,
  videoContractRuleError,
} from "../src/lib/video-model-contracts.ts";
import {
  videoDefaultResolution,
  videoDefaultSeconds,
  videoResolutionOptions,
  videoSecondsOptions,
  videoSizeOptions,
} from "../src/lib/video-model-capabilities.ts";

test("installs and clears runtime video model contracts", () => {
  const previous = activeVideoModelContracts();
  const custom = structuredClone(contractDocument.contracts[0]);
  custom.name = "Custom video v1";
  custom.models = ["custom/video-v1"];
  custom.capability.sizes = ["4:3", "3:4"];
  custom.capability.seconds = [6, 12];
  custom.capability.resolutions = ["1080p"];
  custom.capability.default_size = "4:3";
  custom.capability.default_seconds = 6;
  custom.capability.default_resolution = "1080p";

  installVideoModelContracts([custom]);
  try {
    assert.equal(videoModelContract("CUSTOM/video-v1")?.name, custom.name);
    assert.deepEqual(videoSizeOptions("custom/video-v1"), ["4:3", "3:4"]);
    assert.deepEqual(videoSecondsOptions("custom/video-v1"), [6, 12]);
    assert.deepEqual(videoResolutionOptions("custom/video-v1"), ["1080p"]);
    assert.equal(videoDefaultSeconds("custom/video-v1"), 6);
    assert.equal(videoDefaultResolution("custom/video-v1"), "1080p");
  } finally {
    installVideoModelContracts(previous);
  }
  assert.equal(videoModelContract("custom/video-v1"), undefined);
});

test("an explicit empty contract list does not restore defaults", () => {
  const previous = activeVideoModelContracts();
  try {
    installVideoModelContracts(structuredClone(contractDocument.contracts));
    assert.ok(videoModelContract("minimax-h3-768p"));
    installVideoModelContracts([]);
    assert.equal(videoModelContract("minimax-h3-768p"), undefined);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("failed installs preserve the previous registry atomically", () => {
  const previous = activeVideoModelContracts();
  const installed = structuredClone(contractDocument.contracts[0]);
  installed.name = "Atomic registry";
  installed.models = ["atomic-video"];
  const duplicate = structuredClone(installed);
  duplicate.name = "Duplicate registry";

  try {
    installVideoModelContracts([installed]);
    assert.throws(() => installVideoModelContracts([installed, duplicate]), /Duplicate video model contract/);
    assert.deepEqual(activeVideoModelContracts().map((contract) => contract.name), [installed.name]);
    assert.equal(videoModelContract("atomic-video")?.name, installed.name);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("contract lookups do not expose mutable registry state", () => {
  const previous = activeVideoModelContracts();
  const installed = structuredClone(contractDocument.contracts[0]);
  installed.name = "Owned registry";
  installed.models = ["owned-video"];

  try {
    installVideoModelContracts([installed]);
    const exposed = videoModelContract("owned-video");
    exposed.name = "Mutated caller copy";
    exposed.models[0] = "mutated-video";
    exposed.capability.sizes.push("caller-only-size");

    const retained = videoModelContract("owned-video");
    assert.equal(retained?.name, installed.name);
    assert.deepEqual(retained?.models, installed.models);
    assert.equal(retained?.capability.sizes.includes("caller-only-size"), false);
    assert.equal(videoModelContract("mutated-video"), undefined);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("matches exact and increasingly specific wildcard model rules deterministically", () => {
  const previous = activeVideoModelContracts();
  const base = structuredClone(contractDocument.contracts[0]);
  const broad = structuredClone(base);
  broad.name = "MiniMax family";
  broad.models = ["minimax-*"];
  broad.priority = 900;
  const specific = structuredClone(base);
  specific.name = "MiniMax H3 family";
  specific.models = ["minimax-h3-*"];
  specific.priority = -900;
  const exact = structuredClone(base);
  exact.name = "MiniMax H3 768p";
  exact.models = ["minimax-h3-768p"];
  try {
    installVideoModelContracts([broad, specific, exact]);
    assert.equal(videoModelContract("minimax-video-01")?.name, broad.name);
    assert.equal(videoModelContract("minimax-h3-custom")?.name, specific.name);
    assert.equal(videoModelContract("MINIMAX-H3-768P")?.name, exact.name);
    assert.equal(videoModelContract("unconfigured-video"), undefined);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("validates declared generation modes and conditional rules", () => {
  const contract = structuredClone(contractDocument.contracts[0]);
  assert.equal(videoContractMaterialError(contract, "text", { first_frame: 0, last_frame: 0, image: 0, video: 0, audio: 0 }), "");
  assert.equal(videoContractMaterialError(contract, "image", { first_frame: 0, last_frame: 1, image: 0, video: 0, audio: 0 }), "图生视频至少需要 1 个首帧");
  assert.equal(videoContractMaterialError(contract, "reference", { first_frame: 0, last_frame: 0, image: 9, video: 3, audio: 1 }), "参考素材生视频素材合计最多支持 12 个");
  assert.equal(videoContractRuleError(contract, { last_frame: "tail.png" }), "添加尾帧前必须先添加首帧");
  assert.equal(videoContractRuleError(contract, { first_frame: "first.png", last_frame: "tail.png" }), "");
  assert.equal(videoContractRuleError(contract, { first_frame: "first.png", reference_image: ["reference.png"] }), "首尾帧与普通参考图片、视频和音频不能同时使用");
  assert.equal(videoContractRuleError(contract, { first_frame: "first.png", reference_video: ["reference.mp4"] }), "首尾帧与普通参考图片、视频和音频不能同时使用");
  assert.equal(videoContractRuleError(contract, { first_frame: "first.png", reference_audio: ["reference.mp3"] }), "首尾帧与普通参考图片、视频和音频不能同时使用");
  assert.equal(videoContractRuleError(contract, { reference_image: ["reference.png"], reference_video: ["reference.mp4"] }), "");

  contract.rules = [{
    when: { field: "generate_audio", operator: "equals", value: "true" },
    require_any: ["reference_image", "reference_video"],
    forbid: ["reference_audio"],
    limits: { reference_image: 1 },
    force_values: { duration: "8", watermark: "true" },
    ui: { show: ["watermark"], hide: ["reference_audio"], disable: ["duration"] },
    message: "音频模式素材关系无效",
  }];
  assert.equal(videoContractRuleError(contract, { generate_audio: true }), "音频模式素材关系无效");
  assert.equal(videoContractRuleError(contract, { generate_audio: true, reference_video: ["one.mp4"] }), "");
  assert.equal(videoContractRuleError(contract, { generate_audio: true, reference_image: ["one.png", "two.png"] }), "音频模式素材关系无效");
  assert.equal(videoContractRuleError(contract, { generate_audio: true, reference_video: ["one.mp4"], reference_audio: ["one.mp3"] }), "音频模式素材关系无效");
  assert.deepEqual(applyVideoContractForcedValues(contract, { generate_audio: true, reference_image: ["one.png"] }), {
    generate_audio: true,
    reference_image: ["one.png"],
    duration: 8,
    watermark: true,
  });
  const matchedUI = videoContractUIState(contract, { generate_audio: true });
  assert.equal(matchedUI.hidden.has("reference_audio"), true);
  assert.equal(matchedUI.disabled.has("duration"), true);
  assert.equal(matchedUI.hidden.has("watermark"), false);
  const unmatchedUI = videoContractUIState(contract, { generate_audio: false });
  assert.equal(unmatchedUI.hidden.size, 0);
  assert.equal(unmatchedUI.disabled.size, 0);
});

test("parses forced values with the same typed rules as the backend", () => {
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.rules = [{
    when: { field: "duration", operator: "present" },
    force_values: {
      duration: " 08 ",
      generate_audio: " TRUE ",
      watermark: " False ",
      resolution: " 1080p ",
    },
    message: "apply typed values",
  }];
  assert.deepEqual(applyVideoContractForcedValues(contract, { duration: 4 }), {
    duration: 8,
    generate_audio: true,
    watermark: false,
    resolution: "1080p",
  });

  contract.rules[0].force_values = { duration: "8.5", generate_audio: "1", watermark: "f" };
  assert.deepEqual(applyVideoContractForcedValues(contract, { duration: 4, generate_audio: false, watermark: true }), {
    duration: 4,
    generate_audio: true,
    watermark: false,
  });

  contract.rules[0].force_values = { duration: "9007199254740993", generate_audio: "yes", watermark: "off" };
  assert.deepEqual(applyVideoContractForcedValues(contract, { duration: 4, generate_audio: false, watermark: true }), {
    duration: 4,
    generate_audio: false,
    watermark: true,
  });
});

test("uses normalized forced values when evaluating chained UI rules", () => {
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.rules = [
    {
      when: { field: "duration", operator: "equals", value: "4" },
      force_values: { generate_audio: " TRUE " },
      message: "force audio",
    },
    {
      when: { field: "generate_audio", operator: "equals", value: "true" },
      ui: { hide: ["watermark"] },
      message: "hide watermark",
    },
  ];
  assert.equal(videoContractUIState(contract, { duration: 4 }).hidden.has("watermark"), true);

  contract.rules[0].force_values = { generate_audio: "yes" };
  assert.equal(videoContractUIState(contract, { duration: 4 }).hidden.has("watermark"), false);
});

test("enforces per-material and total minimums in backend order", () => {
  const contract = structuredClone(contractDocument.contracts[0]);
  const referenceMode = contract.generation.modes.find((mode) => mode.kind === "reference");
  referenceMode.materials.image.min = 1;
  referenceMode.materials.video.min = 1;
  referenceMode.materials.total.min = 3;

  assert.equal(
    videoContractMaterialError(contract, "reference", { first_frame: 0, last_frame: 0, image: 1, video: 0, audio: 0 }),
    "参考素材生视频至少需要 1 个参考视频",
  );
  assert.equal(
    videoContractMaterialError(contract, "reference", { first_frame: 0, last_frame: 0, image: 1, video: 1, audio: 0 }),
    "参考素材生视频至少需要 3 个素材",
  );
  assert.equal(
    videoContractMaterialError(contract, "reference", { first_frame: 0, last_frame: 0, image: 2, video: 1, audio: 0 }),
    "",
  );
});
