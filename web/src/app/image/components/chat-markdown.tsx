"use client";

import { MessageResponse } from "@/components/ai-elements/message";

export function ChatMarkdown({ children, className }: { children: string; className?: string }) {
  if (!children.trim()) return null;

  return (
    <MessageResponse className={className}>
      {children}
    </MessageResponse>
  );
}
