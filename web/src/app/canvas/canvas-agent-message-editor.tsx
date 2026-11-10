import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PromptInput, PromptInputFooter } from "@/components/ai-elements/prompt-input";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { InputGroupTextarea } from "@/components/ui/input-group";

export function CanvasAgentMessageEditor({ text, disabled, onSave, onCancel }: {
  text: string;
  disabled: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(input.value.length, input.value.length);
  }, []);
  function save() { if (draft.trim() && !disabled) onSave(draft.trim()); }
  return <form data-agent-message-editor className="w-full min-w-0" onSubmit={(event) => { event.preventDefault(); save(); }}>
    <PromptInput>
    <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-72" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0">
      <InputGroupTextarea ref={inputRef} aria-label="编辑消息内容" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
        }} className="min-h-24 resize-none overflow-hidden" />
    </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
    <PromptInputFooter className="justify-end"><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>取消</Button><Button type="submit" size="sm" disabled={disabled || !draft.trim()}>发送</Button></PromptInputFooter>
    </PromptInput>
  </form>;
}
