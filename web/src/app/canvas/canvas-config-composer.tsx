import { FileText, Image as ImageIcon, Music2, Video, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  contentEditableTextBeforeCaret,
  deleteAdjacentContentEditableReference,
  getContentEditableMentionKeyAction,
  insertPlainTextAtContentEditableSelection,
  moveContentEditableMentionIndex,
  placeContentEditableCaretAtEnd,
  removeActiveContentEditableMention,
  serializeContentEditable,
} from "@/app/canvas/canvas-contenteditable";
import { CANVAS_CONFIG_REFERENCE_PATTERN, canvasConfigInputLabel, canvasConfigUsesConnectedText, type CanvasConfigInput } from "@/app/canvas/canvas-config-inputs";
import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CanvasNode } from "@/services/api/canvas";
import { cn } from "@/lib/utils";

type ComposerToken =
  | { type: "text"; value: string }
  | { type: "reference"; nodeID: string };

export function CanvasConfigComposer({ node, inputs, children, promptTools, onComposerChange, onClose }: {
  node: CanvasNode;
  inputs: CanvasConfigInput[];
  children?: ReactNode;
  promptTools?: ReactNode;
  onComposerChange: (value: string, commit?: boolean) => void;
  onClose: () => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const inputsRef = useRef(inputs);
  const composerChangeRef = useRef(onComposerChange);
  inputsRef.current = inputs;
  composerChangeRef.current = onComposerChange;
  const value = node.composer_content ?? node.prompt ?? "";
  const hasExplicitComposerContent = node.composer_content !== undefined;
  const inputsSignature = JSON.stringify(inputs);
  const usesConnectedText = canvasConfigUsesConnectedText(inputs);
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewInput, setPreviewInput] = useState<CanvasConfigInput | null>(null);
  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    return inputs.filter((input) => !query || `${canvasConfigInputLabel(input, inputs)} ${input.title} ${input.text || ""}`.toLowerCase().includes(query));
  }, [inputs, mention]);

  useEffect(() => {
    if (document.activeElement === editorRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const currentInputs = inputsRef.current;
    const connectedTextInputs = currentInputs.filter((input) => input.type === "text" && Boolean(input.text?.trim()));
    const inputByID = new Map(currentInputs.map((input) => [input.nodeID, input]));
    const tokens = parseComposerTokens(value);
    editor.textContent = "";
    if (!hasExplicitComposerContent && !tokens.length && connectedTextInputs.length) {
      connectedTextInputs.forEach((input) => {
        const chip = createReferenceChip(input, currentInputs, setPreviewInput, () => removeReferenceChip(chip, editor, composerChangeRef.current));
        editor.append(chip, document.createTextNode(" "));
      });
      return;
    }
    tokens.forEach((token) => {
      if (token.type === "text") {
        editor.append(document.createTextNode(token.value));
        return;
      }
      const input = inputByID.get(token.nodeID);
      if (input) {
        const chip = createReferenceChip(input, currentInputs, setPreviewInput, () => removeReferenceChip(chip, editor, composerChangeRef.current));
        editor.append(chip);
      }
    });
  }, [hasExplicitComposerContent, inputsSignature, value]);

  function closeMention() {
    setMention(null);
    setActiveIndex(0);
  }

  function syncMention() {
    const match = /@([^\s@]*)$/.exec(contentEditableTextBeforeCaret());
    if (!match || !inputs.length) return closeMention();
    setMention({ query: match[1] || "" });
    setActiveIndex(0);
  }

  function syncFromEditor(commit = false) {
    const editor = editorRef.current;
    if (!editor) return;
    onComposerChange(serializeEditor(editor), commit);
    syncMention();
  }

  function insertReference(input: CanvasConfigInput) {
    const editor = editorRef.current;
    if (!editor) return;
    const textBeforeMention = contentEditableTextBeforeCaret();
    removeActiveContentEditableMention();
    const chip = createReferenceChip(input, inputs, setPreviewInput, () => removeReferenceChip(chip, editor, onComposerChange));
    const beforeMention = textBeforeMention.replace(/@([^\s@]*)$/, "");
    const needsLeadingSpace = Boolean(beforeMention && !/\s$/.test(beforeMention));
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range) {
      range.insertNode(space);
      range.insertNode(chip);
      if (needsLeadingSpace) range.insertNode(document.createTextNode(" "));
      range.setStartAfter(space);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      if (needsLeadingSpace) editor.append(document.createTextNode(" "));
      editor.append(chip, space);
      placeContentEditableCaretAtEnd(editor);
    }
    closeMention();
    onComposerChange(serializeEditor(editor));
  }

  const previewImages = previewInput?.url ? [{ id: previewInput.nodeID, src: previewInput.url, fileName: previewInput.title }] : [];
  const composerEditor = editorRef.current;

  return (
    <div
      data-canvas-no-zoom
      className="rounded-2xl border border-border bg-card p-3 shadow-[0_18px_50px_rgba(15,23,42,.18)] backdrop-blur-xl"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="shrink-0 text-xs font-semibold">组装提示词</p>
          <p className="truncate text-[11px] text-muted-foreground">@ 引用已连接资源，发送时按当前连接编号</p>
        </div>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="关闭提示词面板" onClick={onClose}><X className="size-3.5" /></Button>
      </div>
      <div className="canvas-prompt-editor-resize relative h-28 rounded-xl border border-border bg-background">
          {!value.trim() && !usesConnectedText ? <div className="pointer-events-none absolute top-2 left-3 text-sm leading-7 text-muted-foreground">输入提示词，按 @ 引用连接的图片或文本</div> : null}
          <ScrollArea className="h-full" viewportClassName="h-full" viewClass="w-full" viewStyle={{ minHeight: "100%" }}>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            className="min-h-28 w-full whitespace-pre-wrap break-words px-3 py-2 text-sm leading-7 outline-none"
            onInput={() => { if (!composingRef.current) syncFromEditor(); }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain");
              if (!text) return;
              event.preventDefault();
              if (insertPlainTextAtContentEditableSelection(text)) syncFromEditor();
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; syncFromEditor(); }}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              event.stopPropagation();
              const mentionAction = mention ? getContentEditableMentionKeyAction(event.key, candidates.length) : null;
              if (mentionAction) {
                event.preventDefault();
                if (mentionAction.type === "move") setActiveIndex((index) => moveContentEditableMentionIndex(index, candidates.length, mentionAction.offset));
                else if (mentionAction.type === "select") insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
                else closeMention();
                return;
              }
              if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentContentEditableReference(event.key, "referenceNodeId")) {
                event.preventDefault();
                requestAnimationFrame(() => syncFromEditor());
                return;
              }
              requestAnimationFrame(syncMention);
            }}
            onBlur={() => {
              syncFromEditor(true);
              window.setTimeout(closeMention, 120);
            }}
          />
          </ScrollArea>
          {mention && candidates.length && composerEditor ? (
            <ComposerMentionMenu
              editor={composerEditor}
              inputs={candidates}
              allInputs={inputs}
              activeIndex={Math.min(activeIndex, candidates.length - 1)}
              onSelect={insertReference}
            />
          ) : null}
      </div>
      {promptTools ? <div className="mt-2 flex min-w-0 items-center border-t border-border/70 pt-2">{promptTools}</div> : null}
      {children ? <div className="mt-3 space-y-3 border-t border-border pt-3">{children}</div> : null}
      <ImageLightbox images={previewImages} currentIndex={0} open={Boolean(previewInput?.url)} onOpenChange={(open) => { if (!open) setPreviewInput(null); }} onIndexChange={() => undefined} />
    </div>
  );
}

