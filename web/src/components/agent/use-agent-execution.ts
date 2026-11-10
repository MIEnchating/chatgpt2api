import { useEffect, useRef, useState } from "react";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { AgentExecutionMonitor, type AgentExecutionSnapshot } from "@/lib/agent-execution-monitor";
import type { AgentExecutionDomain } from "@/lib/agent-executions";

export function useAgentExecution<TResult>(domain: AgentExecutionDomain, busy: boolean, onResult: (result: TResult) => void, runID?: string) {
  const [sessionKey, setSessionKey] = useState(getCachedAuthSession()?.key);
  const [snapshot, setSnapshot] = useState<AgentExecutionSnapshot<TResult>>({ run: null, loading: true, action: "idle", error: "" });
  const monitor = useRef<AgentExecutionMonitor<TResult> | null>(null);
  const resultCallback = useRef(onResult);
  useEffect(() => { resultCallback.current = onResult; }, [onResult]);
  useEffect(() => {
    const sessionChanged = () => {
      const nextKey = getCachedAuthSession()?.key;
      if (nextKey === sessionKey) return;
      monitor.current?.dispose();
      monitor.current = null;
      setSnapshot({ run: null, loading: false, action: "idle", error: "" });
      setSessionKey(nextKey);
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, sessionChanged);
    return () => window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, sessionChanged);
  }, [sessionKey]);
  useEffect(() => {
    if (busy) return;
    const next = new AgentExecutionMonitor<TResult>(runID ? { id: runID } : domain);
    monitor.current = next;
    setSnapshot(next.getSnapshot());
    const unsubscribe = next.subscribe(() => setSnapshot(next.getSnapshot()));
    void next.refresh();
    return () => {
      unsubscribe();
      next.dispose();
      if (monitor.current === next) monitor.current = null;
    };
  }, [domain, busy, sessionKey, runID]);
  return {
    ...snapshot,
    refresh: () => { void monitor.current?.refresh(); },
    stop: () => { void monitor.current?.stop(); },
    continueRun: () => { void monitor.current?.continueRun((result) => resultCallback.current(result)); },
  };
}
