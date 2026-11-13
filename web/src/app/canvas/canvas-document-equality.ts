// Compare JSON canvas values without allocating serialized copies of transcripts.
export function canvasDocumentValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!canvasDocumentValuesEqual(a[index] ?? null, b[index] ?? null)) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  // Optional local properties are omitted by JSON, just like absent properties.
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter(key => right[key] !== undefined).length) return false;
  return keys.every(key => Object.hasOwn(right, key) && canvasDocumentValuesEqual(left[key], right[key]));
}
