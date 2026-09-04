import {
  cancelCreationTask,
  createChatGenerationTask,
  fetchCreationTasks,
  type CreationTaskMessage,
  type CreationTaskToolCall,
} from "@/lib/api";
import type { CanvasAgentProtocolMessage, CanvasAgentToolCall } from "./canvas-agent-types";
import type { CanvasAgentToolDefinition } from "./canvas-agent-tools";

export type CanvasAgentModelTurn = {
  content: string;
  reasoningContent?: string;
  toolCalls: CanvasAgentToolCall[];
};

type RequestCanvasAgentTurnInput = {
  model: string;
  relayTokenName: string;
  prompt: string;
  systemPrompt: string;
  messages: CanvasAgentProtocolMessage[];
  tools: CanvasAgentToolDefinition[];
  signal?: AbortSignal;
};

class CanvasAgentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasAgentRequestError";
  }
}

export async function requestCanvasAgentTurn(input: RequestCanvasAgentTurnInput): Promise<CanvasAgentModelTurn> {
  return requestCompletion({ ...input, tools: input.tools });
}

async function requestCompletion(input: RequestCanvasAgentTurnInput & { tools: CanvasAgentToolDefinition[] }) {
  let submitted;
  try {
    submitted = await createChatGenerationTask({
      clientTaskId: `canvas-agent-${crypto.randomUUID()}`,
      prompt: input.prompt,
      model: input.model,
      relayTokenName: input.relayTokenName,
      messages: [
        { role: "system", content: input.systemPrompt },
        ...input.messages.map(toCreationTaskMessage),
      ],
      tools: input.tools,
      toolChoice: input.tools.length ? "auto" : undefined,
      requestOptions: { signal: input.signal },
    });
  } catch (error) {
    throw normalizeRequestError(error);
  }

  const cancelSubmitted = () => { void cancelCreationTask(submitted.id).catch(() => undefined); };
  input.signal?.addEventListener("abort", cancelSubmitted, { once: true });
  const deadline = Date.now() + 4 * 60_000;
  try {
    while (Date.now() < deadline) {
      throwIfAborted(input.signal);
      const task = (await fetchCreationTasks([submitted.id], { signal: input.signal })).items[0];
      if (task?.status === "success") {
        const data = task.data?.[0];
        const content = typeof data?.text_response === "string" ? data.text_response : "";
        const toolCalls = normalizeToolCalls(data?.tool_calls);
        if (!content && !toolCalls.length) throw new CanvasAgentRequestError("文本模型没有返回内容");
        return {
          content,
          ...(typeof data?.reasoning_content === "string" ? { reasoningContent: data.reasoning_content } : {}),
          toolCalls,
        };
      }
      if (task?.status === "error" || task?.status === "cancelled") {
        throw new CanvasAgentRequestError(task.error || "Agent 请求失败");
      }
      await waitForPoll(input.signal);
    }
    await cancelCreationTask(submitted.id).catch(() => undefined);
    throw new CanvasAgentRequestError("Agent 请求超时");
  } finally {
    input.signal?.removeEventListener("abort", cancelSubmitted);
  }
}

function toCreationTaskMessage(message: CanvasAgentProtocolMessage): CreationTaskMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function" as const,
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeToolCalls(value: CreationTaskToolCall[] | undefined): CanvasAgentToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((toolCall, index) => {
    const name = toolCall?.function?.name?.trim();
    if (!name) return [];
    return [{
      id: toolCall.id || `tool-call-${index}`,
      name,
      arguments: parseToolArguments(toolCall.function.arguments),
    }];
  });
}

function parseToolArguments(value: string | Record<string, unknown> | undefined) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeRequestError(error: unknown) {
  if (error instanceof CanvasAgentRequestError) return error;
  return new CanvasAgentRequestError(error instanceof Error ? error.message : "Agent 请求失败");
}

function waitForPoll(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 1000);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error("Agent 已停止");
  error.name = "AbortError";
  return error;
}
