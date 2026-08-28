import {
  canonicalVideoModel,
  videoAudioControl,
  videoModelProfile,
  videoResolutionOptions,
  videoSecondsOptions,
  videoSizeOptions,
  videoDefaultSeconds,
  videoDefaultSize,
  videoDefaultResolution,
  videoAllowsCustomDimensions,
  videoAllowsCustomResolution,
  videoWatermarkSupported,
  videoComposerWatermarkSupported,
  usesReferenceGenericVideoPanel,
  usesReferenceSpecialVideoPanel,
  videoWorkbenchReferenceLimits,
  videoReferenceImageLimit,
  supportsVideoMultimodalReferences,
  supportsKlingElements,
  supportsKlingMultiShot,
  supportsKlingMode,
  supportsKlingNegativePrompt,
  supportsKlingShotType,
  type VideoModelProfile,
} from "./video-model-capabilities.ts";
import { isPublicReferenceURL } from "./public-reference-url.ts";

type KlingElementReference = { kind: "image" | "video" | "audio"; url: string };

function inferredKlingElementKind(url: string): KlingElementReference["kind"] {
  const value = url.toLowerCase();
  if (/\.(?:mp3|wav|m4a)(?:\?|$)/.test(value)) return "audio";
  if (/\.(?:mp4|mov|webm)(?:\?|$)/.test(value)) return "video";
  return "image";
}

function rawKlingElementReferences(item: Record<string, unknown>) {
  const references = Array.isArray(item.references) ? item.references : [];
  const imageOrVideoURLs = Array.isArray(item.element_input_urls) ? item.element_input_urls : [];
  const audioURLs = Array.isArray(item.element_input_audio_urls) ? item.element_input_audio_urls : [];
  return [
    ...references.map((reference) => {
      const record = reference && typeof reference === "object" && !Array.isArray(reference) ? reference as Record<string, unknown> : {};
      const url = String(record.url || "").trim();
      const rawKind = String(record.kind || "").trim().toLowerCase();
      return { kind: rawKind || inferredKlingElementKind(url), url, validRecord: Object.keys(record).length > 0 };
    }),
    ...imageOrVideoURLs.map((url) => {
      const value = String(url || "").trim();
      return { kind: inferredKlingElementKind(value), url: value, validRecord: typeof url === "string" };
    }),
    ...audioURLs.map((url) => ({ kind: "audio", url: String(url || "").trim(), validRecord: typeof url === "string" })),
  ];
}

export function validateVideoKlingElementList(value: Array<Record<string, unknown>>) {
  if (value.length > 3) return "元素列表最多支持 3 个元素";
  for (const [index, item] of value.entries()) {
    const references = rawKlingElementReferences(item);
    if (references.length === 0) continue;
    if (!String(item.name || "").trim()) return `元素 ${index + 1} 需要填写名称`;
    if (!String(item.description || "").trim()) return `元素 ${index + 1} 需要填写描述`;
    if (references.length < 2 || references.length > 4) return `元素 ${index + 1} 的资源数量需要 2-4 个`;
    for (const reference of references) {
      if (!reference.validRecord || !["image", "video", "audio"].includes(reference.kind)) {
        return `元素 ${index + 1} 的资源类型仅支持 image、video 或 audio`;
      }
      if (!isPublicReferenceURL(reference.url)) return `元素 ${index + 1} 的资源必须使用公网可访问的 http:// 或 https:// URL`;
    }
  }
  return "";
}

export function normalizeVideoKlingElementList(value: Array<Record<string, unknown>>) {
  return value.slice(0, 3).flatMap((item) => {
    const references = rawKlingElementReferences(item)
      .filter((reference) => reference.validRecord && ["image", "video", "audio"].includes(reference.kind) && isPublicReferenceURL(reference.url))
      .slice(0, 4)
      .map(({ kind, url }) => ({ kind, url } as KlingElementReference));
    if (references.length === 0) return [];
    return [{ name: String(item.name || "").trim(), description: String(item.description || "").trim(), references }];
  });
}

