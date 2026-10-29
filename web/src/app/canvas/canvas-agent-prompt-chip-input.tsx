import { ScrollArea } from "@/components/ui/scroll-area";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon, Music2, Video } from "lucide-react";

import {
  appendContentEditableInline,
  contentEditableTextBeforeCaret,
  copyContentEditableSelection,
  deleteAdjacentContentEditableReference,
  getContentEditableMentionKeyAction,
  moveContentEditableMentionIndex,
  placeContentEditableCaretAtEnd,
  removeActiveContentEditableMention,
  serializeContentEditable,
} from "@/app/canvas/canvas-contenteditable";
import type { CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { ImageLightbox } from "@/components/image-lightbox";

import { CanvasAgentAttachmentChip } from "./canvas-agent-attachments";
import type { CanvasAssistantReference } from "./agent/canvas-agent-types";

const EMPTY_ATTACHMENTS: CanvasAssistantReference[] = [];

type CanvasAgentPromptChipInputProps = {
  attachments?: CanvasAssistantReference[];
  onRemoveAttachments?: (ids: string[]) => void;
  value: string;
  references: CanvasResourceReference[];
  onChange: (value: string) => void;
  onReferenceIDsChange?: (nodeIDs: string[]) => void;
  onSubmit?: (value?: string, referenceIDs?: string[]) => void;
  onPasteImage?: (file: File) => void;
  pendingReferences?: CanvasResourceReference[];
  readOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  placeholderClassName?: string;
};

type MentionState = {
  query: string;
  rect: DOMRect | null;
};

type PromptToken =
  | { type: "text"; value: string }
  | { type: "reference"; label: string; value: string };

export function CanvasAgentPromptChipInput({ value, references, onChange, onReferenceIDsChange, onSubmit, onPasteImage, pendingReferences, attachments = EMPTY_ATTACHMENTS, onRemoveAttachments, readOnly, className, style, placeholder, placeholderClassName }: CanvasAgentPromptChipInputProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const initializedRef = useRef(false);
  const caretRef = useRef<Range | null>(null);
  const [attachmentTargets, setAttachmentTargets] = useState<Map<string, HTMLElement>>(new Map());
  const lastEmittedRef = useRef(value);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const activeReferences = useMemo(() => references.filter((reference) => reference.active), [references]);
  const activeNodeIDs = useMemo(() => new Set(activeReferences.map((reference) => reference.nodeID)), [activeReferences]);
  const referenceByLabel = useMemo(() => new Map(activeReferences.map((reference) => [reference.label, reference])), [activeReferences]);
  const activeLabels = useMemo(() => Array.from(new Set(activeReferences.map((reference) => reference.label))).sort((left, right) => right.length - left.length), [activeReferences]);
  const tokens = useMemo(() => parsePromptTokens(value, activeLabels), [activeLabels, value]);
  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    if (!query) return activeReferences;
    return activeReferences.filter((reference) => `${reference.label} ${reference.title} ${reference.kind} ${reference.text || ""}`.toLowerCase().includes(query));
  }, [activeReferences, mention]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (initializedRef.current && value === lastEmittedRef.current) return;
    initializedRef.current = true;
    caretRef.current = null;
    editor.textContent = "";
    editor.append(createPromptFragment(tokens, referenceByLabel, setImagePreview));
    lastEmittedRef.current = value;
  }, [referenceByLabel, tokens, value]);

  const removeUnavailableReferences = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || readOnly) return;
    let removedCommittedReference = false;
    editor.querySelectorAll<HTMLElement>("[data-ref-node-id]").forEach((chip) => {
      if (activeNodeIDs.has(chip.dataset.refNodeId!)) return;
      if (chip.dataset.pendingReference !== "true") removedCommittedReference = true;
      removeReferenceChip(chip);
    });
    if (!removedCommittedReference) return;
    // Update the draft without rebuilding the DOM or committing pending selections.
    const committed = editor.cloneNode(true) as HTMLElement;
    committed.querySelectorAll<HTMLElement>("[data-pending-reference='true']").forEach(removeReferenceChip);
    const nextValue = serializePromptEditor(committed);
    lastEmittedRef.current = nextValue;
    onChange(nextValue);
    onReferenceIDsChange?.(referenceIDsFromEditor(committed));
  }, [activeNodeIDs, onChange, onReferenceIDsChange, readOnly]);

  useLayoutEffect(removeUnavailableReferences, [removeUnavailableReferences]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.querySelectorAll<HTMLElement>("[data-pending-reference='true']").forEach(removeReferenceChip);
    pendingReferences?.forEach((reference) => appendReferenceChip(editor, reference, setImagePreview, true));
  }, [pendingReferences]);

  useEffect(() => {
    if (readOnly) return;
    const rememberCaret = () => {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      if (element?.closest("[contenteditable='false']")) return;
      caretRef.current = range.cloneRange();
    };
    document.addEventListener("selectionchange", rememberCaret);
    return () => document.removeEventListener("selectionchange", rememberCaret);
  }, [readOnly]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextTargets = new Map<string, HTMLElement>();
    const byID = new Map(attachments.map((item) => [item.id, item]));
    editor.querySelectorAll<HTMLElement>("[data-attachment-id]").forEach((chip) => {
      const id = chip.dataset.attachmentId!;
      if (!byID.has(id) || nextTargets.has(id)) removeReferenceChip(chip);
      else nextTargets.set(id, chip);
    });
    for (const attachment of attachments) {
      if (nextTargets.has(attachment.id)) continue;
      const chip = document.createElement("span");
      chip.contentEditable = "false";
      chip.dataset.attachmentId = attachment.id;
      chip.className = "mx-0.5 my-0.5 inline-flex h-7 max-w-[calc(50%-0.75rem)] select-none items-center gap-1 rounded-lg border border-border/60 bg-muted/20 px-1 text-xs leading-none whitespace-nowrap align-middle";
      const trailingSpace = document.createTextNode(" ");
      const range = caretRef.current;
      if (range && editor.contains(range.commonAncestorContainer)) {
        // Keep the insertion point through async uploads without deleting selected text.
        range.collapse(false);
        const fragment = document.createDocumentFragment();
        fragment.append(chip, trailingSpace);
        range.insertNode(fragment);
      } else {
        appendContentEditableInline(editor, chip, trailingSpace);
      }
      const nextCaret = document.createRange();
      nextCaret.setStart(trailingSpace, trailingSpace.length);
      nextCaret.collapse(true);
      caretRef.current = nextCaret;
      if (document.activeElement === editor) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(nextCaret.cloneRange());
      }
      nextTargets.set(attachment.id, chip);
    }
    setAttachmentTargets((current) => current.size === nextTargets.size && [...nextTargets].every(([id, target]) => current.get(id) === target) ? current : nextTargets);
  }, [attachments, referenceByLabel, tokens, value]);

  function emitChange(nextValue: string) {
    lastEmittedRef.current = nextValue;
    onChange(nextValue);
    if (editorRef.current) {
      onReferenceIDsChange?.(referenceIDsFromEditor(editorRef.current));
      const remaining = new Set(Array.from(editorRef.current.querySelectorAll<HTMLElement>("[data-attachment-id]")).map((chip) => chip.dataset.attachmentId));
      const removed = attachments.filter((item) => !remaining.has(item.id)).map((item) => item.id);
      if (removed.length) onRemoveAttachments?.(removed);
    }
  }

  function commitPendingReferences() {
    removeUnavailableReferences();
    const editor = editorRef.current;
    const pendingChips = editor?.querySelectorAll<HTMLElement>("[data-pending-reference='true']");
    pendingChips?.forEach((chip) => delete chip.dataset.pendingReference);
    const nextValue = editor ? serializePromptEditor(editor) : value;
    const referenceIDs = editor ? referenceIDsFromEditor(editor) : [];
    if (pendingChips?.length) emitChange(nextValue);
    return { value: nextValue, referenceIDs };
  }

  function closeMention() {
    setMention(null);
    setActiveIndex(0);
  }

  function syncMention() {
    const text = contentEditableTextBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match || !activeReferences.length) {
      closeMention();
      return;
    }
    setMention({ query: match[1] || "", rect: getCaretRect() });
    setActiveIndex(0);
  }

  function syncFromEditor() {
    const editor = editorRef.current;
    if (!editor) return;
    if (isEmptyEditorPlaceholder(editor)) editor.replaceChildren();
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) caretRef.current = selection.getRangeAt(0).cloneRange();
    emitChange(serializePromptEditor(editor));
    syncMention();
  }

  function insertReference(reference: CanvasResourceReference) {
    const editor = editorRef.current;
    if (!editor) return;
    removeActiveContentEditableMention();
    const leadingSpace = document.createTextNode(" ");
    const chip = createReferenceChip(reference, setImagePreview, `@${reference.label}`);
    const trailingSpace = document.createTextNode(" ");
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range) {
      range.insertNode(trailingSpace);
      range.insertNode(chip);
      range.insertNode(leadingSpace);
      range.setStartAfter(trailingSpace);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      editor.append(leadingSpace, chip, trailingSpace);
      placeContentEditableCaretAtEnd(editor);
    }
    closeMention();
    emitChange(serializePromptEditor(editor));
  }

  const showPlaceholder = !value.trim() && !pendingReferences?.length && !attachments.length;

  return (
    <div className="relative w-full">
      {showPlaceholder && placeholder ? <div className={`pointer-events-none absolute left-3 top-2 text-sm leading-5 text-muted-foreground ${placeholderClassName || ""}`}>{placeholder}</div> : null}
      <div
        ref={editorRef}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-readonly={readOnly}
        aria-label={placeholder}
        className={`${className || ""} whitespace-pre-wrap break-words outline-none [&_[data-pending-reference=true]]:opacity-50`}
        style={{ ...style, cursor: "text" }}
        onFocus={commitPendingReferences}
        onPointerDown={commitPendingReferences}
        onInput={(event) => {
          if (composingRef.current) return;
          const selection = window.getSelection();
          const tail = event.currentTarget.lastChild;
          if (selection?.isCollapsed && selection.anchorNode === tail && selection.anchorOffset === 0 && tail instanceof Text && tail.data === "\n") tail.data = "\uFEFF";
          syncFromEditor();
        }}
        onCopy={(event) => {
          if (copyContentEditableSelection(event.currentTarget, event.clipboardData, serializePromptEditor)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onPaste={(event) => {
          const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
          if (image && onPasteImage) {
            event.preventDefault();
            event.stopPropagation();
            onPasteImage(image);
            return;
          }
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          if (insertPromptText(editorRef.current, text, activeLabels, referenceByLabel, setImagePreview)) syncFromEditor();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          syncFromEditor();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          event.stopPropagation();
          const committed = commitPendingReferences();
          const nativeEvent = event.nativeEvent;
          const isComposing = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
          if (isComposing) return;
          const mentionAction = mention ? getContentEditableMentionKeyAction(event.key, candidates.length) : null;
          if (mentionAction) {
            event.preventDefault();
            if (mentionAction.type === "move") setActiveIndex((index) => moveContentEditableMentionIndex(index, candidates.length, mentionAction.offset));
            else if (mentionAction.type === "select") insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
            else closeMention();
            return;
          }
          if ((event.key === "Backspace" || event.key === "Delete") && (deleteAdjacentContentEditableReference(event.key, "attachmentId", { trimAdjacentWhitespace: true }) || deleteAdjacentContentEditableReference(event.key, "refLabel", { trimAdjacentWhitespace: true }))) {
            event.preventDefault();
            syncFromEditor();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && onSubmit) {
            event.preventDefault();
            onSubmit(committed.value, committed.referenceIDs);
            return;
          }
          requestAnimationFrame(syncMention);
        }}
        onPointerUp={() => requestAnimationFrame(syncMention)}
        onBlur={() => window.setTimeout(closeMention, 120)}
      />
      {attachments.map((attachment) => {
        const target = attachmentTargets.get(attachment.id);
        return target ? createPortal(<CanvasAgentAttachmentChip attachment={attachment} onPreview={setImagePreview} onRemove={readOnly ? undefined : () => {
          const editor = editorRef.current;
          if (!editor) return;
          const caret = document.createRange();
          caret.setStartBefore(target);
          caret.collapse(true);
          target.remove();
          caretRef.current = caret;
          editor.focus({ preventScroll: true });
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(caret.cloneRange());
          syncFromEditor();
        }} />, target, attachment.id) : null;
      })}
      {mention && candidates.length ? <MentionMenu rect={mention.rect} references={candidates} activeIndex={Math.min(activeIndex, candidates.length - 1)} onSelect={insertReference} /> : null}
      {imagePreview ? <ImageLightbox images={[{ id: "agent-reference", src: imagePreview }]} currentIndex={0} open onOpenChange={(open) => { if (!open) setImagePreview(null); }} onIndexChange={() => undefined} /> : null}
    </div>
  );
}

function MentionMenu({ rect, references, activeIndex, onSelect }: { rect: DOMRect | null; references: CanvasResourceReference[]; activeIndex: number; onSelect: (reference: CanvasResourceReference) => void }) {
  const selectedRef = useRef(false);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, references]);

  const selectReference = (reference: CanvasResourceReference) => {
    if (selectedRef.current) return;
    selectedRef.current = true;
    onSelect(reference);
  };
  const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();
  const menuWidth = 256;
  const maxMenuHeight = 224;
  const menuHeight = Math.min(maxMenuHeight, references.length * 48 + 8);
  const gap = 6;
  const anchor = rect || new DOMRect(16, 16, 0, 0);
  const left = clamp(anchor.left, 8, window.innerWidth - menuWidth - 8);
  const showAbove = anchor.bottom + gap + menuHeight > window.innerHeight && anchor.top - gap - menuHeight >= 8;
  const top = clamp(showAbove ? anchor.top - gap - menuHeight : anchor.bottom + gap, 8, window.innerHeight - menuHeight - 8);

  return createPortal(
    <ScrollArea data-canvas-resource-mention-menu="true" className="fixed z-[120] max-h-56 w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl" viewClass="" viewportClassName="overscroll-contain" manageKeyboard={false} style={{ left, top }} onPointerDown={stopCanvasInteraction} onMouseDown={stopCanvasInteraction} onClick={(event) => event.stopPropagation()}>
      {references.map((reference, index) => (
        <button
          key={reference.id}
          ref={index === activeIndex ? activeItemRef : undefined}
          type="button"
          className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${index === activeIndex ? "bg-accent text-accent-foreground" : ""}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            selectReference(reference);
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            selectReference(reference);
          }}
        >
          <ReferencePreview reference={reference} />
          <span className="min-w-0 flex-1"><span className="block font-medium">{reference.label}</span><span className="block truncate opacity-65">{reference.text || reference.title}</span></span>
        </button>
      ))}
    </ScrollArea>,
    document.body,
  );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
  if (reference.kind === "image" && reference.previewURL) return <AuthenticatedImage src={reference.previewURL} alt="" className="size-9 shrink-0 rounded-md object-cover" />;
  if (reference.kind === "video" && reference.previewURL) return <video src={reference.previewURL} className="size-9 shrink-0 rounded-md bg-black object-cover" muted preload="metadata" />;
  const Icon = reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
  return <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted"><Icon className="size-4" /></span>;
}

function createReferenceChip(reference: CanvasResourceReference, onImagePreview: (url: string) => void, serializedLabel = reference.label) {
  const wrapper = document.createElement("span");
  wrapper.contentEditable = "false";
  wrapper.dataset.refLabel = serializedLabel;
  wrapper.dataset.refNodeId = reference.nodeID;
  if (reference.kind === "image" && reference.previewURL) {
    const image = document.createElement("img");
    image.src = reference.previewURL;
    image.alt = reference.title;
    image.className = "size-6 rounded object-cover";
    wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
    wrapper.appendChild(image);
    wrapper.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onImagePreview(reference.previewURL || "");
    });
    return wrapper;
  }
  wrapper.className = "mx-px inline-flex h-6 max-w-40 items-center justify-center overflow-hidden rounded-md border border-border bg-card px-1 text-xs leading-none align-middle text-foreground";
  wrapper.dataset.tooltip = reference.text || reference.title;
  const text = document.createElement("span");
  text.className = "block truncate";
  text.textContent = reference.kind === "text" ? reference.text || reference.title : reference.label;
  wrapper.appendChild(text);
  return wrapper;
}

function appendReferenceChip(editor: HTMLElement, reference: CanvasResourceReference, onImagePreview: (url: string) => void, pending = false) {
  const chip = createReferenceChip(reference, onImagePreview);
  if (pending) chip.dataset.pendingReference = "true";
  appendContentEditableInline(editor, document.createTextNode(" "), chip, document.createTextNode(" "));
  editor.scrollTop = editor.scrollHeight;
}

