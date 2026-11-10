import { ItemMedia } from "@/components/ui/item";
import { ArrowUpRight, Layers3 } from "lucide-react";

import { Button } from "@/components/ui/button";

export function CanvasDirectorNodePanel({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex size-full min-h-0 flex-col items-center justify-center gap-3 bg-card p-3 text-center">
      <ItemMedia variant="icon" className="grid size-10 shrink-0 place-items-center"><Layers3 className="size-6" strokeWidth={1.8} /></ItemMedia>
      <p className="text-xs leading-4 text-muted-foreground">3D 场景</p>
      <Button
        type="button"
        className="max-w-full shrink-0"
        data-canvas-no-pan
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        打开导演台
        <ArrowUpRight  />
      </Button>
    </div>
  );
}