export function videoHasKlingElementReferences(value: Array<Record<string, unknown>>) {
  return value.some((item) => rawKlingElementReferences(item).some((reference) => reference.validRecord && Boolean(reference.url)));
}

export function videoWorkbenchReferenceLimitError(model: string, imageCount: number, videoCount: number, audioCount: number) {
  const profile = videoModelProfile(model);
  if (!usesReferenceSpecialVideoPanel(model) || !profile.startsWith("kling-")) return "";
  const limits = videoWorkbenchReferenceLimits(model);
  if (imageCount > limits.image) return `Kling 参考图最多 ${limits.image} 张`;
  if (videoCount > limits.video) return `Kling 参考视频最多 ${limits.video} 个`;
  if (audioCount > limits.audio) return `Kling 参考音频最多 ${limits.audio} 个`;
  return "";
}

export function videoAudioGenerationError(model: string, enabled: boolean, mode: string, imageCount: number) {
  const key = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
  if (!enabled || key !== "kling-v2-6") return "";
  if (mode !== "pro") return "Kling v2.6 音频生成需要 pro 模式";
  if (imageCount > 1) return "Kling v2.6 开启音频时最多 1 张参考图";
  return "";
}

export type VideoRequestInput = {
  model?: string;
  size?: string;
  seconds?: number;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  referenceMode?: "first-frame" | "reference";
  referenceImageURLs?: string[];
  /** Optional explicit frame slots used by canvas/API callers. */
  firstFrameURL?: string;
  lastFrameURL?: string;
  referenceVideoURLs?: string[];
  referenceAudioURLs?: string[];
  systemPrompt?: string;
  videoMode?: string;
  negativePrompt?: string;
  multiShot?: boolean;
  shotType?: "intelligence" | "customize";
  multiPrompt?: Array<Record<string, unknown>>;
  elementList?: Array<Record<string, unknown>>;
  characterOrientation?: "image" | "video";
};

export type VideoGenerationTaskRequestInput = VideoRequestInput & {
  clientTaskId: string;
  prompt: string;
  relayTokenName?: string;
};

export type NormalizedVideoRequest = {
  model: string;
  profile: VideoModelProfile;
  size?: string;
  seconds: number;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  referenceMode: "first-frame" | "reference";
  firstFrameURL?: string;
  lastFrameURL?: string;
  referenceImageURLs: string[];
  referenceVideoURLs: string[];
  referenceAudioURLs: string[];
  videoMode?: string;
  negativePrompt?: string;
  multiShot?: boolean;
  shotType?: "intelligence" | "customize";
  multiPrompt?: Array<Record<string, unknown>>;
  elementList?: Array<Record<string, unknown>>;
  characterOrientation?: "image" | "video";
};

export type VideoReferenceCombinationInput = Pick<
  VideoRequestInput,
  "model" | "referenceMode" | "firstFrameURL" | "lastFrameURL" | "referenceImageURLs" | "referenceVideoURLs" | "referenceAudioURLs"
> & {
  /** Includes local creator images that have not been uploaded to a public URL yet. */
  ordinaryReferenceImageCount?: number;
};

function referenceCount(values: string[] | undefined) {
  return (values || []).filter((value) => String(value || "").trim()).length;
}

