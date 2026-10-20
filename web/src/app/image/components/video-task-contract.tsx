"use client";

import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { LoaderCircle, PencilLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchAdminVideoModelContracts, type ManagedVideoModelContract } from "@/lib/api";
import type { StoredAuthSession } from "@/lib/auth-session";
import { resolveVideoTaskContracts } from "@/lib/video-task-contract";

const VideoModelContractEditor = lazy(() => import("@/app/settings/components/video-model-contracts-card")
  .then((module) => ({ default: module.VideoModelContractEditor })));

type ContractContext = {
  items: ManagedVideoModelContract[];
  loading: boolean;
  error: string;
  edit: (item: ManagedVideoModelContract) => void;
  retry: () => void;
};

const VideoTaskContractsContext = createContext<ContractContext | null>(null);

export function VideoTaskContractsProvider({ session, enabled, onPublished, children }: {
  session: StoredAuthSession;
  enabled: boolean;
  onPublished: () => void;
  children: ReactNode;
}) {
  const [items, setItems] = useState<ManagedVideoModelContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  const [editing, setEditing] = useState<ManagedVideoModelContract | null>(null);
  const allowed = session.role === "admin" && enabled;

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchAdminVideoModelContracts({ signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setItems(data.items);
    }).catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取契约配置失败");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [allowed, loadVersion, session.key]);

  return (
    <VideoTaskContractsContext.Provider value={allowed ? { items, loading, error, edit: setEditing, retry: () => setLoadVersion((value) => value + 1) } : null}>
      {children}
      {allowed && editing ? <Suspense fallback={<div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm shadow-lg"><LoaderCircle className="size-4 animate-spin" />正在打开契约编辑器</div>}>
        <VideoModelContractEditor
          key={`${session.key}:${editing.id}`}
          sessionKey={session.key}
          item={editing}
          onClose={() => setEditing(null)}
          onDraftSaved={setItems}
          onPublished={(updated) => { setItems(updated); onPublished(); }}
        />
      </Suspense> : null}
    </VideoTaskContractsContext.Provider>
  );
}

function contractLabel(contract: { name: string; revision?: number; driver?: string }) {
  return [contract.name, contract.revision ? `第 ${contract.revision} 版` : "", contract.driver].filter(Boolean).join(" · ");
}

export function VideoModelContractButton({ model }: { model: string }) {
  const context = useContext(VideoTaskContractsContext);
  if (!context) return null;
  const { current } = resolveVideoTaskContracts(context.items, model);
  const label = current ? contractLabel({ ...current.contract, revision: current.revision }) : "当前模型没有启用的契约";

  return (
    <Button
      type="button"
      variant="outline"
      className="h-9 max-w-full shrink-0 gap-1.5 rounded-xl border-border/70 bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-none"
      disabled={context.loading || (!context.error && !current)}
      onClick={() => context.error ? context.retry() : current && context.edit(current)}
      aria-label={context.loading ? "正在读取视频契约" : context.error ? "重试读取视频契约" : `编辑当前视频契约：${label}`}
      title={context.error || label}
    >
      {context.loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <PencilLine className="size-3.5" />}
      {context.loading ? "读取契约中" : context.error ? "重试读取契约" : current ? <>
        <span>编辑契约</span>
        <span className="hidden max-w-28 truncate text-muted-foreground/70 xl:inline">· {current.contract.name}</span>
      </> : "未匹配契约"}
    </Button>
  );
}
