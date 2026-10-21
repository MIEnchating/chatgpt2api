"use client";

import { Clock3, Download, History, X, LoaderCircle, MessageSquarePlus, Trash2 } from "lucide-react";
import { useState } from "react";

import { useHistoryDownload } from "@/app/image/use-history-download";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import {
  getImageConversationStats,
  isImageConversationHistorySummaryOnly,
  type ImageConversation,
} from "@/store/image-conversations";

type ImageSidebarProps = {
  conversations: ImageConversation[];
  isLoadingHistory: boolean;
  isLoadingMoreHistory: boolean;
  hasMoreHistory: boolean;
  selectedConversationId: string | null;
  onCreateDraft: () => void;
  onClearHistory: () => void | Promise<void>;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  onLoadMore: () => void | Promise<void>;
  formatConversationTime: (value: string) => string;
  hideActionButtons?: boolean;
};

export function ImageSidebar({
  conversations,
  isLoadingHistory,
  isLoadingMoreHistory,
  hasMoreHistory,
  selectedConversationId,
  onCreateDraft,
  onClearHistory,
  onSelectConversation,
  onDeleteConversation,
  onLoadMore,
  formatConversationTime,
  hideActionButtons = false,
}: ImageSidebarProps) {
  const batch = useHistoryDownload(conversations);
  const [query, setQuery] = useState("");
  const visibleConversations = conversations.filter((conversation) => conversation.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <aside aria-label="创作会话" className="h-full min-h-0 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-3">
        {!hideActionButtons && (
          <div className="flex items-center gap-2 pb-1">
            <Button className="h-10 flex-1 justify-start rounded-xl px-3 shadow-none" onClick={onCreateDraft}>
              <MessageSquarePlus className="size-4" />
              新建对话
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="清空会话记录"
              className="size-10 shrink-0 rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void onClearHistory()}
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}

        {conversations.length > 0 ? <SearchInput value={query} onValueChange={setQuery} placeholder="搜索已加载的会话" className="h-9 rounded-lg border-border/60 bg-background/70 text-xs shadow-none" /> : null}
        <div className="flex min-h-7 items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
            <span>最近会话</span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] leading-4 tabular-nums">{conversations.length}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 shrink-0 gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground", batch.selecting && "bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand")}
            aria-pressed={batch.selecting}
            disabled={conversations.length === 0 || batch.busy}
            onClick={() => { batch.setSelecting(!batch.selecting); batch.setSelected(new Set()); }}
          >
            {batch.selecting ? <X className="size-3.5" /> : <Download className="size-3.5" />}
            {batch.selecting ? "退出选择" : "批量下载"}
          </Button>
        </div>
        {batch.selecting ? (
          <div className="space-y-2 rounded-xl border border-brand-border bg-brand-soft/40 p-2.5">
            <div className="flex items-center justify-between gap-2 pl-0.5">
              <span className="text-[11px] text-muted-foreground">已选 <strong className="font-semibold text-foreground tabular-nums">{batch.selected.size}</strong> 个会话</span>
              <Button variant="ghost" size="sm" className="h-6 rounded-md px-1.5 text-[11px] text-brand" aria-label="全选已加载会话" disabled={batch.busy} onClick={() => batch.setSelected(new Set(conversations.map((item) => item.id)))}>全选</Button>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-8 min-w-0 flex-1 rounded-lg text-xs" disabled={batch.busy || !batch.selected.size} onClick={() => void batch.download()}>
                {batch.busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                {batch.busy ? "正在打包…" : "下载所选"}
              </Button>
              {batch.busy ? <Button variant="ghost" size="sm" className="h-8 shrink-0 rounded-lg px-2 text-xs" aria-label="取消下载" onClick={batch.cancel}>取消</Button> : null}
            </div>
          </div>
        ) : null}
        <ScrollArea
          className="min-h-0 flex-1"
        >
          <div className={cn("flex min-h-full flex-col gap-1.5", hideActionButtons ? "pr-0" : "pr-1")}>
            {isLoadingHistory ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取会话记录
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <span className="mb-3 flex size-10 items-center justify-center rounded-xl border border-border/60 bg-background/80 text-muted-foreground"><History className="size-4" /></span>
                <p className="text-xs font-medium text-foreground">还没有创作记录</p>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">从一个想法开始，<br />你的创作会保存在这里。</p>
              </div>
            ) : (
              <>
              {visibleConversations.length === 0 ? <div className="px-2 py-5 text-center text-xs leading-6 text-muted-foreground">没有匹配的会话<Button variant="link" size="sm" className="mx-auto mt-1 flex text-xs" onClick={() => setQuery("")}>清除搜索</Button></div> : null}
              {visibleConversations.map((conversation) => {
                const active = conversation.id === selectedConversationId;
                const stats = getImageConversationStats(conversation);
                const turnCount = isImageConversationHistorySummaryOnly(conversation)
                  ? conversation.historySummary?.turnCount || 0
                  : conversation.turns.length;
                const activityLabel = [
                  stats.running > 0 ? `处理中 ${stats.running}` : "",
                  stats.queued > 0 ? `排队 ${stats.queued}` : "",
                ].filter(Boolean).join(" · ");
                return (
                  <div key={conversation.id} className="group relative w-full">
                    <button
                      type="button"
                      onClick={() => onSelectConversation(conversation.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "block w-full cursor-pointer rounded-xl border text-left transition-[border-color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        hideActionButtons ? "px-4 py-3.5" : "px-3 py-2 pr-10 sm:py-3",
                        batch.selecting && (hideActionButtons ? "pl-11" : "pl-10"),
                        active
                          ? "border-brand-border/70 bg-brand-soft text-foreground shadow-xs"
                          : "border-transparent bg-transparent text-foreground hover:border-border/60 hover:bg-card/80",
                      )}
                    >
                      <div className={cn("truncate font-medium", hideActionButtons ? "text-base" : "text-[13px]", active && "text-brand")}>
                        <span className="truncate">{conversation.title}</span>
                      </div>
                      <div className="mt-1.5 flex h-5 min-w-0 items-center gap-2 text-[11px] leading-4 text-muted-foreground">
                        <span className="shrink-0">{turnCount} 轮</span>
                        {activityLabel ? (
                          <span
                            className={cn(
                              "inline-flex h-5 min-w-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold tabular-nums",
                              stats.running > 0
                                ? "bg-blue-600 text-white dark:bg-blue-400 dark:text-slate-950"
                                : "bg-amber-100 text-amber-900 dark:bg-amber-400/20 dark:text-amber-200",
                            )}
                            title={`${activityLabel} · ${formatConversationTime(conversation.updatedAt)}`}
                          >
                            {stats.running > 0 ? <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" /> : <Clock3 aria-hidden="true" className="size-3 shrink-0" />}
                            <span className="min-w-0 truncate">{activityLabel}</span>
                          </span>
                        ) : <span className="min-w-0 truncate tabular-nums">{formatConversationTime(conversation.updatedAt)}</span>}
                      </div>
                    </button>
                    {batch.selecting ? <Checkbox
                      aria-label={`选择会话：${conversation.title}`}
                      checked={batch.selected.has(conversation.id)}
                      disabled={batch.busy}
                      onCheckedChange={() => batch.toggle(conversation.id)}
                      className={cn("absolute top-3.5 z-10", hideActionButtons ? "left-4" : "left-3")}
                    /> : null}
                    {!hideActionButtons ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => void onDeleteConversation(conversation.id)}
                        className="absolute top-3 right-2 z-10 size-7 text-muted-foreground hover:text-destructive sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100"
                        aria-label="删除会话"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
              {hasMoreHistory ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-1 h-9 shrink-0 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  disabled={isLoadingMoreHistory}
                  onClick={() => void onLoadMore()}
                >
                  {isLoadingMoreHistory ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                  {isLoadingMoreHistory ? "正在加载" : "加载更多"}
                </Button>
              ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
}
