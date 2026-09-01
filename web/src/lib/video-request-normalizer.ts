import {
  videoContractGenerationMode,
  videoContractMaterialError,
  videoContractRuleError,
  videoContractUIState,
  videoModelContract,
  type VideoModelContract,
  type VideoModelGenerationMode,
} from "./video-model-contracts.ts";

export function videoWorkbenchReferenceLimitError(model: string, imageCount: number, videoCount: number, audioCount: number) {
  const contract = videoModelContract(model);
  if (!contract) return "";
  const limits = contract.capability.references;
  if (imageCount > limits.image) return `当前模型参考图最多 ${limits.image} 张`;
  if (videoCount > limits.video) return `当前模型参考视频最多 ${limits.video} 个`;
  if (audioCount > limits.audio) return `当前模型参考音频最多 ${limits.audio} 个`;
  if (limits.total > 0 && imageCount + videoCount + audioCount > limits.total) return `当前模型参考素材合计最多 ${limits.total} 个`;
  return "";
}

export function videoAudioGenerationError(model: string, enabled: boolean, imageCount: number) {
  const contract = videoModelContract(model);
  if (!contract) return "";
  return videoContractRuleError(contract, {
    generate_audio: enabled,
    reference_image: imageCount,
  });
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
  firstFrameURL?: string;
  lastFrameURL?: string;
  referenceVideoURLs?: string[];
  referenceAudioURLs?: string[];
  systemPrompt?: string;
};

export type VideoGenerationTaskRequestInput = VideoRequestInput & {
  clientTaskId: string;
  prompt: string;
  relayTokenName?: string;
};

export type NormalizedVideoRequest = {
  model: string;
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
};

export type VideoReferenceCombinationInput = Pick<
  VideoRequestInput,
  "model" | "referenceMode" | "firstFrameURL" | "lastFrameURL" | "referenceImageURLs" | "referenceVideoURLs" | "referenceAudioURLs"
> & { ordinaryReferenceImageCount?: number };

function cleanURLs(values: string[] | undefined) {
  return (values || []).map((value) => String(value || "").trim()).filter(Boolean);
}

function videoRequestRuleValues(input: VideoRequestInput & { ordinaryReferenceImageCount?: number }) {
  return {
    first_frame: String(input.firstFrameURL || "").trim(),
    last_frame: String(input.lastFrameURL || "").trim(),
    reference_image: Math.max(0, Math.floor(input.ordinaryReferenceImageCount ?? cleanURLs(input.referenceImageURLs).length)),
    reference_video: cleanURLs(input.referenceVideoURLs).length,
    reference_audio: cleanURLs(input.referenceAudioURLs).length,
    generate_audio: Boolean(input.generateAudio),
    size: String(input.size || "").trim(),
    resolution: String(input.resolution || "").trim(),
    duration: Number(input.seconds),
    watermark: Boolean(input.watermark),
  };
}

function visibleVideoRequestInput<T extends VideoRequestInput & { ordinaryReferenceImageCount?: number }>(input: T, contract: VideoModelContract): T {
  const state = videoContractUIState(contract, videoRequestRuleValues(input));
  return {
    ...input,
    ...(state.hidden.has("first_frame") ? { firstFrameURL: "" } : {}),
    ...(state.hidden.has("last_frame") ? { lastFrameURL: "" } : {}),
    ...(state.hidden.has("reference_image") ? { referenceImageURLs: [], ordinaryReferenceImageCount: 0 } : {}),
    ...(state.hidden.has("reference_video") ? { referenceVideoURLs: [] } : {}),
    ...(state.hidden.has("reference_audio") ? { referenceAudioURLs: [] } : {}),
    ...(state.hidden.has("size") ? { size: "" } : {}),
    ...(state.hidden.has("resolution") ? { resolution: "" } : {}),
    ...(state.hidden.has("generate_audio") ? { generateAudio: undefined } : {}),
    ...(state.hidden.has("watermark") ? { watermark: undefined } : {}),
  };
}

