import { IMAGE_ASPECT_RATIO_OPTIONS, IMAGE_QUALITY_OPTIONS, parseImageSizeDimensions } from "@/lib/image-options";
import { configuredImageModel } from "@/lib/image-model-definitions";
import { imageOutputCountLimit, supportsImageAspectRatio, supportsImageQualityValue, supportsImageExactDimensions, supportsImageResolution } from "@/lib/image-model-capabilities";
import { videoAudioControl, videoDefaultResolution, videoDefaultSize, videoResolutionOptions, videoSizeOptions } from "@/lib/video-model-capabilities";
import type { CanvasNode } from "@/services/api/canvas";
import { canvasAgentVideoDurationHint } from "./canvas-agent-generation";
import type { CanvasAgentAction } from "./canvas-agent-tools";

export function canvasAgentMediaCapabilities(imageModel: string, videoModel: string) {
  const image = configuredImageModel(imageModel);
  return {
    image: {
      aspectRatios: image?.aspect_ratios || IMAGE_ASPECT_RATIO_OPTIONS.map((item) => item.value).filter((value) => value && supportsImageAspectRatio(imageModel, value)),
      qualities: IMAGE_QUALITY_OPTIONS.map((item) => item.value).filter((value) => supportsImageQualityValue(imageModel, value)),
      resolutions: image?.resolutions || ["512", "1k", "1080p", "2k", "4k"].filter((value) => supportsImageResolution(imageModel, value)),
      exactDimensions: supportsImageExactDimensions(imageModel),
      maxCount: imageOutputCountLimit(imageModel),
    },
    video: {
      sizes: videoSizeOptions(videoModel),
      resolutions: videoResolutionOptions(videoModel),
      duration: canvasAgentVideoDurationHint(videoModel),
      audioControl: videoAudioControl(videoModel),
    },
  };
}

type MediaSettingsResult =
  | { ok: true; parameters: Partial<CanvasNode> }
  | { ok: false; code: string; message: string; supported: unknown };

export function resolveCanvasAgentMediaSettings(action: CanvasAgentAction, model: string, defaults: Partial<CanvasNode>): MediaSettingsResult {
  const required = action.name === "generate_video" ? ["size", "seconds", "generateAudio"] : ["size", "count"];
  const missing = required.filter((field) => action.arguments[field] === undefined || (typeof action.arguments[field] === "string" && !action.arguments[field].trim()));
  if (missing.length) return { ok: false, code: "missing_media_parameters", message: `缺少必要交付参数：${missing.join("、")}。请先通过 ask_user_question 询问用户；已明确要求或委托的参数可直接填写，不得静默使用默认值。`, supported: { required, missing } };
  const size = typeof action.arguments.size === "string" ? action.arguments.size.trim() : "";
  if (action.name === "generate_video") {
    const resolution = typeof action.arguments.resolution === "string" ? action.arguments.resolution.trim() : "";
    const sizes = videoSizeOptions(model);
    const resolutions = videoResolutionOptions(model);
    const audioControl = videoAudioControl(model);
    if (action.arguments.generateAudio === false && audioControl === "always") return { ok: false, code: "video_audio_required", message: "当前视频模型总是生成声音，不能生成静音视频。请确认是否接受有声视频或选择支持静音的模型。", supported: { audioControl } };
    if (size && !sizes.includes(size)) return { ok: false, code: "unsupported_video_size", message: "当前视频模型不支持此尺寸，请根据支持列表重新选择。", supported: sizes };
    if (resolution && !resolutions.includes(resolution)) return { ok: false, code: "unsupported_video_resolution", message: "当前视频模型不支持此清晰度，请根据支持列表重新选择。", supported: resolutions };
    return { ok: true, parameters: {
      generation_video_size: size || videoDefaultSize(model),
      generation_video_resolution: resolution || videoDefaultResolution(model),
    } };
  }
  const capabilities = canvasAgentMediaCapabilities(model, "").image;
  const count = action.arguments.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > capabilities.maxCount) return { ok: false, code: "unsupported_image_count", message: "图片数量超出当前模型单次上限。请在用户已确认的总数量内拆分调用，不得静默减少交付数量。", supported: { min: 1, max: capabilities.maxCount } };
  const quality = typeof action.arguments.quality === "string" ? action.arguments.quality.trim() : "";
  const resolution = typeof action.arguments.resolution === "string" ? action.arguments.resolution.trim() : "";
  if (quality && !capabilities.qualities.includes(quality as "low" | "medium" | "high")) return { ok: false, code: "unsupported_image_quality", message: "当前图片模型不支持此画质，请根据支持列表选择或省略画质参数。", supported: capabilities.qualities };
  if (resolution && !capabilities.resolutions.includes(resolution)) return { ok: false, code: "unsupported_image_resolution", message: "当前图片模型不支持此分辨率，请根据支持列表选择。", supported: capabilities.resolutions };
  // The existing image adapter translates dimensions to aspect ratio/resolution when needed.
  if (size && size !== "auto" && !capabilities.aspectRatios.includes(size) && !parseImageSizeDimensions(size)) {
    return { ok: false, code: "unsupported_image_size", message: "请使用模型支持的图片比例或有效的宽x高尺寸。", supported: capabilities };
  }
  const defaultQuality = defaults.generation_quality || "";
  return { ok: true, parameters: {
    generation_size: size || defaults.generation_size,
    generation_quality: (quality || (supportsImageQualityValue(model, defaultQuality) ? defaultQuality : "")) as CanvasNode["generation_quality"],
    ...((resolution || defaults.generation_resolution) ? { generation_resolution: resolution || (supportsImageResolution(model, defaults.generation_resolution!) ? defaults.generation_resolution : "") } : {}),
  } };
}