/** Matches the mutually exclusive reference roles enforced by the reference workbench. */
export function videoReferenceCombinationError(input: VideoReferenceCombinationInput) {
  const profile = videoModelProfile(input.model || "");
  const firstFrameURL = String(input.firstFrameURL || "").trim();
  const lastFrameURL = String(input.lastFrameURL || "").trim();
  const hasFrames = Boolean(firstFrameURL || lastFrameURL);
  const suppliedImageCount = referenceCount(input.referenceImageURLs);
  // In first-frame mode, an ordered image array supplies frame slots. Once
  // named frame slots or reference mode are present, the array contains
  // ordinary reference images and is validated as a separate role.
  const inferredOrdinaryImageCount = hasFrames || input.referenceMode === "reference" ? suppliedImageCount : 0;
  const ordinaryImageCount = Math.max(0, Math.floor(
    input.ordinaryReferenceImageCount ?? inferredOrdinaryImageCount,
  ));
  const videoCount = referenceCount(input.referenceVideoURLs);
  const audioCount = referenceCount(input.referenceAudioURLs);
  const hasOrdinaryReferences = ordinaryImageCount + videoCount + audioCount > 0;

  if (profile === "veo" || profile === "veo-31") {
    if (videoCount > 0) return "Gemini Veo 不支持普通参考视频，请移除后重试";
    if (audioCount > 0) return "Gemini Veo 不支持参考音频，请移除后重试";
    if (lastFrameURL && !firstFrameURL) return "请先添加首帧图片";
    if (hasFrames && ordinaryImageCount > 0) return "首尾帧模式不能与普通参考图同时使用";
    if ((lastFrameURL || ordinaryImageCount > 0) && profile !== "veo-31") return "当前 Veo 模型不支持尾帧或普通参考图";
    if (ordinaryImageCount > 3) return "Veo 3.1 参考图最多 3 张";
  }
  if (profile === "agnes-25" && hasFrames && hasOrdinaryReferences) {
    return "Agnes Video 2.5 的首尾帧不能和普通参考素材同时使用";
  }
  if (profile === "minimax-h3") {
    if (hasFrames && hasOrdinaryReferences) return "MiniMax H3 首尾帧不能与参考图片、视频或音频同时使用";
    if (audioCount > 0 && ordinaryImageCount + videoCount === 0) {
      return "MiniMax H3 参考音频需要同时提供参考图片或参考视频";
    }
  }
  if (profile === "cogvideox-3" && videoCount + audioCount > 0) {
    return "CogVideoX-3 不支持参考视频或参考音频";
  }
  return "";
}

/** Applies the same prompt ordering as the reference project's video API. */
export function composeVideoPrompt(prompt: string, systemPrompt?: string) {
  const userPrompt = String(prompt || "").trim();
  const system = String(systemPrompt || "").trim();
  return (system ? `${system}\n\n${userPrompt}` : userPrompt).trim();
}

export function normalizeStoredVideoSeconds(value: unknown) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds)) return undefined;
  return seconds === -1 ? -1 : Math.max(1, Math.min(60, seconds));
}

/** Provider-boundary duration normalization used by the shared creation API. */
export function normalizeVideoSubmissionSeconds(model: string, value: number) {
  const profile = videoModelProfile(model);
  const key = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
  const requestedSeconds = Math.round(Number(value));
  // The reference workbench shows -1 as Seedance's smart option, then routes
  // it through the shared 1-30 second submission normalizer. Mirror the final
  // payload here instead of leaking the UI sentinel to strict provider schemas.
  if (profile.startsWith("seedance-") && requestedSeconds === -1) return 1;
  const seconds = Math.max(1, Math.min(30, Number.isFinite(requestedSeconds) ? requestedSeconds : 1));
  // The reference request builder fixes every APIMart Veo 3.1 task at eight
  // seconds while leaving the generic workbench selection unchanged.
  if (key.includes("veo3-1") || key.includes("veo-3-1")) return 8;
  // APIMart Kling 3.0 Turbo uses the reference project's generic workbench
  // and accepts its manual 1-30 second range. It is separate from the KIE
  // Kling 3 endpoint, whose documented duration range is 3-15 seconds.
  if (canonicalVideoModel(model).toLowerCase() === "kling-3-0-turbo") return seconds;
  if (profile === "minimax-h3") return Math.max(4, Math.min(15, seconds));
  if (profile === "grok-kie" || profile === "grok-i2v") return Math.max(6, Math.min(30, seconds));
  // Only the named Kling v2.6 creator panel has a 5/10-second enum. Other
  // Kling endpoints use the reference workbench's generic 1-30 input.
  if (key === "kling-v2-6") return closestAllowedSeconds(seconds, [5, 10]);
  if (usesReferenceSpecialVideoPanel(model) && (profile === "kling-3" || profile.startsWith("kling-omni"))) {
    return Math.max(3, Math.min(15, seconds));
  }
  if (profile === "cogvideox-3") return closestAllowedSeconds(seconds, [5, 10]);
  if (profile === "agnes-25") return Math.max(4, Math.min(12, seconds));
  if (profile.startsWith("seedance-")) {
    return Math.max(4, Math.min(15, seconds));
  }
  return seconds;
}

