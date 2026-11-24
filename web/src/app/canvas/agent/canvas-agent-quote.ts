export function appendCanvasAgentQuote(draft: string, text: string, source: string) {
  const excerpt = Array.from(text.trim()).slice(0, 1200).join("");
  if (!excerpt) return draft;
  const label = Array.from(source.replace(/\s+/g, " ").trim()).slice(0, 80).join("");
  const quote = [`> 引用自${label ? `「${label}」` : "当前对话"}（参考资料）`, ">", ...excerpt.split(/\r?\n/).map(line => `> ${line}`)].join("\n");
  return [draft.trimEnd(), quote].filter(Boolean).join("\n\n");
}

export function appendCanvasAgentHistoryReference(draft: string, session: { id: string; title: string }) {
  const target = `[canvas-session:${encodeURIComponent(session.id)}]`;
  if (draft.split("\n").some(line => line.startsWith("> 引用对话") && line.trimEnd().endsWith(` ${target}`))) return draft;
  const title = Array.from(session.title.replace(/\s+/g, " ").trim()).slice(0, 80).join("");
  return [draft.trimEnd(), `> 引用对话「${title || "历史对话"}」 ${target}`].filter(Boolean).join("\n\n");
}

export function hasCanvasAgentHistoryReference(text: string) {
  return /^>[ \t]+引用对话[^\r\n]* \[canvas-session:[^\]\s]+\][ \t]*\r?$/m.test(text);
}

export function isCanvasAgentHistoryReferenceOnly(text: string) {
  return hasCanvasAgentHistoryReference(text) && !text.replace(/^[ \t]*>[^\n]*/gm, "").trim();
}
