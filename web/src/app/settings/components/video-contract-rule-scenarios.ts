import type { VideoModelContractRule } from "@/lib/video-model-contracts";

export const VIDEO_RULE_SCENARIOS: { label: string; description: string; rule: VideoModelContractRule }[] = [
  { label: "尾帧需要首帧", description: "上传尾帧时，要求同时提供首帧。", rule: { when: { field: "last_frame", operator: "present" }, require: ["first_frame"], message: "添加尾帧前请先添加首帧图片" } },
  { label: "参考音频需要画面", description: "上传参考音频时，图片或视频至少提供一种。", rule: { when: { field: "reference_audio", operator: "present" }, require_any: ["reference_image", "reference_video"], message: "使用参考音频时，请至少添加一张参考图片或一段参考视频" } },
  { label: "有视频时最多一张参考图", description: "上传参考视频后，将参考图片数量限制为 1。", rule: { when: { field: "reference_video", operator: "present" }, limits: { reference_image: 1 }, message: "使用参考视频时，最多添加一张参考图片" } },
];
