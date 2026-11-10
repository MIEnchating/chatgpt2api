import { CanvasMentionMenu } from "./canvas-mention-menu";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { ItemMedia } from "@/components/ui/item";
import { FileText, Image as ImageIcon } from "lucide-react";
import {
  forwardRef,
  useMemo,
  useRef,
  useState,
  type TextareaHTMLAttributes,
} from "react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import {
  filterCanvasResourceMentions,
  findCanvasResourceMention,
  consumeCanvasResourceMention,
  isCanvasPromptSubmitKey,
  type CanvasResourceMention,
} from "@/app/canvas/canvas-resource-mentions";
import type { CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { cn } from "@/lib/utils";

type CanvasResourceMentionTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
  value: string;
  references: readonly CanvasResourceReference[];
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onReferenceSelect?: (reference: CanvasResourceReference) => void;
  containerClassName?: string;
};

export const CanvasResourceMentionTextarea = forwardRef<HTMLTextAreaElement, CanvasResourceMentionTextareaProps>(function CanvasResourceMentionTextarea({
  value,
  references,
  onChange,
  onSubmit,
  onReferenceSelect,
  containerClassName,
  className,
  style,
  onKeyDown,
  onBlur,
  ...props
}, forwardedRef) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<CanvasResourceMention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const candidates = useMemo(() => filterCanvasResourceMentions(mention, references), [mention, references]);

  function closeMention() {
    setMention(null);
    setActiveIndex(0);
  }

  function syncMention(nextValue: string, cursor: number) {
    const next = findCanvasResourceMention(nextValue, cursor, references);
    setMention(next);
    if (next) setActiveIndex(0);
  }

  function selectReference(reference: CanvasResourceReference) {
    if (!mention) return;
    const next = consumeCanvasResourceMention(value, mention, textareaRef.current?.selectionEnd ?? value.length);
    closeMention();
    onChange(next.value);
    onReferenceSelect?.(reference);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  return (
    <div className={cn("relative w-full", containerClassName)}>
      <InputGroupTextarea
        {...props}
        ref={(node) => {
          textareaRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        value={value}
        className={cn("block min-h-0 w-full min-w-0 resize-none", className)}
        style={style}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          syncMention(next, event.target.selectionStart);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            onKeyDown?.(event);
            return;
          }
          if (mention && candidates.length && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
            event.stopPropagation();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % candidates.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              selectReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              closeMention();
              return;
            }
          }
          if (onSubmit && isCanvasPromptSubmitKey(event)) {
            event.preventDefault();
            onSubmit();
            return;
          }
          onKeyDown?.(event);
        }}
        onBlur={(event) => {
          closeMention();
          onBlur?.(event);
        }}
      />
      {mention && candidates.length && textareaRef.current ? (
        <CanvasMentionMenu
          editor={textareaRef.current}
          getAnchorRect={() => textareaRef.current!.getBoundingClientRect()}
          items={candidates}
          getKey={(reference) => reference.id}
          activeIndex={Math.min(activeIndex, candidates.length - 1)}
          onActiveIndexChange={setActiveIndex}
          onSelect={selectReference}
          onClose={closeMention}
          renderItem={(reference) => <>
            <ItemMedia variant="icon" className="grid size-9 shrink-0 place-items-center overflow-hidden">
              {reference.kind === "image" && reference.previewURL
                ? <AuthenticatedImage src={reference.previewURL} alt="" className="size-full object-cover" />
                : reference.kind === "image" ? <ImageIcon /> : <FileText />}
            </ItemMedia>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{reference.label} · {reference.title}</span>
              {reference.text ? <span className="block truncate text-muted-foreground">{reference.text}</span> : null}
            </span>
          </>}
        />
      ) : null}
    </div>
  );
});