function ComposerMentionMenu({ editor, inputs, allInputs, activeIndex, onSelect }: {
  editor: HTMLDivElement;
  inputs: CanvasConfigInput[];
  allInputs: CanvasConfigInput[];
  activeIndex: number;
  onSelect: (input: CanvasConfigInput) => void;
}) {
  const selectedRef = useRef(false);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, inputs]);

  useLayoutEffect(() => {
    function updatePosition() {
      const anchor = composerCaretRect(editor);
      const width = Math.min(288, Math.max(240, window.innerWidth - 16));
      const estimatedHeight = 224;
      const gap = 6;
      const left = clamp(anchor.left, 8, window.innerWidth - width - 8);
      const showAbove = anchor.bottom + gap + estimatedHeight > window.innerHeight && anchor.top - gap - estimatedHeight >= 8;
      const top = clamp(showAbove ? anchor.top - gap - estimatedHeight : anchor.bottom + gap, 8, window.innerHeight - estimatedHeight - 8);
      setPosition({ left, top, width });
    }

    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(editor);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [editor]);

  function select(input: CanvasConfigInput) {
    if (selectedRef.current) return;
    selectedRef.current = true;
    onSelect(input);
  }

  if (!position) return null;

  return createPortal(
    <ScrollArea
      data-canvas-config-mention-menu
      className="fixed z-[140] max-h-56 rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      viewportClassName="p-1"
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {inputs.map((input, index) => (
        <button
          key={input.nodeID}
          ref={index === activeIndex ? activeItemRef : undefined}
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs", index === activeIndex && "bg-accent text-accent-foreground")}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            select(input);
          }}
        >
          <ResourcePreview input={input} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{canvasConfigInputLabel(input, allInputs)}</span>
            <span className="block truncate text-muted-foreground">{input.text || input.title}</span>
          </span>
        </button>
      ))}
    </ScrollArea>,
    document.body,
  );
}

