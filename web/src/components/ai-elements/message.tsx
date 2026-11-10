// AI Elements message composition with the shared shadcn message primitives.
import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { markdownTranslations } from "@/lib/markdown-translations";
import { cn } from "@/lib/utils";
import { Message as MessageRoot, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";

export function Message({ from, ...props }: Omit<ComponentProps<typeof MessageRoot>, "align"> & { from: "user" | "assistant" }) {
  return <MessageRoot data-ai-element="message" data-role={from} align={from === "user" ? "end" : "start"} {...props} />;
}
export const MessageResponse = memo(function MessageResponse({ children, components, className }: Pick<ComponentProps<typeof Streamdown>, "children" | "components" | "className">) {
  return <Streamdown data-ai-element="message-response" className={cn("min-w-0 break-words text-sm leading-6", className)} components={components} plugins={{ code }} translations={markdownTranslations} linkSafety={{ enabled: false }} skipHtml>{children}</Streamdown>;
});
export { MessageContent, MessageFooter, MessageHeader };
