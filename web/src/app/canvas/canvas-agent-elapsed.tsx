import { memo, useEffect, useState } from "react";
import { canvasAgentElapsedMs, formatCanvasAgentElapsed } from "./agent/canvas-agent-timing";
import type { CanvasAssistantMessage } from "./agent/canvas-agent-types";

export const CanvasAgentElapsed = memo(function CanvasAgentElapsed({ elapsedMs, processingStartedAt, durationOnly = false }: Pick<CanvasAssistantMessage, "elapsedMs" | "processingStartedAt"> & { durationOnly?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!processingStartedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [processingStartedAt]);
  if (elapsedMs === undefined && processingStartedAt === undefined) return null;
  return <span data-agent-elapsed role="timer" aria-live="off" className="text-xs tabular-nums text-muted-foreground">
    {durationOnly ? "" : processingStartedAt ? "任务已用时" : "任务用时"} {formatCanvasAgentElapsed(canvasAgentElapsedMs({ elapsedMs, processingStartedAt }, now))}
  </span>;
});
