import { estimateCanvasAgentTokens, isCanvasAgentContextLimitError } from "./canvas-agent-memory";
import type { CanvasAgentContent } from "./canvas-agent-types";

type ContentPart = Exclude<CanvasAgentContent, string>[number];

export const CANVAS_AGENT_MATERIAL_SUMMARY_TOKENS = 3_000;

// Keep captions with their images so every batch retains the original node identity.
export function splitCanvasAgentContent(content: CanvasAgentContent, tokenBudget = 8_000): ContentPart[][] {
  const parts: ContentPart[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const units: ContentPart[][] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.type === "image_url") {
      units.push([part]);
      continue;
    }
    const chunks = splitCanvasAgentText(part.text, Math.max(128, tokenBudget - 2_200));
    for (const text of chunks) units.push([{ type: "text", text }]);
    if (parts[index + 1]?.type === "image_url") {
      if (!chunks.length) units.push([{ type: "text", text: part.text }]);
      units.at(-1)!.push(parts[++index]);
    }
  }
  const batches: ContentPart[][] = [];
  let batch: ContentPart[] = [];
  for (const unit of units) {
    if (batch.length && (estimateCanvasAgentTokens([...batch, ...unit]) > tokenBudget || batch.filter((part) => part.type === "image_url").length >= 4)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...unit);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function splitCanvasAgentText(text: string, tokenBudget: number) {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let chunk = "";
  let bytes = 0;
  for (const char of text) {
    // Include JSON escaping in the estimate, not just the unescaped text.
    const cost = encoder.encode(JSON.stringify(char).slice(1, -1)).length;
    if (bytes + cost > tokenBudget * 3 && chunk) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += cost;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function summarizeCanvasAgentMaterial(input: {
  content: CanvasAgentContent;
  previous?: string;
  tokenBudget?: number;
  signal?: AbortSignal;
  onBatch?: (completed: number, remaining: number) => void;
  summarize: (previous: string | undefined, batch: CanvasAgentContent) => Promise<string>;
}) {
  const queue = splitCanvasAgentContent(input.content, input.tokenBudget).map((content) => ({ content, budget: input.tokenBudget ?? 8_000 }));
  let summary = input.previous;
  let completed = 0;
  while (queue.length) {
    input.signal?.throwIfAborted();
    input.onBatch?.(completed, queue.length);
    const item = queue.shift()!;
    let next: string;
    try {
      next = (await input.summarize(summary, item.content)).trim();
    } catch (error) {
      if (!isCanvasAgentContextLimitError(error)) throw error;
      const smallerBudget = Math.floor(item.budget / 2);
      const smaller = splitCanvasAgentContent(item.content, smallerBudget);
      if (smallerBudget < 512 || smaller.length <= 1) throw error;
      queue.unshift(...smaller.map((content) => ({ content, budget: smallerBudget })));
      continue;
    }
    input.signal?.throwIfAborted();
    if (!next || estimateCanvasAgentTokens(next) > CANVAS_AGENT_MATERIAL_SUMMARY_TOKENS) {
      throw new Error("分批分析未返回完整有效的摘要，原始资料和已执行结果已保留");
    }
    summary = next;
    completed += 1;
  }
  return summary || "";
}
