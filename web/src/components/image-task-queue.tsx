"use client";

import { Spinner } from "@/components/ui/spinner";

import { RunStatus } from "@/components/ai-elements/run-status";
import { GenerationProgress } from "@/components/generation/generation-progress";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";

import { TooltipHint } from "@/components/ui/tooltip";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CheckCircle2, ClipboardList, Clock3 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatImageSizeDisplay, getImageSizeRequirementLabel, isHighResolutionImageSize } from "@/lib/image-options";
import { isWorkflowImageConversation } from "@/lib/image-conversation-source";
import { cn, formatElapsedClock } from "@/lib/utils";
import { useNow } from "@/lib/use-now";
import { canvasProjectPath } from "@/lib/canvas-project-route";
import {
  getCanvasTaskQueueSnapshot,
  subscribeCanvasTaskQueue,
  type CanvasTaskQueueItem,
} from "@/store/canvas-task-queue";
import {
  ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY,
  IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT,
  IMAGE_CONVERSATIONS_CHANGED_EVENT,
  deleteImageConversation,
  getEffectiveImageTurnStatus,
  getImageTurnLoadingCounts,
  loadImageConversationHistoryWindow,
  mergeImageConversationItems,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ImageTurnLoadingPhase,
  type ImageTurnStatus,
} from "@/store/image-conversations";
import {
  getImageTurnProgressSnapshot,
  imageTurnStartedAtTimestamp,
  imageTurnProgressKey,
  subscribeImageTurnProgress,
} from "@/store/image-turn-progress";

type TaskQueueItem = {
  conversationId: string;
  conversationTitle: string;
  turn: ImageTurn;
  totalCount: number;
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
};

type RecentQueueCompletion = TaskQueueItem & {
  key: string;
  completedAt: number;
  finalStatus: ImageTurnStatus;
};

const RECENT_COMPLETION_RETENTION_MS = 4500;

function isTurnBusy(turn: ImageTurn) {
  const status = getEffectiveImageTurnStatus(turn);
  return status === "queued" || status === "generating";
}

function isTerminalTurnStatus(status: ImageTurnStatus) {
  return status === "success" || status === "message" || status === "error" || status === "cancelled";
}

function formatQueueTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getModeLabel(mode: ImageConversationMode) {
  if (mode === "chat") {
    return "文本记录";
  }
  if (mode === "edit") {
    return "继续编辑";
  }
  if (mode === "image") {
    return "参考图";
  }
  if (mode === "video") {
    return "视频生成";
  }
  return "文生图";
}

function getStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  if (status === "message") {
    return "文本回复";
  }
  if (status === "cancelled") {
    return "已终止";
  }
  return "失败";
}

function getQueueSizeLabel(turn: ImageTurn) {
  if (turn.mode === "video") {
    const size = turn.size.includes("x") ? formatImageSizeDisplay(turn.size) : turn.size;
    return Array.from(new Set([size, turn.videoResolution].map((value) => String(value || "").trim()).filter(Boolean)))
      .join(" / ");
  }
  if (!turn.size) {
    return "";
  }
  const size = turn.size.includes("x") ? formatImageSizeDisplay(turn.size) : turn.size;
  const requirement = getImageSizeRequirementLabel(turn.size, turn.sizeSelection);
  return requirement === "自动" ? size : `${size} / ${requirement}`;
}

function getQueueLongTaskHint(turn: ImageTurn) {
  if (isHighResolutionImageSize(turn.size, turn.sizeSelection)) {
    return "高分辨率任务已提交，正在等待生成结果";
  }
  return "";
}

function getQueueLoadingDetail(item: TaskQueueItem, loadingPhase: ImageTurnLoadingPhase) {
  const unit = item.turn.mode === "video" ? "个视频" : "张图片";
  if (loadingPhase === "queued" && item.queuedCount > 0) {
    return `还有 ${item.queuedCount} ${unit}排队中`;
  }
  if (loadingPhase === "running" && item.runningCount > 0) {
    return `还有 ${item.runningCount} ${unit}处理中`;
  }
  return "";
}

