export type VideoModelProfile =
  | "bytedance-v1-i2v"
  | "bytedance-v1-t2v"
  | "seedance-25"
  | "seedance-20"
  | "seedance-20-fast"
  | "seedance-20-mini"
  | "seedance-15"
  | "seedance-10"
  | "kling-3"
  | "kling-kie-v3"
  | "kling-kie-26"
  | "kling-legacy"
  | "kling-kie-legacy"
  | "kling-motion"
  | "kling-avatar"
  | "kling-omni-text"
  | "kling-omni-image"
  | "kling-omni-reference"
  | "kling-omni-transformation"
  | "kling-omni"
  | "minimax-h3"
  | "minimax-hailuo"
  | "grok-15"
  | "grok"
  | "grok-kie"
  | "grok-i2v"
  | "veo-31"
  | "veo"
  | "wan-27-i2v"
  | "wan-27-kie-i2v"
  | "wan-27-r2v"
  | "wan-videoedit"
  | "wan-v2v"
  | "wan-speech"
  | "wan-animate"
  | "wan-i2v"
  | "wan-t2v"
  | "wan-kie-t2v"
  | "vidu-q3"
  | "vidu"
  | "gemini-omni"
  | "pixverse"
  | "skyreels"
  | "happyhorse"
  | "infinitalk"
  | "topaz-video"
  | "flux-3-video"
  | "jimeng"
  | "sora-pro"
  | "sora"
  | "cogvideox-3"
  | "agnes-25"
  | "agnes"
  | "vendor-unknown"
  | "generic";

export const DEFAULT_VIDEO_MODEL = "grok-imagine-video";

import capabilityDocument from "../../../internal/protocol/video_capabilities.json" with { type: "json" };

type SharedVideoCapability = {
  sizes: string[];
  seconds: number[];
  resolutions: string[];
  default_size: string;
  default_seconds: number;
  default_resolution: string;
  references: { image: number; video: number; audio: number };
  first_frame_image_limit: number;
  reference_mode: boolean;
  audio_control: "toggle" | "always" | "none";
  watermark: boolean;
};

const sharedCapabilities = capabilityDocument.profiles as Record<VideoModelProfile, SharedVideoCapability>;
const integerRange = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** Keep the creator UI in lockstep with the provider model aliases. */
export function canonicalVideoModel(model: string): string {
  const value = String(model || "").trim().toLowerCase();
  const aliases: Record<string, string> = {
    "kling/text-to-video": "kling-2.6/text-to-video",
    "kling/image-to-video": "kling-2.6/image-to-video",
    "kling/motion-control": "kling-2.6/motion-control",
    "kling/motion-control-v3": "kling-3.0/motion-control",
    "kling/kling-3-0": "kling-3.0/video",
    "kling/v25-turbo-image-to-video-pro": "kling/v2-5-turbo-image-to-video-pro",
    "kling/v25-turbo-text-to-video-pro": "kling/v2-5-turbo-text-to-video-pro",
    "bytedance/seedance-1-5-pro": "bytedance/seedance-1.5-pro",
    "grok-imagine/1-5-preview": "grok-imagine-video-1-5-preview",
    "grok-imagine/grok-imagine-1.5-preview": "grok-imagine-video-1-5-preview",
    "grok-imagine-1.5-video": "grok-imagine-video-1-5-preview",
    "grok-imagine-1.5-preview": "grok-imagine-video-1-5-preview",
  };
  return aliases[value] || String(model || "").trim();
}

/** Mirrors `isSeedanceVideoConfig` in the reference workbench for model IDs. */
export function isReferenceSeedanceVideoModel(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
  return value.includes("seedance") || value.includes("doubao-seedance");
}

