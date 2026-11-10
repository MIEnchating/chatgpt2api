import { CanvasMentionMenu } from "./canvas-mention-menu";
import { ItemMedia } from "@/components/ui/item";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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
import { useContentEditableReferenceTargets } from "./use-contenteditable-reference-targets";
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
};

type MentionState = {
  query: string;
};

type PromptToken =
  | { type: "text"; value: string }
  | { type: "reference"; label: string; value: string };

export function CanvasAgentPromptChipInput({ value, references, onChange, onReferenceIDsChange, onSubmit, onPasteImage, pendingReferences, attachments = EMPTY_ATTACHMENTS, onRemoveAttachments, readOnly, className, style, placeholder }: CanvasAgentPromptChipInputProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const referenceTargets = useContentEditableReferenceTargets(editorRef, "[data-ref-node-id]");
  const composingRef = useRef(false);
  const mentionFrameRef = useRef<number | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const initializedRef = useRef(false);
  const caretRef = useRef<Range | null>(null);
  const [attachmentTargets, setAttachmentTargets] = useState<Map<string, HTMLElement>>(new Map());
  const lastEmittedRef = useRef(value);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  useEffect(() => () => {
    if (mentionFrameRef.current !== null) cancelAnimationFrame(mentionFrameRef.current);
  }, []);
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
    editor.append(createPromptFragment(tokens, referenceByLabel));
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
    const committed = new Set(Array.from(editor.querySelectorAll<HTMLElement>("[data-ref-node-id]")).map(chip => chip.dataset.refNodeId));
    pendingReferences?.filter(reference => activeNodeIDs.has(reference.nodeID) && !committed.has(reference.nodeID)).forEach((reference) => appendReferenceChip(editor, reference, true));
  }, [pendingReferences, activeNodeIDs]);

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
      chip.className = "mx-0.5 my-0.5 inline-flex max-w-[calc(100%-0.5rem)] select-none items-center align-middle";
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
    if (mentionFrameRef.current !== null) cancelAnimationFrame(mentionFrameRef.current);
    mentionFrameRef.current = null;
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
    const chip = createReferenceChip(reference, `@${reference.label}`);
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

  const showPlaceholder = !isComposing && !value.trim() && !pendingReferences?.length && !attachments.length;

  return (
    <div className="relative w-full">
      {showPlaceholder && placeholder ? <div className="pointer-events-none absolute left-2.5 top-2 text-base text-muted-foreground md:text-sm">{placeholder}</div> : null}
      <div
        data-slot="input-group-control" ref={editorRef}
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
          if (insertPromptText(editorRef.current, text, activeLabels, referenceByLabel)) syncFromEditor();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
          setIsComposing(true);
          closeMention();
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          setIsComposing(false);
          syncFromEditor();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          event.stopPropagation();
          const nativeEvent = event.nativeEvent;
          const isComposing = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
          if (isComposing) return;
          const committed = commitPendingReferences();
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
          scheduleMention();
        }}
        onPointerUp={scheduleMention}
        onBlur={closeMention}
      />
      {referenceTargets.map((target, index) => {
        const reference = activeReferences.find(item => item.nodeID === target.dataset.refNodeId);
        return reference ? createPortal(<CanvasAgentAttachmentChip
          attachment={{ id: reference.id, type: reference.kind, title: reference.kind === "text" ? reference.text || reference.title : reference.label, url: reference.previewURL }}
          onPreview={setImagePreview}
        />, target, `${reference.id}:${index}`) : null;
      })}
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
      {mention && candidates.length && editorRef.current ? <CanvasMentionMenu
        editor={editorRef.current}
        getAnchorRect={() => getCaretRect() || editorRef.current!.getBoundingClientRect()}
        items={candidates}
        getKey={(reference) => reference.id}
        activeIndex={Math.min(activeIndex, candidates.length - 1)}
        onActiveIndexChange={setActiveIndex}
        onSelect={insertReference}
        onClose={closeMention}
        renderItem={(reference) => <>
          <ReferencePreview reference={reference} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{reference.label} · {reference.title}</span>
            {reference.text ? <span className="block truncate text-muted-foreground">{reference.text}</span> : null}
          </span>
        </>}
      /> : null}
      {imagePreview ? <ImageLightbox images={[{ id: "agent-reference", src: imagePreview }]} currentIndex={0} open onOpenChange={(open) => { if (!open) setImagePreview(null); }} onIndexChange={() => undefined} /> : null}
    </div>
  );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
  if (reference.kind === "image" && reference.previewURL) return <AuthenticatedImage src={reference.previewURL} alt="" className="size-9 shrink-0 rounded-md object-cover" />;
  if (reference.kind === "video" && reference.previewURL) return <video src={reference.previewURL} className="size-9 shrink-0 rounded-md bg-black object-cover" muted preload="metadata" />;
  const Icon = reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
  return <ItemMedia variant="icon" className="grid size-9 shrink-0 place-items-center"><Icon className="size-4" /></ItemMedia>;
}

function createReferenceChip(reference: CanvasResourceReference, serializedLabel = reference.label) {
  const wrapper = document.createElement("span");
  wrapper.contentEditable = "false";
  wrapper.dataset.refLabel = serializedLabel;
  wrapper.dataset.refNodeId = reference.nodeID;
  wrapper.dataset.tooltip = reference.text || reference.title;
  wrapper.className = "mx-px inline-flex max-w-40 items-center align-middle";
  return wrapper;
}

function appendReferenceChip(editor: HTMLElement, reference: CanvasResourceReference, pending = false) {
  const chip = createReferenceChip(reference);
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

function createPromptFragment(tokens: PromptToken[], references: Map<string, CanvasResourceReference>) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    const reference = token.type === "reference" ? references.get(token.label) : undefined;
    fragment.append(reference ? createReferenceChip(reference, token.value) : document.createTextNode(token.value));
  }
  return fragment;
}

function insertPromptText(editor: HTMLElement | null, text: string, labels: string[], references: Map<string, CanvasResourceReference>) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!editor || !range || !editor.contains(range.commonAncestorContainer)) return false;
  const fragment = createPromptFragment(parsePromptTokens(text, labels), references);
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