/** Mirrors the models for which the reference request builder omits seconds. */
export function videoSubmissionIncludesSeconds(model: string) {
  const key = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
  return key !== "gemini-omni-flash-preview" && !key.includes("motion-control");
}

function normalizeSeconds(model: string, value: number | undefined) {
  const profile = videoModelProfile(model);
  // Seedance shares one creator panel in the reference project: smart
  // duration plus a manual 4-15 second range for every displayed version.
  if (profile.startsWith("seedance-")) {
    if (Number(value) === -1) return -1;
    const requested = Math.floor(Number(value));
    return Math.max(4, Math.min(15, Number.isFinite(requested) ? requested : 5));
  }
  // The reference workbench's generic panel accepts any integer from 1 to
  // 30. Provider-specific adapters perform the final enum/clamp conversion;
  // using the capability preset here made values such as Grok 1 second or
  // Hailuo 7 seconds jump to an unrelated UI preset before submission.
  if (!usesReferenceSpecialVideoPanel(model)) {
    const requested = Number(value);
    const finite = Number.isFinite(requested) ? requested : videoDefaultSeconds(model);
    const normalized = Math.max(1, Math.min(30, Math.floor(finite)));
    const key = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
    if (key.includes("sora-2")) return closestAllowedSeconds(normalized, [4, 8, 12, 16, 20]);
    if (profile === "veo" || profile === "veo-31") return closestAllowedSeconds(normalized, [4, 6, 8]);
    if (key.includes("minimax-hailuo-02")) return closestAllowedSeconds(normalized, [5, 10]);
    if (key.includes("minimax-hailuo-2-3")) return closestAllowedSeconds(normalized, [6, 10]);
    if (key.includes("omni-flash-ext")) return closestAllowedSeconds(normalized, [4, 6, 8, 10]);
    if (key.includes("wan2-5")) return closestAllowedSeconds(normalized, [5, 10]);
    if (key === "wan2-6") return closestAllowedSeconds(normalized, [5, 10, 15]);
    return normalized;
  }
  const options = videoSecondsOptions(model);
  const requested = Number(value);
  if (options.length === 0) return videoDefaultSeconds(model);
  if (Number.isInteger(requested) && options.includes(requested)) return requested;
  const finite = Number.isFinite(requested) ? requested : videoDefaultSeconds(model);
  return options.reduce((closest, item) => {
    if (Math.abs(item - finite) < Math.abs(closest - finite)) return item;
    return closest;
  }, options[0]);
}

function closestAllowedSeconds(seconds: number, allowed: number[]) {
  return allowed.reduce((best, item) => Math.abs(item - seconds) < Math.abs(best - seconds) ? item : best, allowed[0]);
}