function videoCapability(model: string): SharedVideoCapability {
  const base = sharedCapabilities[videoModelProfile(model)] || sharedCapabilities.generic;
  const value = canonicalVideoModel(model).toLowerCase();
  const capability: SharedVideoCapability = { ...base, references: { ...base.references } };
  const clearReferences = () => {
    capability.first_frame_image_limit = 0;
    capability.reference_mode = false;
    capability.references = { image: 0, video: 0, audio: 0 };
  };
  if (value.startsWith("hailuo/02-image-to-video")) {
    capability.first_frame_image_limit = 2;
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
  } else if (value.startsWith("hailuo/02-text-to-video")) {
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
    capability.resolutions = [];
    capability.default_resolution = "";
    clearReferences();
	} else if (value === "kling-2.6/motion-control" || value === "kling-3.0/motion-control") {
		// KIE derives duration from the driving clip and has no quality/mode
		// parameter. APIMart's hyphenated motion-control models still expose it.
		capability.resolutions = [];
		capability.default_resolution = "";
  } else if (value.startsWith("hailuo/2-3-image-to-video")) {
    capability.first_frame_image_limit = 1;
  } else if (value.includes("minimax-hailuo-2-3") || value.includes("minimax-hailuo-2.3")) {
    capability.first_frame_image_limit = 1;
	} else if (value === "kling/v3-turbo-image-to-video") {
		capability.sizes = [];
		capability.default_size = "";
		capability.first_frame_image_limit = 2;
	} else if (value === "kling-2.6/image-to-video") {
		capability.first_frame_image_limit = 2;
  } else if (value === "kling/v3-turbo-text-to-video" || value === "kling-2.6/text-to-video" || value === "kling/v2-1-master-text-to-video" || value === "kling/v2-5-turbo-text-to-video-pro" || value === "grok-imagine/text-to-video") {
    capability.first_frame_image_limit = 0;
  } else if (value === "minimax-h3/text-to-video") {
    clearReferences();
	} else if (value === "minimax-h3/image-to-video") {
		capability.sizes = [];
		capability.default_size = "";
		// KIE's H3 image-to-video schema accepts only first_frame_url.
		capability.first_frame_image_limit = 1;
		capability.reference_mode = false;
    capability.references = { image: 0, video: 0, audio: 0 };
  } else if (value === "minimax-h3/reference-to-video") {
    capability.first_frame_image_limit = 0;
  } else if (value === "grok-imagine/image-to-video") {
    capability.first_frame_image_limit = 9;
    capability.references = { image: 9, video: 0, audio: 0 };
  } else if (value === "happyhorse/text-to-video" || value === "happyhorse-1-1/text-to-video") {
    clearReferences();
  } else if (value === "happyhorse/image-to-video") {
    capability.sizes = [];
    capability.default_size = "";
    capability.first_frame_image_limit = 9;
    capability.reference_mode = false;
    capability.references = { image: 0, video: 0, audio: 0 };
  } else if (value === "happyhorse-1-1/image-to-video") {
    capability.sizes = [];
    capability.default_size = "";
    capability.first_frame_image_limit = 1;
    capability.reference_mode = false;
    capability.references = { image: 0, video: 0, audio: 0 };
  } else if (value === "happyhorse/reference-to-video" || value === "happyhorse-1-1/reference-to-video") {
    capability.first_frame_image_limit = 0;
    capability.references = { image: 9, video: 0, audio: 0 };
  } else if (value === "happyhorse/video-edit") {
    capability.sizes = [];
    capability.default_size = "";
  }
  // KIE exposes these models as separate APIs. Do not inherit the generic
  // Kling/Wan profile: the accepted fields differ per endpoint.
  if (value === "kling-2.6/image-to-video") {
    capability.sizes = [];
    capability.resolutions = [];
    capability.default_size = "";
    capability.default_resolution = "";
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
  } else if (value === "kling-2.6/text-to-video") {
    capability.sizes = ["16:9", "9:16", "1:1"];
    capability.resolutions = [];
    capability.default_size = "16:9";
    capability.default_resolution = "";
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
  } else if (value === "kling/v2-1-master-image-to-video" || value === "kling/v2-1-pro" || value === "kling/v2-1-standard" || value === "kling/v2-5-turbo-image-to-video-pro") {
    capability.sizes = [];
    capability.resolutions = [];
    capability.default_size = "";
    capability.default_resolution = "";
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
  } else if (value === "kling/v2-1-master-text-to-video" || value === "kling/v2-5-turbo-text-to-video-pro") {
    capability.sizes = ["16:9", "9:16", "1:1"];
    capability.resolutions = [];
    capability.default_size = "16:9";
    capability.default_resolution = "";
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
  } else if (value.includes("grok-imagine-video-1.5") || value.includes("grok-imagine-video-1-5")) {
    capability.references = { image: 9, video: 0, audio: 0 };
    capability.first_frame_image_limit = 9;
    capability.reference_mode = false;
    capability.audio_control = "none";
  } else if (value === "gemini-omni-video") {
    // KIE's audio_ids are provider-issued IDs, not public reference URLs.
    capability.references = { image: 9, video: 3, audio: 0 };
    capability.first_frame_image_limit = 1;
    capability.reference_mode = true;
	} else if (value.includes("vidu")) {
		// APIMart treats Vidu image inputs as a first/last-frame pair.
		capability.references = { image: 0, video: 0, audio: 0 };
		capability.first_frame_image_limit = 2;
		capability.reference_mode = false;
  } else if (value === "bytedance/seedance-1.5-pro") {
    capability.first_frame_image_limit = 9;
  } else if (value.startsWith("wan/2-6-")) {
    capability.resolutions = ["480p", "720p", "1080p"];
    capability.default_resolution = "720p";
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
    capability.watermark = false;
		capability.audio_control = value === "wan/2-6-flash-image-to-video"
			|| value === "wan/2-6-flash-video-to-video"
			|| value === "wan/2-6-i2v-flash"
			? "toggle"
			: "none";
		if (value.includes("text-to-video")) {
			if (value === "wan/2-6-text-to-video") {
				capability.sizes = [];
				capability.default_size = "";
			} else {
				capability.sizes = ["16:9", "9:16", "1:1", "4:3", "3:4"];
				capability.default_size = "16:9";
			}
      capability.references = { image: 0, video: 0, audio: 0 };
      capability.first_frame_image_limit = 0;
      capability.reference_mode = false;
    } else if (value.includes("video-to-video")) {
      capability.sizes = [];
      capability.default_size = "";
      capability.references = { image: 0, video: 1, audio: 0 };
      capability.first_frame_image_limit = 0;
      capability.reference_mode = true;
    } else {
      capability.sizes = [];
      capability.default_size = "";
      capability.references = { image: 9, video: 0, audio: 0 };
      capability.first_frame_image_limit = 9;
      capability.reference_mode = false;
    }
  } else if (value === "wan/2-5-image-to-video") {
    capability.sizes = [];
    capability.resolutions = ["480p", "720p", "1080p"];
    capability.default_size = "";
    capability.default_resolution = "720p";
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
    capability.references = { image: 0, video: 0, audio: 0 };
    capability.first_frame_image_limit = 1;
    capability.reference_mode = false;
    capability.audio_control = "none";
    capability.watermark = false;
  } else if (value === "wan/2-5-text-to-video") {
    capability.sizes = ["16:9", "9:16", "1:1", "4:3", "3:4"];
    capability.resolutions = ["480p", "720p", "1080p"];
    capability.default_size = "16:9";
    capability.default_resolution = "720p";
    capability.seconds = [5, 10];
    capability.default_seconds = 5;
    capability.references = { image: 0, video: 0, audio: 0 };
    capability.first_frame_image_limit = 0;
    capability.reference_mode = false;
  } else if (value.startsWith("wan/2-2-a14b-") || value.startsWith("wan/2-2-animate-")) {
    capability.seconds = [5];
    capability.default_seconds = 5;
    capability.resolutions = ["480p", "720p", "1080p"];
    capability.default_resolution = "720p";
    capability.sizes = value.includes("text-to-video") ? ["16:9", "9:16", "1:1", "4:3", "3:4"] : [];
    capability.default_size = value.includes("text-to-video") ? "16:9" : "";
    capability.watermark = false;
    if (value.includes("image-to-video")) {
      capability.references = { image: 0, video: 0, audio: 0 };
      capability.first_frame_image_limit = 1;
      capability.reference_mode = false;
      capability.audio_control = "none";
    } else if (value.includes("text-to-video")) {
      clearReferences();
      capability.audio_control = "none";
    }
  }
  // Family defaults are too broad for these concrete provider endpoints.
  // Keep the controls aligned with the reference workbench and its payload.
	if (value === "kling-3.0/video") {
		capability.resolutions = [];
		capability.default_resolution = "";
		capability.watermark = false;
	} else if (value === "kling-3-0-turbo") {
		capability.sizes = ["1280x720", "720x1280", "1024x1024", "1792x1024", "1024x1792"];
		capability.seconds = integerRange(1, 30);
		capability.resolutions = ["720p", "480p", "1080p", "2k", "4k"];
		capability.default_size = "1280x720";
		capability.default_seconds = 6;
		capability.default_resolution = "720p";
		capability.references = { image: 0, video: 0, audio: 0 };
		capability.first_frame_image_limit = 1;
		capability.reference_mode = false;
    capability.audio_control = "none";
		capability.watermark = false;
  } else if (value.includes("viduq3-pro") || value.includes("vidu-q3-pro") || value.includes("viduq3-turbo")) {
    capability.audio_control = "toggle";
  } else if (value.includes("pixverse") && !value.includes("pixverse-v6")) {
    capability.audio_control = "none";
  } else if ((videoModelProfile(value) === "veo" || videoModelProfile(value) === "veo-31") && !value.includes("official")) {
    capability.audio_control = "none";
	} else if (videoModelProfile(value) === "wan-27-i2v") {
		capability.audio_control = "none";
	} else if (videoModelProfile(value) === "wan-v2v" && !value.includes("wan2-6-flash-video-to-video")) {
		// The reference workbench only exposes generated audio for the Wan 2.6
		// flash video-to-video endpoint. A regular V2V task may still accept a
		// reference audio asset, but that is a different input and not a toggle.
		capability.audio_control = "none";
	} else if (value.includes("wan2-6") || value.includes("wan2.6")) {
		const wan26Audio = value === "wan2-6"
			|| value === "wan2.6"
			|| value === "wan2-6-i2v-flash"
			|| value === "wan2.6-i2v-flash"
			|| value === "wan2-6-flash-image-to-video"
			|| value === "wan2.6-flash-image-to-video"
			|| value === "wan2-6-flash-video-to-video"
			|| value === "wan2.6-flash-video-to-video";
		capability.audio_control = wan26Audio ? "toggle" : "none";
	} else if ((value.includes("wan2-5") || value.includes("wan2.5")) && !value.startsWith("wan/")) {
    capability.audio_control = "none";
    capability.watermark = false;
  } else if ((value.includes("wan2") || value.includes("wan-2")) && !value.startsWith("wan/") && !value.includes("wan2-6") && !value.includes("wan2.6") && !value.includes("wan-2-6")) {
    // The reference workbench exposes generated audio only for APIMart Wan
    // 2.6 endpoints. Other Wan releases may accept reference audio, which is
    // a separate input and must not surface as a generation toggle.
    capability.audio_control = "none";
  } else if (videoModelProfile(value) === "kling-omni-transformation") {
    capability.audio_control = "toggle";
  }
  return capability;
}

