import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_STEP_STATUS, AGENT_STEP_TONE_CLASS, type AgentStepStatus } from "./agent-step-status";

// Shared icon badge for one agent step; color and spin follow the shared status table.
export function AgentStepIcon({ icon: Icon, status, className }: { icon: LucideIcon; status: AgentStepStatus; className?: string }) {
  const { tone, spin } = AGENT_STEP_STATUS[status];
  return <span className={cn("relative z-10 flex size-6 shrink-0 items-center justify-center rounded-lg bg-card", status === "running" && "bg-brand-soft", AGENT_STEP_TONE_CLASS[tone], className)}>
    <Icon aria-hidden="true" className={cn("size-3.5", spin && "animate-spin")} />
  </span>;
}
