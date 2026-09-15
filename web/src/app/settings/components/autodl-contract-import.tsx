import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CustomRelayConfigsResponse, CustomRelayConfigStatus } from "@/lib/api";
import type { VideoModelContract } from "@/lib/video-model-contracts";
import { httpRequest } from "@/lib/request";
import { fetchAutoDLWorkflows, type AutoDLWorkflow } from "@/services/api/autodl";

export function AutoDLContractImport({ onDraft, disabled }: { onDraft: (contract: VideoModelContract) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [configs, setConfigs] = useState<CustomRelayConfigStatus[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [workflowID, setWorkflowID] = useState("");
  const [workflows, setWorkflows] = useState<AutoDLWorkflow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (open) {
      setError("");
      void httpRequest<CustomRelayConfigsResponse>("/api/profile/custom-relay-configs", { signal: controller.signal }).then(({ configs }) => {
        if (!controller.signal.aborted) setConfigs(configs.filter((item) => item.protocol === "autodl" && item.kind === "video"));
      }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取线路失败"); });
    }
    return () => { controller.abort(); request.current?.abort(); };
  }, [open]);
  useEffect(() => {
    const controller = new AbortController();
    setWorkflows([]);
    setWorkflowID("");
    request.current?.abort();
    setLoading(false);
    if (open && tokenName) void fetchAutoDLWorkflows(tokenName, "", controller.signal).then(({ items }) => {
      if (!controller.signal.aborted) setWorkflows(items.filter((item) => item.kind !== "audio"));
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取工作流失败"); });
    return () => controller.abort();
  }, [open, tokenName]);
  const generate = async () => {
    if (loading || !tokenName || !workflowID.trim()) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ token_name: tokenName, workflow_id: workflowID.trim(), draft: "video" });
      const { contract } = await httpRequest<{ contract: VideoModelContract }>(`/api/profile/autodl-workflows?${query}`, { signal: controller.signal });
      if (!controller.signal.aborted) { onDraft(contract); setOpen(false); }
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "生成契约失败");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return <>
    <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>从 AutoDL 导入</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>从 AutoDL 工作流生成契约</DialogTitle><DialogDescription>读取已保存线路的真实工作流规则。生成后可检查和修改，再发布到视频模型列表。</DialogDescription></DialogHeader>
      <div className="grid gap-3">
        <Select value={tokenName} onValueChange={setTokenName}><SelectTrigger><SelectValue placeholder="选择 AutoDL 视频线路" /></SelectTrigger><SelectContent>{configs.map((item) => <SelectItem key={item.id} value={item.token_name}>{item.name}</SelectItem>)}</SelectContent></Select>
        {configs.length === 0 ? <p className="text-sm text-muted-foreground">先在个人设置中添加协议为 AutoDL 的视频自定义 API 配置。</p> : null}
        {workflows.length ? <Select value={workflowID} onValueChange={setWorkflowID}><SelectTrigger><SelectValue placeholder="选择工作流" /></SelectTrigger><SelectContent>{workflows.map((item) => <SelectItem key={item.uuid} value={item.uuid}>{item.name || item.uuid}</SelectItem>)}</SelectContent></Select> : null}
        <Input value={workflowID} onChange={(event) => setWorkflowID(event.target.value)} placeholder="或填写工作流 ID" disabled={loading} />
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
      <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button><Button type="button" disabled={loading || !tokenName || !workflowID.trim()} onClick={() => void generate()}>{loading ? "正在读取…" : "生成并检查"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
