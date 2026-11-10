import type { ComponentProps } from "react";
import { Spinner } from "@/components/ui/spinner";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

export function AgentActivityLine({ children, ...props }: Omit<ComponentProps<"div">, "role">) {
  return <TraceLine role="status" status="running" {...props}>
    <TraceIcon><Spinner /></TraceIcon>
    <TraceTitle>{children}</TraceTitle>
  </TraceLine>;
}
