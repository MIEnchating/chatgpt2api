"use client";

import { LoaderCircle, MessageSquarePlus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  return (
    <aside className="h-full min-h-0 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-2 py-1 sm:gap-3 sm:py-2">
        {!hideActionButtons && (
          <div className="flex items-center gap-2">
            <Button className="h-10 flex-1 rounded-full" onClick={onCreateDraft}>
              <MessageSquarePlus className="size-4" />
              新建对话
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="清空会话记录"
              className="size-10 shrink-0 text-muted-foreground"
              onClick={() => void onClearHistory()}
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}

        <ScrollArea
          className="min-h-0 flex-1"
        >
          <div className={cn("flex min-h-full flex-col gap-2", hideActionButtons ? "pr-0" : "pr-1")}>
            {isLoadingHistory ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取会话记录
              </div>
            ) : conversations.length === 0 ? (
              <div className="px-2 py-3 text-sm leading-6 text-muted-foreground">还没有对话记录，输入提示词后会在这里显示。</div>
            ) : (
              <>
              {conversations.map((conversation) => {
                const active = conversation.id === selectedConversationId;
                const stats = getImageConversationStats(conversation);
                const turnCount = isImageConversationHistorySummaryOnly(conversation)
                  ? conversation.historySummary?.turnCount || 0
                  : conversation.turns.length;
                return (
                  <div
                    key={conversation.id}
                    className={cn(
                      "group relative w-full rounded-xl border text-left transition-colors focus-within:border-ring",
                      hideActionButtons ? "px-4 py-3.5" : "px-3 py-2 sm:py-3",
                      active
                        ? "border-border bg-card text-foreground shadow-[var(--shadow-card)]"
                        : "border-transparent text-muted-foreground hover:border-border hover:bg-card",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectConversation(conversation.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn("block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", hideActionButtons ? "pr-0" : "pr-8")}
                    >
                      <div className={cn("truncate font-semibold", hideActionButtons ? "text-base" : "text-sm")}>
                        <span className="truncate">{conversation.title}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {turnCount} 轮 · {formatConversationTime(conversation.updatedAt)}
                      </div>
                      {stats.running > 0 || stats.queued > 0 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                          {stats.running > 0 ? (
                            <Badge variant="info">处理中 {stats.running}</Badge>
                          ) : null}
                          {stats.queued > 0 ? (
                            <Badge variant="warning">排队 {stats.queued}</Badge>
                          ) : null}
                        </div>
                      ) : null}
                    </button>
                    {!hideActionButtons ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => void onDeleteConversation(conversation.id)}
                        className="absolute top-3 right-2 size-7 text-muted-foreground hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
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
