"use client";

import { useEffect, useState } from "react";

import {
  fetchImageGenerationPreferences,
  IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT,
  type ImageGenerationPreferences,
} from "@/lib/api";
import { normalizedImagePartialImages } from "@/lib/image-api-contract";

const DEFAULT_IMAGE_GENERATION_PREFERENCES: ImageGenerationPreferences = {
  api_mode: "images",
  stream: false,
  partial_images: 1,
  response_format_b64_json: false,
  codex_cli_compatibility: false,
  system_prompt: "",
  video_system_prompt: "",
  audio_instructions: "",
  default_text_model: "",
  default_image_model: "",
  default_video_model: "",
  default_audio_model: "",
  canvas_default_image_count: 1,
  default_audio_voice: "",
  default_audio_format: "",
  default_audio_speed: 1,
};

const STORAGE_KEYS = {
  apiMode: "chatgpt2api:image_last_api_mode",
  stream: "chatgpt2api:image_last_stream_v3",
  partialImages: "chatgpt2api:image_last_partial_images",
  responseFormatB64JSON: "chatgpt2api:image_generation_response_format_b64_json",
  codexCLICompatibility: "chatgpt2api:image_generation_codex_cli_compatibility",
  canvasImageCount: "chatgpt2api:canvas_default_image_count",
} as const;

const AUDIO_FORMATS: readonly ImageGenerationPreferences["default_audio_format"][] = ["", "mp3", "wav", "opus", "aac", "flac", "pcm"];

function normalizePreferences(value: Partial<ImageGenerationPreferences> | undefined): ImageGenerationPreferences {
  const apiMode = value?.api_mode === "responses" || value?.api_mode === "chat" ? value.api_mode : "images";
  const defaultAudioFormat = AUDIO_FORMATS.includes(value?.default_audio_format as ImageGenerationPreferences["default_audio_format"])
    ? value!.default_audio_format as ImageGenerationPreferences["default_audio_format"]
    : "";
  return {
    api_mode: apiMode,
    stream: value?.stream === true,
    partial_images: normalizedImagePartialImages(value?.partial_images),
    response_format_b64_json: value?.response_format_b64_json === true,
    codex_cli_compatibility: value?.codex_cli_compatibility === true,
    system_prompt: String(value?.system_prompt || "").trim(),
    video_system_prompt: String(value?.video_system_prompt || "").trim(),
    audio_instructions: String(value?.audio_instructions || "").trim(),
    default_text_model: String(value?.default_text_model || "").trim(),
    default_image_model: String(value?.default_image_model || "").trim(),
    default_video_model: String(value?.default_video_model || "").trim(),
    default_audio_model: String(value?.default_audio_model || "").trim(),
    canvas_default_image_count: Math.max(1, Math.min(15, Math.floor(Number(value?.canvas_default_image_count) || 1))),
    default_audio_voice: String(value?.default_audio_voice || "").trim(),
    default_audio_format: defaultAudioFormat,
    default_audio_speed: Math.max(0.25, Math.min(4, Number(value?.default_audio_speed) || 1)),
  };
}

function storePreferences(preferences: ImageGenerationPreferences) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEYS.apiMode, preferences.api_mode);
  window.localStorage.setItem(STORAGE_KEYS.stream, String(preferences.stream));
  window.localStorage.setItem(STORAGE_KEYS.partialImages, String(preferences.partial_images));
  window.localStorage.setItem(STORAGE_KEYS.responseFormatB64JSON, String(preferences.response_format_b64_json));
  window.localStorage.setItem(STORAGE_KEYS.codexCLICompatibility, String(preferences.codex_cli_compatibility));
  window.localStorage.setItem(STORAGE_KEYS.canvasImageCount, String(preferences.canvas_default_image_count));
}

export function useImageGenerationPreferences(sessionKey: string) {
  const [preferences, setPreferences] = useState(DEFAULT_IMAGE_GENERATION_PREFERENCES);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let ignore = false;
    setIsReady(false);
    void fetchImageGenerationPreferences()
      .then(({ preferences: loaded }) => {
        if (ignore) return;
        const normalized = normalizePreferences(loaded);
        setPreferences(normalized);
        storePreferences(normalized);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!ignore) setIsReady(true);
      });

    const handleChange = (event: Event) => {
      const normalized = normalizePreferences(
        (event as CustomEvent<Partial<ImageGenerationPreferences>>).detail,
      );
      setPreferences(normalized);
      storePreferences(normalized);
      setIsReady(true);
    };
    window.addEventListener(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT, handleChange);
    return () => {
      ignore = true;
      window.removeEventListener(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT, handleChange);
    };
  }, [sessionKey]);

  return { preferences, isReady };
}
