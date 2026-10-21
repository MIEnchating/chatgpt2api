import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

export function LoadingState({ label = "正在加载", className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex h-full min-h-40 min-w-0 flex-col items-center justify-center gap-3 px-6 py-8 text-center", className)}>
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-border bg-card shadow-xs"><LoaderCircle aria-hidden="true" className="size-5 animate-spin text-brand" /></span>
      <p className="max-w-sm text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{label}</p>
    </div>
  );
}
