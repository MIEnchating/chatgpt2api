import type {
  CanvasAssistantSession,
  CanvasAgentMessageQueue,
} from "./canvas-agent-types";
import { canvasAgentConversationRun } from "./canvas-agent-run-state";

type CanvasAgentQueueRun = { sessionId: string; assistantId: string; status: string; engine?: string };

export const MAX_AGENT_QUEUED_MESSAGES = 16;

export function canvasAgentCanResume(
  session: CanvasAssistantSession,
  run?: CanvasAgentQueueRun,
) {
  const latest = session.messages.findLast(
    (message) => message.role === "assistant",
  );
  if (!latest || session.agentState.pendingQuestion) return false;
  const turn = canvasAgentConversationRun(run);
  const status =
    turn?.sessionId === session.id && turn.assistantId === latest.id
      ? turn.status
      : latest.status;
  return (
    status === "error" ||
    status === "waiting" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export function canvasAgentComposerAction({
  busy,
  hasDraft,
  resumable,
  queued,
  waitingForAnswer = false,
}: {
  busy: boolean;
  hasDraft: boolean;
  resumable: boolean;
  queued: boolean;
  waitingForAnswer?: boolean;
}) {
  if (hasDraft) return busy ? "enqueue" : "send";
  if (busy) return "pause";
  if (waitingForAnswer) return "send";
  return resumable || queued ? "resume" : "send";
}

export function canvasAgentNextQueuedMessage(session: CanvasAssistantSession, run?: CanvasAgentQueueRun) {
  const queue = session.messageQueue;
  if (!queue?.messages.length || session.agentState.pendingQuestion) return;
  const next = queue.messages[0];
  if (queue.steeringId === next.id) return next;
  const latest = session.messages.findLast((message) => message.role === "assistant");
  const turn = canvasAgentConversationRun(run);
  const status = turn?.sessionId === session.id && turn.assistantId === latest?.id ? turn.status : latest?.status;
  if (
    queue.paused ||
    status !== "success"
  )
    return;
  return next;
}

export function canvasAgentConsumeQueuedMessage(
  queue: CanvasAgentMessageQueue | undefined,
  id: string,
): CanvasAgentMessageQueue | undefined {
  if (!queue) return;
  return {
    ...queue,
    paused: false,
    steeringId: undefined,
    messages: queue.messages.filter((message) => message.id !== id),
  };
}

// Keep browser-owned queue edits while the worker owns conversation progress.
export function mergeCanvasAgentMessageQueues(
  base: readonly unknown[] = [],
  local: readonly unknown[] = [],
  remote: readonly unknown[] = [],
) {
  const byId = (items: readonly unknown[]) =>
    new Map(
      items.flatMap((item) =>
        record(item) && typeof item.id === "string"
          ? [[item.id, item] as const]
          : [],
      ),
    );
  const before = byId(base),
    edited = byId(local);
  return remote.map((item) => {
    if (!record(item) || typeof item.id !== "string" || record(item.messageQueue) && item.messageQueue.serverManaged === true) return item;
    const original = before.get(item.id),
      changed = edited.get(item.id);
    if (
      !changed ||
      JSON.stringify(original?.messageQueue) ===
        JSON.stringify(changed.messageQueue)
    )
      return item;
    return { ...item, messageQueue: changed.messageQueue };
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
