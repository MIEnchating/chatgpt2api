import * as React from "react";
import { LoaderCircle, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确定",
  cancelLabel = "取消",
  destructive = false,
  busy = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block dismissal while the confirmed action is still running.
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="w-[min(92vw,440px)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle className="animate-spin" /> : destructive ? <Trash2 /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmDialog };
