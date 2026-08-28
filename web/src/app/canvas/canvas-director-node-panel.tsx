import { Layers3 } from "lucide-react";

import { Button } from "@/components/ui/button";

export function CanvasDirectorNodePanel({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-6 bg-card px-8 text-center">
      <Layers3 className="size-11 text-muted-foreground" strokeWidth={1.8} />
      <p className="text-[17px] font-medium leading-7 text-muted-foreground">
        在3D空间中搭建场景并进行多视角截图
      </p>
      <Button
        type="button"
        className="px-6 text-base"
        data-canvas-no-pan
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        打开导演台
      </Button>
    </div>
  );
}
