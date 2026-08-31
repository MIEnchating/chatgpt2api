import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type CanvasProjectDialogMode = "create" | "rename" | "delete";

export function CanvasProjectDialog({
  open,
  mode,
  title,
  busy = false,
  description,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  mode: CanvasProjectDialogMode;
  title: string;
  busy?: boolean;
  description?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (value?: string) => void;
}) {
  const [draft, setDraft] = useState(title);
  const editable = mode !== "delete";

  useEffect(() => {
    if (open) setDraft(title);
  }, [open, title]);

  function submit() {
    const value = editable ? draft.trim() : undefined;
    if (editable && !value) return;
    onConfirm(value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,440px)] rounded-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "新建画布" : mode === "rename" ? "重命名画布" : "删除画布？"}</DialogTitle>
          <DialogDescription>{description || (editable ? "输入画布名称。" : `确定删除“${title}”吗？此操作不可恢复。`)}</DialogDescription>
        </DialogHeader>
        {editable ? <Input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder="画布名称" maxLength={200} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" variant={editable ? "default" : "destructive"} disabled={busy || editable && !draft.trim()} onClick={submit}>{busy ? "处理中…" : mode === "create" ? "创建" : mode === "rename" ? "保存" : "删除"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
