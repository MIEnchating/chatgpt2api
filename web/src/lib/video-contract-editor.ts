import type { VideoModelContract, VideoModelGenerationMode } from "./video-model-contracts";

export const VIDEO_MATERIALS = [
  { key: "first_frame", label: "首帧图片", description: "指定视频开始画面", max: 1 },
  { key: "last_frame", label: "尾帧图片", description: "指定视频结束画面，需支持首帧", max: 1 },
  { key: "image", label: "参考图片", description: "参考人物、物体或画面风格", max: 50 },
  { key: "video", label: "参考视频", description: "参考动作、镜头或已有视频", max: 20 },
  { key: "audio", label: "参考音频", description: "参考声音、节奏或对白", max: 20 },
] as const;

export type VideoMaterialKey = typeof VIDEO_MATERIALS[number]["key"];
type Generation = VideoModelContract["generation"];

export function getVideoModeMaterials(mode: VideoModelGenerationMode) {
  if (mode.kind === "image") return VIDEO_MATERIALS.filter((item) => item.key === "first_frame" || item.key === "last_frame");
  return VIDEO_MATERIALS.filter((item) => mode.materials[item.key].max > 0);
}

export function applyVideoFrameDefaults(generation: Generation): Generation {
  const next = structuredClone(generation);
  for (const mode of next.modes) {
    if (mode.kind !== "image" || mode.materials.first_frame.max === 0) continue;
    mode.materials.first_frame.min = 1;
    mode.materials.last_frame.max = 1;
  }
  return next;
}

function newMode(kind: VideoModelGenerationMode["kind"], modes: VideoModelGenerationMode[]): VideoModelGenerationMode {
  const base = `${kind}-to-video`;
  let id = base;
  let suffix = 2;
  while (modes.some((mode) => mode.id === id || mode.request_value === id)) id = `${base}-${suffix++}`;
  return {
    id, kind, label: kind === "text" ? "文生视频" : kind === "image" ? "首尾帧生成" : "参考素材生成", request_value: id,
    materials: {
      first_frame: { min: 0, max: 0 }, last_frame: { min: 0, max: 0 },
      image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total: { min: 0, max: 0 },
    },
  };
}

export function updateVideoMaterialRange(mode: VideoModelGenerationMode, field: VideoMaterialKey, bound: "min" | "max", value: number): VideoModelGenerationMode {
  const next = structuredClone(mode);
  const oldSum = VIDEO_MATERIALS.reduce((sum, item) => sum + mode.materials[item.key].max, 0);
  const limit = VIDEO_MATERIALS.find((item) => item.key === field)!.max;
  const range = next.materials[field];
  range[bound] = Math.max(0, Math.min(limit, Math.trunc(value) || 0));
  if (bound === "min") range.max = Math.max(range.min, range.max);
  else range.min = Math.min(range.min, range.max);
  if (next.kind === "image" && next.materials.last_frame.max > 0) next.materials.first_frame.min = 1;
  const ranges = VIDEO_MATERIALS.map((item) => next.materials[item.key]);
  const sum = Math.min(80, ranges.reduce((total, item) => total + item.max, 0));
  const minimum = ranges.reduce((total, item) => total + item.min, 0);
  const floor = Math.max(minimum, ...ranges.map((item) => item.max));
  next.materials.total.max = Math.min(sum, Math.max(floor, mode.materials.total.max === Math.min(80, oldSum) ? sum : mode.materials.total.max));
  next.materials.total.min = Math.min(next.materials.total.max, Math.max(minimum, mode.materials.total.min));
  return next;
}

export function setVideoMaterialSupport(generation: Generation, field: VideoMaterialKey | "text", enabled: boolean): Generation {
  const next = structuredClone(generation);
  const kind = field === "text" ? "text" : field === "first_frame" || field === "last_frame" ? "image" : "reference";
  let mode = next.modes.find((item) => item.kind === kind);
  if (!mode && enabled) {
    mode = newMode(kind, next.modes);
    next.modes.push(mode);
  }
  if (!mode) return next;
  if (field === "text" || (field === "first_frame" && !enabled)) {
    if (!enabled) next.modes = next.modes.filter((item) => item !== mode);
  } else {
    if (kind === "image" && enabled) {
      mode.materials.first_frame = { min: 1, max: 1 };
      mode.materials.last_frame = { min: 0, max: 1 };
    }
    const range = updateVideoMaterialRange(mode, field, "max", enabled ? 1 : 0);
    if (enabled && kind === "reference") range.materials.total.min = Math.max(1, range.materials.total.min);
    Object.assign(mode, range);
    if (!VIDEO_MATERIALS.some((item) => mode!.materials[item.key].max > 0)) next.modes = next.modes.filter((item) => item !== mode);
  }
  next.default_mode = next.modes.find((item) => item.kind === "text")?.id || next.modes[0]?.id || "";
  return next;
}
