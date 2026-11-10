"use client";

import { LoadingState } from "@/components/ui/loading-state";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";

import { Card } from "@/components/ui/card";

import { Item } from "@/components/ui/item";

import { useCallback, useEffect, useRef, useState } from "react";
import { Edit3, Megaphone, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  createAnnouncement,
  deleteAnnouncement,
  fetchAdminAnnouncements,
  updateAnnouncement,
  type Announcement,
  type AnnouncementInput,
} from "@/lib/api";
import { dispatchAnnouncementsUpdated } from "@/lib/announcement-events";
import {
  mergeScopedMutationItem,
  ScopedMutationLifecycle,
  type ScopedMutationDecision,
  type ScopedMutationToken,
} from "@/lib/scoped-mutation-lifecycle";

import { SettingsEmptyState } from "./settings-ui";
import { SettingsPanel } from "@/components/settings-panel";

const emptyForm: AnnouncementInput = {
  title: "",
  content: "",
  enabled: true,
};

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function AnnouncementsCard({ sessionKey }: { sessionKey: string }) {
  const mountedRef = useRef(false);
  const currentSessionKeyRef = useRef(sessionKey);
  const itemsRef = useRef<Announcement[]>([]);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadVersionRef = useRef(0);
  const loadResetRef = useRef(false);
  const mutationLifecycleRef = useRef<ScopedMutationLifecycle | null>(null);
  currentSessionKeyRef.current = sessionKey;
  if (!mutationLifecycleRef.current) {
    mutationLifecycleRef.current = new ScopedMutationLifecycle(sessionKey);
  } else {
    mutationLifecycleRef.current.activateSession(sessionKey);
  }
  const [items, setItems] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Announcement | null>(null);
  const [deletingItem, setDeletingItem] = useState<Announcement | null>(null);
  const [form, setForm] = useState<AnnouncementInput>(emptyForm);

  const isCurrentSession = useCallback((targetSessionKey: string) => (
    mountedRef.current && currentSessionKeyRef.current === targetSessionKey
  ), []);

  const commitItems = useCallback((
    targetSessionKey: string,
    value: Announcement[] | ((current: Announcement[]) => Announcement[]),
  ) => {
    if (!isCurrentSession(targetSessionKey)) return false;
    const next = typeof value === "function" ? value(itemsRef.current) : value;
    itemsRef.current = next;
    setItems(next);
    return true;
  }, [isCurrentSession]);

  const loadAnnouncements = useCallback(async (targetSessionKey: string, reset: boolean) => {
    const controller = new AbortController();
    const requestVersion = loadVersionRef.current + 1;
    loadVersionRef.current = requestVersion;
    loadControllerRef.current?.abort();
    loadControllerRef.current = controller;
    loadResetRef.current = reset;
    if (reset && isCurrentSession(targetSessionKey)) {
      itemsRef.current = [];
      setItems([]);
      setIsLoading(true);
    }
    try {
      const data = await fetchAdminAnnouncements({ signal: controller.signal });
      if (controller.signal.aborted || loadVersionRef.current !== requestVersion) return;
      commitItems(targetSessionKey, data.items);
    } catch (error) {
      if (controller.signal.aborted || loadVersionRef.current !== requestVersion || !isCurrentSession(targetSessionKey)) return;
      toast.error(error instanceof Error ? error.message : "加载公告失败");
    } finally {
      if (loadVersionRef.current === requestVersion) {
        loadControllerRef.current = null;
        loadResetRef.current = false;
        if (isCurrentSession(targetSessionKey)) setIsLoading(false);
      }
    }
  }, [commitItems, isCurrentSession]);

  useEffect(() => {
    mountedRef.current = true;
    mutationLifecycleRef.current?.activateSession(sessionKey);
    void loadAnnouncements(sessionKey, true);
    return () => {
      mountedRef.current = false;
      mutationLifecycleRef.current?.deactivateSession(sessionKey);
      loadVersionRef.current += 1;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      loadResetRef.current = false;
    };
  }, [loadAnnouncements, sessionKey]);

  const beginMutation = (scope: string) => {
    const interruptedResetLoad = loadResetRef.current;
    loadVersionRef.current += 1;
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    loadResetRef.current = false;
    if (interruptedResetLoad) setIsLoading(false);
    return mutationLifecycleRef.current!.begin(scope);
  };

  const reconcileMutation = (
    token: ScopedMutationToken,
    decision: ScopedMutationDecision,
  ) => {
    if (decision.reconcile) void loadAnnouncements(token.sessionKey, false);
  };

  const applyMutationResult = (
    token: ScopedMutationToken,
    responseItems: Announcement[],
    mergeConcurrent: (current: Announcement[]) => Announcement[],
  ) => {
    const decision = mutationLifecycleRef.current!.complete(token, true);
    if (decision.current && decision.applySnapshot) {
      commitItems(token.sessionKey, decision.concurrent ? mergeConcurrent : responseItems);
    }
    reconcileMutation(token, decision);
    return decision.current;
  };

  const rejectMutation = (token: ScopedMutationToken) => {
    const decision = mutationLifecycleRef.current!.complete(token, false);
    reconcileMutation(token, decision);
    return decision.current;
  };

  const setPending = (id: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const openCreate = () => {
    setEditingItem(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (item: Announcement) => {
    setEditingItem(item);
    setForm({ title: item.title, content: item.content, enabled: item.enabled });
    setDialogOpen(true);
  };

  const save = async () => {
    const payload: AnnouncementInput = {
      title: form.title.trim(),
      content: form.content.trim(),
      enabled: form.enabled,
    };
    if (!payload.content) {
      toast.error("请输入公告内容");
      return;
    }
    if (Array.from(payload.title).length > 80) {
      toast.error("公告标题不能超过 80 个字符");
      return;
    }
    if (Array.from(payload.content).length > 2000) {
      toast.error("公告内容不能超过 2000 个字符");
      return;
    }

    const item = editingItem;
    const token = beginMutation(item?.id || "create");
    let current = true;
    setIsSaving(true);
    try {
      const data = item
        ? await updateAnnouncement(item.id, payload)
        : await createAnnouncement(payload);
      current = applyMutationResult(token, data.items, (items) => mergeScopedMutationItem(items, data.item, data.items));
      if (!current) return;
      setDialogOpen(false);
      setEditingItem(null);
      setForm(emptyForm);
      dispatchAnnouncementsUpdated();
      toast.success(item ? "公告已更新" : "公告已发布");
    } catch (error) {
      current = rejectMutation(token);
      if (current) toast.error(error instanceof Error ? error.message : "保存公告失败");
    } finally {
      if (current) setIsSaving(false);
    }
  };

  const toggleEnabled = async (item: Announcement) => {
    const token = beginMutation(item.id);
    let current = true;
    setPending(item.id, true);
    try {
      const data = await updateAnnouncement(item.id, { enabled: !item.enabled });
      current = applyMutationResult(token, data.items, (items) => mergeScopedMutationItem(items, data.item, data.items));
      if (!current) return;
      dispatchAnnouncementsUpdated();
      toast.success(item.enabled ? "公告已停用" : "公告已启用");
    } catch (error) {
      current = rejectMutation(token);
      if (current) toast.error(error instanceof Error ? error.message : "更新公告失败");
    } finally {
      if (current) setPending(item.id, false);
    }
  };

  const remove = async () => {
    if (!deletingItem) {
      return;
    }
    const item = deletingItem;
    const token = beginMutation(item.id);
    let current = true;
    setPending(item.id, true);
    try {
      const data = await deleteAnnouncement(item.id);
      current = applyMutationResult(token, data.items, (items) => items.filter((candidate) => candidate.id !== item.id));
      if (!current) return;
      setDeletingItem(null);
      dispatchAnnouncementsUpdated();
      toast.success("公告已删除");
    } catch (error) {
      current = rejectMutation(token);
      if (current) toast.error(error instanceof Error ? error.message : "删除公告失败");
    } finally {
      if (current) setPending(item.id, false);
    }
  };

  return (
    <>
      <SettingsPanel
        title="公告发布"
        description="向所有已登录用户发布系统通知。"
        action={
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus  />
            添加公告
          </Button>
        }
      >
        {isLoading ? (
          <LoadingState className="h-auto" label="正在加载公告" />
        ) : items.length === 0 ? (
          <SettingsEmptyState
            icon={Megaphone}
            title="暂无公告"
            description="添加后会显示在所有已登录用户的导航下方。"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item) => {
              const pending = pendingIds.has(item.id);
              return (
                <Card key={item.id} className="p-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <TooltipHint content={item.enabled ? "停用公告" : "启用公告"}>
                      <span className="inline-flex shrink-0"><Checkbox
                        checked={item.enabled}
                        disabled={pending}
                        onCheckedChange={() => void toggleEnabled(item)}
                        aria-label={item.enabled ? "停用公告" : "启用公告"}
                        className="mt-0.5"
                      /></span>
                    </TooltipHint>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {item.title || "系统公告"}
                        </h3>
                        <Badge variant={item.enabled ? "default" : "secondary"} >
                          {item.enabled ? "展示中" : "已停用"}
                        </Badge>
                      </div>
                      <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                        {item.content}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground/75">
                        更新于 {formatDateTime(item.updated_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <TooltipHint content={"编辑公告"}><Button
                        type="button"
                        variant="ghost"
                        size="icon"

                        disabled={pending}
                        onClick={() => openEdit(item)}
                        aria-label="编辑公告"
                      >
                        <Edit3  />
                      </Button></TooltipHint>
                      <TooltipHint content={"删除公告"}><Button
                        type="button"
                        variant="ghost"
                        size="icon"

                        disabled={pending}
                        onClick={() => setDeletingItem(item)}
                        aria-label="删除公告"
                      >
                        <Trash2  />
                      </Button></TooltipHint>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </SettingsPanel>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingItem ? "编辑公告" : "添加公告"}</DialogTitle>
            <DialogDescription>公告将显示在所有已登录用户的导航下方。</DialogDescription>
          </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="announcement-title">标题</FieldLabel>
              <Input
                id="announcement-title"
                value={form.title}
                maxLength={80}
                placeholder="系统公告"

                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              />
              <FieldDescription>不填写时使用“系统公告”。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="announcement-content">公告内容</FieldLabel>
              <Textarea
                id="announcement-content"
                value={form.content}
                maxLength={2000}
                placeholder="输入需要通知用户的内容"
                onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))}
              />
              <FieldDescription className="text-right">
                {Array.from(form.content).length}/2000
              </FieldDescription>
            </Field>
            <Item variant="outline" asChild><Label className="flex min-h-11 items-center gap-3 px-3 py-2.5">
              <Checkbox
                checked={form.enabled}
                onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: Boolean(checked) }))}
              />
              保存后立即展示
            </Label></Item>
          </div>
          </ScrollArea><DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
              取消
            </Button>
            <Button type="button" onClick={() => void save()} disabled={isSaving}>
              {isSaving ? <Spinner /> : null}
              {editingItem ? "保存修改" : "发布公告"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deletingItem)}
        onOpenChange={(open) => (!open ? setDeletingItem(null) : undefined)}
        title="删除公告"
        description={<>删除“{deletingItem?.title || "系统公告"}”后，所有用户将立即停止看到这条公告。</>}
        confirmLabel="删除"
        busy={Boolean(deletingItem && pendingIds.has(deletingItem.id))}
        destructive
        onConfirm={() => void remove()}
      />
    </>
  );
}
