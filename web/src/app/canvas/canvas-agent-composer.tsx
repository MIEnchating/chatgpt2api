import { useState, type ComponentProps } from "react";
import { FolderOpen, LoaderCircle, Menu, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function CanvasAgentComposer({ className, ...props }: ComponentProps<"div">) {
  return <div data-agent-composer className={cn("flex min-h-0 flex-col rounded-xl border border-border bg-card p-4 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20", className)} {...props} />;
}

export function CanvasAgentComposerToolbar({ className, ...props }: ComponentProps<"div">) {
  return <div data-agent-composer-toolbar className={cn("mt-2 flex min-w-0 shrink-0 items-center gap-1.5", className)} {...props} />;
}

export function CanvasAgentSendButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type="button" size="icon" data-agent-send className={cn("ml-auto size-10 shrink-0 rounded-full", className)} {...props} />;
}

export function CanvasAgentAssetMenu({ disabled, uploading = false, onUpload, onOpenAssets }: {
  disabled: boolean;
  uploading?: boolean;
  onUpload: () => void;
  onOpenAssets: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" size="icon" variant="secondary" className="size-9 shrink-0 rounded-full" aria-label="添加 Agent 素材" disabled={disabled}><Menu /></Button></PopoverTrigger>
    <PopoverContent side="top" align="start" className="w-40 p-1.5">
      <button type="button" disabled={disabled || uploading} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50" onClick={() => { setOpen(false); onUpload(); }}>{uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}上传文件</button>
      <button type="button" disabled={disabled} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50" onClick={() => { setOpen(false); onOpenAssets(); }}><FolderOpen className="size-4" />我的素材</button>
    </PopoverContent>
  </Popover>;
}
