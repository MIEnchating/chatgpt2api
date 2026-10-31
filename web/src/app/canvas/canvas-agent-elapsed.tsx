import { memo } from "react";
import { useNow } from "@/lib/use-now";
import { canvasAgentElapsedMs, formatCanvasAgentElapsed } from "./agent/canvas-agent-timing";
import type { CanvasAssistantMessage } from "./agent/canvas-agent-types";

export const CanvasAgentElapsed = memo(function CanvasAgentElapsed({ elapsedMs, processingStartedAt, durationOnly = false }: Pick<CanvasAssistantMessage, "elapsedMs" | "processingStartedAt"> & { durationOnly?: boolean }) {
  const now = useNow(Boolean(processingStartedAt));
  if (elapsedMs === undefined && processingStartedAt === undefined) return null;
  return <span data-agent-elapsed role="timer" aria-live="off" className="text-xs tabular-nums text-muted-foreground">
    {durationOnly ? "" : processingStartedAt ? "任务已用时" : "任务用时"} {formatCanvasAgentElapsed(canvasAgentElapsedMs({ elapsedMs, processingStartedAt }, now))}
  </span>;
});
