const STORAGE_PREFIX = "chatgpt2api:navigation-pins:";

export function readNavigationPins(scope: string, availablePaths: readonly string[]): string[] {
  let paths: unknown[] = [];
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${scope}`);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) paths = parsed;
    }
  } catch {
    // Navigation stays usable when browser storage is unavailable or invalid.
  }
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && availablePaths.includes(path)))];
}

export function writeNavigationPins(scope: string, paths: readonly string[]) {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${scope}`, JSON.stringify(paths));
  } catch {
    // Pin changes still apply to the current navigation when storage is blocked.
  }
}
