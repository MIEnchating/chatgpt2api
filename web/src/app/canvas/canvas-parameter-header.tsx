import type { ReactNode } from "react";

// Title element reused by panels that lay out their own right-hand controls (for example the video panel).
export function CanvasParameterTitle() {
  return <h3 className="text-xs font-semibold text-foreground">生成参数</h3>;
}

// Shared title row for every node parameter panel so image, video and audio sections read the same.
export function CanvasParameterHeader({ summary }: { summary?: ReactNode }) {
  return <div className="flex items-center justify-between gap-3">
    <CanvasParameterTitle />
    {summary ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{summary}</span> : null}
  </div>;
}
