import { FileText, Image as ImageIcon } from "lucide-react";
import { createPortal } from "react-dom";
import {
  forwardRef,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type TextareaHTMLAttributes,
} from "react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import { ScrollArea } from "@/components/ui/scroll-area";
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
      <textarea
        {...props}
        ref={(node) => {
          textareaRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        value={value}
        className={cn("block w-full min-w-0 outline-none focus-visible:ring-0", className)}
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
          if (mention && candidates.length) {
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
          window.setTimeout(closeMention, 120);
          onBlur?.(event);
        }}
      />
      {mention && candidates.length && textareaRef.current ? (
        <CanvasResourceMentionMenu
          textarea={textareaRef.current}
          references={candidates}
          activeIndex={Math.min(activeIndex, candidates.length - 1)}
          onSelect={selectReference}
        />
      ) : null}
    </div>
  );
});

function CanvasResourceMentionMenu({ textarea, references, activeIndex, onSelect }: {
  textarea: HTMLTextAreaElement;
  references: readonly CanvasResourceReference[];
  activeIndex: number;
  onSelect: (reference: CanvasResourceReference) => void;
}) {
  const selectedRef = useRef(false);
  const rect = textarea.getBoundingClientRect();
  const boundary = textarea.closest("[role='dialog']")?.getBoundingClientRect() || { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
  const width = 256;
  const height = 224;
  const gap = 6;
  const left = clamp(rect.left, boundary.left + 8, boundary.right - width - 8);
  const showAbove = rect.bottom + gap + height > boundary.bottom && rect.top - gap - height >= boundary.top;
  const top = clamp(showAbove ? rect.top - gap - height : rect.bottom + gap, boundary.top + 8, boundary.bottom - height - 8);
  const stop = (event: PointerEvent | MouseEvent) => event.stopPropagation();
  const select = (reference: CanvasResourceReference) => {
    if (selectedRef.current) return;
    selectedRef.current = true;
    onSelect(reference);
  };

  return createPortal(
    <ScrollArea
      data-canvas-resource-mention-menu
      className="pointer-events-auto fixed z-[120] max-h-56 w-64 rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      viewportClassName="p-1"
      style={{ left, top }}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={(event) => event.stopPropagation()}
    >
      {references.map((reference, index) => (
        <button
          key={reference.id}
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs", index === activeIndex && "bg-accent text-accent-foreground")}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            select(reference);
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            select(reference);
          }}
        >
          <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
            {reference.kind === "image" && reference.previewURL
              ? <AuthenticatedImage src={reference.previewURL} alt="" className="size-full object-cover" />
              : reference.kind === "image" ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{reference.label} · {reference.title}</span>
            <span className="block truncate text-muted-foreground">{reference.text || reference.title}</span>
          </span>
        </button>
      ))}
    </ScrollArea>,
    document.body,
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}
