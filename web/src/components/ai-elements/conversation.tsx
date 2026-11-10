import type { ComponentProps, ReactNode } from "react";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";

export function Conversation({ children, showScrollButton = true, className, contentClassName, ...props }: Omit<ComponentProps<typeof MessageScrollerViewport>, "children"> & { children: ReactNode; showScrollButton?: boolean; contentClassName?: string }) {
  return <MessageScrollerProvider autoScroll defaultScrollPosition="end">
    <MessageScroller data-ai-element="conversation" className={cn("min-h-0 flex-1", className)}>
      <MessageScrollerViewport data-agent-message-scroll {...props}>
        <MessageScrollerContent className={cn("p-4", contentClassName)}>{children}</MessageScrollerContent>
      </MessageScrollerViewport>
      {showScrollButton ? <MessageScrollerButton aria-label="回到最新" size="icon-sm" /> : null}
    </MessageScroller>
  </MessageScrollerProvider>;
}
