export type ImageConversationHistoryMergeBody<T> = {
  items: T[];
};

export function buildImageConversationHistoryMergeBody<T>(
  items: T[],
): ImageConversationHistoryMergeBody<T> {
  return { items };
}

export function normalizeImageConversationHistoryGeneration(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return /^[1-9]\d*$/.test(text) ? text : null;
}

/** Generations are server-side integer epochs. Keep the greatest known value
 * when responses race, so an older response can never move the client back. */
export function maxImageConversationHistoryGeneration(
  current: string | null | undefined,
  incoming: string | null | undefined,
) {
  const currentValue = normalizeImageConversationHistoryGeneration(current);
  const incomingValue = normalizeImageConversationHistoryGeneration(incoming);
  if (!currentValue) {
    return incomingValue;
  }
  if (!incomingValue) {
    return currentValue;
  }
  return BigInt(incomingValue) >= BigInt(currentValue) ? incomingValue : currentValue;
}

/**
 * Check that a response belongs to at least the known server generation.
 *
 * Current servers expose a positive integer generation.
 */
export function imageConversationHistoryGenerationAtLeast(
  value: string | null | undefined,
  minimum: string | null | undefined,
) {
  const valueGeneration = normalizeImageConversationHistoryGeneration(value);
  const minimumGeneration = normalizeImageConversationHistoryGeneration(minimum);
  if (minimumGeneration === null) {
    return true;
  }
  if (valueGeneration === null) {
    return false;
  }
  return BigInt(valueGeneration) >= BigInt(minimumGeneration);
}

export function imageConversationHistoryGenerationChanged(
  previous: string | null | undefined,
  next: string | null | undefined,
) {
  const currentValue = normalizeImageConversationHistoryGeneration(previous);
  const nextValue = normalizeImageConversationHistoryGeneration(next);
  if (!currentValue || !nextValue || currentValue === nextValue) {
    return false;
  }
  return BigInt(nextValue) > BigInt(currentValue);
}

export function shouldResetImageConversationHistoryCursor(status: unknown) {
  return Number(status) === 409;
}

export function imageConversationHistoryGenerationsMatch(
  first: string | null | undefined,
  active: string | null | undefined,
) {
  const firstValue = normalizeImageConversationHistoryGeneration(first);
  const activeValue = normalizeImageConversationHistoryGeneration(active);
  return firstValue === null || activeValue === null || firstValue === activeValue;
}

export function shouldFallbackToImageConversationHistoryDetail(status: unknown) {
  const normalized = Number(status);
  return normalized === 404 || normalized === 410;
}