export function videoModelProfile(model: string): VideoModelProfile {
  const value = canonicalVideoModel(model).toLowerCase();
  if (value.startsWith("bytedance/v1-")) {
    if (value.includes("image-to-video")) return "bytedance-v1-i2v";
    if (value.includes("text-to-video")) return "bytedance-v1-t2v";
  }
  if (value.includes("seedance") || value.includes("doubao-seedance")) {
    if (value.includes("2-5") || value.includes("2.5") || value.includes("seedance-2-5")) return "seedance-25";
    if (value.includes("2-0") || value.includes("2.0") || /seedance-2(?:$|-)/.test(value)) {
      if (value.includes("fast")) return "seedance-20-fast";
      if (value.includes("mini")) return "seedance-20-mini";
      return "seedance-20";
    }
    if (value.includes("1-5") || value.includes("1.5")) return "seedance-15";
    if (value.includes("1-0") || value.includes("1.0")) return "seedance-10";
    if (value.includes("fast")) return "seedance-20-fast";
    if (value.includes("mini")) return "seedance-20-mini";
    return "seedance-20";
  }
  if (value.includes("kling")) {
    if (value.includes("ai-avatar")) return "kling-avatar";
    if (value.includes("motion-control")) return "kling-motion";
    if (value.includes("omni") || value.includes("video-o1")) {
      if (value.includes("transformation")) return "kling-omni-transformation";
      if (value.includes("reference-to-video")) return "kling-omni-reference";
      if (value.includes("image-to-video")) return "kling-omni-image";
      if (value.includes("text-to-video")) return "kling-omni-text";
      return "kling-omni";
    }
    if (value.startsWith("kling-2.6/")) return "kling-kie-26";
    if (value.startsWith("kling/v3-")) return "kling-kie-v3";
    if (value.includes("v3") || value.includes("3-0") || value.includes("3.0")) return "kling-3";
    if (value.startsWith("kling/v1-") || value.startsWith("kling/v2-")) return "kling-kie-legacy";
    if (/kling[-_./]?(?:v)?[12](?:[-_./]|$)/.test(value)) return "kling-legacy";
    return "vendor-unknown";
  }
  if (value.includes("minimax") || value.includes("hailuo") || value.startsWith("t2v-") || value.startsWith("i2v-") || value.startsWith("s2v-")) {
    return value.includes("h3") ? "minimax-h3" : "minimax-hailuo";
  }
  if (value.includes("grok")) {
    if (value.includes("1.5") || value.includes("1-5")) return "grok-15";
    if (value === "grok-imagine/image-to-video") return "grok-i2v";
    if (value === "grok-imagine" || value === "grok-imagine-video" || value === "grok-imagine-video-latest") return "grok";
    if (value === "grok-imagine/text-to-video") return "grok-kie";
    return "vendor-unknown";
  }
  if (/^(?:models\/)?veo[-_.]?3[-_.]?1/.test(value) || value.includes("veo3.1") || value.includes("veo-3.1")) return "veo-31";
  if (value.includes("veo")) return "veo";
  if (value.includes("wan2") || value.includes("wan/2") || value.includes("wan-2")) {
    if (value.includes("speech-to-video")) return "wan-speech";
    if (value.includes("animate-move") || value.includes("animate-replace")) return "wan-animate";
    if (value.includes("r2v") || value.includes("reference-to-video")) return "wan-27-r2v";
    if (value.includes("videoedit") || value.includes("video-edit")) return "wan-videoedit";
    if (value.includes("v2v") || value.includes("video-to-video")) return "wan-v2v";
    if ((value.includes("2.7") || value.includes("2-7") || value.includes("/2-7")) && (value.includes("i2v") || value.includes("image-to-video"))) {
      return value.includes("wan/2-7") ? "wan-27-kie-i2v" : "wan-27-i2v";
    }
    if (value.includes("i2v") || value.includes("image-to-video")) return "wan-i2v";
    if (value.startsWith("wan/") && value.includes("text-to-video")) return "wan-kie-t2v";
    return "wan-t2v";
  }
  if (value.includes("viduq3") || value.includes("vidu-q3")) return "vidu-q3";
  if (value.includes("vidu")) return "vidu";
  if (value.includes("gemini-omni") || value.includes("omni-flash")) return "gemini-omni";
  if (value.includes("pixverse")) return "pixverse";
  if (value.includes("skyreels")) return "skyreels";
  if (value.includes("happyhorse")) return "happyhorse";
  if (value.includes("infinitalk")) return "infinitalk";
  if (value.includes("topaz") && value.includes("video")) return "topaz-video";
  if (value.includes("flux-3-video")) return "flux-3-video";
  if (value.includes("jimeng") || value.includes("即梦")) return "jimeng";
  if (value.includes("sora")) {
    if (value.includes("sora-2") || value.includes("sora_2")) return value.includes("pro") ? "sora-pro" : "sora";
    return "vendor-unknown";
  }
  if (value === "cogvideox-3" || value === "cogvideo-x3" || value.includes("cogvideox-3")) return "cogvideox-3";
  if (value.replace(/[._/]+/g, "-") === "agnes-video-2-5") return "agnes-25";
  if (value.includes("agnes-video")) return "agnes";
  return "generic";
}

