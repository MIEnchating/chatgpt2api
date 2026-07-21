const STORAGE_IMAGE_FILENAME_PATTERN = /^(?:\d+[-_])?(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[a-z0-9]+)?$/i;
const GENERIC_IMAGE_FILENAME_PATTERN = /^(?:image|img|picture|photo|screenshot|screen[-_ ]?shot|clipboard(?:[-_ ]?image)?|blob)(?:[-_ ]?\d+)?$/i;

function compactTitle(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

export function canvasImageTitle(name?: string, prompt?: string) {
  const promptText = compactTitle(prompt);
  if (promptText) return promptText;
  const fileName = String(name || "").trim();
  if (!fileName || STORAGE_IMAGE_FILENAME_PATTERN.test(fileName)) return "图片";
  const withoutExtension = fileName.replace(/\.[a-z0-9]{2,8}$/i, "").trim();
  if (!withoutExtension || GENERIC_IMAGE_FILENAME_PATTERN.test(withoutExtension)) return "图片";
  return compactTitle(withoutExtension) || "图片";
}
