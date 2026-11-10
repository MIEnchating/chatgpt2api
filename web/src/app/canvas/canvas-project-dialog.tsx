import { LabeledField } from "@/components/labeled-field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isCanvasPromptSubmitKey } from "./canvas-resource-mentions";

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

  useEffect(() => {
    if (open) setDraft(title);
  }, [open, title]);

  function submit() {
    if (busy) return;
    const value = draft.trim();
    if (!value) return;
    onConfirm(value);
  }

  if (mode === "delete") return <ConfirmDialog
    open={open}
    title="删除画布？"
    description={description || `确定删除“${title}”吗？此操作不可恢复。`}
    confirmLabel={busy ? "处理中…" : "删除"}
    destructive
    busy={busy}
    onOpenChange={onOpenChange}
    onConfirm={() => onConfirm()}
  />;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,440px)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "新建画布" : "重命名画布"}</DialogTitle>
          <DialogDescription>{description || "输入画布名称。"}</DialogDescription>
        </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <LabeledField className="grid gap-2 text-sm" label={<span>画布名称 <span className="text-destructive">*</span></span>} meta={`${draft.length}/200`}>
            {(fieldId) => <Input id={fieldId} value={draft} required disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (isCanvasPromptSubmitKey(event)) { event.preventDefault(); submit(); } }} placeholder="例如：春季品牌视觉" maxLength={200} />}
          </LabeledField>
        </ScrollArea><DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={busy || !draft.trim()} onClick={submit}>{busy ? "处理中…" : mode === "create" ? "创建" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
