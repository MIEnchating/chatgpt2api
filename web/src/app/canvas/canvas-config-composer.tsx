import { FileText, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { CANVAS_CONFIG_REFERENCE_PATTERN, canvasConfigInputLabel, type CanvasConfigInput } from "@/app/canvas/canvas-config-inputs";
import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import type { CanvasNode } from "@/lib/api";
import { cn } from "@/lib/utils";

type ComposerToken =
  | { type: "text"; value: string }
  | { type: "reference"; nodeID: string };

export function CanvasConfigComposer({ node, inputs, onComposerChange, onClose }: {
  node: CanvasNode;
  inputs: CanvasConfigInput[];
  onComposerChange: (value: string, commit?: boolean) => void;
  onClose: () => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const value = node.composer_content ?? node.prompt ?? "";
  const tokens = useMemo(() => parseComposerTokens(value), [value]);
  const inputByID = useMemo(() => new Map(inputs.map((input) => [input.nodeID, input])), [inputs]);
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
    editor.textContent = "";
    tokens.forEach((token) => {
      if (token.type === "text") {
        editor.append(document.createTextNode(token.value));
        return;
      }
      const input = inputByID.get(token.nodeID);
      if (input) editor.append(createReferenceChip(input, inputs, setPreviewInput));
    });
  }, [inputByID, inputs, tokens]);

  function closeMention() {
    setMention(null);
    setActiveIndex(0);
  }

  function syncMention() {
    const match = /@([^\s@]*)$/.exec(textBeforeCaret());
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
    removeActiveMention();
    const chip = createReferenceChip(input, inputs, setPreviewInput);
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && editor.contains(range.startContainer)) {
      range.insertNode(space);
      range.insertNode(chip);
      range.setStartAfter(space);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      editor.append(chip, space);
      placeCaretAtEnd(editor);
    }
    closeMention();
    onComposerChange(serializeEditor(editor));
  }

  const previewImages = previewInput?.url ? [{ id: previewInput.nodeID, src: previewInput.url, fileName: previewInput.title }] : [];

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
      <div className="relative rounded-xl border border-border bg-background">
        {!value.trim() ? <div className="pointer-events-none absolute top-2 left-3 text-sm leading-7 text-muted-foreground">输入提示词，按 @ 引用连接的图片或文本</div> : null}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className="hide-scrollbar min-h-28 w-full overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm leading-7 outline-none"
          onInput={() => { if (!composingRef.current) syncFromEditor(); }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; syncFromEditor(); }}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            event.stopPropagation();
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
                insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeMention();
                return;
              }
            }
            if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
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
        {mention && candidates.length ? (
          <ComposerMentionMenu
            inputs={candidates}
            allInputs={inputs}
            activeIndex={Math.min(activeIndex, candidates.length - 1)}
            onSelect={insertReference}
          />
        ) : null}
      </div>
      <ImageLightbox images={previewImages} currentIndex={0} open={Boolean(previewInput?.url)} onOpenChange={(open) => { if (!open) setPreviewInput(null); }} onIndexChange={() => undefined} />
    </div>
  );
}

function ComposerMentionMenu({ inputs, allInputs, activeIndex, onSelect }: {
  inputs: CanvasConfigInput[];
  allInputs: CanvasConfigInput[];
  activeIndex: number;
  onSelect: (input: CanvasConfigInput) => void;
}) {
  const selectedRef = useRef(false);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, inputs]);

  function select(input: CanvasConfigInput) {
    if (selectedRef.current) return;
    selectedRef.current = true;
    onSelect(input);
  }

  return (
    <div className="absolute top-[calc(100%+6px)] left-2 z-[90] max-h-56 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl">
      {inputs.map((input, index) => (
        <button
          key={input.nodeID}
          ref={index === activeIndex ? activeItemRef : undefined}
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs", index === activeIndex && "bg-accent text-accent-foreground")}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            select(input);
          }}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
            {input.type === "image" ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{canvasConfigInputLabel(input, allInputs)}</span>
            <span className="block truncate text-muted-foreground">{input.text || input.title}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function createReferenceChip(input: CanvasConfigInput, inputs: CanvasConfigInput[], onPreview: (input: CanvasConfigInput) => void) {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.referenceNodeId = input.nodeID;
  chip.title = input.text || input.title;
  chip.className = "mx-px inline-flex h-7 max-w-40 items-center gap-1 overflow-hidden rounded-md border border-border bg-card px-2 text-xs leading-none align-middle text-foreground";

  const icon = document.createElement("span");
  icon.textContent = input.type === "image" ? "▧" : "T";
  icon.className = input.type === "image" ? "text-[#1456f0]" : "text-amber-600";
  const label = document.createElement("span");
  label.className = "block truncate";
  label.textContent = `${canvasConfigInputLabel(input, inputs)} · ${input.type === "text" ? input.text || input.title : input.title}`;
  chip.append(icon, label);
  if (input.type === "image" && input.url) {
    chip.className += " cursor-pointer";
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onPreview(input);
    });
  }
  return chip;
}

function serializeEditor(editor: HTMLElement) {
  return serializeNodes(editor.childNodes).replace(/\uFEFF/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
  let result = "";
  nodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
    if (!(node instanceof HTMLElement)) return;
    const nodeID = node.dataset.referenceNodeId;
    if (nodeID) result += `@[node:${nodeID}]`;
    else if (node.tagName === "BR") result += "\n";
    else result += serializeNodes(node.childNodes);
  });
  return result;
}

function removeActiveMention() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const match = /@([^\s@]*)$/.exec(textBeforeCaret());
  if (!match) return;
  range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
  range.deleteContents();
}

function deleteAdjacentReference(key: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const target = adjacentReferenceNode(range, key);
  if (!target) return false;
  const caret = document.createTextNode("");
  target.replaceWith(caret);
  range.setStart(caret, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function adjacentReferenceNode(range: Range, key: string) {
  const container = range.startContainer;
  const offset = range.startOffset;
  const previous = key === "Backspace";
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent || "";
    if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
    return findReferenceSibling(container, previous);
  }
  const children = Array.from(container.childNodes);
  return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
  let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
  while (current?.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
  return current instanceof HTMLElement && current.dataset.referenceNodeId ? current : null;
}

function textBeforeCaret() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return "";
  const range = selection.getRangeAt(0).cloneRange();
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const editor = element?.closest("[contenteditable='true']");
  if (!editor) return "";
  range.setStart(editor, 0);
  return range.toString();
}

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
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
