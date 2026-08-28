export type VideoMultiPromptItem = {
  prompt: string;
  duration: string;
};

export type VideoElementReference = {
  id: string;
  kind: "image" | "video" | "audio";
  name: string;
  type: string;
  url: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type VideoElementItem = {
  name: string;
  description: string;
  references: VideoElementReference[];
};

export function defaultVideoMultiPrompts(): VideoMultiPromptItem[] {
  return [{ prompt: "", duration: "1" }];
}

export function normalizeVideoMultiPromptDuration(value: string | number | undefined) {
  const duration = Math.floor(Number(value) || 1);
  return String(Math.max(1, Math.min(15, duration)));
}

export function normalizeVideoMultiPrompts(value: unknown): VideoMultiPromptItem[] {
  if (!Array.isArray(value) || !value.length) return defaultVideoMultiPrompts();
  return value.map((candidate) => {
    const item = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    return {
      prompt: typeof item.prompt === "string" ? item.prompt : "",
      duration: normalizeVideoMultiPromptDuration(typeof item.duration === "string" || typeof item.duration === "number" ? item.duration : undefined),
    };
  });
}

export function defaultVideoElementList(): VideoElementItem[] {
  return [{ name: "", description: "", references: [] }];
}

export function normalizeVideoElementList(value: unknown): VideoElementItem[] {
  if (!Array.isArray(value) || !value.length) return defaultVideoElementList();
  return value.slice(0, 3).map((candidate) => {
    const item = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    return {
      name: typeof item.name === "string" ? item.name : "",
      description: typeof item.description === "string" ? item.description : "",
      references: normalizeVideoElementReferences(item.references).slice(0, 4),
    };
  });
}

export function moveVideoElementReference(references: VideoElementReference[], index: number, offset: number) {
  const target = index + offset;
  if (index < 0 || index >= references.length || target < 0 || target >= references.length) return references;
  const next = [...references];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function videoMultiPromptsToRequest(value: VideoMultiPromptItem[]): Array<Record<string, unknown>> {
  return normalizeVideoMultiPrompts(value).map((item) => ({
    prompt: item.prompt,
    duration: Number(normalizeVideoMultiPromptDuration(item.duration)),
  }));
}

export function videoElementListToRequest(value: VideoElementItem[]): Array<Record<string, unknown>> {
  return normalizeVideoElementList(value).map((item) => ({
    name: item.name,
    description: item.description,
    references: item.references.map((reference) => ({ kind: reference.kind, url: reference.url })),
  }));
}

function normalizeVideoElementReferences(value: unknown): VideoElementReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const kind = item.kind === "video" || item.kind === "audio" ? item.kind : "image";
    const url = typeof item.url === "string" ? item.url.trim() : typeof item.dataUrl === "string" ? item.dataUrl.trim() : "";
    if (!url) return [];
    return [{
      id: typeof item.id === "string" && item.id ? item.id : `element-reference-${index}-${url}`,
      kind,
      name: typeof item.name === "string" && item.name ? item.name : `element-${index + 1}`,
      type: typeof item.type === "string" ? item.type : "",
      url,
      ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}),
      ...(typeof item.width === "number" ? { width: item.width } : {}),
      ...(typeof item.height === "number" ? { height: item.height } : {}),
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    }];
  });
}
