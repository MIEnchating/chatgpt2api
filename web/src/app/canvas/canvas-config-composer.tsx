import { CanvasMentionMenu } from "./canvas-mention-menu";
import { ItemMedia } from "@/components/ui/item";
import { FileText, Image as ImageIcon, Music2, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CanvasAgentAttachmentChip } from "./canvas-agent-attachments";
import { useContentEditableReferenceTargets } from "./use-contenteditable-reference-targets";

import {
  appendContentEditableInline,
  contentEditableTextBeforeCaret,
  copyContentEditableSelection,
  deleteAdjacentContentEditableReference,
  getContentEditableMentionKeyAction,
  insertPlainTextAtContentEditableSelection,
  moveContentEditableMentionIndex,
  placeContentEditableCaretAtEnd,
  removeActiveContentEditableMention,
  serializeContentEditable,
} from "@/app/canvas/canvas-contenteditable";
import { CANVAS_CONFIG_REFERENCE_PATTERN, canvasConfigPromptDisplay, canvasConfigInputLabel, type CanvasConfigInput } from "@/app/canvas/canvas-config-inputs";
import { ImageLightbox } from "@/components/image-lightbox";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import type { CanvasNode } from "@/services/api/canvas";


type ComposerToken =
  | { type: "text"; value: string }
  | { type: "reference"; nodeID: string };

