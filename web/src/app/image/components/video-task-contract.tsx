"use client";

import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { LoaderCircle, PencilLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { TooltipHint } from "@/components/ui/tooltip";
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
      {allowed && editing ? <Suspense fallback={(
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent scrollable={false} className="h-[min(90dvh,860px)] w-[min(96vw,1280px)] max-w-none">
            <DialogHeader>
              <DialogTitle>编辑视频模型契约</DialogTitle>
              <DialogDescription>{editing.contract.name || "配置模型能力和上游字段映射"}</DialogDescription>
            </DialogHeader>
            <LoadingState className="min-h-0 flex-1" label="正在加载契约编辑器" />
          </DialogContent>
        </Dialog>
      )}>
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
    <TooltipHint content={context.error || label} className="studio-contract-tooltip pointer-events-none">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="px-2 text-xs has-[>svg]:px-2"
        disabled={context.loading || (!context.error && !current)}
        onClick={() => context.error ? context.retry() : current && context.edit(current)}
        aria-label={context.loading ? "正在读取视频契约" : context.error ? "重试读取视频契约" : `编辑当前视频契约：${label}`}
      >
        {context.loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <PencilLine className="size-3.5" />}
        <span>
          {context.loading ? "读取契约中" : context.error ? "重试读取契约" : current ? "管理契约" : "未匹配契约"}
        </span>
      </Button>
    </TooltipHint>
  );
}
