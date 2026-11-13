"use client";

import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";

import { Download, History, X, SquarePen, Search, Trash2, Pin, PinOff, MoreHorizontal, Pencil, ListChecks } from "lucide-react";
import { useState } from "react";
import { useAppMeta } from "@/lib/use-app-meta";
import { resolveSiteIconSrc } from "@/lib/app-meta";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { TooltipButton } from "@/components/ui/tooltip";

import { useHistoryDownload } from "@/app/image/use-history-download";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import {
  getImageConversationStats,
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
  pinnedIds: string[];
  unreadIds: string[];
  onTogglePin: (id: string) => void;
  onRenameConversation: (id: string) => void;
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
  pinnedIds,
  unreadIds,
  onTogglePin,
  onRenameConversation,
  hideActionButtons = false,
}: ImageSidebarProps) {
  const appMeta = useAppMeta();
  const [searchOpen, setSearchOpen] = useState(false);
  const batch = useHistoryDownload(conversations);
  const [query, setQuery] = useState("");
  const pinOrder = new Map(pinnedIds.map((id, index) => [id, index]));
  const visibleConversations = conversations
    .filter((conversation) => conversation.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => (pinOrder.get(a.id) ?? Infinity) - (pinOrder.get(b.id) ?? Infinity));
  const selectedVisibleCount = visibleConversations.filter((conversation) => batch.selected.has(conversation.id)).length;
  const allVisibleSelected = visibleConversations.length > 0 && selectedVisibleCount === visibleConversations.length;
  return (
    <aside aria-label="创作会话" className="h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex min-h-12 items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
            <img src={resolveSiteIconSrc(appMeta.site_icon_url)} alt="" aria-hidden="true" className="size-8 shrink-0 object-contain" />
            <span className="min-w-0 truncate text-lg font-semibold">{appMeta.app_title}</span>
          </div>
          <TooltipButton tooltip="搜索会话" aria-label="搜索会话" aria-expanded={searchOpen} onClick={() => { setSearchOpen((open) => !open); setQuery(""); }}><Search className="size-5" /></TooltipButton>
        </div>
        {!hideActionButtons && (
          <div className="flex items-center gap-2 pb-1">
            <Button variant="ghost" className="h-10 flex-1 justify-start" onClick={onCreateDraft}>
              <SquarePen className="size-5" />
              新建对话
            </Button>
          </div>
        )}

        {searchOpen ? <SearchInput containerClassName="h-10" value={query} onValueChange={setQuery} placeholder="搜索已加载的会话" /> : null}
        {batch.selecting ? (
          <div role="toolbar" aria-label="会话批量操作" className="flex min-h-8 items-center gap-1 px-1">
            <Label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                aria-label="全选当前列表"
                checked={allVisibleSelected ? true : selectedVisibleCount > 0 ? "indeterminate" : false}
                disabled={batch.busy || visibleConversations.length === 0}
                onCheckedChange={() => batch.setSelected((current) => {
                  const next = new Set(current);
                  for (const conversation of visibleConversations) {
                    if (allVisibleSelected) next.delete(conversation.id);
                    else next.add(conversation.id);
                  }
                  return next;
                })}
              />
              {batch.busy ? <Spinner aria-label="正在打包" /> : null}
              <span aria-live="polite" className="truncate">{batch.busy ? "正在打包…" : `已选 ${batch.selected.size} 个会话`}</span>
            </Label>
            <TooltipButton tooltip="下载所选会话" aria-label="下载所选会话" disabled={batch.busy || batch.selected.size === 0} onClick={() => void batch.download()}><Download /></TooltipButton>
            <TooltipButton tooltip={batch.busy ? "取消下载" : "退出选择"} aria-label={batch.busy ? "取消下载" : "退出选择"} onClick={() => {
              if (batch.busy) { batch.cancel(); return; }
              batch.setSelecting(false);
              batch.setSelected(new Set());
            }}>
              <X />
            </TooltipButton>
          </div>
        ) : (
          <div className="flex min-h-8 items-center justify-between gap-2 px-1">
            <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>最近会话</span>
              <Badge variant="secondary" className="tabular-nums">{conversations.length}</Badge>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="会话管理" disabled={conversations.length === 0}><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right" className="w-40">
                <DropdownMenuItem onSelect={() => { batch.setSelecting(true); batch.setSelected(new Set()); }}><ListChecks />批量下载</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void onClearHistory()}><Trash2 />清空会话记录</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative -mx-3 flex min-h-0 min-w-0 w-[calc(100%+1.5rem)] flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0 pl-3">
          <div className="flex min-h-full flex-col gap-0.5">
            {isLoadingHistory ? (
              <LoadingState compact className="justify-start px-2 py-3" label="正在读取会话记录" />
            ) : conversations.length === 0 ? (
              <EmptyState compact icon={History} title="还没有创作记录" description="从一个想法开始，你的创作会保存在这里。" className="px-4 py-10" />
            ) : (
              <>
              {visibleConversations.length === 0 ? <EmptyState compact title="没有匹配的会话" className="min-h-0 px-2 py-5" action={<Button variant="link" size="sm" onClick={() => setQuery("")}>清除搜索</Button>} /> : null}
              {visibleConversations.map((conversation) => {
                const active = conversation.id === selectedConversationId;
                const stats = getImageConversationStats(conversation);
                const busy = stats.running + stats.queued > 0;
                const pinned = pinnedIds.includes(conversation.id);
                const unread = unreadIds.includes(conversation.id) && !active;
                return (
                  <div key={conversation.id} className="group relative w-full" data-conversation-id={conversation.id}>
                    <Button variant={(batch.selecting ? batch.selected.has(conversation.id) : active) ? "secondary" : "ghost"}
                      type="button"
                      onClick={() => { if (batch.selecting) batch.toggle(conversation.id); else onSelectConversation(conversation.id); }}
                      disabled={batch.busy}
                      aria-current={active ? "true" : undefined}
                      className={cn("h-11 w-full justify-start gap-2 px-3 text-left font-normal group-hover:pr-20 group-focus-within:pr-20 [@media(hover:none)]:pr-20", (busy || unread || pinned) && "pr-8", (busy || unread) && "group-hover:pr-24 group-focus-within:pr-24 [@media(hover:none)]:pr-24", pinned && (busy || unread) && "pr-14", batch.selecting && "pl-10")}
                    >
                      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                      <span className="absolute inset-y-0 right-3 flex items-center gap-2 group-hover:invisible group-focus-within:invisible [@media(hover:none)]:invisible">
                        {pinned ? <Pin aria-hidden="true" className="size-3.5" /> : null}
                      </span>
                    </Button>
                    {busy || unread ? <span className={cn("pointer-events-none absolute inset-y-0 right-3 flex items-center group-hover:right-[4.5rem] group-focus-within:right-[4.5rem] [@media(hover:none)]:right-[4.5rem]", pinned && "right-9")}>
                      {busy ? <Spinner aria-label="任务处理中" className="size-3.5 motion-reduce:animate-none" /> : <span role="status" aria-label="任务已完成，未查看" className="size-2 rounded-full bg-current" />}
                    </span> : null}
                    {batch.selecting ? <Checkbox
                      aria-label={`选择会话：${conversation.title}`}
                      checked={batch.selected.has(conversation.id)}
                      disabled={batch.busy}
                      onCheckedChange={() => batch.toggle(conversation.id)}
                      className="absolute top-1/2 left-3 z-10 -translate-y-1/2"
                    /> : (
                      <div className="absolute inset-y-0 right-1 flex items-center [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:pointer-events-auto [@media(hover:hover)]:group-focus-within:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100">
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`${pinned ? "取消置顶" : "置顶"}会话：${conversation.title}`} aria-pressed={pinned} onClick={() => onTogglePin(conversation.id)}>
                          {pinned ? <PinOff /> : <Pin />}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={`更多操作：${conversation.title}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="start" side="right" className="w-40">
                            <DropdownMenuItem onSelect={() => onRenameConversation(conversation.id)}><Pencil />重命名</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onTogglePin(conversation.id)}>{pinned ? <PinOff /> : <Pin />}{pinned ? "取消置顶" : "置顶"}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => void onDeleteConversation(conversation.id)}><Trash2 />删除</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                );
              })}
              {hasMoreHistory ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-1 shrink-0"
                  disabled={isLoadingMoreHistory}
                  onClick={() => void onLoadMore()}
                >
                  {isLoadingMoreHistory ? <Spinner /> : null}
                  {isLoadingMoreHistory ? "正在加载" : "加载更多"}
                </Button>
              ) : null}
              </>
            )}
          </div>
        </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
      </div>
    </aside>
  );
}
