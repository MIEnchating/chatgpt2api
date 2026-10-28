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
    <div className={cn("shrink-0", className)}>
      <div className="flex items-center justify-end gap-2">
        {secondaryAction ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-8 min-w-0 rounded-lg px-3 text-xs"
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
          className="size-8 min-w-0 rounded-xl p-0"
          title={running ? "停止生成" : "开始生成"}
          disabled={disabled || stopping}
          aria-busy={stopping}
          aria-label={running ? "停止生成" : "开始生成"}
          onClick={running ? onStop : onGenerate}
        >
          {stopping ? <LoaderCircle className="animate-spin" /> : running ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