/** Values mirror the provider's official `ratio`/`aspect_ratio` enums. */
export function videoSizeOptions(model: string): string[] {
  const profile = videoModelProfile(model);
  // `adaptive` is a transport value for H3 reference mode, not a standalone
  // text-to-video choice in the composer. The normalizer selects it when a
  // reference asset is present.
  const supported = [...videoCapability(model).sizes].filter((size) => !(profile === "minimax-h3" && size === "adaptive"));
  if (isReferenceSeedanceVideoModel(model)) {
    return ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"];
  }
  return supported;
}

export function videoSecondsOptions(model: string): number[] {
  const profile = videoModelProfile(model);
  if (profile === "generic" || profile === "agnes") return integerRange(1, 30);
  return [...videoCapability(model).seconds];
}

export function videoDefaultSeconds(model: string) {
  const capability = videoCapability(model);
  if (isReferenceSeedanceVideoModel(model)) return 5;
  if (videoModelProfile(model) === "minimax-hailuo") return capability.default_seconds || 6;
  if (usesReferenceGenericVideoPanel(model)) return 6;
  return capability?.default_seconds || videoSecondsOptions(model).find((value) => value > 0) || 4;
}

export function videoDefaultSize(model: string) {
  const capability = videoCapability(model);
  if (isReferenceSeedanceVideoModel(model)) return "adaptive";
  if (usesReferenceGenericVideoPanel(model)) return "1280x720";
  return capability?.default_size || videoSizeOptions(model)[0] || "";
}

export function videoDefaultResolution(model: string, seconds?: number) {
  const capability = videoCapability(model);
  if (isReferenceSeedanceVideoModel(model)) return "720p";
  if (usesReferenceGenericVideoPanel(model)) return "720p";
  const requestedDefault = capability?.default_resolution || "";
  const options = videoResolutionOptions(model, seconds);
  return options.find((value) => value.toLowerCase() === requestedDefault.toLowerCase()) || options[0] || "";
}

export function videoResolutionOptions(model: string, seconds?: number): string[] {
  const profile = videoModelProfile(model);
  const value = canonicalVideoModel(model).toLowerCase();
  if (value.includes("kling-v2-6-motion-control") || value.includes("kling-v3-motion-control")) {
    return ["720p", "1080p"];
  }
  if (profile === "minimax-hailuo" && seconds === 10) return ["768P"];
  return [...videoCapability(model).resolutions]
}

export function videoReferenceImageLimit(model: string) {
	const value = canonicalVideoModel(model).toLowerCase();
	if (value.startsWith("bytedance/v1-")) return value.includes("v1-lite-image-to-video") ? 2 : value.includes("text-to-video") ? 0 : 1;
	if (value === "minimax-h3/image-to-video") return 1;
	if (value === "kling-2.6/image-to-video" || value === "kling/v3-turbo-image-to-video") return 2;
	if (value.startsWith("hailuo/02-image-to-video")) return 2;
	if (value.startsWith("hailuo/2-3-image-to-video")) return 1;
	if (value === "bytedance/seedance-2" || value === "bytedance/seedance-2-fast" || value === "bytedance/seedance-2-mini" || value === "bytedance/seedance-2-5") return 2;
	if (value === "wan/2-7-image-to-video") return 2;
  if (value === "kling/v2-1-pro" || value === "kling/v2-5-turbo-image-to-video-pro") return 2;
  if (value === "kling/v2-1-master-image-to-video" || value === "kling/v2-1-standard") return 1;
  return videoCapability(model).first_frame_image_limit;
}

