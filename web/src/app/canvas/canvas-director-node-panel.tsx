import { ArrowUpRight, Layers3 } from "lucide-react";

import { Button } from "@/components/ui/button";

export function CanvasDirectorNodePanel({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex size-full min-h-0 flex-col items-center justify-center gap-3 bg-card p-3 text-center">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-300"><Layers3 className="size-6" strokeWidth={1.8} /></span>
      <p className="text-xs leading-4 text-muted-foreground">3D 场景</p>
      <Button
        type="button"
        className="h-8 max-w-full shrink-0 gap-1.5 rounded-md px-3 text-xs"
        data-canvas-no-pan
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        打开导演台
        <ArrowUpRight className="size-3.5" />
      </Button>
    </div>
  );
}
