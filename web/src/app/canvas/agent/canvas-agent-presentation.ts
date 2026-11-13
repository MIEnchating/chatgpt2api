import type {
  CanvasAgentPlan,
  CanvasAgentProtocolMessage,
  CanvasAgentToolCall,
  CanvasAgentTraceEntry,
} from "./canvas-agent-types";
import { canvasAgentToolKind } from "./canvas-agent-trace";

export function canvasAgentTraceIndex(
  protocol: readonly CanvasAgentProtocolMessage[],
  entries: readonly CanvasAgentTraceEntry[],
) {
  const ids = new Set(entries.flatMap(entry => entry.type === "operation" ? [entry.id.replace(/^tool:/, "")] : []));
  const calls = new Map<string, CanvasAgentToolCall>();
  const outputs = new Map<string, unknown>();
  const positions = new Map<string, number>();
  if (!ids.size) return { calls, outputs, positions };
  protocol.forEach((message, position) => {
    if (message.role === "assistant") {
      for (const call of message.toolCalls || []) {
        if (ids.has(call.id)) calls.set(call.id, call);
      }
    }
    if (message.role === "tool" && ids.has(message.toolCallId)) {
      outputs.set(message.toolCallId, toolOutput(message.content));
      positions.set(message.toolCallId, position);
    }
  });
  return { calls, outputs, positions };
}

export function canvasAgentDisplayTraces(
  entries: readonly CanvasAgentTraceEntry[],
  protocol: readonly CanvasAgentProtocolMessage[],
  index = canvasAgentTraceIndex(protocol, entries),
) {
  const { calls, outputs, positions } = index;
  const acceptedFinishes = entries.flatMap(entry => {
    if (entry.type !== "operation") return [];
    const id = entry.id.replace(/^tool:/, ""), position = positions.get(id), output = outputs.get(id);
    return position !== undefined && calls.get(id)?.name === "finish_task" && record(output) && output.ok === true && output.status !== "error" ? [{ id, position }] : [];
  }).sort((a, b) => a.position - b.position);
  return entries.map((entry, entryIndex) => {
    if (entry.type !== "operation") return entry;
    const call = calls.get(entry.id.replace(/^tool:/, ""));
    const output = call ? outputs.get(call.id) : undefined;
    const position = call ? positions.get(call.id) : undefined;
    const laterGeneration = entry.status === "error" && entry.kind === "generate" && entry.nodeId ? entries.slice(entryIndex+1).find(item=>item.type==="operation" && item.kind==="generate" && item.nodeId===entry.nodeId && item.status==="success") : undefined;
    const resolution = call?.name === "finish_task" && entry.status === "error" && record(output) && output.code === "task_incomplete" && position !== undefined
      ? acceptedFinishes.find(finish => finish.position > position) : laterGeneration;

    return call
      ? {
          ...entry,
          ...(resolution ? { resolvedBy: resolution.id } : {}),
          kind: canvasAgentToolKind(call.name),
          tool: {
            name: call.name,
            input: call.arguments,
            output,
          },
        }
      : entry;
  });
}

export function canvasAgentToolPlan(
  input: unknown,
): CanvasAgentPlan | undefined {
  if (
    !record(input) ||
    (input.explanation !== undefined && typeof input.explanation !== "string") ||
    !Array.isArray(input.steps)
  )
    return;
  const steps: CanvasAgentPlan["steps"] = [];
  for (const step of input.steps) {
    if (
      !record(step) ||
      typeof step.id !== "string" ||
      typeof step.title !== "string"
    )
      return;
    const status = step.status;
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "deferred"
    )
      return;
    steps.push({ id: step.id, title: step.title, status });
  }
  return steps.length ? { explanation: input.explanation as string | undefined || "", steps } : undefined;
}

