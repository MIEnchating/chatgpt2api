import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";

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
  return <form data-agent-message-editor className="w-full min-w-0 rounded-xl border border-brand/25 bg-brand-soft p-2" onSubmit={(event) => { event.preventDefault(); save(); }}>
    <ScrollArea className="max-h-72" manageKeyboard={false}>
      <Textarea ref={inputRef} aria-label="编辑消息内容" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
        }} className="min-h-24 resize-none overflow-hidden border-0 bg-transparent px-2 py-1 text-sm shadow-none focus-visible:ring-0" />
    </ScrollArea>
    <div className="mt-2 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>取消</Button><Button type="submit" size="sm" disabled={disabled || !draft.trim()}>发送</Button></div>
  </form>;
}
