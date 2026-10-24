import { waitForCreationTask, CreationTaskTimeoutError } from "@/lib/creation-task-events";
import {
  cancelCreationTask,
  createChatGenerationTask,
  type CreationTaskMessage,
  type CreationTaskToolCall,
} from "@/lib/api";
import type { CanvasAgentProtocolMessage, CanvasAgentToolCall } from "./canvas-agent-types";
import { parseCanvasAgentToolArguments } from "./canvas-agent-protocol";
import type { CanvasAgentToolDefinition } from "./canvas-agent-tools";

export type CanvasAgentModelTurn = {
  content: string;
  toolError?: string;
  inputTokens?: number;
  finishReason?: string;
  reasoningContent?: string;
  responseItems?: Record<string, unknown>[];
  toolCalls: CanvasAgentToolCall[];
};

export type RequestCanvasAgentTurnInput = {
  apiMode?: "chat" | "responses";
  reasoningEnabled?: boolean;
  stream?: boolean;
  maxOutputTokens?: number;
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
  throwIfAborted(input.signal);
  let submitted;
  try {
    submitted = await createChatGenerationTask({
      clientTaskId: `canvas-agent-${crypto.randomUUID()}`,
      prompt: input.prompt,
      model: input.model,
      apiMode: input.apiMode || "chat",
      reasoningEnabled: input.reasoningEnabled === true,
      stream: input.stream === true,
      maxOutputTokens: input.maxOutputTokens,
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
    throwIfAborted(input.signal);
    throw normalizeRequestError(error);
  }

  const cancelSubmitted = () => { void cancelCreationTask(submitted.id).catch(() => undefined); };
  input.signal?.addEventListener("abort", cancelSubmitted, { once: true });
  try {
    if (input.signal?.aborted) {
      cancelSubmitted();
      throw abortError();
    }
    const task = await waitForCreationTask(submitted.id, { signal: input.signal, timeoutMs: 4 * 60_000 });
    throwIfAborted(input.signal);
    if (task.status !== "success") throw new CanvasAgentRequestError(task.error || "Agent 请求失败");
    const data = task.data?.[0];
    const content = typeof data?.text_response === "string" ? data.text_response : "";
    const { toolCalls, toolError } = normalizeToolCalls(data?.tool_calls);
    const meta = data as Record<string, unknown> | undefined;
    const finishReason = typeof meta?.finish_reason === "string" ? meta.finish_reason : undefined;
    const usage = meta?.usage as { input_tokens?: number; prompt_tokens?: number } | undefined;
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
    if (!content && !toolCalls.length && !toolError && finishReason !== "length") throw new CanvasAgentRequestError("文本模型没有返回内容");
    return {
      content,
      ...(typeof data?.reasoning_content === "string" ? { reasoningContent: data.reasoning_content } : {}),
      toolCalls,
      toolError: finishReason === "length" || finishReason === "incomplete" ? "模型输出被截断，本批操作未执行；请减少单批操作数量并保留完整参数" : toolError,
      finishReason,
      responseItems: Array.isArray(meta?.response_items) ? meta.response_items as Record<string, unknown>[] : undefined,
      inputTokens: typeof inputTokens === "number" && Number.isFinite(inputTokens) ? inputTokens : undefined,
    };
  } catch (error) {
    if (error instanceof CreationTaskTimeoutError) {
      await cancelCreationTask(submitted.id).catch(() => undefined);
      throw new CanvasAgentRequestError("Agent 请求超时");
    }
    throwIfAborted(input.signal);
    throw normalizeRequestError(error);
  } finally {
    input.signal?.removeEventListener("abort", cancelSubmitted);
  }
}

function toCreationTaskMessage(message: CanvasAgentProtocolMessage): CreationTaskMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.responseItems?.length ? { response_items: message.responseItems } : {}),
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

function normalizeToolCalls(value: CreationTaskToolCall[] | undefined): { toolCalls: CanvasAgentToolCall[]; toolError?: string } {
  if (value === undefined) return { toolCalls: [] };
  if (!Array.isArray(value)) return { toolCalls: [], toolError: "tool_calls 必须是数组" };
  const invalid = value.some((call) => !call?.id || !call.function?.name?.trim());
  if (invalid) return { toolCalls: [], toolError: "工具调用缺少 ID 或名称，本批操作未执行" };
  return { toolCalls: value.map((call) => ({ id: call.id, name: call.function.name.trim(), ...parseCanvasAgentToolArguments(call.function.arguments) })) };
}

function normalizeRequestError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error instanceof CanvasAgentRequestError) return error;
  return new CanvasAgentRequestError(error instanceof Error ? error.message : "Agent 请求失败");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error("Agent 已停止");
  error.name = "AbortError";
  return error;
}
