"use client";

import { BookOpen, ExternalLink, Eye, LoaderCircle, Pencil, Plus, RefreshCcw, Save, Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { normalizePromptMarketSources, type PromptMarketSourceConfig } from "@/app/image/banana-prompts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SettingsCard, settingsDialogInputClassName, settingsListItemClassName } from "./settings-ui";
import { PromptSourceContentDialog } from "./prompt-source-content-dialog";
import { usePromptSourcePulls } from "./use-prompt-source-pulls";

type SourceDraft = {
  label: string;
  url: string;
  homepage: string;
  enabled: boolean;
};

const EMPTY_SOURCE_DRAFT: SourceDraft = {
  label: "",
  url: "",
  homepage: "",
  enabled: true,
};

const PROMPT_SOURCE_EXAMPLE = `[
  {
    "id": "product-photo-1",
    "title": "Product photo",
    "prompt": "Generate a professional product photo...",
    "description": "",
    "coverUrl": "",
    "referenceImageUrls": [],
    "tags": ["product", "photography"]
  }
]`;

function sourceID() {
  return `prompt-source-${Date.now().toString(36)}`;
}

function isHTTPURL(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatPullTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function PromptSourcesCard() {
  const config = useSettingsStore((state) => state.config);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const setPromptSources = useSettingsStore((state) => state.setPromptSources);
  const sources = useMemo(() => normalizePromptMarketSources(config?.prompt_sources), [config?.prompt_sources]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [draft, setDraft] = useState<SourceDraft>(EMPTY_SOURCE_DRAFT);
  const [formError, setFormError] = useState("");
  const [viewingSource, setViewingSource] = useState<PromptMarketSourceConfig | null>(null);
  const {
    states: pullStates,
    isPullingAll,
    pullSource,
    pullAll,
  } = usePromptSourcePulls(sources);

  const updateSource = (id: string, patch: Partial<PromptMarketSourceConfig>) => {
    setPromptSources(sources.map((source) => source.id === id ? { ...source, ...patch } : source));
  };

  const openNewSource = () => {
    setEditingID(null);
    setDraft(EMPTY_SOURCE_DRAFT);
    setFormError("");
    setDrawerOpen(true);
  };

  const openSourceEditor = (source: PromptMarketSourceConfig) => {
    if (source.builtin) return;
    setEditingID(source.id);
    setDraft({
      label: source.label,
      url: source.url,
      homepage: source.homepage || "",
      enabled: source.enabled,
    });
    setFormError("");
    setDrawerOpen(true);
  };

  const removeSource = (source: PromptMarketSourceConfig) => {
    if (source.builtin) {
      updateSource(source.id, { enabled: false });
      return;
    }
    setPromptSources(sources.filter((item) => item.id !== source.id));
  };

  const submitSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = draft.label.trim();
    const url = draft.url.trim();
    const homepage = draft.homepage.trim();
    if (!label) {
      setFormError("请输入来源名称");
      return;
    }
    if (!isHTTPURL(url)) {
      setFormError("请输入有效的 HTTP 或 HTTPS JSON URL");
      return;
    }
    if (homepage && !isHTTPURL(homepage)) {
      setFormError("请输入有效的 HTTP 或 HTTPS 来源主页");
      return;
    }

    const source: PromptMarketSourceConfig = {
      id: editingID || sourceID(),
      label,
      url,
      ...(homepage ? { homepage } : {}),
      format: "generic-json",
      enabled: draft.enabled,
    };
    const nextSources = editingID
      ? sources.map((item) => item.id === editingID ? source : item)
      : [...sources, source];
    setPromptSources(nextSources);
    setDrawerOpen(false);
    void saveConfig();
  };

  return (
    <>
      <SettingsCard
        icon={BookOpen}
        title="提示词来源"
        description="管理提示词库的数据来源，并按需检查远端内容。"
        tone="violet"
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={openNewSource}>
              <Plus className="size-4" />
              新增来源
            </Button>
            <Button type="button" size="sm" onClick={() => void saveConfig()} disabled={isSavingConfig}>
              {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存更改
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {sources.map((source) => {
            const displayURL = source.homepage || source.url;
            const pullState = pullStates[source.id] || { status: "idle" as const };
            const isPulling = pullState.status === "pulling";
            return (
              <div key={source.id} className={cn(settingsListItemClassName, "p-3 sm:p-4", !source.enabled && "bg-muted/20")}>
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
                  <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                    <Switch checked={source.enabled} aria-label={`启用${source.label}`} onCheckedChange={(enabled) => updateSource(source.id, { enabled })} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{source.label || "未命名来源"}</p>
                        {source.builtin ? <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">内置</span> : null}
                      </div>
                      <TooltipHint content={displayURL}><a href={displayURL} target="_blank" rel="noreferrer" className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        <span className="truncate">{displayURL}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a></TooltipHint>
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground lg:max-w-[330px] lg:justify-end">
                    {typeof pullState.count === "number" ? <span className="shrink-0 tabular-nums">{pullState.count} 条</span> : null}
                    <TooltipHint content={pullState.error || (isPulling ? "拉取中" : pullState.status === "success" ? "正常" : pullState.status === "error" ? "失败" : "尚未拉取")}><span
                      className={cn(
                        "shrink-0 rounded-md px-2 py-1 font-medium",
                        pullState.status === "success" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                        pullState.status === "error" && "bg-destructive/10 text-destructive",
                        (pullState.status === "idle" || isPulling) && "bg-muted text-muted-foreground",
                      )}
                    >
                      {isPulling ? "检查中" : pullState.status === "success" ? "正常" : pullState.status === "error" ? "失败" : "尚未检查"}
                    </span></TooltipHint>
                    {pullState.lastSuccess ? <span className="shrink-0 tabular-nums">上次成功 {formatPullTime(pullState.lastSuccess)}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <Button type="button" variant="outline" size="sm" disabled={!source.enabled} onClick={() => setViewingSource(source)}>
                      <Eye className="size-4" />
                      查看内容
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={!source.enabled || isPulling} onClick={() => void pullSource(source)}>
                      {isPulling ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
                      立即检查
                    </Button>
                    {!source.builtin ? (
                      <Button type="button" variant="ghost" size="icon" className="size-8" title="编辑来源" aria-label={`编辑${source.label}`} onClick={() => openSourceEditor(source)}>
                        <Pencil className="size-4" />
                      </Button>
                    ) : null}
                    {!source.builtin ? (
                      <Button type="button" variant="ghost" size="icon" className="size-8 text-rose-600" title="删除来源" aria-label={`删除${source.label}`} onClick={() => removeSource(source)}>
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="mt-2 flex justify-end border-t border-border pt-4">
            <Button type="button" variant="outline" size="sm" disabled={isPullingAll || !sources.some((source) => source.enabled)} onClick={() => void pullAll()}>
              {isPullingAll ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
              全部刷新
            </Button>
          </div>
        </div>
      </SettingsCard>

      <PromptSourceContentDialog
        source={viewingSource}
        open={Boolean(viewingSource)}
        onOpenChange={(nextOpen) => { if (!nextOpen) setViewingSource(null); }}
        onPull={pullSource}
      />

      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-0 right-0 bottom-0 left-auto grid h-dvh max-h-none w-full max-w-[680px] translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none border-y-0 border-r-0 bg-background p-0"
        >
          <div className="flex min-h-16 items-center gap-3 border-b border-border px-4 sm:px-6">
            <DialogClose className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="关闭">
              <X className="size-5" />
            </DialogClose>
            <DialogTitle className="min-w-0 flex-1 truncate text-lg">{editingID ? "编辑提示词来源" : "新增提示词来源"}</DialogTitle>
            <DialogDescription className="sr-only">配置提示词来源的名称、JSON 地址、主页和启用状态。</DialogDescription>
            <DialogClose asChild>
              <Button type="button" variant="outline">取消</Button>
            </DialogClose>
            <Button type="submit" form="prompt-source-form" disabled={isSavingConfig}>
              {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>

          <ScrollArea className="min-h-0" viewportClassName="overscroll-contain">
            <form id="prompt-source-form" onSubmit={submitSource} className="flex flex-col gap-6 px-4 py-6 sm:px-8">
              <div className="flex flex-col gap-5">
                <Field>
                  <FieldLabel htmlFor="prompt-source-name">来源名称</FieldLabel>
                  <Input id="prompt-source-name" value={draft.label} onChange={(event) => { setDraft((current) => ({ ...current, label: event.target.value })); setFormError(""); }} placeholder="用于分类展示" className={settingsDialogInputClassName} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="prompt-source-url">JSON URL</FieldLabel>
                  <Input id="prompt-source-url" type="url" value={draft.url} onChange={(event) => { setDraft((current) => ({ ...current, url: event.target.value })); setFormError(""); }} placeholder="https://example.com/prompts.json" className={settingsDialogInputClassName} />
                  <FieldDescription>地址需要允许浏览器跨域读取，并返回下方格式的 JSON 数组。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="prompt-source-homepage">来源主页（可选）</FieldLabel>
                  <Input id="prompt-source-homepage" type="url" value={draft.homepage} onChange={(event) => { setDraft((current) => ({ ...current, homepage: event.target.value })); setFormError(""); }} placeholder="https://example.com" className={settingsDialogInputClassName} />
                </Field>
                <label className="flex min-h-16 items-center justify-between gap-4 border-y border-border py-3 text-sm font-medium">
                  <span>启用来源</span>
                  <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
                </label>
                {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
              </div>

              <Field>
                <FieldLabel>JSON 格式</FieldLabel>
                <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
                  <ScrollArea maxHeight={320} className="max-h-80" viewportClassName="overscroll-contain" always>
                    <pre className="min-w-max p-4 font-mono text-xs leading-6 text-foreground">{PROMPT_SOURCE_EXAMPLE}</pre>
                  </ScrollArea>
                </div>
              </Field>
            </form>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
