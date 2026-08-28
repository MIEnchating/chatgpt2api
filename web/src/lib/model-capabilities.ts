export type ModelCapability = "text" | "image" | "video" | "audio";

function normalizedModelName(model: string) {
  return String(model || "").trim().toLowerCase();
}

function isAudioModelName(model: string) {
  const value = normalizedModelName(model);
  return ["audio", "tts", "speech", "voice", "music", "sound", "elevenlabs", "suno", "lyrics", "vocal", "midi", "wav"]
    .some((keyword) => value.includes(keyword));
}

function isVideoModelName(model: string) {
  const value = normalizedModelName(model);
  return [
    "video", "sora", "veo", "kling", "hailuo", "minimax", "seedance", "wan2", "wan/2",
    "t2v-", "i2v-", "s2v-", "r2v", "videoedit", "jimeng", "即梦", "vidu", "pixverse",
    "skyreels", "happyhorse", "runway", "aleph", "agnes", "omni-flash", "gemini-omni",
    "infinitalk", "grok-imagine/upscale", "grok-imagine/extend",
  ]
    .some((keyword) => value.includes(keyword));
}

function isImageModelName(model: string) {
  const value = normalizedModelName(model);
  if (isVideoModelName(value) || isAudioModelName(value)) return false;
  return [
    "image", "nano-banana", "seedream", "gpt-image", "cogview", "dall-e", "dalle", "imagen",
    "flux", "kontext", "4o-image", "z-image", "text-to-image", "ideogram", "recraft", "sdxl",
    "stable-diffusion", "midjourney",
  ].some((keyword) => value.includes(keyword));
}

function modelMatchesCapability(model: string, capability: ModelCapability) {
  if (capability === "audio") return isAudioModelName(model);
  if (capability === "video") return isVideoModelName(model);
  if (capability === "image") return isImageModelName(model);
  return !isAudioModelName(model) && !isVideoModelName(model) && !isImageModelName(model);
}

export function filterModelsByCapability(models: string[], capability: ModelCapability) {
  return models.filter((model) => modelMatchesCapability(model, capability));
}
