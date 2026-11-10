import type { LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { AgentStepStatus } from "./agent-step-status";

export function AgentStepIcon({ icon: Icon, status, className }: { icon: LucideIcon; status: AgentStepStatus; className?: string }) {
  if (status === "running") return <Spinner aria-hidden="true" className={className} />;
  return <Icon aria-hidden="true" className={className} />;
}
