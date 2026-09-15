import type { CanvasAgentProtocolMessage } from "./canvas-agent-types";

export const CANVAS_AGENT_INPUT_TOKEN_BUDGET = 64_000;
const SUMMARY_CHUNK_TOKENS = 20_000;
const SUMMARY_MAX_TOKENS = 4_000;

export function estimateCanvasAgentTokens(value: unknown) {
  let imageTokens = 0;
  const text = typeof value === "string" ? value : JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && item.type === "image_url") { imageTokens += 2048; return "[image reference]"; }
    return item;
  });
  return Math.ceil(new TextEncoder().encode(text || "").length / 3) + 8 + imageTokens;
}

export function isCanvasAgentContextLimitError(error: unknown) {
  return error instanceof Error && /context.{0,24}(?:length|limit|window)|maximum.{0,12}tokens|token.{0,12}limit|上下文.{0,10}(?:超|限)/i.test(error.message);
}

export async function compactCanvasAgentHistory(input: {
  messages: CanvasAgentProtocolMessage[];
  checkpoint?: string;
  recentTokenBudget?: number;
  summarize: (previous: string | undefined, history: string) => Promise<string>;
}) {
  // Keep complete user turns, including every tool request and its responses.
  const starts = input.messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  if (starts.length < 2) return { compacted: false, messages: input.messages, checkpoint: input.checkpoint };
  let cut = starts.at(-1)!;
  let recentTokens = estimateCanvasAgentTokens(input.messages.slice(cut));
  for (let index = starts.length - 2; index >= 1; index -= 1) {
    const cost = estimateCanvasAgentTokens(input.messages.slice(starts[index], starts[index + 1]));
    if (recentTokens + cost > (input.recentTokenBudget ?? 16_000)) break;
    recentTokens += cost;
    cut = starts[index];
  }
  const historicalText = JSON.stringify(input.messages.slice(0, cut).map((message) => {
    if (message.role === "assistant") return { role: message.role, content: message.content, toolCalls: message.toolCalls };
    if (message.role === "tool") return message;
    return { role: message.role, content: typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text") };
  }));
  let nextCheckpoint = input.checkpoint;
  // Stage all summaries before replacing any persisted history.
  for (const chunk of splitSummaryChunks(historicalText)) {
    const summary = (await input.summarize(nextCheckpoint, chunk)).trim();
    if (!summary || estimateCanvasAgentTokens(summary) > SUMMARY_MAX_TOKENS) throw new Error("对话摘要为空或过长，原始历史已保留");
    nextCheckpoint = summary;
  }
  return { compacted: true, messages: input.messages.slice(cut), checkpoint: nextCheckpoint };
}

function splitSummaryChunks(text: string) {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of text) {
    const cost = new TextEncoder().encode(char).length;
    if (bytes + cost > SUMMARY_CHUNK_TOKENS * 3) {
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