function getQueueItem(conversation: ImageConversation, turn: ImageTurn): TaskQueueItem {
  const { queued: queuedCount, running: runningCount } = getImageTurnLoadingCounts(turn);
  const completedCount = turn.images.filter((image) => image.status === "success" || image.status === "message").length;
  const failedCount = turn.images.filter((image) => image.status === "error").length;
  const cancelledCount = turn.images.filter((image) => image.status === "cancelled").length;
  const totalCount = Math.max(1, turn.count || turn.images.length || 1);
  return {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    turn,
    totalCount,
    queuedCount,
    runningCount,
    completedCount,
    failedCount,
    cancelledCount,
  };
}

function getTaskQueueItems(conversations: ImageConversation[]) {
  const items = conversations.flatMap((conversation) =>
    conversation.turns.flatMap((turn) => {
      if (!isTurnBusy(turn)) {
        return [];
      }

      return [getQueueItem(conversation, turn)];
    }),
  );

  return items.sort((a, b) => a.turn.createdAt.localeCompare(b.turn.createdAt));
}

function findQueueItem(conversations: ImageConversation[], conversationId: string, turnId: string) {
  const conversation = conversations.find((item) => item.id === conversationId);
  const turn = conversation?.turns.find((item) => item.id === turnId);
  return conversation && turn ? getQueueItem(conversation, turn) : null;
}

function useImageConversationsForQueue() {
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const requestSequenceRef = useRef(0);
  const cleanupIDsRef = useRef(new Set<string>());

  useEffect(() => {
    let active = true;

    const loadConversations = async () => {
      const requestSequence = ++requestSequenceRef.current;
      try {
        const { firstPage, activePage } = await loadImageConversationHistoryWindow(24);
        if (!active || requestSequence !== requestSequenceRef.current) return;
        const sourceItems = [...firstPage.items, ...activePage.items];
        const items = mergeImageConversationItems(firstPage.items, activePage.items);
        setConversations(items);
        for (const conversation of sourceItems) {
          if (!isWorkflowImageConversation(conversation) || cleanupIDsRef.current.has(conversation.id)) continue;
          cleanupIDsRef.current.add(conversation.id);
          void deleteImageConversation(conversation.id)
            .catch(() => undefined)
            .finally(() => cleanupIDsRef.current.delete(conversation.id));
        }
      } catch {
        // Preserve the last successful snapshot when a background refresh fails.
      }
    };

    const handleRefresh = () => {
      void loadConversations();
    };

    void loadConversations();
    window.addEventListener("focus", handleRefresh);
    window.addEventListener(IMAGE_CONVERSATIONS_CHANGED_EVENT, handleRefresh);
    return () => {
      active = false;
      requestSequenceRef.current += 1;
      window.removeEventListener("focus", handleRefresh);
      window.removeEventListener(IMAGE_CONVERSATIONS_CHANGED_EVENT, handleRefresh);
    };
  }, []);

  return conversations;
}

