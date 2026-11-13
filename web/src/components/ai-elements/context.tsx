// AI Elements Context: official circular indicator, composed with shadcn HoverCard.
// https://elements.ai-sdk.dev/components/context
// https://ui.shadcn.com/docs/ai-elements/radix/context
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";

export function Context({
  tokens,
  error,
  limit,
  rows,
  compacting = false,
  reported = false,
  measured = false,
}: {
  tokens?: number;
  error?: string;
  limit?: number;
  rows: { label: string; value: string }[];
  compacting?: boolean;
  reported?: boolean;
  measured?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = error ? "用量估算失败" : tokens === undefined ? "正在估算" : undefined;
  const percent =
    tokens !== undefined && limit && limit > 0 ? Math.round((tokens / limit) * 1000) / 10 : undefined;
  const progress =
    percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * 9.5;
  const format = (value: number) =>
    new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={100}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <Button
          data-ai-element="context"
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="查看上下文"
          onClick={() => setOpen(true)}
        >
          <svg
            className="size-5"
            viewBox="0 0 24 24"
            role={progress === undefined ? "img" : "progressbar"}
            aria-label="上下文占用"
            aria-valuemin={progress === undefined ? undefined : 0}
            aria-valuemax={progress === undefined ? undefined : 100}
            aria-valuenow={progress}
            aria-valuetext={
              status || (percent === undefined
                ? "上限未知"
                : `${percent}%${compacting ? "，正在压缩" : ""}`)
            }
          >
            <circle
              cx="12"
              cy="12"
              r="9.5"
              fill="none"
              opacity="0.25"
              stroke="currentColor"
              strokeWidth="3.5"
            />
            {progress === undefined ? null : (
              <circle
                cx="12"
                cy="12"
                r="9.5"
                fill="none"
                opacity="0.7"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeDasharray={`${circumference} ${circumference}`}
                strokeDashoffset={circumference * (1 - progress / 100)}
                transform="rotate(-90 12 12)"
              />
            )}
          </svg>
        </Button>
      </HoverCardTrigger>
      {open ? <HoverCardContent
        side="top"
        align="end"
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 p-4"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium">{compacting ? "正在压缩上下文" : "上下文"}</span>
          <span className="shrink-0 text-muted-foreground">{status || (percent === undefined ? "上限未知" : `${percent}%`)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium tabular-nums">{tokens === undefined ? "尚无统计" : format(tokens)}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{limit ? `${format(limit)} tokens` : "tokens"}</span>
        </div>
        <Progress value={progress} aria-label="上下文占用" className="h-2" />
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-x-4 gap-y-2 border-t pt-3 text-xs">
          {rows.map((row) => <div key={row.label} className="contents">
            <span className="min-w-0 text-muted-foreground">{row.label}</span>
            <span className="min-w-0 break-words text-right font-medium tabular-nums">{row.value}</span>
          </div>)}
        </div>
        <p className="border-t pt-3 text-xs leading-5 text-muted-foreground">
          {error ? `${error}，请重新打开面板重试。` : tokens === undefined ? "正在估算当前对话和画布的上下文用量。" : measured ? "最近一次上游返回的实际输入 token，包含系统指令和工具定义。配置上限与执行记录存储上限分别计算。" : reported
            ? "最近一次模型输入的估算，包含系统指令和工具定义。"
            : "可见对话和画布内容的估算；运行后更新模型输入统计。"}
        </p>
      </HoverCardContent> : null}
    </HoverCard>
  );
}
