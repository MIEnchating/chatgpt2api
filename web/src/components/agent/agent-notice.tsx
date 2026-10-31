import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Shared amber notice block for agent surfaces (canvas resume notice, workflow draft warnings).
export function AgentNotice({ className, ...props }: ComponentProps<"div">) {
  return <div role="status" className={cn("rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs", className)} {...props} />;
}
