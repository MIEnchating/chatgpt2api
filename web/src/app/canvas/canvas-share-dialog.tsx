
import { Alert, AlertDescription } from "@/components/ui/alert";

import { LoadingState } from "@/components/ui/loading-state";
import { LabeledField } from "@/components/labeled-field";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Item } from "@/components/ui/item";
import { Link } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createCanvasShare, fetchCanvasShare, revokeCanvasShare } from "@/services/api/canvas";

export function CanvasShareDialog({ projectID, beforeShare, onClose, onShareChange }: {
  projectID: string;
  beforeShare: () => Promise<boolean>;
  onClose: () => void;
  onShareChange: (shared: boolean) => void;
}) {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const link = token ? `${window.location.origin}/share/canvas/${token}` : "";

  useEffect(() => {
    let active = true;
    fetchCanvasShare(projectID).then((share) => { if (active) { setToken(share.token); onShareChange(Boolean(share.token)); } })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : "无法读取分享状态"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectID, onShareChange]);

  async function updateShare() {
    setBusy(true);
    try {
      if (token) {
        await revokeCanvasShare(projectID);
        setToken("");
        onShareChange(false);
        toast.success("已取消分享，旧链接已失效");
      } else {
        if (!await beforeShare()) throw new Error("画布保存失败，请保存成功后再分享");
        const share = await createCanvasShare(projectID);
        setToken(share.token);
        onShareChange(Boolean(share.token));
        toast.success("只读分享链接已生成");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新分享失败");
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>分享画布</DialogTitle><DialogDescription>拥有链接的人无需登录即可查看最新保存的画布，无法编辑或生成内容。Agent 对话和调用配置不会分享。</DialogDescription></DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
      {loading ? <LoadingState compact label="正在读取分享状态" /> : error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : <>
        {link ? <div className="space-y-3">
          <LabeledField className="grid gap-2 text-sm" label={<span>只读分享链接</span>}>{(fieldId) => <><Input id={fieldId} readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></>}</LabeledField>
          <CodeBlockCopyButton variant="default" size="default" className="w-full" value={link}>复制链接</CodeBlockCopyButton>
          {!window.isSecureContext ? <p className="text-xs text-muted-foreground">当前使用 HTTP，请选中上方链接手动复制；使用 HTTPS 后可一键复制。</p> : null}
          <p className="text-xs text-muted-foreground">取消分享后，旧链接将无法继续访问。重新分享会生成新链接。</p>
        </div> : <Item variant="muted" className="p-4">分享尚未开启，生成链接后即可发送给他人查看。</Item>}
        <Button variant={token ? "destructive" : "default"} disabled={busy} onClick={() => void updateShare()}>{busy ? <Spinner /> : <Link  />}{token ? "取消分享" : "生成分享链接"}</Button>
      </>}
    </ScrollArea></DialogContent>
  </Dialog>;
}
