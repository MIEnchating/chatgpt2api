import type { CanvasAssistantMessage } from "./canvas-agent-types";

type Timing = Pick<CanvasAssistantMessage, "elapsedMs" | "processingStartedAt">;

export function canvasAgentElapsedMs(message: Timing, now = Date.now()) {
  return Math.max(0, message.elapsedMs || 0) + (message.processingStartedAt ? Math.max(0, (Number.isFinite(now) ? now : message.processingStartedAt) - message.processingStartedAt) : 0);
}

export function setCanvasAgentProcessing<T extends Timing>(message: T, processing: boolean, now = Date.now()): T {
  if (processing) return { ...message, elapsedMs: message.elapsedMs || 0, processingStartedAt: message.processingStartedAt || now };
  if (message.processingStartedAt === undefined) return message;
  return { ...message, elapsedMs: canvasAgentElapsedMs(message, now), processingStartedAt: undefined };
}

export function formatCanvasAgentElapsed(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分 ${seconds % 60}秒`;
}

// Clarification answers continue the original task instead of starting a new timer.
export function canvasAgentTaskTimings(messages: readonly CanvasAssistantMessage[]) {
  const result = new Map<string, Timing>();
  let lastAssistant: string | undefined;
  let timing: Timing = {};
  for (const message of messages) {
    if (message.role === "user") {
      if (!message.questionAnswerFor) { lastAssistant = undefined; timing = {}; }
      continue;
    }
    if (lastAssistant) result.delete(lastAssistant);
    if (message.elapsedMs !== undefined || message.processingStartedAt !== undefined) {
      timing = { elapsedMs: (timing.elapsedMs || 0) + (message.elapsedMs || 0), processingStartedAt: message.processingStartedAt };
    }
    lastAssistant = message.id;
    result.set(message.id, { ...timing });
  }
  return result;
}
