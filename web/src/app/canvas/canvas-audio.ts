import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";
import { canvasGenerationInputs } from "./canvas-config-inputs.ts";

export const AUDIO_VOICE_OPTIONS = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export const AUDIO_FORMAT_OPTIONS = ["mp3", "wav", "opus", "aac", "flac", "pcm"] as const;
export const GLM_TTS_VOICE_OPTIONS = ["tongtong", "chuichui", "xiaochen", "jam", "kazi", "douji", "luodo"] as const;
export const GLM_TTS_FORMAT_OPTIONS = ["wav", "pcm"] as const;
export const GROK_TTS_LANGUAGE_OPTIONS = ["auto", "en", "zh", "ja", "ko", "fr", "de", "hi", "id", "it", "ru", "tr", "vi", "bn", "pt-BR", "pt-PT", "es-MX", "es-ES", "ar-EG", "ar-SA", "ar-AE"] as const;
export const GROK_TTS_FORMAT_OPTIONS = ["mp3", "wav"] as const;
export const MIMO_TTS_VOICE_OPTIONS = ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"] as const;
export const MIMO_TTS_FORMAT_OPTIONS = ["wav", "mp3"] as const;
export const GEMINI_TTS_VOICE_OPTIONS = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
] as const;

const GROK_TTS_MODELS = new Set(["grok-voice-latest", "grok-voice-think-fast-2.0", "grok-voice-think-fast-1.0"]);

export type CanvasAudioProvider = "openai" | "glm" | "grok" | "mimo-preset" | "mimo-design" | "mimo-clone" | "gemini";
export type CanvasAudioPreferenceDefaults = { format?: string; speed?: number };
export type CanvasAudioReference = { nodeID: string; title: string; url: string; mimeType?: string };
export type CanvasAudioGenerationRequest = Record<string, unknown> & { model: string; input: string; audio_protocol: CanvasAudioProvider };

export function resolveCanvasAudioModel(
  defaultModel: unknown,
  audioModels: unknown,
  fallback = "gpt-4o-mini-tts",
) {
  const configuredModels = Array.isArray(audioModels)
    ? audioModels
    : String(audioModels ?? "").split(",");
  for (const candidate of [defaultModel, ...configuredModels, fallback]) {
    const model = String(candidate ?? "").trim();
    if (model) return model;
  }
  return fallback;
}

