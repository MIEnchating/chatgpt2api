import { Spinner } from "@/components/ui/spinner";
import { Check, CircleAlert, Clock, Pause, Square } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { AGENT_RUN_STATE, type AgentRunStatus } from "@/lib/agent-run-state";
import type { ReactNode } from "react";

export function RunStatus({ status, stopping = false, title, description, children }: {
  status: AgentRunStatus;
  stopping?: boolean;
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  const state = AGENT_RUN_STATE[status];
  const Icon = status === "success" ? Check : status === "error" ? CircleAlert : status === "cancelled" ? Square : status === "interrupted" ? Pause : Clock;
  return <Item variant="muted" size="sm" data-ai-element="run-status" data-status={status} aria-busy={stopping}>
    <ItemMedia variant="icon">{stopping || status === "running" ? <Spinner aria-hidden="true" /> : <Icon />}</ItemMedia>
    <ItemContent className="min-w-0">
      <ItemTitle className="max-w-full">{stopping ? "正在停止" : title || state.label}</ItemTitle>
      <ItemDescription className="[overflow-wrap:anywhere]" role={status === "error" ? "alert" : "status"}>{description || state.description}</ItemDescription>
    </ItemContent>
    {children ? <ItemActions className="flex-wrap">{children}</ItemActions> : null}
  </Item>;
}
