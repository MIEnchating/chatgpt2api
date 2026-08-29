"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardCopy, ImageIcon, LoaderCircle, RefreshCcw } from "lucide-react";
import { toast } from "sonner";

import type { BananaPrompt, PromptMarketSourceConfig } from "@/app/image/banana-prompts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { PromptSourcePullResult } from "./use-prompt-source-pulls";

type PromptSourceContentDialogProps = {
  source: PromptMarketSourceConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPull: (source: PromptMarketSourceConfig, quiet?: boolean) => Promise<PromptSourcePullResult>;
};

const PAGE_SIZE = 10;

function PromptCover({ prompt, large = false }: { prompt: BananaPrompt; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const hasCover = prompt.preview && !prompt.preview.startsWith("data:image/gif");
  if (!hasCover || failed) {
    return (
      <div className={cn("flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground", large ? "size-full min-h-64" : "size-16")}>
        <ImageIcon className={large ? "size-10" : "size-5"} />
      </div>
    );
  }
  return (
    <img
      src={prompt.preview}
      alt={prompt.title}
      className={cn("shrink-0 rounded-md bg-muted object-cover", large ? "max-h-[68dvh] size-full object-contain" : "size-16")}
      onError={() => setFailed(true)}
    />
  );
}

function paginationItems(page: number, totalPages: number) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = Array.from(new Set([1, totalPages, page - 1, page, page + 1].filter((value) => value >= 1 && value <= totalPages))).sort((left, right) => left - right);
  const items: Array<number | string> = [];
  pages.forEach((value, index) => {
    const previous = pages[index - 1];
    if (previous && value - previous > 1) items.push(`ellipsis-${previous}`);
    items.push(value);
  });
  return items;
}

export function PromptSourceContentDialog({ source, open, onOpenChange, onPull }: PromptSourceContentDialogProps) {
  const [prompts, setPrompts] = useState<BananaPrompt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [selectedPrompt, setSelectedPrompt] = useState<BananaPrompt | null>(null);

  const loadPrompts = useCallback(async (quiet: boolean) => {
    if (!source) return;
    setIsLoading(true);
    setError("");
    const result = await onPull(source, quiet);
    if (result.ok) {
      setPrompts(result.prompts);
      setPage(1);
    } else if (!result.skipped) {
      setError("提示词内容加载失败，请重试");
    }
    setIsLoading(false);
  }, [onPull, source]);

  useEffect(() => {
    if (!open || !source) return;
    setPrompts([]);
    setPage(1);
    setSelectedPrompt(null);
    void loadPrompts(true);
  }, [loadPrompts, open, source]);

  const totalPages = Math.max(1, Math.ceil(prompts.length / PAGE_SIZE));
  const visiblePrompts = useMemo(() => prompts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [page, prompts]);

  const copyPrompt = async (prompt: BananaPrompt) => {
    try {
      await navigator.clipboard.writeText(prompt.prompt);
      toast.success("提示词已复制");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent scrollable={false} className="flex h-[min(88dvh,780px)] w-[min(94vw,1180px)] max-w-none flex-col gap-0 overflow-hidden p-0">
          <div className="flex min-h-20 items-center justify-between gap-4 border-b border-border px-5 py-4 pr-14 sm:px-6 sm:pr-16">
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg sm:text-xl">{source?.label || "提示词来源"} · 提示词内容</DialogTitle>
              <DialogDescription className="mt-1">{isLoading && prompts.length === 0 ? "正在读取..." : `共 ${prompts.length} 条`}</DialogDescription>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={isLoading || !source} onClick={() => void loadPrompts(false)}>
              {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
              立即更新
            </Button>
          </div>

          <div className="hidden grid-cols-[80px_minmax(0,1fr)_minmax(180px,240px)_150px] border-b border-border bg-muted/35 px-5 py-3 text-xs font-semibold text-muted-foreground md:grid sm:px-6">
            <span>封面</span><span>标题</span><span>标签</span><span>操作</span>
          </div>

          <ScrollArea className="min-h-0 flex-1" viewportClassName="overscroll-contain">
            {isLoading && prompts.length === 0 ? (
              <div className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-5 animate-spin" />正在加载提示词内容
              </div>
            ) : error ? (
              <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 px-5 text-center text-sm text-muted-foreground">
                <p>{error}</p><Button type="button" variant="outline" onClick={() => void loadPrompts(false)}>重新加载</Button>
              </div>
            ) : visiblePrompts.length === 0 ? (
              <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">该来源暂无提示词</div>
            ) : (
              <div>
                {visiblePrompts.map((prompt) => {
                  const tags = Array.from(new Set([prompt.category, ...prompt.tags].filter(Boolean))).slice(0, 4);
                  return (
                    <div key={prompt.id} className="grid gap-3 border-b border-border px-5 py-4 last:border-b-0 md:grid-cols-[80px_minmax(0,1fr)_minmax(180px,240px)_150px] md:items-center sm:px-6">
                      <PromptCover prompt={prompt} />
                      <div className="min-w-0">
                        <TooltipHint content={prompt.title}><p className="truncate text-sm font-semibold">{prompt.title}</p></TooltipHint>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{prompt.prompt}</p>
                      </div>
                      <div className="flex min-w-0 flex-wrap gap-1.5">
                        {tags.map((tag) => <TooltipHint key={tag} content={tag}><Badge variant="secondary" className="max-w-36 truncate rounded-md px-2 py-1 font-normal">{tag}</Badge></TooltipHint>)}
                      </div>
                      <div className="flex flex-nowrap items-center gap-1">
                        <Button type="button" variant="ghost" size="sm" onClick={() => void copyPrompt(prompt)}><ClipboardCopy className="size-4" />复制</Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedPrompt(prompt)}>详情</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          <DialogFooter flush className="flex-row justify-center gap-1 sm:justify-center">
            <Button type="button" variant="ghost" size="icon" className="size-8" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="上一页"><ChevronLeft /></Button>
            {paginationItems(page, totalPages).map((item) => typeof item === "number" ? (
              <Button key={item} type="button" variant={item === page ? "default" : "ghost"} size="icon" className="size-8" onClick={() => setPage(item)}>{item}</Button>
            ) : <span key={item} className="flex size-8 items-center justify-center text-xs text-muted-foreground">...</span>)}
            <Button type="button" variant="ghost" size="icon" className="size-8" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight /></Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedPrompt)} onOpenChange={(nextOpen) => !nextOpen && setSelectedPrompt(null)}>
        <DialogContent scrollable={false} className="flex max-h-[90dvh] w-[min(94vw,920px)] max-w-none flex-col overflow-hidden p-0">
          <div className="grid min-h-0 md:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
            <div className="flex min-h-64 items-center justify-center overflow-hidden bg-muted md:min-h-[520px]">
              {selectedPrompt ? <PromptCover prompt={selectedPrompt} large /> : null}
            </div>
            <div className="flex min-h-0 flex-col p-5 pr-7 sm:p-6 sm:pr-8">
              <DialogTitle className="pr-20 text-xl leading-7">{selectedPrompt?.title}</DialogTitle>
              <DialogDescription className="mt-1.5">{[selectedPrompt?.category, selectedPrompt?.author].filter(Boolean).join(" · ")}</DialogDescription>
              <ScrollArea className="mt-5 min-h-0 flex-1" viewportClassName="pr-3">
                <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{selectedPrompt?.prompt}</p>
              </ScrollArea>
              <div className="mt-5 flex justify-end border-t border-border pt-4">
                {selectedPrompt ? <Button type="button" onClick={() => void copyPrompt(selectedPrompt)}><ClipboardCopy />复制提示词</Button> : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
