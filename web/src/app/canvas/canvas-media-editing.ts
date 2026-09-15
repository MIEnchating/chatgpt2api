import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";

export type CanvasVideoFramePosition = "first" | "last" | "current";
export type CanvasAudioTrim = { start: number; end: number };

export function canvasVideoFrameTime(duration: number, position: CanvasVideoFramePosition, currentTime: number) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长");
  const last = Math.max(0, duration - 0.001);
  return position === "first" ? 0 : position === "last" ? last : Math.max(0, Math.min(Number.isFinite(currentTime) ? currentTime : 0, last));
}

export function validateCanvasAudioTrim(trim: CanvasAudioTrim, duration: number) {
  if (!Number.isFinite(trim.start) || !Number.isFinite(trim.end) || trim.start < 0 || Math.round((trim.end - trim.start) * 100) < 50) throw new Error("请选择有效范围，至少保留 0.5 秒");
  if (!Number.isFinite(duration) || trim.end > duration + 0.001) throw new Error("结束时间不能超过音频时长");
}

export async function canvasMediaBlob(source: { url?: string; storage_key?: string }, signal: AbortSignal) {
  signal.throwIfAborted();
  const id = source.storage_key?.startsWith("server:") ? source.storage_key.slice(7) : "";
  // Stored media uses our authenticated endpoint, including private cloud objects.
  const url = id ? `/api/files/${encodeURIComponent(id)}/content` : source.url;
  if (!url) throw new Error("素材地址不存在");
  return fetchAuthenticatedImageBlob(url, signal);
}

export async function captureCanvasVideoFrame(blob: Blob, position: CanvasVideoFramePosition, currentTime: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const ready = waitForCanvasMedia(video, "loadedmetadata", signal);
    video.src = url;
    video.load();
    await ready;
    const time = canvasVideoFrameTime(video.duration, position, currentTime);
    if (time > 0) {
      const seeked = waitForCanvasMedia(video, "seeked", signal);
      video.currentTime = time;
      await seeked;
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForCanvasMedia(video, "loadeddata", signal);
    }
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("无法读取视频画面");
    context.drawImage(video, 0, 0);
    const frame = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("视频截帧失败")), "image/png"));
    signal.throwIfAborted();
    return frame;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function waitForCanvasMedia(media: HTMLMediaElement, event: "loadedmetadata" | "loadeddata" | "seeked", signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      media.removeEventListener(event, success);
      media.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const success = () => finish();
    const fail = () => finish(new Error("当前浏览器无法读取该视频"));
    const abort = () => finish(signal.reason);
    const timeout = setTimeout(() => finish(new Error("读取视频超时")), 30_000);
    media.addEventListener(event, success, { once: true });
    media.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function extractCanvasAudio(blob: Blob, trim: CanvasAudioTrim | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  const { Input, ALL_FORMATS, BlobSource, Output, WavOutputFormat, BufferTarget, Conversion } = await import("mediabunny");
  signal.throwIfAborted();
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  let conversion: import("mediabunny").Conversion | undefined;
  const abort = () => { void conversion?.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("该素材没有音轨");
    const duration = await track.computeDuration();
    if (trim) validateCanvasAudioTrim(trim, duration);
    signal.throwIfAborted();
    const target = new BufferTarget();
    conversion = await Conversion.init({
      input,
      output: new Output({ format: new WavOutputFormat(), target }),
      tracks: "primary",
      video: { discard: true },
      trim,
      audio: { process: (sample) => { if (sample.timestamp < 0 && sample.timestamp > -1e-9) sample.setTimestamp(0); return sample; } },
    });
    signal.throwIfAborted();
    if (!conversion.isValid) throw new Error("当前浏览器无法解码该素材的音频");
    await conversion.execute();
    signal.throwIfAborted();
    if (!target.buffer) throw new Error("音频处理没有返回内容");
    return { blob: new Blob([target.buffer], { type: "audio/wav" }), duration: trim ? trim.end - trim.start : duration };
  } finally {
    signal.removeEventListener("abort", abort);
    await conversion?.cancel().catch(() => {});
    input.dispose();
  }
}
