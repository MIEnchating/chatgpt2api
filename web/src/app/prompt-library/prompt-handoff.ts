import type { BananaPrompt } from "@/app/image/banana-prompts";

const PROMPT_HANDOFF_KEY = "yunmian:prompt-library:pending-apply";

export function stagePromptForWorkbench(prompt: BananaPrompt) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(PROMPT_HANDOFF_KEY, JSON.stringify(prompt));
}

export function consumePromptForWorkbench(): BananaPrompt | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(PROMPT_HANDOFF_KEY);
  window.sessionStorage.removeItem(PROMPT_HANDOFF_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<BananaPrompt>;
    if (typeof value.id !== "string" || typeof value.prompt !== "string" || typeof value.title !== "string") return null;
    return {
      ...value,
      id: value.id,
      title: value.title,
      prompt: value.prompt,
      preview: typeof value.preview === "string" ? value.preview : "",
      referenceImageUrls: Array.isArray(value.referenceImageUrls) ? value.referenceImageUrls.filter((url): url is string => typeof url === "string") : [],
      author: typeof value.author === "string" ? value.author : "",
      mode: value.mode === "edit" || value.mode === "generate" ? value.mode : undefined,
      category: typeof value.category === "string" ? value.category : "未分类",
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
      source: typeof value.source === "string" ? value.source : "prompt-library",
      sourceLabel: typeof value.sourceLabel === "string" ? value.sourceLabel : "提示词库",
      isNsfw: value.isNsfw === true,
    };
  } catch {
    return null;
  }
}
