export function resetLogCursorStack() {
  return [""];
}

export function logCursorForPage(cursors: readonly string[], page: number) {
  if (!Number.isInteger(page) || page < 1) return null;
  const cursor = cursors[page - 1];
  return typeof cursor === "string" ? cursor : null;
}

export function recordLogPageCursor(
  cursors: readonly string[],
  page: number,
  snapshotCursor: string,
  nextCursor: string,
  hasMore: boolean,
) {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const next = cursors.slice(0, safePage);
  if (next.length === 0) next.push("");
  const normalizedSnapshotCursor = snapshotCursor.trim();
  if (normalizedSnapshotCursor) next[0] = normalizedSnapshotCursor;
  const normalizedNextCursor = nextCursor.trim();
  if (hasMore && normalizedNextCursor) {
    next[safePage] = normalizedNextCursor;
  }
  return next;
}