function removeReferenceChip(chip: HTMLElement) {
  const parent = chip.parentElement;
  const previousSibling = chip.previousSibling;
  const nextSibling = chip.nextSibling;
  if (previousSibling?.nodeType === Node.TEXT_NODE) previousSibling.textContent = (previousSibling.textContent || "").replace(/[ \u00A0]$/, "");
  if (nextSibling?.nodeType === Node.TEXT_NODE) nextSibling.textContent = (nextSibling.textContent || "").replace(/^[ \u00A0]/, "");
  chip.remove();
  parent?.normalize();
}

function referenceIDsFromEditor(editor: HTMLElement) {
  return Array.from(new Set(Array.from(editor.querySelectorAll<HTMLElement>("[data-ref-node-id]")).map((chip) => chip.dataset.refNodeId).filter((id): id is string => Boolean(id))));
}

function serializePromptEditor(editor: HTMLElement) {
  const text = editor.cloneNode(true) as HTMLElement;
  text.querySelectorAll("[data-attachment-id]").forEach((chip) => chip.remove());
  return serializeContentEditable(text, (element) => element.dataset.refLabel);
}

function isEmptyEditorPlaceholder(editor: HTMLElement) {
  if (editor.childNodes.length !== 1) return false;
  const child = editor.firstChild;
  if (!(child instanceof HTMLElement)) return false;
  if (child.tagName === "BR") return true;
  return (child.tagName === "DIV" || child.tagName === "P") && child.childNodes.length <= 1 && (!child.firstChild || child.firstChild instanceof HTMLBRElement);
}

function getCaretRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height || rect.left || rect.top) return rect;
  const editor = closestPromptEditor(range.startContainer);
  return editor?.getBoundingClientRect() || null;
}

function closestPromptEditor(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[contenteditable='true']") || null;
}

function createPromptFragment(tokens: PromptToken[], references: Map<string, CanvasResourceReference>, onImagePreview: (url: string) => void) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    const reference = token.type === "reference" ? references.get(token.label) : undefined;
    fragment.append(reference ? createReferenceChip(reference, onImagePreview, token.value) : document.createTextNode(token.value));
  }
  return fragment;
}

function insertPromptText(editor: HTMLElement | null, text: string, labels: string[], references: Map<string, CanvasResourceReference>, onImagePreview: (url: string) => void) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!editor || !range || !editor.contains(range.commonAncestorContainer)) return false;
  const fragment = createPromptFragment(parsePromptTokens(text, labels), references, onImagePreview);
  const lastNode = fragment.lastChild;
  if (!lastNode) return false;
  range.deleteContents();
  range.insertNode(fragment);
  range.setStartAfter(lastNode);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function parsePromptTokens(value: string, labels: string[]): PromptToken[] {
  if (!labels.length) return value ? [{ type: "text", value }] : [];
  const pattern = new RegExp(`@?(${[...labels].sort((left, right) => right.length - left.length).map(escapeRegExp).join("|")})(?![a-zA-Z0-9_])`, "g");
  const tokens: PromptToken[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
    tokens.push({ type: "reference", label: match[1], value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
  return tokens;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, minimum: number, maximum: number) {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}
