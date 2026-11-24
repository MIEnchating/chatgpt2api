import { httpRequest, httpRequestEventStream } from "@/lib/request";
import type { AgentRunStatus } from "./agent-run-state";
import { isRetryableTaskPollError } from "./generation-task-contract";

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
type AgentExecutionEvent<TResult> = { type: "snapshot"; run: AgentExecution<TResult> | null } | { type: "error"; status: number; message: string };

export async function watchAgentExecution<TResult>(id: string, signal: AbortSignal, onProgress?: (run: AgentExecution<TResult> | null) => void, { awaitStart = false, awaitResume = false } = {}): Promise<AgentExecution<TResult> | null> {
  const query = new URLSearchParams({ id });
  if (awaitStart) query.set("await_start", "1");
  if (awaitResume) query.set("await_resume", "1");
  let settled: AgentExecution<TResult> | null | undefined;
  let lastData: string | undefined;
  let started = false;
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    if (started) query.delete("await_start");
    let callbackFailed = false;
    try {
      await httpRequestEventStream(`/api/agent-runs?${query}`, {
        signal, timeout: 0, idleTimeoutMs: 45_000,
        onData(data) {
          signal.throwIfAborted();
          const event = JSON.parse(data) as AgentExecutionEvent<TResult>;
          if (event?.type === "error") throw Object.assign(new Error(event.message), { status: event.status });
          if (event?.type !== "snapshot" || (event.run !== null && (!event.run || !Array.isArray(event.run.events)))) {
            throw new SyntaxError("Agent 进度格式无效");
          }
          const { run } = event;
          if (run && run.id !== id) throw new SyntaxError("任务标识不匹配，请重新读取进度");
          if (run) started = true;
          const watching = run ? run.status === "running" || (awaitResume && run.domain === "studio" && run.status === "waiting") : awaitStart && !started;
          if (!watching) settled = run;
          if (lastData === data) return;
          lastData = data;
          failures = 0;
          try {
            onProgress?.(run);
          } catch (error) {
            callbackFailed = true;
            throw error;
          }
        },
      });
      signal.throwIfAborted();
      if (settled !== undefined) return settled;
      throw new Error("Agent 进度连接已断开");
    } catch (error) {
      signal.throwIfAborted();
      if (callbackFailed || error instanceof SyntaxError || !isRetryableTaskPollError(error)) throw error;
      if (settled !== undefined) return settled;
      if (failures >= 3) throw error;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 500 * 2 ** failures++);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
}

export async function observeAgentExecution<TResult>(id: string, signal: AbortSignal, onProgress?: (run: AgentExecution<TResult>) => void): Promise<TResult> {
  const run = await watchAgentExecution<TResult>(id, signal, (next) => { if (next) onProgress?.(next); });
  if (!run) throw new Error("Agent 任务不存在");
  if (run.status !== "success") throw new Error(run.error || "任务尚未完成，可从已保存进度继续");
  if (run.result == null) throw new Error("Agent 没有返回已验收的结果");
  return run.result;
}
