export type ContentEditableMentionKeyAction =
  | { type: "move"; offset: -1 | 1 }
  | { type: "select" }
  | { type: "close" };

type DeleteReferenceOptions = {
  trimAdjacentWhitespace?: boolean;
};

type ReferenceSerializer = (element: HTMLElement) => string | null | undefined;

const TEXT_NODE_TYPE = 3;

export function getContentEditableMentionKeyAction(
  key: string,
  candidateCount: number,
): ContentEditableMentionKeyAction | null {
  if (candidateCount <= 0) return null;
  if (key === "ArrowDown") return { type: "move", offset: 1 };
  if (key === "ArrowUp") return { type: "move", offset: -1 };
  if (key === "Enter") return { type: "select" };
  if (key === "Escape") return { type: "close" };
  return null;
}

export function moveContentEditableMentionIndex(activeIndex: number, candidateCount: number, offset: -1 | 1) {
  if (candidateCount <= 0) return activeIndex;
  return (activeIndex + offset + candidateCount) % candidateCount;
}

export function insertPlainTextAtContentEditableSelection(text: string) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range) return false;
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

export function deleteAdjacentContentEditableReference(
  key: string,
  referenceDataKey: string,
  options: DeleteReferenceOptions = {},
) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const target = adjacentReferenceNode(range, key, referenceDataKey);
  if (!target) return false;
  if (options.trimAdjacentWhitespace) {
    target.parentNode?.normalize();
    const previousSibling = target.previousSibling;
    const nextSibling = target.nextSibling;
    if (previousSibling?.nodeType === Node.TEXT_NODE) previousSibling.textContent = (previousSibling.textContent || "").replace(/[ \u00A0]$/, "");
    if (nextSibling?.nodeType === Node.TEXT_NODE) nextSibling.textContent = (nextSibling.textContent || "").replace(/^[ \u00A0]/, "");
  }
  const caret = document.createTextNode("");
  target.replaceWith(caret);
  range.setStart(caret, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function serializeContentEditable(editor: HTMLElement, serializeReference: ReferenceSerializer) {
  return serializeContentEditableNodes(editor.childNodes, serializeReference).replace(/\uFEFF/g, "");
}

export function removeActiveContentEditableMention() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const match = /@([^\s@]*)$/.exec(contentEditableTextBeforeCaret());
  if (!match) return;
  range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
  range.deleteContents();
}

export function contentEditableTextBeforeCaret() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return "";
  const range = selection.getRangeAt(0).cloneRange();
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const editor = element?.closest("[contenteditable='true']");
  if (!editor) return "";
  range.setStart(editor, 0);
  return range.toString();
}

export function placeContentEditableCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function serializeContentEditableNodes(nodes: NodeListOf<ChildNode>, serializeReference: ReferenceSerializer) {
  let result = "";
  nodes.forEach((node) => {
    if (node.nodeType === TEXT_NODE_TYPE) {
      result += node.textContent || "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const element = node;
    const reference = serializeReference(element);
    if (reference) {
      result += reference;
      return;
    }
    if (element.tagName === "BR") {
      result += "\n";
      return;
    }
    const content = serializeContentEditableNodes(element.childNodes, serializeReference);
    const isBlock = element.tagName === "DIV" || element.tagName === "P";
    if (isBlock && result && !result.endsWith("\n")) result += "\n";
    result += content;
    if (isBlock && !content) result += "\n";
  });
  return result;
}

function adjacentReferenceNode(range: Range, key: string, referenceDataKey: string) {
  const container = range.startContainer;
  const offset = range.startOffset;
  const previous = key === "Backspace";
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent || "";
    if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
    return findReferenceSibling(container, previous, referenceDataKey);
  }
  const children = Array.from(container.childNodes);
  return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, referenceDataKey, true);
}

function findReferenceSibling(node: Node, previous: boolean, referenceDataKey: string, includeSelf = false): HTMLElement | null {
  let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
  while (current?.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
  return current instanceof HTMLElement && current.dataset[referenceDataKey] ? current : null;
}