export function isCanvasAudioFile(file: Pick<File, "name" | "type">) {
  return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function canvasAgentAudioNodeParameters(
  model: string,
  voice: string,
  instructions: string,
  cloneNodeID = "",
  defaults: CanvasAudioPreferenceDefaults = {},
): Partial<CanvasNode> {
  const provider = canvasAudioProvider(model);
  const requestedVoice = voice.trim();
  const requestedInstructions = instructions.trim();
  const requestedFormat = String(defaults.format || "").trim().toLowerCase();
  if (provider === "gemini") {
    return { generation_audio_gemini_voice: includes(GEMINI_TTS_VOICE_OPTIONS, requestedVoice) ? requestedVoice : "Kore" };
  }
  if (provider === "glm") {
    return {
      generation_audio_glm_voice: includes(GLM_TTS_VOICE_OPTIONS, requestedVoice) ? requestedVoice : "tongtong",
      generation_audio_glm_format: includes(GLM_TTS_FORMAT_OPTIONS, requestedFormat) ? requestedFormat : "wav",
      generation_audio_glm_speed: normalizeAudioSpeed(defaults.speed, 0.5, 2),
    };
  }
  if (provider === "grok") {
    return {
      generation_audio_grok_voice: requestedVoice || "eve",
      generation_audio_grok_language: "auto",
      generation_audio_grok_format: includes(GROK_TTS_FORMAT_OPTIONS, requestedFormat) ? requestedFormat : "mp3",
      generation_audio_grok_speed: normalizeAudioSpeed(defaults.speed, 0.7, 1.5),
    };
  }
  if (provider === "mimo-preset") {
    return {
      generation_audio_mimo_voice: includes(MIMO_TTS_VOICE_OPTIONS, requestedVoice) ? requestedVoice : "冰糖",
      generation_audio_mimo_format: includes(MIMO_TTS_FORMAT_OPTIONS, requestedFormat) ? requestedFormat : "wav",
      generation_audio_instructions: requestedInstructions,
    };
  }
  if (provider === "mimo-design") {
    return {
      generation_audio_mimo_format: includes(MIMO_TTS_FORMAT_OPTIONS, requestedFormat) ? requestedFormat : "wav",
      generation_audio_mimo_voice_design_prompt: requestedInstructions,
    };
  }
  if (provider === "mimo-clone") {
    return {
      generation_audio_mimo_format: includes(MIMO_TTS_FORMAT_OPTIONS, requestedFormat) ? requestedFormat : "wav",
      generation_audio_mimo_voice_clone_node_id: cloneNodeID,
      generation_audio_instructions: requestedInstructions,
    };
  }
  return {
    generation_audio_voice: includes(AUDIO_VOICE_OPTIONS, requestedVoice) ? requestedVoice : "alloy",
    generation_audio_format: includes(AUDIO_FORMAT_OPTIONS, requestedFormat) ? requestedFormat : "mp3",
    generation_audio_speed: normalizeAudioSpeed(defaults.speed, 0.25, 4),
    generation_audio_instructions: requestedInstructions,
  };
}

export function canvasAudioProvider(model: string): CanvasAudioProvider {
  const normalized = model.trim().toLowerCase();
  const name = normalized.split("/").pop() || "";
  if (normalized === "glm-tts") return "glm";
  if (GROK_TTS_MODELS.has(name)) return "grok";
  if (normalized === "mimo-v2.5-tts") return "mimo-preset";
  if (normalized === "mimo-v2.5-tts-voicedesign") return "mimo-design";
  if (normalized === "mimo-v2.5-tts-voiceclone") return "mimo-clone";
  if (normalized.includes("gemini") && normalized.includes("tts")) return "gemini";
  return "openai";
}

function isMimoAudioProvider(provider: CanvasAudioProvider) {
  return provider === "mimo-preset" || provider === "mimo-design" || provider === "mimo-clone";
}

function normalizeAudioSpeed(value: number | undefined, minimum: number, maximum: number) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return 1;
  return Math.max(minimum, Math.min(maximum, Number(speed.toFixed(2))));
}

