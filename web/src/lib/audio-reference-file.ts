import type { AudioReferenceFileMetadata } from "./video-reference-validation";

export const AUDIO_REFERENCE_METADATA_TIMEOUT_MS = 8_000;

type AudioMetadataElement = Pick<
  HTMLAudioElement,
  "duration" | "load" | "onerror" | "onloadedmetadata" | "preload" | "removeAttribute" | "src"
>;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

export type AudioReferenceInspectionEnvironment = {
  createAudioElement: () => AudioMetadataElement;
  createObjectURL: (file: File) => string;
  revokeObjectURL: (url: string) => void;
  scheduleTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearScheduledTimeout: (handle: TimeoutHandle) => void;
};

const browserAudioReferenceInspectionEnvironment: AudioReferenceInspectionEnvironment = {
  createAudioElement: () => document.createElement("audio"),
  createObjectURL: (file) => URL.createObjectURL(file),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  scheduleTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearScheduledTimeout: (handle) => globalThis.clearTimeout(handle),
};

export function inspectAudioReferenceFile(
  file: File,
  environment: AudioReferenceInspectionEnvironment = browserAudioReferenceInspectionEnvironment,
) {
  return new Promise<AudioReferenceFileMetadata>((resolve, reject) => {
    const audio = environment.createAudioElement();
    const url = environment.createObjectURL(file);
    let timeoutHandle: TimeoutHandle | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutHandle !== null) {
        try {
          environment.clearScheduledTimeout(timeoutHandle);
        } catch {
          // Timer cleanup must not change the inspection result.
        }
        timeoutHandle = null;
      }
      audio.onloadedmetadata = null;
      audio.onerror = null;
      try {
        audio.removeAttribute("src");
        audio.load();
      } catch {
        // A detached audio element may already be unavailable during cleanup.
      }
      try {
        environment.revokeObjectURL(url);
      } catch {
        // URL cleanup failures must not leave metadata inspection pending.
      }
    };
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };

    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const metadata = { durationMs: Math.round(audio.duration * 1000), bytes: file.size };
      if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0) {
        settle(() => reject(new Error("无法读取参考音频的时长")));
        return;
      }
      settle(() => resolve(metadata));
    };
    audio.onerror = () => {
      settle(() => reject(new Error("无法读取参考音频，请确认文件编码可用")));
    };
    try {
      timeoutHandle = environment.scheduleTimeout(() => {
        settle(() => reject(new Error("读取参考音频信息超时，请重试")));
      }, AUDIO_REFERENCE_METADATA_TIMEOUT_MS);
      audio.src = url;
    } catch {
      settle(() => reject(new Error("无法读取参考音频，请确认文件编码可用")));
    }
  });
}
