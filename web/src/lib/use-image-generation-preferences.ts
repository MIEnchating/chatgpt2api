"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CreationWorkbenchPreferences,
  fetchImageGenerationPreferences,
  type ImageGenerationPreferences,
} from "@/lib/api";
import { normalizedImagePartialImages } from "@/lib/image-api-contract";
import {
  imageGenerationPreferencesFromChangedEvent,
  IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT,
} from "@/lib/image-generation-preferences-events";
import {
  dismissImageGenerationPreferencesLoadError,
  IMAGE_GENERATION_PREFERENCES_RETRY_EVENT,
  requestImageGenerationPreferencesRetry,
  showImageGenerationPreferencesLoadError,
} from "@/lib/image-generation-preferences-retry";

export const DEFAULT_CREATION_WORKBENCH_PREFERENCES: CreationWorkbenchPreferences = {
  image_model: "",
  image_size: "1024x1024",
  image_size_mode: "ratio",
  image_aspect_ratio: "1:1",
  image_resolution: "auto",
  image_custom_ratio: "16:9",
  image_custom_width: "1024",
  image_custom_height: "1024",
  image_snap_to_multiple_16: true,
  image_quality: "",
  image_count: 1,
  image_output_format: "png",
  image_output_compression: "",
  video_model: "",
  video_size: "1280x720",
  video_seconds: "6",
  video_resolution: "720p",
  video_generate_audio: false,
  video_watermark: false,
};

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
  default_text_relay_token_names: [],
  default_image_relay_token_names: [],
  default_video_relay_token_names: [],
  default_audio_relay_token_names: [],
  workbench: DEFAULT_CREATION_WORKBENCH_PREFERENCES,
};

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
    default_text_relay_token_names: Array.isArray(value?.default_text_relay_token_names) ? value.default_text_relay_token_names.map((name) => String(name).trim()).filter(Boolean) : [],
    default_image_relay_token_names: Array.isArray(value?.default_image_relay_token_names) ? value.default_image_relay_token_names.map((name) => String(name).trim()).filter(Boolean) : [],
    default_video_relay_token_names: Array.isArray(value?.default_video_relay_token_names) ? value.default_video_relay_token_names.map((name) => String(name).trim()).filter(Boolean) : [],
    default_audio_relay_token_names: Array.isArray(value?.default_audio_relay_token_names) ? value.default_audio_relay_token_names.map((name) => String(name).trim()).filter(Boolean) : [],
    workbench: {
      ...DEFAULT_CREATION_WORKBENCH_PREFERENCES,
      ...value?.workbench,
      image_model: String(value?.workbench?.image_model || "").trim(),
      image_count: Math.max(1, Math.min(10, Math.round(Number(value?.workbench?.image_count) || 1))),
      image_snap_to_multiple_16: value?.workbench?.image_snap_to_multiple_16 !== false,
      video_generate_audio: value?.workbench?.video_generate_audio === true,
      video_model: String(value?.workbench?.video_model || "").trim(),
      video_watermark: value?.workbench?.video_watermark === true,
    },
  };
}

type ImageGenerationPreferencesLoader = () => Promise<{ preferences: ImageGenerationPreferences }>;

export async function loadImageGenerationPreferences(
  load: ImageGenerationPreferencesLoader = fetchImageGenerationPreferences,
) {
  try {
    const { preferences } = await load();
    return { status: "ready" as const, preferences: normalizePreferences(preferences) };
  } catch (error) {
    return {
      status: "error" as const,
      error: error instanceof Error ? error : new Error("创作偏好读取失败"),
    };
  }
}

export function useImageGenerationPreferences(sessionKey: string) {
  const [preferences, setPreferences] = useState(DEFAULT_IMAGE_GENERATION_PREFERENCES);
  const [isReady, setIsReady] = useState(false);
  const [loadedSessionKey, setLoadedSessionKey] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const loadGeneration = useRef(0);
  const retry = useCallback(() => requestImageGenerationPreferencesRetry(), []);

  useEffect(() => {
    let ignore = false;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setPreferences(DEFAULT_IMAGE_GENERATION_PREFERENCES);
    setIsReady(false);
    setLoadedSessionKey("");
    setError(null);
    if (!sessionKey) {
      dismissImageGenerationPreferencesLoadError();
    } else {
      void loadImageGenerationPreferences()
        .then((result) => {
          if (ignore || loadGeneration.current !== generation) return;
          if (result.status === "error") {
            setError(result.error);
            showImageGenerationPreferencesLoadError(result.error);
            return;
          }
          setPreferences(result.preferences);
          setLoadedSessionKey(sessionKey);
          setIsReady(true);
          dismissImageGenerationPreferencesLoadError();
        });
    }

    const handleChange = (event: Event) => {
      const changedPreferences = imageGenerationPreferencesFromChangedEvent(event, sessionKey);
      if (!changedPreferences) return;
      loadGeneration.current += 1;
      const normalized = normalizePreferences(changedPreferences);
      setPreferences(normalized);
      setLoadedSessionKey(sessionKey);
      setError(null);
      setIsReady(true);
      dismissImageGenerationPreferencesLoadError();
    };
    const handleRetry = () => setLoadVersion((version) => version + 1);
    window.addEventListener(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT, handleChange);
    window.addEventListener(IMAGE_GENERATION_PREFERENCES_RETRY_EVENT, handleRetry);
    return () => {
      ignore = true;
      window.removeEventListener(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT, handleChange);
      window.removeEventListener(IMAGE_GENERATION_PREFERENCES_RETRY_EVENT, handleRetry);
    };
  }, [loadVersion, sessionKey]);

  return { error, isReady, loadedSessionKey, preferences, retry };
}
