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

export function consumeCanvasResourceMention(
  value: string,
  mention: CanvasResourceMention,
  selectionEnd: number,
) {
  return {
    value: `${value.slice(0, mention.start)}${value.slice(selectionEnd)}`,
    cursor: mention.start,
  };
}

export function remapCanvasResourceLabels(
  value: string,
  before: readonly { nodeID: string; label: string }[],
  after: readonly { nodeID: string; label: string }[],
) {
  const nextLabels = new Map(after.map((reference) => [reference.nodeID, reference.label]));
  const labels = new Map(before.map((reference) => [reference.label, nextLabels.get(reference.nodeID) || ""]));
  const alternatives = [...labels.keys()].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!alternatives.length) return value;
  // Match ID tokens as a whole so a numbered label never changes a node ID.
  const pattern = new RegExp(`@\\[node:([^\\]]+)\\]|(${alternatives.join("|")})(?!\\d)`, "g");
  return value.replace(pattern, (token, nodeID: string | undefined, label: string | undefined) => nodeID
    ? nextLabels.has(nodeID) ? token : ""
    : labels.get(label || "") || "");
}
