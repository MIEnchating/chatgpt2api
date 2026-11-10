import { Spinner } from "@/components/ui/spinner";
import { TooltipHint } from "@/components/ui/tooltip";
import { ArrowUp, Square } from "lucide-react";
import type { ReactNode } from "react";

import { InputGroupButton } from "@/components/ui/input-group";
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
          <InputGroupButton
            type="button"
            variant="outline"
            size="sm"
            className="min-w-0"
            disabled={secondaryAction.disabled || secondaryAction.loading}
            aria-busy={secondaryAction.loading}
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.loading ? <Spinner /> : secondaryAction.icon}
            {secondaryAction.label}
          </InputGroupButton>
        ) : null}
        <TooltipHint content={running ? "停止生成" : "开始生成"}><InputGroupButton
          type="button"
          size="icon-sm"
          variant={running ? "destructive" : "default"}
          className="min-w-0"
          disabled={disabled || stopping}
          aria-busy={stopping}
          aria-label={running ? "停止生成" : "开始生成"}
          onClick={running ? onStop : onGenerate}
        >
          {stopping ? <Spinner /> : running ? <Square className="fill-current" /> : <ArrowUp  />}
        </InputGroupButton></TooltipHint>
      </div>
    </div>
  );
}
