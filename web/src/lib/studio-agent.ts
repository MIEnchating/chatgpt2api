import { httpRequest } from "./request";
import { fetchAgentExecution, type AgentExecution } from "./agent-executions";
import type { ImageTurn, StoredImage } from "./image-conversation-types";
import { normalizeImageGenerationOptions } from "./image-generation-options";
import { isImageOutputFormat, isImageQuality } from "./api";

export type StudioAgent = { runId: string; model: string; tokenName: string };
export type StudioAgentResult = {
  settings: Record<string, unknown>;
  tasks: { id: string; settings: Record<string, unknown> }[];
  question?: { callId: string; text: string };
  text: string;
};

export function normalizeStudioAgent(value: unknown): StudioAgent | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.runId !== "string" || !item.runId || typeof item.model !== "string" || !item.model || typeof item.tokenName !== "string") return;
  return { runId: item.runId, model: item.model, tokenName: item.tokenName };
}

export async function startStudioAgent(conversationId: string, turn: ImageTurn, signal: AbortSignal) {
  const agent = turn.studioAgent;
  if (!agent) throw new Error("缺少智能生成配置");
  return (await httpRequest<{ run: AgentExecution<StudioAgentResult> }>("/api/creation-tasks/agent", {
    method: "POST", signal, body: { conversationId, turnId: turn.id, runId: agent.runId, model: agent.model, tokenName: agent.tokenName },
  })).run;
}

export async function waitStudioAgent(id: string, signal: AbortSignal, onProgress: (run: AgentExecution<StudioAgentResult>) => void) {
  while (true) {
    signal.throwIfAborted();
    const run = await fetchAgentExecution<StudioAgentResult>({ id }, signal);
    if (!run) throw new Error("智能生成任务不存在");
    onProgress(run);
    if (run.status === "success" && run.result) return run.result;
    if (!["running", "waiting"].includes(run.status)) throw new Error(run.error || "智能生成已中断，可从已保存进度继续");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException("观察已结束", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export function studioAgentTurnResult(turn: ImageTurn, result: StudioAgentResult, images: StoredImage[]): ImageTurn {
  const settings = result.tasks.at(-1)?.settings || result.settings;
  return {
    ...turn, size: typeof settings.size === "string" ? settings.size : turn.size,
    sizeSelection: typeof settings.size === "string" && settings.size !== turn.size ? undefined : turn.sizeSelection,
    count: images.length || turn.count,
    ...(turn.mode === "video" ? {
      videoSeconds: typeof settings.seconds === "number" ? settings.seconds : turn.videoSeconds,
      videoResolution: typeof settings.resolution === "string" ? settings.resolution : turn.videoResolution,
      videoGenerateAudio: typeof settings.generate_audio === "boolean" ? settings.generate_audio : turn.videoGenerateAudio,
      videoWatermark: typeof settings.watermark === "boolean" ? settings.watermark : turn.videoWatermark,
      videoParameters: settings.parameters && typeof settings.parameters === "object" ? settings.parameters as ImageTurn["videoParameters"] : turn.videoParameters,
    } : {
      quality: isImageQuality(settings.quality) ? settings.quality : turn.quality,
      outputFormat: isImageOutputFormat(settings.output_format) ? settings.output_format : turn.outputFormat,
      outputCompression: typeof settings.output_compression === "number" ? settings.output_compression : turn.outputCompression,
      imageOptions: { ...turn.imageOptions, ...normalizeImageGenerationOptions(settings) },
    }),
    images: result.text ? [...images, { id: `${turn.id}-agent-message`, status: "message", text_response: result.text }] : images,
    status: images.length ? "success" : "message", error: undefined,
  };
}

export function conversationComposerMode(conversation: { composerMode?: "image" | "video"; turns: Pick<ImageTurn, "mode">[] } | null): "image" | "video" {
  return conversation?.composerMode || (conversation?.turns.at(-1)?.mode === "video" ? "video" : "image");
}
