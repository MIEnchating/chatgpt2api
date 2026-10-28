import { Copy, Link, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { copyClipboardText } from "@/lib/clipboard-text";
import { createCanvasShare, fetchCanvasShare, revokeCanvasShare } from "@/services/api/canvas";

export function CanvasShareDialog({ projectID, beforeShare, onClose }: {
  projectID: string;
  beforeShare: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const link = token ? `${window.location.origin}/share/canvas/${token}` : "";

  useEffect(() => {
    let active = true;
    fetchCanvasShare(projectID).then((share) => { if (active) setToken(share.token); })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : "无法读取分享状态"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectID]);

  async function updateShare() {
    setBusy(true);
    try {
      if (token) {
        await revokeCanvasShare(projectID);
        setToken("");
        toast.success("已取消分享，旧链接已失效");
      } else {
        if (!await beforeShare()) throw new Error("画布保存失败，请保存成功后再分享");
        const share = await createCanvasShare(projectID);
        setToken(share.token);
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
      <DialogHeader><DialogTitle>分享画布</DialogTitle><DialogDescription>拥有链接的人无需登录即可查看最新保存的画布，无法编辑或生成内容。Agent 对话和调用配置不会分享。</DialogDescription></DialogHeader>
      {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取分享状态</p> : error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <>
        {link ? <div className="space-y-3">
          <label className="block space-y-2 text-sm"><span>只读分享链接</span><Input readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></label>
          <Button className="w-full" onClick={() => { void copyClipboardText(link).then(() => toast.success("分享链接已复制")).catch((error: Error) => toast.error(error.message)); }}><Copy className="size-4" />复制链接</Button>
          {!window.isSecureContext ? <p className="text-xs text-muted-foreground">当前使用 HTTP，请选中上方链接手动复制；使用 HTTPS 后可一键复制。</p> : null}
          <p className="text-xs text-muted-foreground">取消分享后，旧链接将无法继续访问。重新分享会生成新链接。</p>
        </div> : <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">分享尚未开启，生成链接后即可发送给他人查看。</p>}
        <Button variant={token ? "destructive" : "default"} disabled={busy} onClick={() => void updateShare()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Link className="size-4" />}{token ? "取消分享" : "生成分享链接"}</Button>
      </>}
    </DialogContent>
  </Dialog>;
}