/** Models for which the reference workbench exposes independent first/last-frame slots. */
export function supportsVideoFrameReferences(model: string, protocol = "") {
  const key = canonicalVideoModel(model).trim().toLowerCase().replace(/[._/]+/g, "-");
  return (protocol === "gemini" && (key.startsWith("veo-3-1") || key.startsWith("veo3-1")))
    || (key.includes("veo3-1") && key.includes("official"))
    || key === "agnes-video-2-5"
    || key === "cogvideox-3"
    || key === "bytedance-seedance-2"
    || key === "bytedance-seedance-2-fast"
    || key === "bytedance-seedance-2-mini"
    || key === "bytedance-seedance-2-5"
    || key === "wan-2-7-image-to-video"
    || key === "bytedance-v1-lite-image-to-video"
    || key === "hailuo-02-image-to-video-standard"
    || key === "hailuo-02-image-to-video-pro"
    || key === "kling-v2-1-pro"
    || key === "kling-v2-5-turbo-image-to-video-pro"
    || key === "minimax-h3-image-to-video"
    || key === "minimax-h3"
    || key.includes("doubao-seedance-2-5")
    || key.includes("doubao-seedance-2-0")
    || key.includes("doubao-seedance-1-5")
    || key.includes("doubao-seedance-1-0")
    || key === "happyhorse-1-1"
    || key.includes("minimax-hailuo-02")
    || key.includes("skyreels-v4")
    || key.includes("pixverse-v6")
    || key.includes("viduq3")
    || key.includes("vidu-q3");
}

export function supportsVideoMultimodalReferences(model: string) {
  return videoCapability(model).reference_mode;
}

function isKIEKlingUniversalV3(model: string) {
  return canonicalVideoModel(model).toLowerCase() === "kling-3.0/video";
}

export function klingOmniVariant(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
  const prefix = "kling-3.0-omni/";
  if (!value.startsWith(prefix)) return "";
  const variant = value.slice(prefix.length);
  return ["text-to-video", "image-to-video", "reference-to-video", "transformation"].includes(variant) ? variant : "";
}

export function supportsKlingNegativePrompt(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
	if (value === "kling-3-0-turbo") return false;
  const profile = videoModelProfile(value);
  return !value.includes("/") && (profile === "kling-3" || profile === "kling-legacy");
}

export function supportsKlingMultiShot(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
	if (value === "kling-3-0-turbo") return false;
  const omni = klingOmniVariant(value);
  if (omni) return omni !== "transformation";
  return isKIEKlingUniversalV3(value) || (!value.includes("/") && videoModelProfile(value) === "kling-3");
}

export function supportsKlingShotType(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
  const omni = klingOmniVariant(value);
  if (omni) return omni === "text-to-video" || omni === "image-to-video";
  return !value.includes("/") && videoModelProfile(value) === "kling-3";
}

export function supportsKlingElements(model: string) {
  return supportsKlingMultiShot(model);
}

export function supportsKlingMode(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
	if (value === "kling-3-0-turbo") return false;
  const profile = videoModelProfile(value);
  return isKIEKlingUniversalV3(value) || Boolean(klingOmniVariant(value)) || (!value.includes("/") && (profile === "kling-3" || profile === "kling-legacy"));
}

export function videoMultimodalReferenceLimits(model: string) {
  return { ...videoCapability(model).references };
}

/** Material limits rendered by the reference workbench before provider validation. */
export function videoWorkbenchReferenceLimits(model: string) {
  const profile = videoModelProfile(model);
  const omni = klingOmniVariant(model);
  if (usesReferenceSpecialVideoPanel(model) && profile.startsWith("kling-")) {
    if (omni === "text-to-video") return { image: 0, video: 0, audio: 0 };
    if (omni === "image-to-video") return { image: 2, video: 0, audio: 0 };
    if (omni === "reference-to-video") return { image: 9, video: 1, audio: 0 };
    if (omni === "transformation") return { image: 4, video: 1, audio: 0 };
    return { image: 2, video: 0, audio: 0 };
  }
  return { image: 9, video: 3, audio: 3 };
}

export function videoRequiresReferenceImage(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
  const profile = videoModelProfile(value);
  // Wan 2.7 accepts either a first-frame image or a source video. The shared
  // submit validation enforces that at least one visual reference is present.
  if (profile === "wan-27-i2v" || profile === "wan-27-kie-i2v") return false;
  return value.includes("hailuo-2.3-fast")
    || value.includes("image-to-video")
    || value.startsWith("i2v-")
    || profile === "wan-i2v"
    || profile === "wan-speech"
    || profile === "wan-animate"
    || profile === "bytedance-v1-i2v"
    || profile === "vidu-q3"
    || profile === "grok-i2v"
    || profile === "kling-motion"
    || profile === "kling-avatar"
    || (profile === "minimax-hailuo" && value.includes("image-to-video"))
    || profile === "kling-omni-image"
    || (profile === "happyhorse" && value.includes("image-to-video"))
    || profile === "infinitalk";
}

export function videoRequiresReferenceVideo(model: string) {
  const value = String(model || "").trim().toLowerCase();
  const profile = videoModelProfile(value);
  return profile === "wan-v2v"
    || profile === "wan-videoedit"
    || profile === "wan-animate"
    || profile === "kling-motion"
    || profile === "kling-omni-transformation"
    || (profile === "happyhorse" && value.includes("video-edit"))
    || profile === "topaz-video";
}

export function videoRequiresReferenceAudio(model: string) {
  const profile = videoModelProfile(model);
  return profile === "wan-speech" || profile === "kling-avatar" || profile === "infinitalk";
}

export function videoRequiresMultimodalReferenceMode(model: string) {
  const value = canonicalVideoModel(model).toLowerCase();
  return videoRequiresReferenceVideo(model) || videoRequiresReferenceAudio(model) || value.includes("reference-to-video");
}

export function videoAudioControl(model: string): "toggle" | "always" | "none" {
  return referenceWorkbenchSupportsVideoAudio(model) ? "toggle" : "none";
}

/** Conditions that make the reference workbench's audio-generation switch unavailable. */
export function videoAudioGenerationDisabled(model: string, mode: string, imageCount: number, videoCount: number) {
  const key = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
  if (key === "kling-v2-6") return mode !== "pro" || imageCount > 1;
  return videoModelProfile(model) === "kling-omni-reference" && videoCount > 0;
}

