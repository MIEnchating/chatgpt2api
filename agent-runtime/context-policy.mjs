export const DEFAULT_CONTEXT_WINDOW_TOKENS = 457_000;
export const CONTEXT_COMPACTION_RATIO = 0.8;

export function contextTokenBudget(contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS) {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 2) throw new Error('上下文上限必须是大于 1 的安全整数');
  return Math.floor(contextWindowTokens * CONTEXT_COMPACTION_RATIO);
}
