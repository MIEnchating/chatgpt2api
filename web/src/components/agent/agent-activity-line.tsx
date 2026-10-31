import type { ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared "what the agent is doing now" line for canvas, workflow draft and other agent surfaces.
export function AgentActivityLine({ className, children, ...props }: Omit<ComponentProps<"div">, "role">) {
  return <div role="status" className={cn("flex items-start gap-2 py-1 text-xs leading-5 text-muted-foreground", className)} {...props}>
    <LoaderCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 animate-spin text-brand" />
    <span className="min-w-0">{children}</span>
  </div>;
}
