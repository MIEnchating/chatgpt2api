"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, CalendarClock, ChevronRight, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  fetchAnnouncementPreferences,
  fetchAnnouncements,
  updateAnnouncementPreferences,
  type Announcement,
  type AnnouncementPreferences,
} from "@/lib/api";
import { ANNOUNCEMENTS_UPDATED_EVENT } from "@/lib/announcement-events";
import { cn } from "@/lib/utils";

const emptyPreferences: AnnouncementPreferences = {
  seen_versions: [],
  permanent_versions: [],
  snoozed_dates: {},
};
const ANNOUNCEMENT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function announcementVersion(item: Announcement) {
  return `${item.id}:${item.updated_at}`;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function announcementTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AnnouncementCenter({ className }: { className?: string }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [preferences, setPreferences] = useState<AnnouncementPreferences>(emptyPreferences);
  const [isLoaded, setIsLoaded] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isAutomaticPrompt, setIsAutomaticPrompt] = useState(false);
  const [selected, setSelected] = useState<Announcement | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const automaticPromptHandledRef = useRef(false);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const lastLoadedAtRef = useRef(0);

  const load = useCallback((force = false) => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    if (!force && Date.now() - lastLoadedAtRef.current < ANNOUNCEMENT_REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }
    const request = Promise.allSettled([
      fetchAnnouncements(),
      fetchAnnouncementPreferences(),
    ]).then(([announcementResult, preferenceResult]) => {
      if (announcementResult.status === "fulfilled") {
        setAnnouncements(Array.isArray(announcementResult.value.items) ? announcementResult.value.items : []);
      }
      if (preferenceResult.status === "fulfilled") {
        setPreferences(preferenceResult.value.preferences || emptyPreferences);
      }
      lastLoadedAtRef.current = Date.now();
      setIsLoaded(true);
    }).finally(() => {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null;
    });
    loadPromiseRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    void load(true);
    const handleAnnouncementsUpdated = () => void load(true);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener(ANNOUNCEMENTS_UPDATED_EVENT, handleAnnouncementsUpdated);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ANNOUNCEMENT_REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener(ANNOUNCEMENTS_UPDATED_EVENT, handleAnnouncementsUpdated);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(refreshTimer);
    };
  }, [load]);

  const seenVersions = useMemo(() => new Set(preferences.seen_versions || []), [preferences.seen_versions]);
  const permanentVersions = useMemo(
    () => new Set(preferences.permanent_versions || []),
    [preferences.permanent_versions],
  );
  const unreadCount = announcements.filter((item) => !seenVersions.has(announcementVersion(item))).length;

  useEffect(() => {
    if (!isLoaded || automaticPromptHandledRef.current) {
      return;
    }
    automaticPromptHandledRef.current = true;
    const today = localDateKey();
    const candidate = announcements.find((item) => {
      const version = announcementVersion(item);
      return !permanentVersions.has(version) && preferences.snoozed_dates?.[version] !== today;
    });
    if (!candidate) {
      return;
    }
    setSelected(candidate);
    setIsAutomaticPrompt(true);
    setDialogOpen(true);
    const version = announcementVersion(candidate);
    if (!seenVersions.has(version)) {
      void updateAnnouncementPreferences(version, "seen")
        .then((data) => setPreferences(data.preferences))
        .catch(() => undefined);
    }
  }, [announcements, isLoaded, permanentVersions, preferences.snoozed_dates, seenVersions]);

  const openAnnouncement = (item: Announcement) => {
    setSelected(item);
    setIsAutomaticPrompt(false);
    setPopoverOpen(false);
    setDialogOpen(true);
    const version = announcementVersion(item);
    if (!seenVersions.has(version)) {
      void updateAnnouncementPreferences(version, "seen")
        .then((data) => setPreferences(data.preferences))
        .catch(() => undefined);
    }
  };

  const closeAutomaticPrompt = async (action: "today" | "forever") => {
    if (!selected || isUpdating) {
      return;
    }
    setIsUpdating(true);
    try {
      const data = await updateAnnouncementPreferences(
        announcementVersion(selected),
        action,
        action === "today" ? localDateKey() : "",
      );
      setPreferences(data.preferences);
      setIsAutomaticPrompt(false);
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存公告偏好失败");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      setDialogOpen(true);
      return;
    }
    if (isAutomaticPrompt) {
      void closeAutomaticPrompt("today");
      return;
    }
    setDialogOpen(false);
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("relative size-8 rounded-full", className)}
            aria-label={unreadCount > 0 ? `系统公告，${unreadCount} 条未读` : "系统公告"}
            title="系统公告"
          >
            <Bell className="size-4" />
            {unreadCount > 0 ? (
              <span className="absolute -top-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-semibold leading-4 text-white ring-2 ring-card">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-[min(calc(100vw-1.5rem),360px)] overflow-hidden rounded-2xl border-border bg-card p-0 shadow-[0_22px_60px_-30px_rgba(15,23,42,0.55)]"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm font-semibold text-foreground">系统公告</div>
            <div className="text-xs text-muted-foreground">{announcements.length} 条</div>
          </div>
          <ScrollArea className="max-h-[min(420px,65dvh)]">
            {!isLoaded ? (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在加载
              </div>
            ) : announcements.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无公告</div>
            ) : (
              announcements.map((item) => {
                const version = announcementVersion(item);
                const unread = !seenVersions.has(version);
                return (
                  <button
                    key={version}
                    type="button"
                    className="group flex w-full items-start gap-3 border-b border-border/70 px-4 py-3 text-left transition last:border-b-0 hover:bg-muted/55"
                    onClick={() => openAnnouncement(item)}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        unread ? "bg-[#1456f0]" : "bg-border",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3">
                        <span className={cn("truncate text-sm text-foreground", unread && "font-semibold")}>{item.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{announcementTime(item.updated_at)}</span>
                      </span>
                      <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{item.content}</span>
                    </span>
                    <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                  </button>
                );
              })
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="w-[min(92vw,520px)] rounded-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.title || "系统公告"}</DialogTitle>
            <DialogDescription>
              系统公告{selected?.updated_at ? ` · ${announcementTime(selected.updated_at)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[50dvh] whitespace-pre-wrap break-words pr-1 text-sm leading-7 text-foreground">
            {selected?.content || ""}
          </ScrollArea>
          <DialogFooter className="gap-2 sm:justify-end">
            {isAutomaticPrompt ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isUpdating}
                  onClick={() => void closeAutomaticPrompt("today")}
                >
                  <CalendarClock className="size-4" />
                  今日关闭
                </Button>
                <Button
                  type="button"
                  disabled={isUpdating}
                  onClick={() => void closeAutomaticPrompt("forever")}
                >
                  {isUpdating ? <LoaderCircle className="size-4 animate-spin" /> : <BellOff className="size-4" />}
                  永久关闭
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                关闭
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
