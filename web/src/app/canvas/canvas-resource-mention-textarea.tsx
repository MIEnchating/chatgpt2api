import { FileText, Image as ImageIcon } from "lucide-react";
import { createPortal } from "react-dom";
import {
  forwardRef,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type TextareaHTMLAttributes,
} from "react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import {
  filterCanvasResourceMentions,
  findCanvasResourceMention,
  insertCanvasResourceMention,
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
  containerClassName?: string;
  highlightLabels?: boolean;
};

export const CanvasResourceMentionTextarea = forwardRef<HTMLTextAreaElement, CanvasResourceMentionTextareaProps>(function CanvasResourceMentionTextarea({
  value,
  references,
  onChange,
  onSubmit,
  containerClassName,
  highlightLabels = true,
  className,
  style,
  onSelect,
  onKeyUp,
  onPointerUp,
  onKeyDown,
  onScroll,
  onBlur,
  ...props
}, forwardedRef) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [mention, setMention] = useState<CanvasResourceMention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const candidates = useMemo(() => filterCanvasResourceMentions(mention, references), [mention, references]);
  const activeLabels = useMemo(() => (
    highlightLabels
      ? Array.from(new Set(references.filter((reference) => reference.active).map((reference) => reference.label))).sort((a, b) => b.length - a.length)
      : []
  ), [highlightLabels, references]);

  function closeMention() {
    setMention(null);
    setActiveIndex(0);
  }

  function syncMention(nextValue: string, cursor: number) {
    const next = findCanvasResourceMention(nextValue, cursor, references);
    setMention(next);
    if (next) setActiveIndex(0);
  }

  function updateSelectionState() {
    const textarea = textareaRef.current;
    setHasSelection(Boolean(textarea && textarea.selectionStart !== textarea.selectionEnd));
  }

  function syncOverlayScroll() {
    if (!overlayRef.current || !textareaRef.current) return;
    overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    overlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
  }

  function selectReference(reference: CanvasResourceReference) {
    if (!mention) return;
    const next = insertCanvasResourceMention(value, mention, textareaRef.current?.selectionStart ?? value.length, reference);
    closeMention();
    onChange(next.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  const showOverlay = Boolean(activeLabels.length && !hasSelection);
  const mergedStyle = {
    ...style,
    color: showOverlay ? "transparent" : style?.color,
    caretColor: style?.color || "currentColor",
    ...(showOverlay ? { background: "transparent", backgroundColor: "transparent" } : {}),
  } satisfies CSSProperties;

  return (
    <div className={cn("relative size-full", containerClassName)}>
      {showOverlay ? (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className={cn("block w-full min-w-0", className, "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words")}
          style={style}
        >
          <MentionHighlightText value={value || String(props.placeholder || "")} labels={activeLabels} placeholder={!value} />
        </div>
      ) : null}
      <textarea
        {...props}
        ref={(node) => {
          textareaRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        value={value}
        className={cn("block w-full min-w-0", className)}
        style={mergedStyle}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          syncMention(next, event.target.selectionStart);
          requestAnimationFrame(() => {
            syncOverlayScroll();
            updateSelectionState();
          });
        }}
        onSelect={(event) => {
          updateSelectionState();
          onSelect?.(event);
        }}
        onKeyUp={(event) => {
          updateSelectionState();
          onKeyUp?.(event);
        }}
        onPointerUp={(event) => {
          updateSelectionState();
          onPointerUp?.(event);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
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
        onScroll={(event) => {
          syncOverlayScroll();
          onScroll?.(event);
        }}
        onBlur={(event) => {
          setHasSelection(false);
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

function MentionHighlightText({ value, labels, placeholder }: { value: string; labels: string[]; placeholder: boolean }) {
  if (placeholder) return <span className="text-muted-foreground">{value}</span>;
  if (!labels.length) return <>{value}</>;
  const pattern = new RegExp(`(${labels.map(escapeRegExp).join("|")})`, "g");
  return value.split(pattern).map((part, index) => labels.includes(part) ? (
    <span key={`${part}-${index}`} className="rounded-md bg-[#1456f0]/12 px-1 py-0.5 font-medium text-[#1456f0] ring-1 ring-[#1456f0]/20">{part}</span>
  ) : <span key={`${part}-${index}`}>{part}</span>);
}

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
    <div
      data-canvas-resource-mention-menu
      className="fixed z-[120] max-h-56 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl"
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
            <span className="block font-medium">{reference.label}</span>
            <span className="block truncate text-muted-foreground">{reference.text || reference.title}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
