// A confirmation never chooses an answer automatically.
import type { ReactNode } from "react";
import { CircleHelp, ShieldQuestion } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";

export function Confirmation({ title, description, confirmation = false, busy = false, actions, children }: {
  title: string;
  description?: string;
  confirmation?: boolean;
  busy?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const Icon = confirmation ? ShieldQuestion : CircleHelp;
  return <Item variant="outline" size="sm" data-ai-element="confirmation" aria-label={confirmation ? "Agent 等待确认" : "Agent 等待回答"} aria-busy={busy} className="mb-2 min-h-0 overflow-hidden">
    <ItemMedia variant="icon" className="self-start"><Icon /></ItemMedia>
    <ItemContent className="min-w-0 basis-40"><ItemTitle className="max-w-full line-clamp-none [overflow-wrap:anywhere]">{title}</ItemTitle>{description ? <ItemDescription className="whitespace-pre-wrap">{description}</ItemDescription> : null}</ItemContent>
    {actions ? <ItemActions className="ml-auto flex-wrap">{actions}</ItemActions> : null}
    {children}
  </Item>;
}