export function buildCanvasAudioGenerationRequest(node: CanvasNode, prompt: string, cloneAudioDataURL?: string): CanvasAudioGenerationRequest {
  const model = String(node.generation_audio_model || "gpt-4o-mini-tts").trim();
  const provider = canvasAudioProvider(model);
  const input = prompt.trim();
  if (!input) throw new Error("音频文本不能为空");

  if (provider === "gemini") {
    const voiceName = includes(GEMINI_TTS_VOICE_OPTIONS, node.generation_audio_gemini_voice) ? node.generation_audio_gemini_voice! : "Kore";
    return {
      model,
      input,
      audio_protocol: provider,
      contents: [{ role: "user", parts: [{ text: input }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    };
  }
  if (provider === "glm") {
    if (input.length > 1024) throw new Error("GLM-TTS 文本不能超过 1024 个字符");
    return {
      model,
      input,
      audio_protocol: provider,
      voice: includes(GLM_TTS_VOICE_OPTIONS, node.generation_audio_glm_voice) ? node.generation_audio_glm_voice! : "tongtong",
      response_format: includes(GLM_TTS_FORMAT_OPTIONS, node.generation_audio_glm_format) ? node.generation_audio_glm_format! : "wav",
      speed: normalizeAudioSpeed(node.generation_audio_glm_speed, 0.5, 2),
    };
  }
  if (provider === "grok") {
    return {
      model,
      input,
      audio_protocol: provider,
      voice_id: node.generation_audio_grok_voice?.trim() || "eve",
      language: includes(GROK_TTS_LANGUAGE_OPTIONS, node.generation_audio_grok_language) ? node.generation_audio_grok_language! : "auto",
      output_format: { codec: includes(GROK_TTS_FORMAT_OPTIONS, node.generation_audio_grok_format) ? node.generation_audio_grok_format! : "mp3" },
      speed: normalizeAudioSpeed(node.generation_audio_grok_speed, 0.7, 1.5),
    };
  }
  if (isMimoAudioProvider(provider)) {
    const format = includes(MIMO_TTS_FORMAT_OPTIONS, node.generation_audio_mimo_format) ? node.generation_audio_mimo_format! : "wav";
    const instructions = node.generation_audio_instructions?.trim() || "";
    if (provider === "mimo-design" && !node.generation_audio_mimo_voice_design_prompt?.trim()) throw new Error("请填写音色描述");
    if (provider === "mimo-clone" && !cloneAudioDataURL) throw new Error("请连接并选择参考音频节点");
    return {
      model,
      input,
      audio_protocol: provider,
      ...(provider === "mimo-preset" ? { voice: includes(MIMO_TTS_VOICE_OPTIONS, node.generation_audio_mimo_voice) ? node.generation_audio_mimo_voice! : "冰糖" } : {}),
      ...(provider === "mimo-design" ? { mimo_voice_design_prompt: node.generation_audio_mimo_voice_design_prompt!.trim() } : {}),
      ...(provider === "mimo-clone" ? { mimo_voice_clone_audio: cloneAudioDataURL } : {}),
      ...((provider === "mimo-preset" || provider === "mimo-clone") && instructions ? { instructions } : {}),
      response_format: format,
    };
  }

  const voice = includes(AUDIO_VOICE_OPTIONS, node.generation_audio_voice) ? node.generation_audio_voice! : "alloy";
  const format = includes(AUDIO_FORMAT_OPTIONS, node.generation_audio_format) ? node.generation_audio_format! : "mp3";
  const instructions = node.generation_audio_instructions?.trim() || "";
  return {
    model,
    input,
    audio_protocol: provider,
    voice,
    response_format: format,
    speed: normalizeAudioSpeed(node.generation_audio_speed, 0.25, 4),
    ...(instructions ? { instructions } : {}),
  };
}

function includes<const T extends readonly string[]>(options: T, value: string | undefined): value is T[number] {
  return Boolean(value && options.includes(value as T[number]));
}

export function canvasAudioResponseFormat(node: CanvasNode) {
  const provider = canvasAudioProvider(node.generation_audio_model || "");
  if (provider === "gemini") return "wav";
  if (provider === "glm") return includes(GLM_TTS_FORMAT_OPTIONS, node.generation_audio_glm_format) ? node.generation_audio_glm_format : "wav";
  if (provider === "grok") return includes(GROK_TTS_FORMAT_OPTIONS, node.generation_audio_grok_format) ? node.generation_audio_grok_format : "mp3";
  if (isMimoAudioProvider(provider)) return includes(MIMO_TTS_FORMAT_OPTIONS, node.generation_audio_mimo_format) ? node.generation_audio_mimo_format : "wav";
  return includes(AUDIO_FORMAT_OPTIONS, node.generation_audio_format) ? node.generation_audio_format : "mp3";
}

export function canvasAudioReferences(nodeID: string, nodes: readonly CanvasNode[], connections: readonly CanvasConnection[]) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return canvasGenerationInputs(nodeID, nodes, connections).flatMap((input): CanvasAudioReference[] => {
    if (input.type !== "audio" || !input.url) return [];
    const source = nodeByID.get(input.nodeID);
    return [{ nodeID: input.nodeID, title: input.title || "音频", url: input.url, mimeType: source?.mime_type }];
  });
}

export function canvasAudioGenerationReferences(
  nodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  selectedURLs: readonly string[],
) {
  const references = canvasAudioReferences(nodeID, nodes, connections);
  const referencesByURL = new Map(references.map((reference) => [reference.url, reference]));
  return selectedURLs.flatMap((url): CanvasAudioReference[] => {
    const reference = referencesByURL.get(url);
    return reference ? [reference] : [];
  });
}
