import { httpRequest } from "@/lib/request";
import type { AgentRunStatus } from "./agent-run-state";

export type AgentExecutionDomain = "workflow" | "video_contract" | "studio";
export type AgentExecution<TResult = unknown> = {
  id: string;
  domain: AgentExecutionDomain;
  status: AgentRunStatus;
  updatedAt: string;
  error?: string;
  events: Record<string, unknown>[];
  result?: TResult;
};
export async function fetchAgentExecution<TResult>(query: { id: string } | { domain: AgentExecutionDomain }, signal?: AbortSignal) {
  const params = new URLSearchParams(query);
  return (await httpRequest<{ run: AgentExecution<TResult> | null }>(`/api/agent-runs?${params}`, { signal })).run;
}
export async function resumeAgentExecution<TResult>(id: string, signal?: AbortSignal) {
  return (await httpRequest<{ run: AgentExecution<TResult> }>(`/api/agent-runs?id=${encodeURIComponent(id)}`, { method: "POST", signal })).run;
}
export async function stopAgentExecution(id: string) {
  await httpRequest(`/api/agent-runs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function observeAgentExecution<TResult>(id: string, signal: AbortSignal, onProgress?: (run: AgentExecution<TResult>) => void): Promise<TResult> {
  while (!signal.aborted) {
    const run = await fetchAgentExecution<TResult>({ id }, signal);
    if (signal.aborted) throw signal.reason || new DOMException("观察已结束", "AbortError");
    if (!run) throw new Error("Agent 任务不存在");
    if (run.id !== id) throw new Error("任务标识不匹配，请重新读取进度");
    onProgress?.(run);
    if (signal.aborted) throw signal.reason || new DOMException("观察已结束", "AbortError");
    if (run.status === "success") {
      if (run.result == null) throw new Error("Agent 没有返回已验收的结果");
      return run.result;
    }
    if (run.status !== "running") throw new Error(run.error || "任务尚未完成，可从已保存进度继续");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException("观察已结束", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  throw signal.reason || new DOMException("观察已结束", "AbortError");
}
