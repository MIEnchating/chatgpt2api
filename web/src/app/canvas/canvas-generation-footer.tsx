import { Spinner } from "@/components/ui/spinner";
import { TooltipHint } from "@/components/ui/tooltip";
import { ArrowUp, Sparkles, Square } from "lucide-react";

import { InputGroupButton } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export type CanvasPromptOptimizationAction = {
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
};

export function CanvasGenerationFooter({
  running,
  disabled = false,
  stopping = false,
  optimization,
  className,
  onGenerate,
  onStop,
}: {
  running: boolean;
  disabled?: boolean;
  stopping?: boolean;
  optimization?: CanvasPromptOptimizationAction;
  className?: string;
  onGenerate: () => void;
  onStop: () => void;
}) {
  const actionLabel = optimization?.loading ? "停止优化" : running ? "停止生成" : "开始生成";
  return (
    <div className={cn("shrink-0", className)}>
      <div className="flex items-center justify-end gap-2">
        {optimization ? (
          <InputGroupButton
            type="button"
            variant="outline"
            size="sm"
            className="min-w-0"
            disabled={optimization.disabled || running}
            aria-busy={optimization.loading}
            aria-label={optimization.loading ? "正在优化提示词" : "优化提示词"}
            onClick={optimization.onClick}
          >
            {optimization.loading ? <Spinner /> : <Sparkles />}
            {optimization.loading ? "正在优化" : "优化提示词"}
          </InputGroupButton>
        ) : null}
        <TooltipHint content={actionLabel}><InputGroupButton
          type="button"
          size="icon-sm"
          variant={running ? "destructive" : "default"}
          className="min-w-0"
          disabled={disabled || stopping}
          aria-busy={stopping}
          aria-label={actionLabel}
          onClick={running ? onStop : onGenerate}
        >
          {stopping ? <Spinner /> : running ? <Square className="fill-current" /> : <ArrowUp  />}
        </InputGroupButton></TooltipHint>
      </div>
    </div>
  );
}
