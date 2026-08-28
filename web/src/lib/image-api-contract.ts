const PROMPT_REWRITE_GUARD_PREFIX =
  "Use the following text as the complete prompt. Do not rewrite it:";

export function composeImageGenerationPrompt(
  prompt: string,
  systemPrompt?: string,
  codexCLICompatibility?: boolean,
) {
  const composed = systemPrompt?.trim()
    ? `${systemPrompt.trim()}\n\n${prompt}`
    : prompt;
  return codexCLICompatibility
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${composed}`
    : composed;
}

export function normalizedImagePartialImages(value: number | undefined) {
  const normalized = Math.floor(Math.abs(Number(value)));
  if (!Number.isFinite(normalized)) {
    return 1;
  }
  return Math.max(0, Math.min(3, normalized));
}

export function normalizedImageWorkbenchCount(value: string | number) {
  return Math.max(1, Math.min(10, Math.floor(Number(value) || 1)));
}

export function imageWorkbenchTaskDispatches(taskIds: string[]) {
  return taskIds.map((taskId) => ({ taskId, count: 1 as const }));
}