function inferredGenerationKind(input: VideoReferenceCombinationInput): VideoModelGenerationMode["kind"] {
  const hasFrames = Boolean(String(input.firstFrameURL || "").trim() || String(input.lastFrameURL || "").trim());
  const images = cleanURLs(input.referenceImageURLs).length;
  const videos = cleanURLs(input.referenceVideoURLs).length;
  const audios = cleanURLs(input.referenceAudioURLs).length;
  if (input.referenceMode === "reference" || videos + audios > 0) return "reference";
  if (hasFrames || images > 0) return "image";
  return "text";
}

function contractMaterialCounts(input: VideoReferenceCombinationInput, kind: VideoModelGenerationMode["kind"]) {
  const firstFrame = String(input.firstFrameURL || "").trim();
  const lastFrame = String(input.lastFrameURL || "").trim();
  const images = Math.max(0, Math.floor(input.ordinaryReferenceImageCount ?? cleanURLs(input.referenceImageURLs).length));
  let remainingImages = images;
  let firstFrameCount = firstFrame ? 1 : 0;
  let lastFrameCount = lastFrame ? 1 : 0;
  if (kind === "image" && !firstFrame) {
    if (remainingImages > 0) {
      firstFrameCount = 1;
      remainingImages -= 1;
    }
    if (!lastFrame && remainingImages > 0) {
      lastFrameCount = 1;
      remainingImages -= 1;
    }
  }
  return {
    first_frame: firstFrameCount,
    last_frame: lastFrameCount,
    image: kind === "reference" ? images : kind === "image" ? remainingImages : 0,
    video: cleanURLs(input.referenceVideoURLs).length,
    audio: cleanURLs(input.referenceAudioURLs).length,
  };
}

export function videoReferenceCombinationError(input: VideoReferenceCombinationInput) {
  const contract = videoModelContract(input.model || "");
  if (!contract) return `视频模型 ${String(input.model || "").trim() || "未选择"} 未配置启用的视频模型契约`;
  const visibleInput = visibleVideoRequestInput(input, contract);
  const kind = inferredGenerationKind(visibleInput);
  const counts = contractMaterialCounts(visibleInput, kind);
  const materialError = videoContractMaterialError(contract, kind, counts);
  if (materialError) return materialError;
  return videoContractRuleError(contract, {
    first_frame: counts.first_frame,
    last_frame: counts.last_frame,
    reference_image: counts.image,
    reference_video: counts.video,
    reference_audio: counts.audio,
  });
}

export function composeVideoPrompt(prompt: string, systemPrompt?: string) {
  const userPrompt = String(prompt || "").trim();
  const system = String(systemPrompt || "").trim();
  return (system ? `${system}\n\n${userPrompt}` : userPrompt).trim();
}

export function normalizeStoredVideoSeconds(value: unknown) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds)) return undefined;
  return seconds === -1 ? -1 : Math.max(1, Math.min(3600, seconds));
}

function selectedOption<T extends string | number>(options: T[], requested: unknown, fallback: T): T {
  return options.find((option) => String(option).toLowerCase() === String(requested ?? "").trim().toLowerCase()) ?? fallback;
}

function modeLimit(contract: VideoModelContract, kind: VideoModelGenerationMode["kind"], field: "image" | "video" | "audio") {
  return videoContractGenerationMode(contract, kind)?.materials[field].max || 0;
}

