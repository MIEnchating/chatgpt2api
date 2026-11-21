import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";

import { fetchVideoModelContractVersions, type ManagedVideoModelContract, type VideoModelContractVersion } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { ScrollArea } from "@/components/ui/scroll-area";

type VideoContractVersionsDialogProps = {
  item: ManagedVideoModelContract;
  formatDateTime: (value: string) => string;
  onClose: () => void;
  onRollback: (revision: number) => Promise<boolean>;
};

export function VideoContractVersionsDialog({ item, formatDateTime, onClose, onRollback }: VideoContractVersionsDialogProps) {
  const [versions, setVersions] = useState<VideoModelContractVersion[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pendingVersion, setPendingVersion] = useState<VideoModelContractVersion | null>(null);
  const [rollbackError, setRollbackError] = useState("");
  const [rollingBack, setRollingBack] = useState(false);
  const rollingBackRef = useRef(false);
  const contractId = item.id;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void fetchVideoModelContractVersions(contractId, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setVersions(data.versions);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "加载契约版本失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [contractId, loadAttempt]);

  const confirmRollback = async () => {
    if (!pendingVersion || rollingBackRef.current) return;
    rollingBackRef.current = true;
    setRollingBack(true);
    setRollbackError("");
    try {
      if (await onRollback(pendingVersion.revision)) onClose();
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : "回滚契约失败");
    } finally {
      rollingBackRef.current = false;
      setRollingBack(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !rollingBackRef.current) onClose(); }}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!rollingBack}>
        <DialogHeader>
          <DialogTitle>契约版本历史</DialogTitle>
          <DialogDescription className="break-words">{item.contract.name} · 当前第 {item.revision} 版</DialogDescription>
        </DialogHeader>
        <ScrollArea data-slot="dialog-body" className="min-h-0 max-h-[min(60dvh,520px)] flex-1" contentClassName="py-1">
          {loading ? (
            <LoadingState className="h-auto min-h-32" label="正在加载版本记录" />
          ) : loadError ? (
            <EmptyState compact role="alert" icon={History} title="无法加载历史版本" description={loadError}
              action={<Button variant="outline" size="sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重试</Button>} />
          ) : versions.length === 0 ? (
            <EmptyState compact title="暂无历史版本" className="min-h-0 p-6" />
          ) : (
            <ul className="divide-y">
              {versions.map((version) => (
                <li key={version.revision} className="flex min-w-0 flex-wrap items-center gap-2 py-3 sm:gap-3">
                  <Badge variant="outline" className="shrink-0 font-mono">v{version.revision}</Badge>
                  <div className="min-w-32 flex-1">
                    <p className="break-words text-sm font-medium">{version.contract.name}</p>
                    <time dateTime={version.published_at} className="text-xs text-muted-foreground">{formatDateTime(version.published_at)}</time>
                  </div>
                  {version.revision === item.revision ? <Badge variant="default">当前版本</Badge> : (
                    <Button type="button" size="sm" variant="outline" disabled={rollingBack}
                      aria-label={`回滚到第 ${version.revision} 版`}
                      onClick={() => { setRollbackError(""); setPendingVersion(version); }}>
                      <History />回滚
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" disabled={rollingBack} onClick={onClose}>关闭</Button>
        </DialogFooter>
        <ConfirmDialog
          open={Boolean(pendingVersion)}
          title="回滚并发布契约？"
          description={`第 ${pendingVersion?.revision ?? ""} 版将作为新版本发布，并用于后续任务。`}
          confirmLabel="回滚并发布"
          busy={rollingBack}
          onOpenChange={(open) => { if (!open && !rollingBackRef.current) setPendingVersion(null); }}
          onConfirm={() => void confirmRollback()}
        >
          {rollbackError ? <Alert variant="destructive" role="alert"><AlertDescription>{rollbackError}</AlertDescription></Alert> : null}
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}
