"use client";

import { KeyRound } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type RelayTokenCreationKind = "text" | "image" | "video" | "audio";

export function RelayTokenRequiredDialog({
  kind,
  open,
  onOpenChange,
}: {
  kind: RelayTokenCreationKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const creationLabel = kind === "text" ? "文本生成" : kind === "video" ? "生视频" : kind === "audio" ? "生音频" : "生图";

  const openProfile = () => {
    onOpenChange(false);
    navigate("/profile");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="w-[min(92vw,440px)] rounded-2xl">
        <DialogHeader className="gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </div>
          <DialogTitle>请选择{creationLabel}密钥</DialogTitle>
          <DialogDescription className="leading-6">
            生成前需要先在个人中心选择一枚用于{creationLabel}的可用密钥。如果没有可用密钥，请先创建后再回来生成。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={openProfile}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