/** Mirrors `supportsVideoAudioGeneration` in tigerowo/infinite-canvas. */
export function referenceWorkbenchSupportsVideoAudio(model: string) {
  const value = String(model || "").trim().toLowerCase().replace(/[._/]+/g, "-");
  if (value.includes("motion-control")) return false;
  return value === "cogvideox-3"
    || value === "kling-2-6-text-to-video"
    || value === "kling-2-6-image-to-video"
    || value === "kling-text-to-video"
    || value === "kling-image-to-video"
    || value === "bytedance-seedance-2"
    || value === "bytedance-seedance-2-fast"
    || value === "bytedance-seedance-2-mini"
    || value === "bytedance-seedance-2-5"
    || value === "wan-2-6-flash-image-to-video"
    || value === "wan-2-6-flash-video-to-video"
    || value.includes("bytedance-seedance-1-5")
    || value.includes("doubao-seedance-2-5")
    || value.includes("doubao-seedance-2-0")
    || value.includes("doubao-seedance-1-5")
    || (value.includes("veo") && value.includes("official"))
    || value === "wan2-6"
    || value === "wan2-6-i2v-flash"
    || value.includes("kling-v2-6")
    || value.includes("kling-2-6")
    || ((value.includes("kling-v3") || value.includes("kling-3-0")) && !value.includes("turbo"))
    || value.includes("pixverse-v6")
    || value.includes("viduq3-pro")
    || value.includes("vidu-q3-pro")
    || value.includes("viduq3-turbo");
}

export function videoWatermarkSupported(model: string) {
  return videoCapability(model).watermark;
}

/** Mirrors the reference project's video workbench instead of every provider API field. */
export function videoComposerWatermarkSupported(model: string) {
  return videoModelProfile(model).startsWith("seedance-") && videoWatermarkSupported(model);
}

export function videoAllowsCustomDimensions(model: string) {
  return usesReferenceGenericVideoPanel(model);
}

export function videoAllowsCustomResolution(model: string) {
  return usesReferenceGenericVideoPanel(model);
}

export function videoSizeIsValid(model: string, value: string) {
  const requested = String(value || "").trim();
  if (videoAllowsCustomDimensions(model) && (requested === "auto" || requested === "adaptive" || /^\d+x\d+$/i.test(requested))) return true;
  const options = videoSizeOptions(model);
  if (options.length === 0) return requested === "";
  return options.some((option) => option.toLowerCase() === requested.toLowerCase());
}

export function videoSecondsIsValid(model: string, value: number) {
  if (videoModelProfile(model) === "cogvideox-3") return Number.isInteger(value) && videoSecondsOptions(model).includes(value);
  if (usesReferenceGenericVideoPanel(model)) return Number.isInteger(value) && value >= 1 && value <= 30;
  if (isReferenceSeedanceVideoModel(model)) {
    return value === -1 || (Number.isInteger(value) && value >= 4 && value <= 15);
  }
  if (!videoDurationSupported(model)) return true;
  return Number.isInteger(value) && videoSecondsOptions(model).includes(value);
}

/** Mirrors whether the reference workbench renders a manual duration input. */
export function videoAllowsCustomDuration(model: string) {
  const value = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
  if (usesReferenceGenericVideoPanel(model)) return videoModelProfile(model) !== "cogvideox-3";
  if (!videoDurationSupported(model) || value === "kling-v2-6") return false;
  return true;
}

export function videoDurationSupported(model: string) {
  const profile = videoModelProfile(model);
  const value = canonicalVideoModel(model).toLowerCase();
  if (profile === "kling-motion") return false;
  if (profile === "happyhorse" && value.includes("video-edit")) return false;
  if (value.startsWith("wan/2-2-a14b-") || value.startsWith("wan/2-2-animate-")) return false;
  return !["kling-avatar", "wan-speech", "wan-animate", "infinitalk", "topaz-video"].includes(profile);
}

export function videoResolutionIsValid(model: string, value: string, seconds?: number) {
  const requested = String(value || "").trim();
  const options = videoResolutionOptions(model, seconds);
  const normalized = /^\d{3,5}$/.test(requested) ? `${requested}p` : requested;
  // Hailuo 10-second generation is restricted to 768P by the provider.
  // Keep the model-specific enum strict even though other providers accept
  // manually entered quality values in the workbench.
  if (videoModelProfile(model) === "minimax-hailuo" && seconds === 10) {
    return options.some((option) => option.toLowerCase() === normalized.toLowerCase());
  }
  // A manual value is valid in the workbench even when the provider later
  // maps it to its nearest documented quality. This keeps typing responsive
  // instead of resetting the field on every keystroke.
  if (usesReferenceGenericVideoPanel(model) && /^(?:\d{3,5})(?:p|k)?$/i.test(normalized)) return true;
  if (options.length === 0) return requested === "";
  return options.some((option) => option.toLowerCase() === normalized.toLowerCase());
}

export function videoWorkbenchResolutionOptions(model: string, seconds?: number) {
  const supported = videoResolutionOptions(model, seconds);
  if (isReferenceSeedanceVideoModel(model)) {
    return ["480p", "720p", "1080p"];
  }
  if (usesReferenceSpecialVideoPanel(model)) return supported;
  // The reference project's generic panel always exposes 720p, 480p and a
  // manual quality field. Provider adapters normalize values that are not
  // native to a particular endpoint at submission time.
  return ["720p", "480p"];
}

export function videoWorkbenchSecondsOptions(model: string) {
  const profile = videoModelProfile(model);
  const supported = videoSecondsOptions(model);
	const presets = canonicalVideoModel(model).toLowerCase() === "kling-3-0-turbo"
			? [6, 10, 12, 16, 20]
			: isReferenceSeedanceVideoModel(model)
	    ? [-1, 4, 5, 6, 8, 10, 12, 15]
	    : profile === "kling-3" || profile.startsWith("kling-omni")
      ? [3, 15]
      : profile === "kling-legacy"
        ? [5, 10]
        : profile === "cogvideox-3"
          ? [5, 10]
          : usesReferenceGenericVideoPanel(model)
            ? [6, 10, 12, 16, 20]
            : supported;
	return usesReferenceGenericVideoPanel(model) || isReferenceSeedanceVideoModel(model) ? presets : presets.filter((value) => supported.includes(value));
}

/**
 * The reference workbench has specialized parameter panels for Seedance and
 * provider-specific Kling controls. Every other model uses the generic panel,
 * even when the provider later ignores or normalizes a generic field.
 */