export function CanvasConfigComposer({ node, inputs, referenceCandidates, onReferenceSelect, children, promptTools, onComposerChange }: {
  node: CanvasNode;
  inputs: CanvasConfigInput[];
  referenceCandidates: CanvasConfigInput[];
  onReferenceSelect: (nodeID: string) => void;
  children?: ReactNode;
  promptTools?: ReactNode;
  onComposerChange: (value: string, commit?: boolean) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const mentionFrameRef = useRef<number | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const inputsRef = useRef(inputs);
  const composerChangeRef = useRef(onComposerChange);
  inputsRef.current = inputs;
  composerChangeRef.current = onComposerChange;
  const value = node.composer_content ?? node.prompt ?? "";
  const inputsSignature = JSON.stringify(inputs);
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewInput, setPreviewInput] = useState<CanvasConfigInput | null>(null);
  const referenceTargets = useContentEditableReferenceTargets(editorRef, "[data-reference-node-id]");
  useEffect(() => () => {
    if (mentionFrameRef.current !== null) cancelAnimationFrame(mentionFrameRef.current);
  }, []);
  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    return referenceCandidates.filter((input) => !query || `${canvasConfigInputLabel(input, inputs)} ${input.title} ${input.text || ""}`.toLowerCase().includes(query));
  }, [inputs, referenceCandidates, mention]);

  useEffect(() => {
    if (document.activeElement === editorRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const currentInputs = inputsRef.current;
    const inputByID = new Map(currentInputs.map((input) => [input.nodeID, input]));
    const tokens = parseComposerTokens(value);
    editor.textContent = "";
    tokens.forEach((token) => {
      if (token.type === "text") {
        editor.append(document.createTextNode(token.value));
        return;
      }
      const input = inputByID.get(token.nodeID);
      if (input) {
        editor.append(createReferenceChip(input));
      }
    });
  }, [inputsSignature, value]);

  function closeMention() {
    if (mentionFrameRef.current !== null) cancelAnimationFrame(mentionFrameRef.current);
    mentionFrameRef.current = null;
    setMention(null);
    setActiveIndex(0);
  }

  function syncMention() {
    const match = /@([^\s@]*)$/.exec(contentEditableTextBeforeCaret());
    if (!match || !referenceCandidates.length) return closeMention();
    setMention({ query: match[1] || "" });
    setActiveIndex(0);
  }

  function scheduleMention() {
    if (mentionFrameRef.current !== null) cancelAnimationFrame(mentionFrameRef.current);
    mentionFrameRef.current = requestAnimationFrame(() => {
      mentionFrameRef.current = null;
      syncMention();
    });
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
    removeActiveContentEditableMention();
    const chip = createReferenceChip(input);
    const trailingSpace = document.createTextNode(" ");
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && editor.contains(range.commonAncestorContainer)) {
      const fragment = document.createDocumentFragment();
      fragment.append(chip, trailingSpace);
      range.insertNode(fragment);
      range.setStartAfter(trailingSpace);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      appendContentEditableInline(editor, chip, trailingSpace);
      placeContentEditableCaretAtEnd(editor);
    }
    closeMention();
    onComposerChange(serializeEditor(editor));
    onReferenceSelect(input.nodeID);
  }

  const previewImages = previewInput?.url ? [{ id: previewInput.nodeID, src: previewInput.url, fileName: previewInput.title }] : [];
  const composerEditor = editorRef.current;

  return (
    <div
      data-canvas-no-zoom
      className="flex h-full min-h-0 min-w-0 flex-col gap-2"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="canvas-prompt-editor-resize relative min-h-0 flex-1">
          {!isComposing && !value.trim() ? <div className="pointer-events-none absolute top-2 left-3 text-sm leading-7 text-muted-foreground">输入提示词，按 @ 引用画布图片或文本</div> : null}
          <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden h-full" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain h-full"><div className="min-w-0 w-full" style={{ minHeight: "100%" }}>
          <div
            ref={editorRef}
            contentEditable
            data-slot="input-group-control"
            role="textbox"
            aria-label="组装提示词"
            aria-multiline="true"
            suppressContentEditableWarning
            className="min-h-full w-full whitespace-pre-wrap break-words px-3 py-2 text-sm leading-7 outline-none"
            onInput={() => { if (!composingRef.current) syncFromEditor(); }}
            onCopy={(event) => {
              if (copyContentEditableSelection(event.currentTarget, event.clipboardData, (selection) => canvasConfigPromptDisplay(serializeEditor(selection), inputs))) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain");
              if (!text) return;
              event.preventDefault();
              if (insertPlainTextAtContentEditableSelection(text)) syncFromEditor();
            }}
            onCompositionStart={() => { composingRef.current = true; setIsComposing(true); closeMention(); }}
            onCompositionEnd={() => { composingRef.current = false; setIsComposing(false); syncFromEditor(); }}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              event.stopPropagation();
              if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
              scheduleMention();
            }}
            onBlur={() => {
              syncFromEditor(true);
              closeMention();
            }}
          />
          </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
          {mention && candidates.length && composerEditor ? (
            <CanvasMentionMenu
              editor={composerEditor}
              getAnchorRect={() => composerCaretRect(composerEditor)}
              items={candidates}
              getKey={(input) => input.nodeID}
              activeIndex={Math.min(activeIndex, candidates.length - 1)}
              onActiveIndexChange={setActiveIndex}
              onSelect={insertReference}
              onClose={closeMention}
              renderItem={(input) => <>
                <ResourcePreview input={input} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{canvasConfigInputLabel(input, inputs.some((item) => item.nodeID === input.nodeID) ? inputs : [...inputs, input])} · {input.title}</span>
                  {input.text ? <span className="block truncate text-muted-foreground">{input.text}</span> : null}
                </span>
              </>}
            />
          ) : null}
      </div>
      {referenceTargets.map((target, index) => {
        const input = inputs.find(item => item.nodeID === target.dataset.referenceNodeId);
        return input ? createPortal(<CanvasAgentAttachmentChip
          attachment={{ id: input.nodeID, type: input.type, title: canvasConfigInputLabel(input, inputs), url: input.url }}
          onPreview={() => setPreviewInput(input)}
          onRemove={() => {
            const editor = editorRef.current;
            if (editor && editor.contains(target)) removeReferenceChip(target, editor, composerChangeRef.current);
          }}
        />, target, `${input.nodeID}:${index}`) : null;
      })}
      {promptTools ? <div className="min-w-0 shrink-0">{promptTools}</div> : null}
      {children ? <div className="mt-3 space-y-3 border-t border-border pt-3">{children}</div> : null}
      <ImageLightbox images={previewImages} currentIndex={0} open={Boolean(previewInput?.url)} onOpenChange={(open) => { if (!open) setPreviewInput(null); }} onIndexChange={() => undefined} />
    </div>
  );
}

function ResourcePreview({ input }: { input: CanvasConfigInput }) {
  if (input.type === "image" && input.url) return <img src={input.url} alt="" className="size-9 shrink-0 rounded-md object-cover" />;
  if (input.type === "video" && input.url) return <video src={input.url} className="size-9 shrink-0 rounded-md bg-black object-cover" muted preload="metadata" />;
  const Icon = input.type === "audio" ? Music2 : input.type === "video" ? Video : input.type === "image" ? ImageIcon : FileText;
  return <ItemMedia variant="icon" className="grid size-9 shrink-0 place-items-center"><Icon className="size-4" /></ItemMedia>;
}

function createReferenceChip(input: CanvasConfigInput) {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.referenceNodeId = input.nodeID;
  if (input.type === "text" && input.text) chip.dataset.tooltip = input.text;
  chip.className = "mx-px inline-flex max-w-40 items-center align-middle";
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
        return DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height || 28 });
      }
    }
  }
  const rect = editor.getBoundingClientRect();
  return new DOMRect(rect.left + 12, rect.top + 12, 0, 28);
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
