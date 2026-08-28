export function extractRequestErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    const message = value.trim();
    if (message.startsWith("{") || message.startsWith("[")) {
      try {
        const extracted = extractRequestErrorMessage(JSON.parse(message));
        if (extracted) return extracted;
      } catch {
        // Preserve non-JSON provider messages verbatim.
      }
    }
    return message;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractRequestErrorMessage(item);
      if (extracted) return extracted;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";

  const item = value as { message?: unknown; error?: unknown; detail?: unknown };
  return extractRequestErrorMessage(item.message)
    || extractRequestErrorMessage(item.error)
    || extractRequestErrorMessage(item.detail);
}