function ResourcePreview({ input }: { input: CanvasConfigInput }) {
  if (input.type === "image" && input.url) return <img src={input.url} alt="" className="size-9 shrink-0 rounded-md object-cover" />;
  if (input.type === "video" && input.url) return <video src={input.url} className="size-9 shrink-0 rounded-md bg-black object-cover" muted preload="metadata" />;
  const Icon = input.type === "audio" ? Music2 : input.type === "video" ? Video : input.type === "image" ? ImageIcon : FileText;
  return <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted"><Icon className="size-4" /></span>;
}

function createReferenceChip(input: CanvasConfigInput, inputs: CanvasConfigInput[], onPreview: (input: CanvasConfigInput) => void, onDelete?: () => void) {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.referenceNodeId = input.nodeID;
  chip.dataset.tooltip = input.text || input.title;
  chip.className = "mx-px inline-flex h-7 max-w-40 items-center gap-1 overflow-hidden rounded-md border border-border bg-card px-2 text-xs leading-none align-middle text-foreground";

  const icon = document.createElement("span");
  icon.textContent = input.type === "image" ? "▧" : "T";
  icon.className = input.type === "image" ? "text-[#1456f0]" : "text-amber-600";
  const label = document.createElement("span");
  label.className = "block truncate";
  label.textContent = `${canvasConfigInputLabel(input, inputs)} · ${input.type === "text" ? input.text || input.title : input.title}`;
  chip.append(icon, label);
  if (onDelete) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.ariaLabel = `删除${canvasConfigInputLabel(input, inputs)}引用`;
    remove.textContent = "×";
    remove.className = "ml-0.5 grid size-4 shrink-0 place-items-center rounded text-sm leading-none text-muted-foreground hover:bg-muted hover:text-foreground";
    let removed = false;
    const deleteReference = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (removed) return;
      removed = true;
      onDelete();
    };
    remove.addEventListener("pointerdown", deleteReference);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!removed) deleteReference(event);
    });
    chip.append(remove);
  }
  if (input.type === "image" && input.url) {
    chip.className += " cursor-pointer";
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target instanceof Element && event.target.closest("button")) return;
      onPreview(input);
    });
  }
  return chip;
}

function removeReferenceChip(chip: HTMLElement, editor: HTMLElement, onChange: (value: string, commit?: boolean) => void) {
  const next = chip.nextSibling;
  if (next?.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(" ")) next.textContent = next.textContent.slice(1);
  chip.remove();
  onChange(serializeEditor(editor), true);
  placeContentEditableCaretAtEnd(editor);
}

function composerCaretRect(editor: HTMLElement) {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    const anchorNode = range.startContainer;
    if (editor === anchorNode || editor.contains(anchorNode)) {
      const collapsed = range.cloneRange();
      collapsed.collapse(true);
      const rect = Array.from(collapsed.getClientRects()).at(-1) || collapsed.getBoundingClientRect();
      if (rect && (rect.width || rect.height || rect.top || rect.left)) {
        return {
          bottom: rect.bottom || rect.top + 28,
          left: rect.left,
          top: rect.top,
        };
      }
    }
  }
  const rect = editor.getBoundingClientRect();
  return { bottom: rect.top + 40, left: rect.left + 12, top: rect.top + 12 };
}

function clamp(value: number, minimum: number, maximum: number) {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function serializeEditor(editor: HTMLElement) {
  return serializeContentEditable(editor, (element) => {
    if (element.tagName === "BR") return undefined;
    const nodeID = element.dataset.referenceNodeId;
    return nodeID ? `@[node:${nodeID}]` : undefined;
  });
}

function parseComposerTokens(value: string) {
  const tokens: ComposerToken[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(CANVAS_CONFIG_REFERENCE_PATTERN)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
    tokens.push({ type: "reference", nodeID: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
  return tokens;
}
