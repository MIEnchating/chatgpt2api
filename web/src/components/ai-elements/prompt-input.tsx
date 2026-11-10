import type { ComponentProps } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

// The input slot supports both textareas and canvas resource chip editors.
export function PromptInput({ className, ...props }: ComponentProps<typeof InputGroup>) {
  return <InputGroup data-ai-element="prompt-input" data-agent-composer className={cn("min-h-0 flex-col", className)} {...props} />;
}
export function PromptInputFooter({ className, ...props }: ComponentProps<typeof InputGroupAddon>) {
  return <InputGroupAddon data-agent-composer-toolbar align="block-end" className={cn("min-w-0 shrink-0", className)} {...props} />;
}
export function PromptInputSubmit({ className, ...props }: ComponentProps<typeof InputGroupButton>) {
  return <InputGroupButton type="button" size="icon-sm" variant="default" data-agent-send className={cn("ml-auto shrink-0 rounded-full", className)} {...props} />;
}
