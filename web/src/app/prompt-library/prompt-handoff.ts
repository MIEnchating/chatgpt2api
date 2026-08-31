import type { BananaPrompt } from "@/app/image/banana-prompts";

const PROMPT_HANDOFF_KEY = "yunmian:prompt-library:pending-apply";

type PromptHandoff = {
  prompt: BananaPrompt;
  sessionKey: string;
};

export function stagePromptForWorkbench(prompt: BananaPrompt, sessionKey: string) {
  if (typeof window === "undefined") return;
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) return;
  window.sessionStorage.setItem(PROMPT_HANDOFF_KEY, JSON.stringify({ prompt, sessionKey: normalizedSessionKey }));
}

export function consumePromptForWorkbench(sessionKey: string): BananaPrompt | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(PROMPT_HANDOFF_KEY);
  window.sessionStorage.removeItem(PROMPT_HANDOFF_KEY);
  if (!raw) return null;
  try {
    const handoff = JSON.parse(raw) as Partial<PromptHandoff>;
    if (handoff.sessionKey !== sessionKey.trim() || !handoff.prompt || typeof handoff.prompt !== "object") {
      return null;
    }
    const value = handoff.prompt as Partial<BananaPrompt>;
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
