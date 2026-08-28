export type MyAssetKind = "text" | "image" | "video" | "audio";
export type MyAssetVisibility = "private" | "public";

export type MyAsset = {
  id: string;
  kind: MyAssetKind;
  title: string;
  coverUrl?: string;
  url?: string;
	storageKey?: string;
  content?: string;
  mimeType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Present only for images projected from the existing generated-image library. */
  managedPath?: string;
  tags: string[];
  visibility: MyAssetVisibility;
  source?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  ownerId?: string;
  ownerName?: string;
  owned?: boolean;
  createdAt: string;
  updatedAt: string;
};

export function createMyAssetId(randomUUID?: () => string) {
  const generator = randomUUID ?? (
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID.bind(crypto)
      : undefined
  );
  if (generator) {
    try {
      return `asset-${generator()}`;
    } catch {
      // randomUUID can be unavailable on non-secure remote HTTP origins.
    }
  }
  return `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createMyAsset(input: Omit<MyAsset, "id" | "createdAt" | "updatedAt" | "visibility"> & { visibility?: MyAssetVisibility }): MyAsset {
  const now = new Date().toISOString();
  return { ...input, visibility: input.visibility === "public" ? "public" : "private", id: createMyAssetId(), createdAt: now, updatedAt: now };
}

export function mergeMyAssets(...groups: readonly MyAsset[][]) {
  const records = new Map<string, MyAsset>();
  groups.flat().forEach((asset) => {
    const previous = records.get(asset.id);
    if (!previous || timestamp(asset.updatedAt) > timestamp(previous.updatedAt)) records.set(asset.id, asset);
  });
  return Array.from(records.values()).sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
}

export function normalizeMyAssets(value: unknown): MyAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const asset = normalizeMyAsset(candidate);
    return asset ? [asset] : [];
  });
}

function normalizeMyAsset(value: unknown): MyAsset | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<MyAsset>;
  const kind = String(item.kind || "") as MyAssetKind;
  const id = String(item.id || "").trim();
  const title = String(item.title || "").trim();
  const content = typeof item.content === "string" ? item.content.trim() : undefined;
  const url = typeof item.url === "string" ? item.url.trim() : undefined;
  const coverUrl = typeof item.coverUrl === "string" ? item.coverUrl.trim() : undefined;
  if (!id || !title || !["text", "image", "video", "audio"].includes(kind)) return null;
  if (kind === "text" ? !content : !url) return null;
  if (isBlobURL(url) || isBlobURL(coverUrl)) return null;
  const createdAt = validDate(item.createdAt) || new Date().toISOString();
  const updatedAt = validDate(item.updatedAt) || createdAt;
  return {
    id,
    kind,
    title,
    ...(coverUrl ? { coverUrl } : {}),
    ...(url ? { url } : {}),
	...(cleanString(item.storageKey) ? { storageKey: cleanString(item.storageKey) } : {}),
    ...(content ? { content } : {}),
    ...(cleanString(item.mimeType) ? { mimeType: cleanString(item.mimeType) } : {}),
    ...(nonNegativeNumber(item.bytes) !== undefined ? { bytes: nonNegativeNumber(item.bytes) } : {}),
    ...(positiveNumber(item.width) !== undefined ? { width: positiveNumber(item.width) } : {}),
    ...(positiveNumber(item.height) !== undefined ? { height: positiveNumber(item.height) } : {}),
    ...(nonNegativeNumber(item.durationMs) !== undefined ? { durationMs: nonNegativeNumber(item.durationMs) } : {}),
    ...(cleanString(item.managedPath) ? { managedPath: cleanString(item.managedPath) } : {}),
    tags: Array.isArray(item.tags)
      ? Array.from(new Set(item.tags.map(cleanString).filter((tag): tag is string => Boolean(tag)))).slice(0, 24)
      : [],
    visibility: item.visibility === "public" ? "public" : "private",
    ...(cleanString(item.source) ? { source: cleanString(item.source) } : {}),
    ...(cleanString(item.note) ? { note: cleanString(item.note) } : {}),
    ...(item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? { metadata: item.metadata } : {}),
    ...(cleanString(item.ownerId) ? { ownerId: cleanString(item.ownerId) } : {}),
    ...(cleanString(item.ownerName) ? { ownerName: cleanString(item.ownerName) } : {}),
    ...(typeof item.owned === "boolean" ? { owned: item.owned } : {}),
    createdAt,
    updatedAt,
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isBlobURL(value?: string) {
  return Boolean(value && value.toLowerCase().startsWith("blob:"));
}

function validDate(value: unknown) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "";
  return value;
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