function normalizeSize(
  model: string,
  value: string | undefined,
  hasReferences: boolean,
  hasFrameReferences: boolean,
  profile: VideoModelProfile,
) {
  const options = videoSizeOptions(model);
  if (profile === "minimax-h3" && hasFrameReferences) {
    return "adaptive";
  }
  let requested = String(value || "").trim().toLowerCase();
  if (profile === "minimax-h3" && !hasReferences && (requested === "auto" || requested === "adaptive")) {
    return "16:9";
  }
  if (/^\d{3,5}$/.test(requested)) requested = `${requested}p`;
  if (videoAllowsCustomDimensions(model)) {
    if ((requested === "auto" || requested === "adaptive") && profile === "minimax-h3" && hasFrameReferences) return undefined;
    const dimensions = requested.match(/^(\d+)x(\d+)$/i);
    if (dimensions) {
      // Generic workbench inputs are pixel dimensions, while many official
      // endpoints accept only an aspect-ratio enum. Convert those inputs at
      // the request boundary instead of leaking `1280x720` to `ratio`.
      const ratioOptions = options.filter((item) => /^\d+:\d+$/.test(item));
      if (ratioOptions.length > 0) {
        const ratio = Number(dimensions[1]) / Number(dimensions[2]);
        return ratioOptions.reduce((best, item) => {
          const [width, height] = item.split(":").map(Number);
          return Math.abs(width / height - ratio) < Math.abs(Number(best.split(":")[0]) / Number(best.split(":")[1]) - ratio) ? item : best;
        }, ratioOptions[0]);
      }
      if (options.length === 0 && !["generic", "agnes", "sora", "sora-pro"].includes(profile)) return undefined;
      return requested;
    }
  }
  // The reference project's generic workbench lets the user choose a ratio
  // even when the provider-specific capability list has no native size enum.
  // Keep that value until the provider adapter converts or removes it.
  if (options.length === 0) {
    if (usesReferenceGenericVideoPanel(model) && (/^\d+:\d+$/.test(requested) || requested === "auto" || requested === "adaptive")) {
      return requested;
    }
    return undefined;
  }
  const exact = options.find((item) => item.toLowerCase() === requested);
  return exact || videoDefaultSize(model) || options[0] || undefined;
}

function normalizeResolution(model: string, value: string | undefined, seconds: number) {
  const profile = videoModelProfile(model);
  const options = videoResolutionOptions(model, seconds);
  if (options.length === 0 && !videoAllowsCustomResolution(model) && profile !== "sora" && profile !== "sora-pro") {
    return undefined;
  }
  let requested = String(value || "").trim().toLowerCase();
  if (/^\d{3,5}$/.test(requested)) requested = `${requested}p`;
  if (profile === "minimax-h3") {
    return ["1080p", "2k", "4k"].includes(requested) ? "2K" : "768P";
  }
  if (profile === "minimax-hailuo") {
    if (requested === "1080" || requested === "1080p" || requested === "high") return seconds === 10 ? "768P" : "1080P";
    return "768P";
  }
  if (profile === "veo" || profile === "veo-31") {
    if (requested === "4k" && options.some((item) => item.toLowerCase() === "4k")) return "4k";
    if (["1080", "1080p", "2k", "4k"].includes(requested)) return "1080p";
    return "720p";
  }
  // The reference workbench renders the same 480p/720p buttons and manual
  // quality field for every generic model. Keep the entered value in the
  // shared request envelope; provider adapters can map it to their native
  // enum (for example Hailuo 480p -> 512P) at the final boundary.
  if (usesReferenceGenericVideoPanel(model)) {
    if (!requested) return videoDefaultResolution(model, seconds) || options[0] || "720p";
    if (requested === "low") return "480p";
    if (["auto", "medium", "high"].includes(requested)) return "720p";
    const exact = options.find((item) => item.toLowerCase() === requested);
    if (exact) return exact;
    const custom = /^(?:\d{3,5})(?:p|k)?$/i.test(requested)
      ? (requested.endsWith("k") || requested.endsWith("p") ? requested : `${requested}p`)
      : "";
    // The reference workbench sends the manually entered value unchanged.
    // Provider adapters own any final enum conversion or field removal.
    if (custom) return custom;
  }
  const exact = options.find((item) => item.toLowerCase() === requested);
  if (exact) return exact;
  return videoDefaultResolution(model, seconds) || options[0];
}