export function normalizeVideoRequest(input: VideoRequestInput): NormalizedVideoRequest {
  const model = String(input.model || "").trim();
  const contract = videoModelContract(model);
  if (!contract) {
    throw new Error(`视频模型 ${model || "未选择"} 未配置启用的视频模型契约`);
  }
  const visibleInput = visibleVideoRequestInput(input, contract);
  const kind = inferredGenerationKind(visibleInput);
  const images = cleanURLs(visibleInput.referenceImageURLs);
  const videos = cleanURLs(visibleInput.referenceVideoURLs);
  const audios = cleanURLs(visibleInput.referenceAudioURLs);
  const firstFrame = String(visibleInput.firstFrameURL || "").trim();
  const lastFrame = String(visibleInput.lastFrameURL || "").trim();
  const capability = contract.capability;
  if (!videoContractGenerationMode(contract, kind)) {
    throw new Error(`当前视频模型不支持${kind === "image" ? "图生视频" : kind === "reference" ? "参考素材生视频" : "文生视频"}`);
  }
  const materialError = videoContractMaterialError(contract, kind, contractMaterialCounts(visibleInput, kind));
  if (materialError) throw new Error(materialError);
  const normalizedKind = kind;
  const size = capability.sizes.length > 0
    ? selectedOption(capability.sizes, visibleInput.size, capability.default_size)
    : "";
  const seconds = selectedOption(capability.seconds, Math.round(Number(visibleInput.seconds)), capability.default_seconds);
  const resolution = capability.resolutions.length > 0
    ? selectedOption(capability.resolutions, visibleInput.resolution, capability.default_resolution)
    : "";
  const referenceMode = normalizedKind === "reference" ? "reference" : "first-frame";
  const imageLimit = normalizedKind === "reference"
    ? modeLimit(contract, normalizedKind, "image")
    : (videoContractGenerationMode(contract, "image")?.materials.total.max || 0);
  const normalizedImages = images.slice(0, imageLimit);
  const normalizedVideos = videos.slice(0, modeLimit(contract, normalizedKind, "video"));
  const normalizedAudios = audios.slice(0, modeLimit(contract, normalizedKind, "audio"));
  const audioControl = capability.audio_control;
  return {
    model,
    ...(size ? { size } : {}),
    seconds,
    ...(resolution ? { resolution } : {}),
    ...(audioControl === "none" || visibleInput.generateAudio === undefined ? {} : { generateAudio: audioControl === "always" || Boolean(visibleInput.generateAudio) }),
    ...(capability.watermark && visibleInput.watermark !== undefined ? { watermark: Boolean(visibleInput.watermark) } : {}),
    referenceMode,
    ...(normalizedKind === "image" && firstFrame ? { firstFrameURL: firstFrame } : {}),
    ...(normalizedKind === "image" && lastFrame ? { lastFrameURL: lastFrame } : {}),
    referenceImageURLs: normalizedImages,
    referenceVideoURLs: normalizedVideos,
    referenceAudioURLs: normalizedAudios,
  };
}

export function videoGenerationTaskRequestBody(input: VideoGenerationTaskRequestInput) {
  const model = String(input.model || "").trim();
  const contract = videoModelContract(model);
  if (!contract) throw new Error(`视频模型 ${model || "未选择"} 未配置启用的视频模型契约`);
  const normalized = normalizeVideoRequest(input);
  const uiState = videoContractUIState(contract, videoRequestRuleValues(normalized));
  const kind = inferredGenerationKind(normalized);
  const generationMode = videoContractGenerationMode(contract, kind);
  if (!generationMode) throw new Error("当前视频模型不支持所选生成模式");
  const prompt = composeVideoPrompt(input.prompt, input.systemPrompt);
  return {
    client_task_id: input.clientTaskId,
    prompt,
    model: normalized.model,
    ...(normalized.size && !uiState.hidden.has("size") ? { size: normalized.size } : {}),
    ...(contract.request.duration_field && !uiState.hidden.has("duration") ? { seconds: normalized.seconds } : {}),
    ...(normalized.resolution && !uiState.hidden.has("resolution") ? { resolution: normalized.resolution } : {}),
    ...(normalized.generateAudio === undefined ? {} : { generate_audio: normalized.generateAudio }),
    ...(normalized.watermark === undefined ? {} : { watermark: normalized.watermark }),
    generation_mode: generationMode.request_value || generationMode.id,
    reference_mode: normalized.referenceMode,
    ...(normalized.firstFrameURL ? { first_frame_url: normalized.firstFrameURL } : {}),
    ...(normalized.lastFrameURL ? { last_frame_url: normalized.lastFrameURL } : {}),
    ...(normalized.referenceImageURLs.length ? { reference_image_urls: normalized.referenceImageURLs } : {}),
    ...(normalized.referenceVideoURLs.length ? { reference_video_urls: normalized.referenceVideoURLs } : {}),
    ...(normalized.referenceAudioURLs.length ? { reference_audio_urls: normalized.referenceAudioURLs } : {}),
    ...(input.relayTokenName ? { token_name: input.relayTokenName } : {}),
  };
}
