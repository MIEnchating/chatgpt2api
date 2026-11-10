"use client";

import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";

import { Spinner } from "@/components/ui/spinner";

import { ItemMedia } from "@/components/ui/item";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageIcon, RefreshCcw } from "lucide-react";

import type { BananaPrompt, PromptMarketSourceConfig } from "@/app/image/banana-prompts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CodeBlockCopyButton } from "@/components/ui/code-block";

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
      <ItemMedia variant="icon" className={cn("flex shrink-0 items-center justify-center", large ? "size-full min-h-64" : "size-16")}>
        <ImageIcon className={large ? "size-10" : "size-5"} />
      </ItemMedia>
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
  const loadGenerationRef = useRef(0);
  const currentSourceIDRef = useRef(source?.id || "");
  const openRef = useRef(open);
  currentSourceIDRef.current = source?.id || "";
  openRef.current = open;

  const loadPrompts = useCallback(async (quiet: boolean) => {
    if (!source) return;
    const sourceID = source.id;
    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    setIsLoading(true);
    setError("");
    const result = await onPull(source, quiet);
    if (
      loadGenerationRef.current !== loadGeneration
      || currentSourceIDRef.current !== sourceID
      || !openRef.current
    ) return;
    if (result.ok) {
      setPrompts(result.prompts);
      setPage(1);
    } else {
      setError(result.skipped ? "该来源正在其他位置更新，请稍后重试" : "提示词内容加载失败，请重试");
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


  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn("sm:max-w-none", cn("h-[min(88dvh,780px)]", "flex w-[min(94vw,1180px)] max-w-none flex-col overflow-hidden"))}>
          <div className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 pr-14 sm:px-6 sm:pr-16">
            <div className="min-w-0">
              <DialogTitle className="break-words">{source?.label || "提示词来源"} · 提示词内容</DialogTitle>
              <DialogDescription className="mt-1">{isLoading && prompts.length === 0 ? "正在读取..." : `共 ${prompts.length} 条`}</DialogDescription>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={isLoading || !source} onClick={() => void loadPrompts(false)}>
              {isLoading ? <Spinner /> : <RefreshCcw  />}
              立即更新
            </Button>
          </div>

          <div className="hidden grid-cols-[80px_minmax(0,1fr)_minmax(180px,240px)_150px] border-b border-border bg-muted/35 px-5 py-3 text-xs font-semibold text-muted-foreground md:grid sm:px-6">
            <span>封面</span><span>标题</span><span>标签</span><span>操作</span>
          </div>

          <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0">
            {isLoading && prompts.length === 0 ? (
              <LoadingState className="min-h-[360px]" label="正在加载提示词内容" />
            ) : error ? (
              <EmptyState className="min-h-[360px]" title="提示词加载失败" description={error} action={<Button type="button" variant="outline" onClick={() => void loadPrompts(false)}>重新加载</Button>} />
            ) : visiblePrompts.length === 0 ? (
              <EmptyState className="min-h-[360px]" title="该来源暂无提示词" />
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
                        {tags.map((tag) => <TooltipHint key={tag} content={tag}><Badge variant="secondary" className="max-w-36 truncate">{tag}</Badge></TooltipHint>)}
                      </div>
                      <div className="flex flex-nowrap items-center gap-1">
                        <CodeBlockCopyButton size="sm" value={prompt.prompt}>复制</CodeBlockCopyButton>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedPrompt(prompt)}>详情</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>

          <DialogFooter className="m-0 shrink-0 flex-row flex-wrap justify-center sm:justify-center">
            <Button type="button" variant="ghost" size="icon"  disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="上一页"><ChevronLeft /></Button>
            {paginationItems(page, totalPages).map((item) => typeof item === "number" ? (
              <Button key={item} type="button" aria-label={`第 ${item} 页`} aria-current={item === page ? "page" : undefined} variant={item === page ? "default" : "ghost"} size="icon"  onClick={() => setPage(item)}>{item}</Button>
            ) : <span key={item} className="flex size-8 items-center justify-center text-xs text-muted-foreground">...</span>)}
            <Button type="button" variant="ghost" size="icon"  disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight /></Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedPrompt)} onOpenChange={(nextOpen) => !nextOpen && setSelectedPrompt(null)}>
        <DialogContent className={cn("sm:max-w-none", cn("h-[min(90dvh,680px)]", "flex w-[min(94vw,920px)] max-w-none flex-col overflow-hidden"))}>
          <div className="grid h-full min-h-0 grid-rows-[minmax(0,0.65fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] md:grid-rows-1">
            <div className="flex min-h-0 items-center justify-center overflow-hidden bg-muted">
              {selectedPrompt ? <PromptCover prompt={selectedPrompt} large /> : null}
            </div>
            <div className="flex min-h-0 flex-col p-5 pr-7 sm:p-6 sm:pr-8">
              <DialogTitle className="line-clamp-2 shrink-0">{selectedPrompt?.title}</DialogTitle>
              <DialogDescription className="mt-1.5">{[selectedPrompt?.category, selectedPrompt?.author].filter(Boolean).join(" · ")}</DialogDescription>
              <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden mt-5 flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0">
                <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{selectedPrompt?.prompt}</p>
              </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
              <div className="mt-4 flex shrink-0 justify-end border-t border-border pt-3">
                {selectedPrompt ? <CodeBlockCopyButton variant="default" size="default" value={selectedPrompt.prompt}>复制提示词</CodeBlockCopyButton> : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