export function usesReferenceSpecialVideoPanel(model: string) {
  const value = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
  if (isReferenceSeedanceVideoModel(model)) return true;
  // The reference workbench only switches to the Kling-specific panel for
  // APIMart's named v2.6/v3 models and KIE's universal v3/Omni endpoints.
  // Other KIE Kling endpoints (legacy, v3 Turbo, motion control, etc.) use
  // the generic workbench controls even though their provider schemas differ.
  if (value === "kling-v2-6" || value === "kling-v3") return true;
  return value === "kling-3-0-video"
    || value.startsWith("kling-3-0-omni-");
}

export function usesReferenceGenericVideoPanel(model: string) {
  return !usesReferenceSpecialVideoPanel(model);
}

export type VideoWorkbenchMaterialSections = {
  image: boolean;
  video: boolean;
  audio: boolean;
  imageLabel: "首尾帧" | "参考图";
};

/** Matches the material sections rendered by the reference video workbench. */
export function videoWorkbenchMaterialSections(model: string): VideoWorkbenchMaterialSections {
  const value = canonicalVideoModel(model).toLowerCase().replace(/[._/]+/g, "-");
  const klingWorkbench = value === "kling-v2-6"
    || value === "kling-v3"
    || value === "kling-3-0-video"
    || value.startsWith("kling-3-0-omni-");
  if (!klingWorkbench) return { image: true, video: true, audio: true, imageLabel: "参考图" };

  const variant = value.startsWith("kling-3-0-omni-")
    ? value.slice("kling-3-0-omni-".length)
    : "";
  if (variant === "text-to-video") return { image: false, video: false, audio: false, imageLabel: "参考图" };
  if (variant === "reference-to-video" || variant === "transformation") {
    return { image: true, video: true, audio: false, imageLabel: "参考图" };
  }
  return { image: true, video: false, audio: false, imageLabel: "首尾帧" };
}

/** Whether the generic workbench applies its 2-15s video metadata checks. */
export function videoWorkbenchValidatesReferenceVideoMetadata(model: string) {
  const profile = videoModelProfile(model);
  const usesKlingReferencePanel = usesReferenceSpecialVideoPanel(model) && profile.startsWith("kling-");
  const usesDedicatedMiniMaxH3 = canonicalVideoModel(model).trim().toLowerCase() === "minimax-h3";
  return !usesKlingReferencePanel && !usesDedicatedMiniMaxH3 && profile !== "agnes-25";
}

export function videoSizeLabel(size: string) {
  const labels: Record<string, string> = {
    adaptive: "自适应",
    "16:9": "16:9 横屏",
    "9:16": "9:16 竖屏",
    "1:1": "1:1 方形",
    "4:3": "4:3 横屏",
    "3:4": "3:4 竖屏",
    "21:9": "21:9 宽银幕",
    "3:2": "3:2 横幅",
    "2:3": "2:3 竖幅",
    "1280x720": "16:9 横屏",
    "720x1280": "9:16 竖屏",
  };
  return labels[size] || size;
}

export function videoComposerSizeLabel(size: string) {
  const labels: Record<string, string> = {
    adaptive: "自适应",
    "16:9": "横屏",
    "9:16": "竖屏",
    "1:1": "方形",
    "4:3": "标准横屏",
    "3:4": "标准竖屏",
    "21:9": "宽银幕",
  };
  return labels[size] || videoSizeLabel(size);
}

export function videoComposerPixelLabel(resolution: string, size: string) {
  if (size === "adaptive") return "自动匹配";
  const pixels: Record<string, Record<string, string>> = {
    "480p": { "16:9": "864x496", "4:3": "752x560", "1:1": "640x640", "3:4": "560x752", "9:16": "496x864", "21:9": "992x432" },
    "720p": { "16:9": "1280x720", "4:3": "1112x834", "1:1": "960x960", "3:4": "834x1112", "9:16": "720x1280", "21:9": "1470x630" },
    "1080p": { "16:9": "1920x1080", "4:3": "1664x1248", "1:1": "1440x1440", "3:4": "1248x1664", "9:16": "1080x1920", "21:9": "2206x946" },
    "2k": { "16:9": "2560x1440", "4:3": "2224x1668", "1:1": "1920x1920", "3:4": "1668x2224", "9:16": "1440x2560", "21:9": "2940x1260" },
    "4k": { "16:9": "3840x2160", "4:3": "3328x2496", "1:1": "2880x2880", "3:4": "2496x3328", "9:16": "2160x3840", "21:9": "4412x1892" },
  };
  return pixels[normalizeVideoWorkbenchResolutionToken(resolution)]?.[size] || size;
}

function normalizeVideoWorkbenchResolutionToken(resolution: string) {
  const value = String(resolution || "").trim().toLowerCase();
  if (value === "low") return "480p";
  if (value === "auto" || value === "medium" || value === "high") return "720p";
  if (/^\d{3,5}$/.test(value)) return `${value}p`;
  return ["480p", "720p", "1080p", "2k", "4k"].includes(value) ? value : "720p";
}

export const VIDEO_WORKBENCH_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] as const;

function closestVideoWorkbenchRatio(size: string) {
  if (size === "auto" || size === "adaptive") return "adaptive";
  if ((VIDEO_WORKBENCH_RATIO_OPTIONS as readonly string[]).includes(size)) return size;
  const dimensions = size.match(/^(\d+)x(\d+)$/i);
  if (!dimensions) return "16:9";
  const ratio = Number(dimensions[1]) / Number(dimensions[2]);
  const candidates = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["21:9", 21 / 9],
  ] as const;
  return candidates.reduce((best, item) => Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best, candidates[0])[0];
}

/**
 * The reference workbench preserves raw settings when the model changes and
 * normalizes only the value shown by a specialized panel.
 */
export function videoWorkbenchDisplaySize(model: string, size: string) {
  if (usesReferenceGenericVideoPanel(model)) {
    return normalizeReferenceGenericVideoSize(size);
  }
  const ratio = closestVideoWorkbenchRatio(size);
  return isReferenceSeedanceVideoModel(model) ? ratio : ratio === "adaptive" ? "16:9" : ratio;
}

export function videoWorkbenchRatioForSize(size: string) {
  return closestVideoWorkbenchRatio(String(size || "").trim().toLowerCase());
}

