import { fetchAgentExecution, observeAgentExecution, resumeAgentExecution, stopAgentExecution, type AgentExecution, type AgentExecutionDomain } from "./agent-executions";

type ExecutionAPI<TResult> = {
  fetch: (query: { id: string } | { domain: AgentExecutionDomain }, signal?: AbortSignal) => Promise<AgentExecution<TResult> | null>;
  resume: (id: string, signal?: AbortSignal) => Promise<AgentExecution<TResult>>;
  observe: (id: string, signal: AbortSignal, progress: (run: AgentExecution<TResult>) => void) => Promise<TResult>;
  stop: (id: string) => Promise<void>;
};
export type AgentExecutionSnapshot<TResult> = {
  run: AgentExecution<TResult> | null;
  loading: boolean;
  action: "idle" | "observing" | "stopping";
  error: string;
};

// A monitor owns browser observation only. Disposing it never stops a server run.
export class AgentExecutionMonitor<TResult> {
  private snapshot: AgentExecutionSnapshot<TResult> = { run: null, loading: true, action: "idle", error: "" };
  private listeners = new Set<() => void>();
  private request: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(private query: AgentExecutionDomain | { id: string }, private api: ExecutionAPI<TResult> = {
    fetch: fetchAgentExecution<TResult>, resume: resumeAgentExecution<TResult>, observe: observeAgentExecution<TResult>, stop: stopAgentExecution,
  }) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<AgentExecutionSnapshot<TResult>>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private begin() {
    clearTimeout(this.timer);
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    return controller;
  }
  private current(controller: AbortController) {
    return !this.disposed && !controller.signal.aborted && this.request === controller;
  }
  async refresh() {
    if (this.disposed || this.snapshot.action !== "idle") return;
    const controller = this.begin();
    this.update({ loading: true, error: "" });
    try {
      const query = typeof this.query === "string" ? { domain: this.query } : this.query;
      const run = await this.api.fetch(query, controller.signal);
      if (!this.current(controller)) return;
      if ("id" in query && run && run.id !== query.id) throw new Error("任务标识不匹配，请重新读取进度");
      this.update({ run, loading: false });
      if (run?.status === "running" || (!run && "id" in query)) this.timer = setTimeout(() => { void this.refresh(); }, 2000);
    } catch (failure) {
      if (this.current(controller)) this.update({ loading: false, error: failure instanceof Error ? failure.message : "读取任务进度失败" });
    }
  }
  async continueRun(onResult: (result: TResult) => void) {
    const run = this.snapshot.run;
    if (this.disposed || !run || this.snapshot.action !== "idle") return;
    const controller = this.begin();
    this.update({ action: "observing", loading: false, error: "" });
    try {
      if (run.status !== "running" && run.status !== "success") {
        const resumed = await this.api.resume(run.id, controller.signal);
        if (!this.current(controller)) return;
        if (resumed.id !== run.id) throw new Error("任务标识不匹配，请重新读取进度");
        this.update({ run: resumed });
      }
      const result = await this.api.observe(run.id, controller.signal, (next) => {
        if (this.current(controller) && next.id === run.id) this.update({ run: next });
      });
      if (this.current(controller)) onResult(result);
    } catch (failure) {
      if (this.current(controller)) this.update({ error: failure instanceof Error ? failure.message : "读取任务进度失败" });
    } finally {
      if (this.current(controller)) this.update({ action: "idle" });
    }
  }
  async stop() {
    const run = this.snapshot.run;
    if (this.disposed || run?.status !== "running" || this.snapshot.action === "stopping") return;
    const controller = this.begin();
    this.update({ action: "stopping", loading: false, error: "" });
    try {
      await this.api.stop(run.id);
      if (!this.current(controller)) return;
      const next = await this.api.fetch({ id: run.id }, controller.signal);
      if (!this.current(controller)) return;
      if (!next || next.id !== run.id) throw new Error("任务进度不可用，请重新读取");
      this.update({ run: next });
    } catch (failure) {
      if (this.current(controller)) this.update({ error: failure instanceof Error ? failure.message : "停止任务失败" });
    } finally {
      if (this.current(controller)) {
        this.update({ action: "idle" });
        if (this.snapshot.run?.status === "running") this.timer = setTimeout(() => { void this.refresh(); }, 2000);
      }
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.request?.abort();
    this.listeners.clear();
  }
}
