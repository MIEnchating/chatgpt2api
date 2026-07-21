import type { CanvasResourceReference } from "./canvas-resources.ts";

export type CanvasResourceMention = {
  start: number;
  query: string;
};

export function isCanvasPromptSubmitKey(event: {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}) {
  const composing = event.isComposing
    || event.nativeEvent?.isComposing
    || event.keyCode === 229
    || event.nativeEvent?.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !composing;
}

export function findCanvasResourceMention(
  value: string,
  cursor: number,
  references: readonly CanvasResourceReference[],
): CanvasResourceMention | null {
  const prefix = value.slice(0, Math.max(0, cursor));
  const match = /(^|\s)@([^\s@]*)$/.exec(prefix);
  if (!match || !references.some((reference) => reference.active)) return null;
  return { start: cursor - match[2].length - 1, query: match[2] };
}

export function filterCanvasResourceMentions(
  mention: CanvasResourceMention | null,
  references: readonly CanvasResourceReference[],
) {
  if (!mention) return [];
  const query = mention.query.trim().toLowerCase();
  const active = references.filter((reference) => reference.active);
  if (!query) return active;
  return active.filter((reference) => (
    `${reference.label} ${reference.title} ${reference.kind} ${reference.text || ""}`
      .toLowerCase()
      .includes(query)
  ));
}

export function insertCanvasResourceMention(
  value: string,
  mention: CanvasResourceMention,
  selectionEnd: number,
  reference: CanvasResourceReference,
) {
  const inserted = `${reference.label} `;
  return {
    value: `${value.slice(0, mention.start)}${inserted}${value.slice(selectionEnd)}`,
    cursor: mention.start + inserted.length,
  };
}
