"use client";

import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { ExternalLink, Eye, Pencil, Plus, RefreshCcw, Save, Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { normalizePromptMarketSources, type PromptMarketSourceConfig } from "@/app/image/banana-prompts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";


import { useSettingsStore } from "../store";
import { SettingsPanel } from "@/components/settings-panel";
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
      <SettingsPanel
        title="提示词来源"
        description="管理提示词库的数据来源，并按需检查远端内容。"
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={openNewSource}>
              <Plus  />
              新增来源
            </Button>
            <Button type="button" size="sm" onClick={() => void saveConfig()} disabled={isSavingConfig}>
              {isSavingConfig ? <Spinner /> : <Save  />}
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
              <Card key={source.id} className="p-3 sm:p-4">
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
                  <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                    <Switch checked={source.enabled} aria-label={`启用${source.label}`} onCheckedChange={(enabled) => updateSource(source.id, { enabled })} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{source.label || "未命名来源"}</p>
                        {source.builtin ? <Badge variant="secondary" className="shrink-0">内置</Badge> : null}
                      </div>
                      <TooltipHint content={displayURL}><a href={displayURL} target="_blank" rel="noreferrer" className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        <span className="truncate">{displayURL}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a></TooltipHint>
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground lg:max-w-[330px] lg:justify-end">
                    {typeof pullState.count === "number" ? <span className="shrink-0 tabular-nums">{pullState.count} 条</span> : null}
                    <TooltipHint content={pullState.error || (isPulling ? "拉取中" : pullState.status === "success" ? "正常" : pullState.status === "error" ? "失败" : "尚未拉取")}><Badge variant={isPulling ? "secondary" : pullState.status === "error" ? "destructive" : pullState.status === "success" ? "default" : "secondary"}
                      className="shrink-0"
                    >
                      {isPulling ? "检查中" : pullState.status === "success" ? "正常" : pullState.status === "error" ? "失败" : "尚未检查"}
                    </Badge></TooltipHint>
                    {pullState.lastSuccess ? <span className="shrink-0 tabular-nums">上次成功 {formatPullTime(pullState.lastSuccess)}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <Button type="button" variant="outline" size="sm" disabled={!source.enabled} onClick={() => setViewingSource(source)}>
                      <Eye  />
                      查看内容
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={!source.enabled || isPulling} onClick={() => void pullSource(source)}>
                      {isPulling ? <Spinner /> : <RefreshCcw  />}
                      立即检查
                    </Button>
                    {!source.builtin ? (
                      <TooltipHint content={"编辑来源"}><Button type="button" variant="ghost" size="icon"  aria-label={`编辑${source.label}`} onClick={() => openSourceEditor(source)}>
                        <Pencil  />
                      </Button></TooltipHint>
                    ) : null}
                    {!source.builtin ? (
                      <TooltipHint content={"删除来源"}><Button type="button" variant="ghost" size="icon"  aria-label={`删除${source.label}`} onClick={() => removeSource(source)}>
                        <Trash2  />
                      </Button></TooltipHint>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}

          <div className="mt-2 flex justify-end border-t border-border pt-4">
            <Button type="button" variant="outline" size="sm" disabled={isPullingAll || !sources.some((source) => source.enabled)} onClick={() => void pullAll()}>
              {isPullingAll ? <Spinner /> : <RefreshCcw  />}
              全部刷新
            </Button>
          </div>
        </div>
      </SettingsPanel>

      <PromptSourceContentDialog
        source={viewingSource}
        open={Boolean(viewingSource)}
        onOpenChange={(nextOpen) => { if (!nextOpen) setViewingSource(null); }}
        onPull={pullSource}
      />

      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-0 right-0 bottom-0 left-auto grid h-dvh max-h-none w-full max-w-[680px] translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-[680px]"
        ><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <div className="flex min-h-16 items-center gap-3 border-b border-border px-4 sm:px-6">
            <DialogClose className="flex shrink-0 items-center justify-center" aria-label="关闭">
              <X className="size-5" />
            </DialogClose>
            <DialogTitle className="min-w-0 flex-1 truncate">{editingID ? "编辑提示词来源" : "新增提示词来源"}</DialogTitle>
            <DialogDescription className="sr-only">配置提示词来源的名称、JSON 地址、主页和启用状态。</DialogDescription>
            <DialogClose asChild>
              <Button type="button" variant="outline">取消</Button>
            </DialogClose>
            <Button type="submit" form="prompt-source-form" disabled={isSavingConfig}>
              {isSavingConfig ? <Spinner /> : null}
              保存
            </Button>
          </div>

          <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0">
            <form id="prompt-source-form" onSubmit={submitSource} className="flex flex-col gap-6 px-4 py-6 sm:px-8">
              <div className="flex flex-col gap-5">
                <Field>
                  <FieldLabel htmlFor="prompt-source-name">来源名称</FieldLabel>
                  <Input id="prompt-source-name" value={draft.label} onChange={(event) => { setDraft((current) => ({ ...current, label: event.target.value })); setFormError(""); }} placeholder="用于分类展示"  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="prompt-source-url">JSON URL</FieldLabel>
                  <Input id="prompt-source-url" type="url" value={draft.url} onChange={(event) => { setDraft((current) => ({ ...current, url: event.target.value })); setFormError(""); }} placeholder="https://example.com/prompts.json"  />
                  <FieldDescription>地址需要允许浏览器跨域读取，并返回下方格式的 JSON 数组。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="prompt-source-homepage">来源主页（可选）</FieldLabel>
                  <Input id="prompt-source-homepage" type="url" value={draft.homepage} onChange={(event) => { setDraft((current) => ({ ...current, homepage: event.target.value })); setFormError(""); }} placeholder="https://example.com"  />
                </Field>
                <Label className="flex min-h-16 items-center justify-between gap-4 border-y border-border py-3 text-sm font-medium">
                  <span>启用来源</span>
                  <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
                </Label>
                {formError ? <FieldError>{formError}</FieldError> : null}
              </div>

              <Field>
                <FieldLabel>JSON 格式</FieldLabel>
                <Card className="overflow-hidden gap-0 p-0">
                  <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-80" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain" style={{maxHeight: 320}}><div className="min-w-0">
                    <CodeBlock><CodeBlockContent wrap>{PROMPT_SOURCE_EXAMPLE}</CodeBlockContent></CodeBlock>
                  </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
                </Card>
              </Field>
            </form>
          </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
        </ScrollArea></DialogContent>
      </Dialog>
    </>
  );
}
