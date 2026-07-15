"use client";

import { useEffect, useRef, useState } from "react";
import { Edit3, LoaderCircle, Megaphone, Plus, Trash2 } from "lucide-react";
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
  SettingsCard,
  SettingsEmptyState,
  settingsDialogInputClassName,
  settingsListItemClassName,
} from "./settings-ui";

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

export function AnnouncementsCard() {
  const didLoadRef = useRef(false);
  const [items, setItems] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Announcement | null>(null);
  const [deletingItem, setDeletingItem] = useState<Announcement | null>(null);
  const [form, setForm] = useState<AnnouncementInput>(emptyForm);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    const load = async () => {
      try {
        const data = await fetchAdminAnnouncements();
        setItems(data.items);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "加载公告失败");
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

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

    setIsSaving(true);
    try {
      const data = editingItem
        ? await updateAnnouncement(editingItem.id, payload)
        : await createAnnouncement(payload);
      setItems(data.items);
      setDialogOpen(false);
      setEditingItem(null);
      setForm(emptyForm);
      dispatchAnnouncementsUpdated();
      toast.success(editingItem ? "公告已更新" : "公告已发布");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存公告失败");
    } finally {
      setIsSaving(false);
    }
  };

  const toggleEnabled = async (item: Announcement) => {
    setPending(item.id, true);
    try {
      const data = await updateAnnouncement(item.id, { enabled: !item.enabled });
      setItems(data.items);
      dispatchAnnouncementsUpdated();
      toast.success(item.enabled ? "公告已停用" : "公告已启用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新公告失败");
    } finally {
      setPending(item.id, false);
    }
  };

  const remove = async () => {
    if (!deletingItem) {
      return;
    }
    const item = deletingItem;
    setPending(item.id, true);
    try {
      const data = await deleteAnnouncement(item.id);
      setItems(data.items);
      setDeletingItem(null);
      dispatchAnnouncementsUpdated();
      toast.success("公告已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除公告失败");
    } finally {
      setPending(item.id, false);
    }
  };

  return (
    <>
      <SettingsCard
        icon={Megaphone}
        tone="amber"
        title="公告管理"
        description="向所有已登录用户发布系统通知。"
        action={
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            添加公告
          </Button>
        }
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
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
                <div key={item.id} className={settingsListItemClassName}>
                  <div className="flex min-w-0 items-start gap-3">
                    <Checkbox
                      checked={item.enabled}
                      disabled={pending}
                      onCheckedChange={() => void toggleEnabled(item)}
                      aria-label={item.enabled ? "停用公告" : "启用公告"}
                      title={item.enabled ? "停用公告" : "启用公告"}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {item.title || "系统公告"}
                        </h3>
                        <Badge variant={item.enabled ? "success" : "secondary"} className="rounded-md">
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        disabled={pending}
                        onClick={() => openEdit(item)}
                        aria-label="编辑公告"
                        title="编辑公告"
                      >
                        <Edit3 className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/30"
                        disabled={pending}
                        onClick={() => setDeletingItem(item)}
                        aria-label="删除公告"
                        title="删除公告"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsCard>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingItem ? "编辑公告" : "添加公告"}</DialogTitle>
            <DialogDescription>公告将显示在所有已登录用户的导航下方。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="announcement-title">标题</FieldLabel>
              <Input
                id="announcement-title"
                value={form.title}
                maxLength={80}
                placeholder="系统公告"
                className={settingsDialogInputClassName}
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
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm font-medium text-foreground">
              <Checkbox
                checked={form.enabled}
                onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: Boolean(checked) }))}
              />
              保存后立即展示
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
              取消
            </Button>
            <Button type="button" onClick={() => void save()} disabled={isSaving}>
              {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {editingItem ? "保存修改" : "发布公告"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingItem)} onOpenChange={(open) => (!open ? setDeletingItem(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除公告</DialogTitle>
            <DialogDescription>
              删除“{deletingItem?.title || "系统公告"}”后，所有用户将立即停止看到这条公告。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingItem(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void remove()}
              disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}
            >
              {deletingItem && pendingIds.has(deletingItem.id) ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