export function canvasAgentOperationContext<T extends { id: string; title?: string }>(
  entry: Extract<CanvasAgentTraceEntry, { type: "operation" }>,
  nodes: readonly T[],
) {
  const input = record(entry.tool?.input) ? entry.tool.input : {};
  const output = record(entry.tool?.output) ? entry.tool.output : {};
  const resultNode = record(output.node) ? output.node : {};
  const nodeId = entry.nodeId || (typeof input.nodeId === "string" ? input.nodeId : undefined) || (typeof resultNode.id === "string" ? resultNode.id : undefined);
  const node = nodes.find(item => item.id === nodeId);
  const nodeName = node?.title || (typeof resultNode.title === "string" && resultNode.title) || nodeId;
  const nodeNameFor = (id: string) => nodes.find(item => item.id === id)?.title || id;
  const details: string[] = [];
  if (entry.tool?.name === "create_canvas_workflow" && Array.isArray(input.steps)) {
    const steps = input.steps.filter(record);
    const names = new Map(steps.flatMap(step => typeof step.key === "string" && typeof step.title === "string" ? [[step.key, step.title] as const] : []));
    for (const step of steps) {
      if (typeof step.title !== "string") continue;
      const dependencies = Array.isArray(step.dependsOn) ? step.dependsOn.filter((id): id is string => typeof id === "string").map(id => names.get(id) || id) : [];
      details.push(`${step.title}${dependencies.length ? `（依赖：${dependencies.join("、")}）` : ""}`);
    }
  }
  if (entry.tool?.name === "run_canvas_workflow" && Array.isArray(input.nodeIds)) {
    details.push(...input.nodeIds.filter((id): id is string => typeof id === "string").map(nodeNameFor));
  }
  const workflowName = typeof input.groupTitle === "string" && input.groupTitle || typeof input.name === "string" && input.name || typeof input.workflowId === "string" && input.workflowId || undefined;
  return { nodeId, node, nodeName, workflowName, details };
}

export function canvasAgentLatestTracePlan(
  entries: readonly CanvasAgentTraceEntry[],
): CanvasAgentPlan | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type !== "operation" || entry.kind !== "plan" || !entry.tool) continue;
    const plan = canvasAgentToolPlan(entry.tool.input);
    if (plan) return plan;
  }
}

export function canvasAgentResponsePresentation(
  protocol: readonly CanvasAgentProtocolMessage[],
) {
  const reasoning: { id: string; text: string }[] = [];
  const sources = new Map<string, { url: string; title: string }>();
  for (const message of protocol) {
    if (message.role !== "assistant") continue;
    for (const item of message.responseItems || []) {
      // Responses publishes summaries separately from encrypted/raw reasoning.
      if (item.type === "reasoning" && Array.isArray(item.summary)) {
        const text = item.summary
          .flatMap((part) =>
            record(part) &&
            part.type === "summary_text" &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          )
          .join("\n\n");
        if (text)
          reasoning.push({
            id:
              typeof item.id === "string"
                ? item.id
                : `summary:${reasoning.length}`,
            text,
          });
      }
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!record(part) || !Array.isArray(part.annotations)) continue;
        for (const annotation of part.annotations) {
          if (
            !record(annotation) ||
            annotation.type !== "url_citation" ||
            typeof annotation.url !== "string"
          )
            continue;
          let url: URL;
          try {
            url = new URL(annotation.url);
          } catch {
            continue;
          }
          if (url.protocol !== "https:" && url.protocol !== "http:") continue;
          if (url.username || url.password) continue;
          sources.set(url.href, {
            url: url.href,
            title:
              typeof annotation.title === "string" && annotation.title.trim()
                ? annotation.title
                : url.hostname,
          });
        }
      }
    }
  }
  return { reasoning, sources: [...sources.values()] };
}

export function canvasAgentErrorStack(value: unknown): string | undefined {
  if (record(value)) {
    if (typeof value.stack === "string") return value.stack;
    if (record(value.error) && typeof value.error.stack === "string")
      return value.error.stack;
  }
  // A plain error message is not a stack trace.
  if (typeof value === "string" && /^\s+at .+\(.+:\d+:\d+\)\s*$/m.test(value))
    return value;
}

export function canvasAgentToolMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return canvasAgentToolMessage(JSON.parse(value));
    } catch {
      return value.trim() || undefined;
    }
  }
  if (Array.isArray(value)) {
    const messages = value.flatMap(item => record(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []);
    return messages.join("\n").trim() || undefined;
  }
  if (!record(value)) return;
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  if (record(value.error) && typeof value.error.message === "string") return value.error.message;
}

function toolOutput(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