export function videoWorkbenchDisplayResolution(model: string, resolution: string) {
  if (!isReferenceSeedanceVideoModel(model)) return resolution;
  const normalized = normalizeVideoWorkbenchResolutionToken(resolution);
  if (/fast|mini/i.test(model) && normalized === "1080p") return "720p";
  return ["480p", "720p", "1080p"].includes(normalized) ? normalized : "720p";
}

/** Value shown in the reference panel's manual quality field. */
export function videoWorkbenchResolutionInputValue(value: string) {
  const requested = String(value || "").trim();
  const normalized = requested.toLowerCase();
  if (normalized === "480p" || normalized === "low") return "480";
  if (["720p", "auto", "high", "medium"].includes(normalized)) return "720";
  return requested.replace(/p$/i, "") || "720";
}

export function videoWorkbenchDisplaySeconds(model: string, seconds: string | number) {
  const requested = Math.floor(Number(seconds));
  const profile = videoModelProfile(model);
  if (usesReferenceGenericVideoPanel(model)) {
    if (profile === "cogvideox-3") {
      const finite = Number.isFinite(requested) ? requested : 5;
      return String(Math.abs(finite - 5) <= Math.abs(finite - 10) ? 5 : 10);
    }
    return String(seconds).trim() || "6";
  }
  if (isReferenceSeedanceVideoModel(model)) {
    if (String(seconds).trim() === "-1") return "-1";
    return String(Math.max(4, Math.min(15, Number.isFinite(requested) ? requested : 5)));
  }
  if (profile === "kling-3" || profile.startsWith("kling-omni")) {
    return String(Math.max(3, Math.min(15, Number.isFinite(requested) ? requested : 3)));
  }
  if (profile === "kling-legacy") return String(requested === 10 ? 10 : 5);
  const options = videoSecondsOptions(model);
  if (Number.isFinite(requested) && options.includes(requested)) return String(requested);
  return String(videoDefaultSeconds(model));
}

export function videoWorkbenchSizeForResolution(resolution: string, currentSize: string) {
  const normalized = explicitVideoWorkbenchResolutionPreset(resolution);
  if (!normalized) return normalizeReferenceGenericVideoSize(currentSize);
  const ratio = closestVideoWorkbenchRatio(currentSize);
  return ratio === "adaptive" ? "auto" : videoComposerPixelLabel(normalized, ratio);
}

export function videoWorkbenchResolutionForSize(size: string, currentResolution: string) {
  const dimensions = String(size || "").trim().match(/^(\d+)x(\d+)$/i);
  if (!dimensions) return currentResolution;
  const pixels = Number(dimensions[1]) * Number(dimensions[2]);
  return ["480p", "720p", "1080p", "2k", "4k"].reduce((best, candidate) => {
    const [candidateWidth, candidateHeight] = videoComposerPixelLabel(candidate, "16:9").split("x").map(Number);
    const [bestWidth, bestHeight] = videoComposerPixelLabel(best, "16:9").split("x").map(Number);
    return Math.abs(candidateWidth * candidateHeight - pixels) < Math.abs(bestWidth * bestHeight - pixels) ? candidate : best;
  }, "720p");
}

export function videoWorkbenchSizeForModelResolution(model: string, resolution: string, currentSize: string) {
  const normalized = explicitVideoWorkbenchResolutionPreset(resolution);
  if (!normalized) return normalizeReferenceGenericVideoSize(currentSize);
  if (videoModelProfile(model) !== "cogvideox-3") {
    return videoWorkbenchSizeForResolution(resolution, currentSize);
  }
  const ratio = closestVideoWorkbenchRatio(currentSize);
  if (ratio === "adaptive") return "1280x720";
  if (ratio === "1:1") return "1024x1024";
  if (ratio === "9:16" || ratio === "3:4") {
    return normalized === "480p" || normalized === "720p" ? "720x1280" : "1080x1920";
  }
  if (normalized === "4k") return "3840x2160";
  if (normalized === "2k") return "2048x1080";
  return normalized === "1080p" ? "1920x1080" : "1280x720";
}

export function videoWorkbenchResolutionForModelSize(model: string, size: string, currentResolution: string) {
  if (videoModelProfile(model) !== "cogvideox-3") {
    return videoWorkbenchResolutionForSize(size, currentResolution);
  }
  const normalized = String(size || "").trim().toLowerCase();
  if (normalized === "3840x2160") return "4k";
  if (normalized === "2048x1080") return "2k";
  if (normalized === "1920x1080" || normalized === "1080x1920") return "1080p";
  return "720p";
}

export function videoComposerSizeDescription(model: string, resolution: string, size: string) {
  const profile = videoModelProfile(model);
	if (canonicalVideoModel(model).toLowerCase() === "kling-3-0-turbo") return undefined;
  if (profile.startsWith("seedance-")) return videoComposerPixelLabel(resolution, size);
  if (profile === "kling-3" || profile === "kling-legacy") {
    return {
      "16:9": "1280x720",
      "9:16": "720x1280",
      "1:1": "960x960",
    }[size];
  }
  return size === "adaptive" ? "自动匹配" : undefined;
}

export function videoComposerAspectRatio(size: string) {
  if (/^\d+:\d+$/.test(size)) return size;
  const dimensions = size.match(/^(\d+)x(\d+)$/i);
  return dimensions ? `${dimensions[1]}:${dimensions[2]}` : undefined;
}

function isVideoWorkbenchResolutionPreset(value: string) {
  return ["480p", "720p", "1080p", "2k", "4k"].includes(value);
}

function explicitVideoWorkbenchResolutionPreset(value: string) {
  const requested = String(value || "").trim().toLowerCase();
  if (requested === "low") return "480p";
  if (["auto", "medium", "high"].includes(requested)) return "720p";
  const normalized = /^\d{3,5}$/.test(requested) ? `${requested}p` : requested;
  return isVideoWorkbenchResolutionPreset(normalized) ? normalized : "";
}

function normalizeReferenceGenericVideoSize(size: string) {
  const requested = String(size || "").trim().toLowerCase();
  if (requested === "auto") return "auto";
  if (/^\d+x\d+$/i.test(requested)) return requested;
  return ["9:16", "2:3", "3:4"].includes(requested) ? "720x1280" : "1280x720";
}