function QueueItem({
  item,
  now,
  onOpenConversation,
}: {
  item: TaskQueueItem;
  now: number;
  onOpenConversation: (conversationId: string) => void;
}) {
  const progress = getImageTurnProgressSnapshot()[imageTurnProgressKey(item.conversationId, item.turn.id)];
  const settledCount = item.completedCount + item.failedCount + item.cancelledCount;
  const effectiveStatus = getEffectiveImageTurnStatus(item.turn);
  const loadingPhase: ImageTurnLoadingPhase =
    effectiveStatus === "generating" ? "running" : effectiveStatus === "queued" ? "queued" : "idle";
  const progressPercent =
    settledCount > 0
      ? Math.min(100, Math.round((settledCount / item.totalCount) * 100))
      : effectiveStatus === "generating"
        ? 8
        : 0;
  const isQueued = loadingPhase === "queued";
  const isRunning = loadingPhase === "running";
  const elapsedSeconds = isRunning ? Math.max(0, Math.floor((now - imageTurnStartedAtTimestamp(item.turn.processingStartedAt, item.turn.createdAt)) / 1000)) : 0;
  const elapsed = isRunning ? formatElapsedClock(elapsedSeconds) : "";
  const sizeLabel = getQueueSizeLabel(item.turn);
  const detailParts = [
    getModeLabel(item.turn.mode),
    item.turn.model,
    sizeLabel,
    item.turn.quality ? `Quality ${item.turn.quality}` : "",
  ].filter(Boolean);
  const progressMessage =
    isQueued
      ? "等待任务开始"
      : progress?.message || (item.turn.mode === "video" ? "等待视频处理" : "等待图片处理");
  const loadingDetail = getQueueLoadingDetail(item, loadingPhase);
  const progressDetail = loadingDetail || (isQueued ? "" : progress?.detail) || "";
  const longTaskHint = getQueueLongTaskHint(item.turn);

  return (
    <Button variant="outline"
      type="button"
      className="block h-auto w-full whitespace-normal p-0 text-left"
      onClick={() => onOpenConversation(item.conversationId)}
    >
      <RunStatus
        status={isQueued ? "waiting" : "running"}
        title={item.conversationTitle || item.turn.prompt || "未命名任务"}
        description={getStatusLabel(effectiveStatus)}
      />
      <div className="min-w-0 space-y-3 px-3 py-3">
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {item.turn.prompt || "无提示词内容"}
        </p>

        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{[...detailParts, `${item.completedCount + item.failedCount + item.cancelledCount}/${item.totalCount}`].join(" · ")}</span>
          {item.queuedCount > 0 ? (
            <Badge variant="secondary" className="shrink-0 font-mono tabular-nums">
              排队 {item.queuedCount}
            </Badge>
          ) : null}
          {item.runningCount > 0 ? (
            <Badge variant="secondary" className="shrink-0 font-mono tabular-nums">
              处理中 {item.runningCount}
            </Badge>
          ) : null}
        </div>

        <div className="space-y-2">
          <GenerationProgress progress={progressPercent} label={progressMessage} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{longTaskHint || progressDetail || formatQueueTime(item.turn.createdAt)}</span>
            {elapsed ? <span className="shrink-0 font-mono tabular-nums">已运行 {elapsed}</span> : null}
          </div>
        </div>
      </div>
    </Button>
  );
}

function CompletionItem({
  item,
  onOpenConversation,
}: {
  item: RecentQueueCompletion;
  onOpenConversation: (conversationId: string) => void;
}) {
  const completionMessage = item.finalStatus === "success" || item.finalStatus === "message" ? "任务已完成" : item.finalStatus === "cancelled" ? "任务已终止" : "任务失败";
  const settledCount = item.completedCount + item.failedCount + item.cancelledCount;
  const resultText =
    item.finalStatus === "success" || item.finalStatus === "message"
      ? `${settledCount}/${item.totalCount} 已完成`
      : item.turn.error || getStatusLabel(item.finalStatus);

  return (
    <Button variant="outline"
      type="button"
      className="block h-auto w-full whitespace-normal p-0 text-left"
      onClick={() => onOpenConversation(item.conversationId)}
    >
      <RunStatus
        status={item.finalStatus === "error" ? "error" : item.finalStatus === "cancelled" ? "cancelled" : "success"}
        title={item.conversationTitle || item.turn.prompt || "未命名任务"}
        description={getStatusLabel(item.finalStatus)}
      />
      <div className="min-w-0 space-y-3 px-3 py-3">
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {item.turn.prompt || "无提示词内容"}
        </p>
        <GenerationProgress progress={100} label={completionMessage} />
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{resultText}</p>
      </div>
    </Button>
  );
}

