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
    <div className={cn("shrink-0 -mx-3 -mb-3 border-t border-border/80 bg-card/95 px-3 pb-1 pt-3 backdrop-blur-xl sm:-mx-4 sm:-mb-4 sm:px-4", className)}>
      <div className={cn("grid gap-2", secondaryAction && "grid-cols-[auto_minmax(0,1fr)]")}>
        {secondaryAction ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-10 px-3 text-xs"
            disabled={secondaryAction.disabled}
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
          className={cn(
            "h-10 w-full rounded-lg text-xs font-semibold text-white shadow-sm",
            running
              ? "bg-rose-600 hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              : "bg-[#1456f0] shadow-[0_4px_10px_rgba(20,86,240,.24)] hover:bg-[#0f45c8] hover:shadow-[0_5px_12px_rgba(20,86,240,.3)]",
          )}
          disabled={disabled}
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
