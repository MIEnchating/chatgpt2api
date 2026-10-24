import type { VideoModelContract, VideoModelParameter, VideoParameterValues } from "./video-model-contracts";

export function videoParameterError(parameter: VideoModelParameter, value: unknown): string {
  const fail = `${parameter.label}的值不符合允许的类型、范围或选项`;
  if (value == null) return parameter.required ? `请填写${parameter.label}` : "";
  if (parameter.type === "boolean") return typeof value === "boolean" ? "" : fail;
  if (parameter.type === "number" || parameter.type === "integer") {
    return typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER
      || parameter.type === "integer" && !Number.isInteger(value)
      || parameter.minimum != null && value < parameter.minimum || parameter.maximum != null && value > parameter.maximum ? fail : "";
  }
  if (typeof value !== "string" || parameter.required && !value.trim()
    || parameter.max_length && [...value].length > parameter.max_length
    || parameter.enum?.length && !parameter.enum.includes(value)) return fail;
  if (parameter.format === "uri") {
    try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/.test(value)) return fail; }
    catch { return fail; }
  }
  return "";
}

export function normalizeVideoParameters(contract: VideoModelContract, mode: string, input: VideoParameterValues = {}): VideoParameterValues {
  const definitions = (contract.capability.parameters || []).filter(p => !p.modes?.length || p.modes.includes(mode as "text" | "image" | "reference"));
  const result: VideoParameterValues = {};
  for (const name of Object.keys(input)) if (!definitions.some(p => p.name === name)) throw new Error(`当前模型或模式未声明参数 ${name}`);
  for (const parameter of definitions) {
    const value = Object.hasOwn(input, parameter.name) ? input[parameter.name] : parameter.default;
    if (Object.hasOwn(input, parameter.name) && value == null) throw new Error(`请填写${parameter.label}`);
    const error = videoParameterError(parameter, value);
    if (error) throw new Error(error);
    if (value != null) result[parameter.name] = value;
  }
  return result;
}

export function videoDurationValue(cap: VideoModelContract["capability"], requested: number | undefined) {
  const range = cap.seconds_range;
  if (!range) return cap.seconds.find(value => value === requested) ?? cap.default_seconds;
  if (requested === undefined || Number.isNaN(requested)) return cap.default_seconds;
  if (!Number.isSafeInteger(requested) || requested < range.min || range.max != null && requested > range.max || (requested - range.min) % range.step !== 0) throw new Error("视频时长不符合契约范围");
  return requested;
}