function CanvasQueueItem({ item, now, onOpenCanvas }: { item: CanvasTaskQueueItem; now: number; onOpenCanvas: (canvasID: string) => void }) {
  const terminal = item.status !== "generating";
  const successful = item.status === "success";
  const typeLabel = { video: "视频", audio: "音频", panorama: "全景图", text: "文本", image: "图片" }[item.type];
  const elapsed = formatElapsedClock(Math.max(0, Math.floor(((item.completedAt || now) - item.startedAt) / 1000)));
  const statusLabel = item.status === "generating" ? "处理中" : successful ? "已完成" : item.status === "cancelled" ? "已终止" : "失败";

  return (
    <Button variant="outline"
      type="button"
      className="block h-auto w-full whitespace-normal p-0 text-left"
      onClick={() => onOpenCanvas(item.canvasID)}
    >
      <RunStatus
        status={item.status === "generating" ? "running" : item.status}
        title={item.title || `${typeLabel}任务`}
        description={statusLabel}
      />
      <div className="min-w-0 space-y-3 px-3 py-3">
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{item.prompt || "无提示词内容"}</p>
        <p className="truncate text-[11px] text-muted-foreground">{["无限画布", typeLabel, item.model, `${item.completedCount + item.failedCount}/${item.totalCount}`].filter(Boolean).join(" · ")}</p>
        <div className="space-y-2">
          <GenerationProgress progress={item.progress} label="画布任务进度" />
          {item.error ? <p className="text-xs text-destructive [overflow-wrap:anywhere]">{item.error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{item.canvasTitle}</span>
            <span className="shrink-0 font-mono tabular-nums">{terminal ? "耗时" : "已运行"} {elapsed}</span>
          </div>
        </div>
      </div>
    </Button>
  );
}

export function ImageTaskQueue({ className, side }: { className?: string; side: "right" | "bottom" }) {
  const navigate = useNavigate();
  const conversations = useImageConversationsForQueue();
  const progressByTurnKey = useSyncExternalStore(
    subscribeImageTurnProgress,
    getImageTurnProgressSnapshot,
    getImageTurnProgressSnapshot,
  );
  const canvasTasks = useSyncExternalStore(subscribeCanvasTaskQueue, getCanvasTaskQueueSnapshot, getCanvasTaskQueueSnapshot);
  const queueItems = useMemo(() => getTaskQueueItems(conversations), [conversations]);
  const activeCanvasTasks = useMemo(() => canvasTasks.filter((item) => item.status === "generating"), [canvasTasks]);
  const completedCanvasTasks = useMemo(() => canvasTasks.filter((item) => item.status !== "generating"), [canvasTasks]);
  const activeCount = queueItems.length + activeCanvasTasks.length;
  const hasRunningTasks = activeCanvasTasks.length > 0 || queueItems.some((item) => getEffectiveImageTurnStatus(item.turn) === "generating");
  const [recentCompletions, setRecentCompletions] = useState<RecentQueueCompletion[]>([]);
  const [open, setOpen] = useState(false);
  const previousQueueItemsRef = useRef<Map<string, TaskQueueItem>>(new Map());
  const hasRecentCompletion = recentCompletions.length > 0 || completedCanvasTasks.length > 0;

  useEffect(() => {
    const currentItems = new Map(queueItems.map((item) => [`${item.conversationId}:${item.turn.id}`, item]));
    const completedItems: RecentQueueCompletion[] = [];

    previousQueueItemsRef.current.forEach((previousItem, key) => {
      if (currentItems.has(key)) {
        return;
      }

      const completedItem = findQueueItem(conversations, previousItem.conversationId, previousItem.turn.id);
      if (!completedItem) {
        return;
      }
      const finalStatus = getEffectiveImageTurnStatus(completedItem.turn);
      if (isTurnBusy(completedItem.turn) || !isTerminalTurnStatus(finalStatus)) {
        return;
      }

      completedItems.push({
        ...completedItem,
        key,
        completedAt: Date.now(),
        finalStatus,
      });
    });

    previousQueueItemsRef.current = currentItems;
    if (completedItems.length > 0) {
      setRecentCompletions((current) => [...completedItems, ...current].slice(0, 3));
    }
  }, [conversations, queueItems]);

  useEffect(() => {
    if (recentCompletions.length === 0) {
      return;
    }

    const nextExpiration = Math.min(
      ...recentCompletions.map((item) => item.completedAt + RECENT_COMPLETION_RETENTION_MS),
    );
    const timer = window.setTimeout(() => {
      const cutoff = Date.now() - RECENT_COMPLETION_RETENTION_MS;
      setRecentCompletions((current) => current.filter((item) => item.completedAt > cutoff));
    }, Math.max(0, nextExpiration - Date.now()));
    return () => {
      window.clearTimeout(timer);
    };
  }, [recentCompletions]);

  const now = useNow(open || activeCount > 0 || Object.keys(progressByTurnKey).length > 0 || hasRecentCompletion);

  const handleOpenConversation = (conversationId: string) => {
    try {
      window.localStorage.setItem(ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY, conversationId);
    } catch {
      // Navigation and the active-conversation event still work without browser storage.
    }
    window.dispatchEvent(
      new CustomEvent(IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT, {
        detail: { conversationId },
      }),
    );
    setOpen(false);
    navigate("/studio");
  };

  const handleOpenCanvas = (canvasID: string) => {
    setOpen(false);
    navigate(canvasProjectPath(canvasID));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipHint content={"任务队列"}><span className="inline-flex shrink-0"><PopoverTrigger asChild><Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn("relative", className)}
          aria-label={activeCount > 0 ? `查看 ${activeCount} 个排队或处理中任务` : hasRecentCompletion ? "查看刚结束的任务" : "查看任务队列"}
        >
          {activeCount > 0 ? (
            hasRunningTasks ? <Spinner className="size-5" /> : <Clock3 className="size-5" />
          ) : (
            <ClipboardList className="size-5" />
          )}
          {activeCount > 0 ? (
            <Badge variant="default" className="absolute -top-1 -right-1 inline-flex min-w-4 items-center justify-center">
              {activeCount}
            </Badge>
          ) : null}
        </Button></PopoverTrigger></span></TooltipHint>
      <PopoverContent side={side} align="end" sideOffset={8} collisionPadding={8} className="max-h-[var(--radix-popover-content-available-height)] w-[min(calc(100vw-2rem),420px)] overflow-hidden">
        <Item size="sm" className="shrink-0">
          <ItemMedia variant="icon"><ClipboardList /></ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>任务队列</ItemTitle>
            <ItemDescription>
              {activeCount > 0
                ? `${activeCount} 个任务正在排队或处理`
                : hasRecentCompletion
                  ? "最近结束的任务"
                  : "查看任务状态与处理进度"}
            </ItemDescription>
          </ItemContent>
        </Item>

        {queueItems.length > 0 || recentCompletions.length > 0 || canvasTasks.length > 0 ? (
          <ScrollArea aria-live="polite" className="max-h-[min(68dvh,520px)] flex-1" contentClassName="flex flex-col gap-2 py-1" onWheel={(event) => { event.stopPropagation(); }}>
            {queueItems.map((item) => (
              <QueueItem
                key={`${item.conversationId}:${item.turn.id}`}
                item={item}
                now={now}
                onOpenConversation={handleOpenConversation}
              />
            ))}
            {activeCanvasTasks.map((item) => <CanvasQueueItem key={item.id} item={item} now={now} onOpenCanvas={handleOpenCanvas} />)}
            {recentCompletions.map((item) => (
              <CompletionItem
                key={`${item.key}:${item.completedAt}`}
                item={item}
                onOpenConversation={handleOpenConversation}
              />
            ))}
            {completedCanvasTasks.map((item) => <CanvasQueueItem key={item.id} item={item} now={now} onOpenCanvas={handleOpenCanvas} />)}
          </ScrollArea>
        ) : (
          <EmptyState compact icon={CheckCircle2} title="暂无处理中的任务" description="新任务开始后，状态与进度会显示在这里" />
        )}
      </PopoverContent>
    </Popover>
  );
}
