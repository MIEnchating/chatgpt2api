import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CanvasGenerationSecondaryAction = {
  label: string;
  icon: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export function CanvasGenerationFooter({
  running,
  disabled = false,
  stopping = false,
  secondaryAction,
  className,
  onGenerate,
  onStop,
}: {
  running: boolean;
  disabled?: boolean;
  stopping?: boolean;
  secondaryAction?: CanvasGenerationSecondaryAction;
  className?: string;
  onGenerate: () => void;
  onStop: () => void;
}) {
  return (
    <div className={cn("shrink-0 -mx-3 -mb-3 border-t border-border/80 bg-card/95 p-3 backdrop-blur-xl", className)}>
      <div className={cn("grid gap-2", secondaryAction && "grid-cols-[auto_minmax(0,1fr)]")}>
        {secondaryAction ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-10 min-w-0 rounded-lg px-3 text-xs"
            disabled={secondaryAction.disabled || secondaryAction.loading}
            aria-busy={secondaryAction.loading}
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.loading ? <LoaderCircle className="animate-spin" /> : secondaryAction.icon}
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          type="button"
          size="lg"
          variant={running ? "destructive" : "default"}
          className="h-10 w-full min-w-0 rounded-lg text-sm font-semibold"
          disabled={disabled || stopping}
          aria-busy={stopping}
          aria-label={running ? "停止生成" : "开始生成"}
          onClick={running ? onStop : onGenerate}
        >
          {running ? (
            <>
              {stopping ? <LoaderCircle className="animate-spin" /> : <Square className="size-3.5 fill-current" />}
              {stopping ? "停止中" : "停止生成"}
            </>
          ) : (
            <><ArrowUp className="size-4" />开始生成</>
          )}
        </Button>
      </div>
    </div>
  );
}
