import type { ComponentProps } from "react";
import { Item, ItemContent } from "@/components/ui/item";

export function AgentNotice({ children, ...props }: ComponentProps<"div">) {
  return <Item role="status" variant="muted" size="sm" {...props}><ItemContent>{children}</ItemContent></Item>;
}