export function normalizeVideoRequest(input: VideoRequestInput): NormalizedVideoRequest {
  const model = canonicalVideoModel(String(input.model || "").trim());
  const profile = videoModelProfile(model);
  const requestedVideoMode = String(input.videoMode || "").trim().toLowerCase();
	const normalizedKlingMode = requestedVideoMode === "pro" || requestedVideoMode === "4k" ? requestedVideoMode : "std";
  const modelKey = model.toLowerCase().replace(/[._/]+/g, "-");
  const requestedFirstFrameURL = String(input.firstFrameURL || "").trim();
  const requestedLastFrameURL = String(input.lastFrameURL || "").trim();
  const referenceImageURLs = (input.referenceImageURLs || []).map((value) => String(value || "").trim()).filter(Boolean);
  const referenceLimits = videoWorkbenchReferenceLimits(model);
  const referenceVideoURLs = (input.referenceVideoURLs || []).filter(Boolean).slice(0, referenceLimits.video);
  const referenceAudioURLs = (input.referenceAudioURLs || []).filter(Boolean).slice(0, referenceLimits.audio);
  let seconds = normalizeSeconds(model, input.seconds);
  const frameImageLimit = videoReferenceImageLimit(model);
  const supportsMultimodalReferences = supportsVideoMultimodalReferences(model);
  const usesGenericPanel = usesReferenceGenericVideoPanel(model);
  const hasOnlyNamedFrames = Boolean(requestedFirstFrameURL || requestedLastFrameURL)
    && referenceImageURLs.length + referenceVideoURLs.length + referenceAudioURLs.length === 0;
  const normalizedReferenceMode = hasOnlyNamedFrames
    ? "first-frame"
    : referenceVideoURLs.length > 0
      || referenceAudioURLs.length > 0
      || String(model).toLowerCase().includes("reference-to-video")
      || input.referenceMode === "reference"
      || (supportsMultimodalReferences && referenceImageURLs.length > frameImageLimit)
      || (usesGenericPanel && referenceImageURLs.length > frameImageLimit)
      ? "reference"
      : "first-frame";
  const imageLimit = normalizedReferenceMode === "reference" ? referenceLimits.image : frameImageLimit;
  const normalizedImages = referenceImageURLs.slice(0, Math.max(0, imageLimit));
  const normalizedFirstFrameURL = frameImageLimit > 0 ? requestedFirstFrameURL : "";
  const normalizedLastFrameURL = frameImageLimit > 1 ? requestedLastFrameURL : "";
  const normalizedFrames = [normalizedFirstFrameURL, normalizedLastFrameURL].filter(Boolean);
  const hasReferences = normalizedFrames.length > 0 || normalizedImages.length > 0 || referenceVideoURLs.length > 0 || referenceAudioURLs.length > 0;
  const hasFrameReferences = normalizedFrames.length > 0 || (normalizedReferenceMode === "first-frame" && normalizedImages.length > 0);
  const audioControl = videoAudioControl(model);
  const resolution = normalizeResolution(model, input.resolution, seconds);
  const klingMultiShot = supportsKlingMultiShot(model);
  const klingShotType = supportsKlingShotType(model);
  const klingOmniReferenceWithVideo = profile === "kling-omni-reference" && referenceVideoURLs.length > 0;
  const generateAudio = audioControl === "always"
    || Boolean(input.generateAudio
      && (modelKey !== "kling-v2-6" || normalizedKlingMode === "pro")
      && !klingOmniReferenceWithVideo);
  const normalizedMultiPrompt = Array.isArray(input.multiPrompt) && input.multiPrompt.length > 0
    ? input.multiPrompt
    : input.multiShot && klingMultiShot && (!klingShotType || input.shotType === "customize")
      ? [{ prompt: "", duration: 1 }]
      : [];
  if ((profile === "veo-31" || profile === "veo") && (normalizedFrames.length > 0 || normalizedImages.length > 0 || (resolution && resolution.toLowerCase() !== "720p"))) {
    seconds = 8;
  }

  return {
    model,
    profile,
    size: normalizeSize(model, input.size, hasReferences, hasFrameReferences, profile),
    seconds,
    resolution,
    ...(audioControl === "none" ? {} : { generateAudio }),
    ...(videoComposerWatermarkSupported(model) && videoWatermarkSupported(model) ? { watermark: input.watermark ?? false } : {}),
    referenceMode: normalizedReferenceMode,
    ...(normalizedFirstFrameURL ? { firstFrameURL: normalizedFirstFrameURL } : {}),
    ...(normalizedLastFrameURL ? { lastFrameURL: normalizedLastFrameURL } : {}),
    referenceImageURLs: normalizedImages,
    referenceVideoURLs,
    referenceAudioURLs,
    ...(profile === "grok-kie" || profile === "grok-i2v"
      ? { videoMode: input.videoMode === "fun" || input.videoMode === "spicy" ? input.videoMode : "normal" }
        : supportsKlingMode(model) ? { videoMode: profile === "kling-legacy" && normalizedKlingMode === "4k" ? "pro" : normalizedKlingMode } : {}),
    ...(supportsKlingNegativePrompt(model) && input.negativePrompt?.trim() ? { negativePrompt: input.negativePrompt.trim() } : {}),
    ...(klingMultiShot && typeof input.multiShot === "boolean" ? { multiShot: input.multiShot } : {}),
    ...(klingShotType && (input.shotType === "customize" || input.shotType === "intelligence") ? { shotType: input.shotType } : {}),
    ...(klingMultiShot && normalizedMultiPrompt.length > 0 ? { multiPrompt: normalizedMultiPrompt } : {}),
    ...(supportsKlingElements(model) && Array.isArray(input.elementList) ? { elementList: normalizeVideoKlingElementList(input.elementList) } : {}),
    ...(profile === "kling-motion" && (input.characterOrientation === "image" || input.characterOrientation === "video") ? { characterOrientation: input.characterOrientation } : {}),
  };
}

