import { useState } from "react";
import { FileText, MessageSquareText, Pencil, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { CanvasNode } from "@/services/api/canvas";
import { cn } from "@/lib/utils";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";

export function CanvasAgentTextArtifact({ node, onFocusNode, onSave, onAddToConversation, disabled = false }: {
  node: CanvasNode;
  onFocusNode?: (id: string) => void;
  onSave: (nodeID: string, title: string, content: string) => Promise<void>;
  onAddToConversation: (nodeID: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(node.title || "文字");
  const [content, setContent] = useState(node.prompt || "");
  const [saving, setSaving] = useState(false);
  if (node.type !== "text") return null;

  async function save() {
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(node.id, title.trim(), content);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文本节点保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <article data-agent-text-artifact={node.id} className="min-w-0 rounded-xl border border-border/70 bg-muted/15 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.title || "文字"}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={disabled} onClick={() => { setTitle(node.title || "文字"); setContent(node.prompt || ""); setOpen(true); }}><Pencil className="size-3.5" />编辑</Button>
      </div>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{node.prompt || "暂无正文"}</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <CanvasAgentNodeChip node={node} onFocus={onFocusNode} />
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={disabled} onClick={() => onAddToConversation(node.id)}><MessageSquareText className="size-3.5" />加入对话</Button>
      </div>
    </article>
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <DialogContent className="w-[min(94vw,720px)] gap-0 p-0">
        <DialogHeader className="px-5 pb-3 pt-5">
          <DialogTitle>编辑文本节点</DialogTitle>
          <DialogDescription>保存后会直接更新画布上的原节点。</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[min(68dvh,680px)] px-5" viewportClassName="overscroll-contain pr-2">
          <label className="mb-3 block space-y-1.5 text-sm"><span>节点名称</span><Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="mb-4 block space-y-1.5 text-sm"><span>内容</span><Textarea aria-label="节点内容" rows={18} className={cn("min-h-[min(52dvh,420px)] resize-y text-sm leading-6")} value={content} onChange={(event) => setContent(event.target.value)} /></label>
        </ScrollArea>
        <DialogFooter className="border-t border-border/60 px-5 py-3">
          <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" disabled={saving || !title.trim() || !content.trim()} aria-busy={saving} onClick={() => void save()}>{saving ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" /> : <Save className="size-4" />}保存到节点</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
