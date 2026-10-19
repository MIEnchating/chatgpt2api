import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

export function LoadingState({ label = "正在加载", className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center", className)}>
      <span className="grid size-11 place-items-center rounded-xl border border-border bg-card shadow-xs"><LoaderCircle aria-hidden="true" className="size-5 animate-spin text-brand" /></span>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