export function videoGenerationTaskRequestBody(
  input: VideoGenerationTaskRequestInput,
) {
  const normalized = normalizeVideoRequest(input);
  const prompt = composeVideoPrompt(
    input.prompt,
    input.systemPrompt,
  );
  return {
    client_task_id: input.clientTaskId,
    prompt,
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.size ? { size: normalized.size } : {}),
    ...(videoSubmissionIncludesSeconds(normalized.model)
      ? { seconds: normalizeVideoSubmissionSeconds(normalized.model, normalized.seconds) }
      : {}),
    ...(normalized.resolution ? { resolution: normalized.resolution } : {}),
    ...(normalized.generateAudio === undefined ? {} : { generate_audio: normalized.generateAudio }),
    ...(normalized.watermark === undefined ? {} : { watermark: normalized.watermark }),
    reference_mode: normalized.referenceMode,
    ...(normalized.firstFrameURL ? { first_frame_url: normalized.firstFrameURL } : {}),
    ...(normalized.lastFrameURL ? { last_frame_url: normalized.lastFrameURL } : {}),
    ...(normalized.videoMode ? { video_mode: normalized.videoMode } : {}),
    ...(normalized.referenceImageURLs.length ? { reference_image_urls: normalized.referenceImageURLs } : {}),
    ...(normalized.referenceVideoURLs.length ? { reference_video_urls: normalized.referenceVideoURLs } : {}),
    ...(normalized.referenceAudioURLs.length ? { reference_audio_urls: normalized.referenceAudioURLs } : {}),
    ...(normalized.negativePrompt ? { negative_prompt: normalized.negativePrompt } : {}),
    ...(normalized.multiShot !== undefined ? { multi_shot: normalized.multiShot } : {}),
    ...(normalized.shotType ? { shot_type: normalized.shotType } : {}),
    ...(normalized.multiPrompt ? { multi_prompt: normalized.multiPrompt } : {}),
    ...(normalized.elementList ? { element_list: normalized.elementList } : {}),
    ...(normalized.characterOrientation ? { character_orientation: normalized.characterOrientation } : {}),
    ...(input.relayTokenName ? { token_name: input.relayTokenName } : {}),
  };
}
