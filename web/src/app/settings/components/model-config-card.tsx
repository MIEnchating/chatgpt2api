"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  GripVertical,
  Image as ImageIcon,
  KeyRound,
  ListPlus,
  LoaderCircle,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Save,
  Settings2,
  Trash2,
  WandSparkles,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  fetchProfileRelayKey,
  fetchRelayModels,
  normalizeModelNames,
  relayModelOptionsFromList,
} from "@/lib/api";
import { getStoredRelayTokenName } from "@/lib/relay-token-selection";
import { cn } from "@/lib/utils";
import type { StoredAuthSession } from "@/store/auth";

import { useSettingsStore } from "../store";
import { SettingsCard, settingsDialogInputClassName } from "./settings-ui";

type ModelKind = "image" | "video";
type AddMode = "automatic" | "custom";

function normalizeTokenNames(values: unknown) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((name) => String(name || "").trim()).filter(Boolean)))
    : [];
}

function moveModel(models: string[], index: number, offset: -1 | 1) {
  const target = index + offset;
  if (target < 0 || target >= models.length) return models;
  const next = [...models];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function GlobalModelList({
  icon: Icon,
  kind,
  models,
  onChange,
  onAdd,
}: {
  icon: typeof ImageIcon;
  kind: ModelKind;
  models: string[];
  onChange: (models: string[]) => void;
  onAdd: () => void;
}) {
  const title = kind === "image" ? "图片生成模型" : "视频生成模型";
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function resetDragState() {
    setDraggedIndex(null);
    setDropIndex(null);
  }

  function handleDrop(index: number) {
    if (draggedIndex === null || draggedIndex === index) {
      resetDragState();
      return;
    }
    const next = [...models];
    const [moved] = next.splice(draggedIndex, 1);
    next.splice(index, 0, moved);
    onChange(next);
    resetDragState();
  }

  return (
    <section className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border/70">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground">全站可用，共 {models.length} 个</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={onAdd}>
          <Plus className="size-4" />
          添加
        </Button>
      </div>
      <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border/80 bg-background">
        {models.map((model, index) => {
          const isDragging = draggedIndex === index;
          const isDropTarget = dropIndex === index && draggedIndex !== index;
          return (
            <div
              key={model}
              draggable
              onDragStart={(event) => {
                setDraggedIndex(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", model);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropIndex(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(index);
              }}
              onDragEnd={resetDragState}
              aria-grabbed={isDragging}
              className={cn(
                "flex min-h-12 min-w-0 items-center gap-1.5 px-2 py-2 transition-colors sm:gap-2 sm:px-3",
                isDragging && "opacity-45",
                isDropTarget && "bg-primary/10",
              )}
            >
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/60 active:cursor-grabbing" aria-label="拖拽排序" />
              <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground">{index + 1}</span>
              <code className="min-w-0 flex-1 truncate text-xs text-foreground sm:text-sm" title={model}>{model}</code>
              {index === 0 ? <Badge className="shrink-0 rounded-md px-1.5 text-[11px]">全局默认</Badge> : null}
              <div className="flex shrink-0 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => onChange(moveModel(models, index, -1))}
                  disabled={index === 0}
                  aria-label={`上移 ${model}`}
                  title="上移"
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => onChange(moveModel(models, index, 1))}
                  disabled={index === models.length - 1}
                  aria-label={`下移 ${model}`}
                  title="下移"
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={() => onChange(models.filter((_, itemIndex) => itemIndex !== index))}
                  disabled={models.length === 1}
                  aria-label={`删除 ${model}`}
                  title={models.length === 1 ? "每类至少保留一个模型" : "删除"}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AddModelDialog({
  imageModels,
  onAdd,
  open,
  onOpenChange,
  session,
  videoModels,
  initialKind,
}: {
  imageModels: string[];
  onAdd: (kind: ModelKind, models: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: StoredAuthSession;
  videoModels: string[];
  initialKind: ModelKind;
}) {
  const [mode, setMode] = useState<AddMode>("automatic");
  const [kind, setKind] = useState<ModelKind>("image");
  const [tokenNames, setTokenNames] = useState<string[]>([]);
  const [selectedTokenName, setSelectedTokenName] = useState("");
  const [isLoadingKeys, setIsLoadingKeys] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [customModels, setCustomModels] = useState("");

  const configuredModels = kind === "image" ? imageModels : videoModels;
  const configuredSet = useMemo(() => new Set(configuredModels), [configuredModels]);
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return fetchedModels;
    return fetchedModels.filter((model) => model.toLowerCase().includes(query));
  }, [fetchedModels, search]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const preferredKind = initialKind;
    const preferredTokenName = getStoredRelayTokenName(session, preferredKind).trim();
    setMode("automatic");
    setKind(preferredKind);
    setSelectedTokenName(preferredTokenName);
    setFetchedModels([]);
    setSelectedModels(new Set());
    setSearch("");
    setCustomModels("");
    setIsLoadingKeys(true);
    void fetchProfileRelayKey(undefined, preferredTokenName)
      .then((status) => {
        if (controller.signal.aborted) return;
        const names = normalizeTokenNames(status.token_names);
        setTokenNames(names);
        const serviceSelection = String(status.token_name || "").trim();
        setSelectedTokenName(
          names.includes(preferredTokenName)
            ? preferredTokenName
            : names.includes(serviceSelection)
              ? serviceSelection
              : "",
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setTokenNames([]);
        toast.error(error instanceof Error ? error.message : "读取 Key 列表失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingKeys(false);
      });
    return () => controller.abort();
  }, [initialKind, open, session]);

  function selectTokenName(value: string) {
    setSelectedTokenName(value);
    setFetchedModels([]);
    setSelectedModels(new Set());
    setSearch("");
  }

  function selectModelKind(value: ModelKind) {
    setKind(value);
    const preferredTokenName = getStoredRelayTokenName(session, value).trim();
    setSelectedTokenName(tokenNames.includes(preferredTokenName) ? preferredTokenName : "");
    setFetchedModels([]);
    setSelectedModels(new Set());
    setSearch("");
  }

  async function loadModels() {
    if (!selectedTokenName) {
      toast.error("请先选择用于获取模型的 Key");
      return;
    }
    setIsLoadingModels(true);
    try {
      const response = await fetchRelayModels({ tokenName: selectedTokenName });
      const models = relayModelOptionsFromList(response.data).map((option) => option.value);
      setFetchedModels(models);
      setSelectedModels(new Set());
      setSearch("");
      if (models.length === 0) toast.info("该 Key 没有返回可用模型");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "获取模型失败");
    } finally {
      setIsLoadingModels(false);
    }
  }

  function toggleFetchedModel(model: string) {
    if (configuredSet.has(model)) return;
    setSelectedModels((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  }

  function submitModels() {
    const candidates = mode === "automatic"
      ? Array.from(selectedModels)
      : normalizeModelNames(customModels, []);
    const additions = candidates.filter((model) => !configuredSet.has(model));
    if (additions.length === 0) {
      toast.error(mode === "automatic" ? "请选择尚未添加的模型" : "请输入尚未添加的模型 ID");
      return;
    }
    onAdd(kind, additions);
    onOpenChange(false);
    toast.success(`已加入 ${additions.length} 个全局模型，保存配置后生效`);
  }

  const canSubmit = mode === "automatic"
    ? selectedModels.size > 0
    : normalizeModelNames(customModels, []).some((model) => !configuredSet.has(model));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-[calc(100vw-2rem)] gap-5 overflow-x-hidden sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ListPlus className="size-5 text-primary" />添加全局模型</DialogTitle>
          <DialogDescription>添加后的模型会在创作台、无限画布和任务接口中统一可用。</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="添加方式">
          <Button
            type="button"
            variant={mode === "automatic" ? "outline" : "ghost"}
            className={cn("shadow-none", mode === "automatic" && "bg-background")}
            onClick={() => setMode("automatic")}
          >
            <WandSparkles className="size-4" />自动获取
          </Button>
          <Button
            type="button"
            variant={mode === "custom" ? "outline" : "ghost"}
            className={cn("shadow-none", mode === "custom" && "bg-background")}
            onClick={() => setMode("custom")}
          >
            <PencilLine className="size-4" />自定义
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium">
            模型类型
            <Select
              value={kind}
              onValueChange={(value) => selectModelKind(value as ModelKind)}
              disabled={isLoadingKeys}
            >
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="image"><span className="flex items-center gap-2"><ImageIcon className="size-4" />图片生成模型</span></SelectItem>
                <SelectItem value="video"><span className="flex items-center gap-2"><Clapperboard className="size-4" />视频生成模型</span></SelectItem>
              </SelectContent>
            </Select>
          </label>

          {mode === "automatic" ? (
            <label className="grid gap-2 text-sm font-medium">
              用于获取模型的 Key
              <Select value={selectedTokenName || undefined} onValueChange={selectTokenName} disabled={isLoadingKeys || tokenNames.length === 0}>
                <SelectTrigger className="h-11">
                  {isLoadingKeys ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4 text-muted-foreground" />}
                  <SelectValue placeholder={isLoadingKeys ? "正在读取 Key" : tokenNames.length ? "选择 Key" : "暂无可用 Key"} />
                </SelectTrigger>
                <SelectContent>
                  {tokenNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          ) : (
            <div className="hidden sm:block" />
          )}
        </div>

        {mode === "automatic" ? (
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              <span>默认使用个人中心的{kind === "image" ? "图片" : "视频"} Key；在此切换不会修改个人中心。</span>
              <Button type="button" size="sm" onClick={() => void loadModels()} disabled={!selectedTokenName || isLoadingModels}>
                {isLoadingModels ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                获取模型
              </Button>
            </div>

            {fetchedModels.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-border/80">
                <div className="relative border-b border-border/70 bg-muted/25 p-2.5">
                  <Search className="pointer-events-none absolute left-5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选模型" className="h-9 bg-background pl-9" />
                </div>
                <ScrollArea className="h-[min(34vh,260px)]">
                  <div className="divide-y divide-border/60 p-1">
                    {filteredModels.map((model) => {
                      const configured = configuredSet.has(model);
                      const checked = configured || selectedModels.has(model);
                      return (
                        <label key={model} className={cn("flex min-h-10 items-center gap-3 rounded-md px-2.5 py-2 text-sm", configured ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer hover:bg-muted/60")}>
                          <Checkbox checked={checked} disabled={configured} onCheckedChange={() => toggleFetchedModel(model)} />
                          <code className="min-w-0 flex-1 truncate" title={model}>{model}</code>
                          {configured ? <span className="shrink-0 text-xs">已添加</span> : null}
                        </label>
                      );
                    })}
                    {filteredModels.length === 0 ? <div className="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的模型</div> : null}
                  </div>
                </ScrollArea>
              </div>
            ) : (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center">
                <WandSparkles className="size-6 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">选择 Key 后点击“获取模型”</p>
              </div>
            )}
          </div>
        ) : (
          <label className="grid gap-2 text-sm font-medium">
            模型 ID
            <Input
              autoFocus
              value={customModels}
              onChange={(event) => setCustomModels(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) {
                  event.preventDefault();
                  submitModels();
                }
              }}
              placeholder={kind === "image" ? "例如：gpt-image-2" : "例如：sora-2"}
              className={settingsDialogInputClassName}
            />
            <span className="font-normal text-muted-foreground">可输入一个或多个模型 ID，多个模型使用英文逗号分隔。</span>
          </label>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" onClick={submitModels} disabled={!canSubmit}>
            <Plus className="size-4" />
            {mode === "automatic" ? `添加已选模型${selectedModels.size ? ` (${selectedModels.size})` : ""}` : "添加模型"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ModelConfigCard({ session }: { session: StoredAuthSession }) {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const setImageModels = useSettingsStore((state) => state.setImageModels);
  const setVideoModels = useSettingsStore((state) => state.setVideoModels);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogKind, setAddDialogKind] = useState<ModelKind>("image");

  const imageModels = normalizeModelNames(config?.image_models, []);
  const videoModels = normalizeModelNames(config?.video_models, []);

  if (isLoadingConfig || !config) {
    return (
      <SettingsCard icon={Settings2} title="全局模型配置" description="配置全站统一使用的图片与视频生成模型。">
        <div className="flex items-center justify-center py-10"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
      </SettingsCard>
    );
  }

  function updateModels(kind: ModelKind, models: string[]) {
    const normalized = normalizeModelNames(models, []);
    if (normalized.length === 0) return;
    if (kind === "image") setImageModels(normalized.join(", "));
    else setVideoModels(normalized.join(", "));
  }

  function addModels(kind: ModelKind, additions: string[]) {
    const current = kind === "image" ? imageModels : videoModels;
    updateModels(kind, [...current, ...additions]);
  }

  function openAddDialog(kind: ModelKind) {
    setAddDialogKind(kind);
    setAddDialogOpen(true);
  }

  return (
    <>
      <SettingsCard
        icon={Settings2}
        title="全局模型配置"
        description="图片与视频模型在全站统一生效。"
        action={
          <Button type="button" size="sm" onClick={() => void saveConfig()} disabled={isSavingConfig}>
            {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存模型配置
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid min-w-0 gap-4">
            <GlobalModelList
              icon={ImageIcon}
              kind="image"
              models={imageModels}
              onChange={(models) => updateModels("image", models)}
              onAdd={() => openAddDialog("image")}
            />
            <GlobalModelList
              icon={Clapperboard}
              kind="video"
              models={videoModels}
              onChange={(models) => updateModels("video", models)}
              onAdd={() => openAddDialog("video")}
            />
          </div>
        </div>
      </SettingsCard>
      <AddModelDialog
        imageModels={imageModels}
        videoModels={videoModels}
        onAdd={addModels}
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        session={session}
        initialKind={addDialogKind}
      />
    </>
  );
}
