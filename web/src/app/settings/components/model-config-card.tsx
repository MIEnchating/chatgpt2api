"use client";

import { LoadingState } from "@/components/ui/loading-state";

import { LabeledField } from "@/components/labeled-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Card } from "@/components/ui/card";
import { Item } from "@/components/ui/item";
import { SearchInput } from "@/components/ui/search-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useEffect, useMemo, useRef, useState } from "react";
import { SortableList, SortableItem, SortableHandle } from "@/components/sortable-list";
import { AudioLines, ArrowDown, ArrowUp, Clapperboard, Image as ImageIcon, ListPlus, PencilLine, Plus, RefreshCw, Save, Settings2, TextCursorInput, Trash2, WandSparkles } from "lucide-react";
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
import { MultiSelect } from "@/components/ui/multi-select";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  fetchCustomRelayConfigs,
  fetchModelConfig,
  fetchProfileRelayKey,
  fetchRelayModels,
  normalizeModelNames,
  relayModelOptionsFromList,
  type CustomRelayConfigStatus,
} from "@/lib/api";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";
import { relayTokenOptions } from "@/lib/relay-token-selection";
import { filterModelsByCapability, type ModelCapability } from "@/lib/model-capabilities";
import { cn } from "@/lib/utils";
import { hydrateModelPriceQuotes, mergeModelPriceQuotes, modelPriceQuotesFromResponses, type ModelPriceQuotes, type ModelPriceQuote } from "@/lib/model-pricing";
import type { StoredAuthSession } from "@/lib/auth-session";
import { automaticModelGroup, groupModelsByFamily, renameModelGroup } from "@/lib/model-groups";

import { useSettingsStore } from "../store";
import { SettingsPanel, SettingsSection } from "@/components/settings-panel";
import { ImageModelDefinitionDialog } from "./image-model-definition-dialog";
import { imageProtocolLabels, type ImageModelDefinitions } from "@/lib/image-model-definitions";

type ModelKind = "text" | "image" | "video" | "audio";
type AddMode = "automatic" | "custom";
const modelKinds: ModelKind[] = ["text", "image", "video", "audio"];

async function priceKeysByKind(preferences: Record<ModelKind, string[]>) {
  const [status, custom] = await Promise.all([fetchProfileRelayKey(), fetchCustomRelayConfigs()]);
  const names = normalizeTokenNames(status.token_names);
  const fallback = String(status.token_name || "").trim();
  return Object.fromEntries(modelKinds.map((kind) => {
    const options = relayTokenOptions(names, custom.configs, kind);
    const selected = preferences[kind].filter((name) => options.some((option) => option.value === name));
    return [kind, selected.length ? selected : options.some((option) => option.value === fallback) ? [fallback] : []];
  })) as Record<ModelKind, string[]>;
}

const modelKindMetadata = {
  text: { title: "文本模型", label: "文本", icon: TextCursorInput, placeholder: "例如：gpt-5.5" },
  image: { title: "图片生成模型", label: "图片", icon: ImageIcon, placeholder: "例如：gpt-image-2" },
  video: { title: "视频生成模型", label: "视频", icon: Clapperboard, placeholder: "例如：sora-2" },
  audio: { title: "音频模型", label: "音频", icon: AudioLines, placeholder: "例如：gpt-4o-mini-tts" },
} satisfies Record<ModelKind, { title: string; label: string; icon: typeof ImageIcon; placeholder: string }>;

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

function ModelPrice({ quotes }: { quotes?: ModelPriceQuote[] }) {
  return <div className="grid min-w-0 gap-0.5 text-[11px] leading-relaxed text-muted-foreground">
    {quotes?.length ? Array.from(new Set(quotes.map((quote) => quote.text))).map((text) => (
      <span key={text} className="whitespace-pre-line break-words">{text}</span>
    )) : <span>未获取价格</span>}
  </div>;
}

function ModelGroupInput({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <Input aria-label={label} value={draft} placeholder={placeholder} maxLength={128}
    onChange={(event) => setDraft(event.target.value)} onBlur={() => { onChange(draft.trim()); setDraft(value); }}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { event.stopPropagation(); setDraft(value); }
    }} />;
}

type GlobalModelListProps = {
  kind: ModelKind;
  models: string[];
  onChange: (models: string[]) => void;
  onAdd: () => void;
  onClear: () => void;
  onConfigure?: (model: string) => void;
  definitions?: ImageModelDefinitions;
  capabilities?: Record<string, ModelCapability>;
  onCapabilityChange?: (model: string, capability: ModelCapability) => void;
  prices?: ModelPriceQuotes;
};

function GlobalModelRow({ model, index, kind, models, onChange, onConfigure, definitions, capabilities, onCapabilityChange, prices }: Omit<GlobalModelListProps, "onAdd" | "onClear"> & { model: string; index: number }) {
  return (
    <SortableItem value={model} label={model}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3 py-3 @min-[40rem]:grid-cols-[minmax(0,1fr)_6rem_7rem] @min-[40rem]:px-4"
    >
      <div className="col-span-2 flex min-w-0 items-center gap-2 @min-[40rem]:col-span-1">
        <SortableHandle aria-label={`拖动 ${model} 排序`} />
        <span className="w-5 shrink-0 text-center font-mono text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <code className="break-all text-sm leading-5">{model}</code>
            {index === 0 ? <Badge variant="secondary" className="shrink-0">全局默认</Badge> : null}
          </div>
          <ModelPrice quotes={prices?.[model]} />
        </div>
      </div>
      {onCapabilityChange ? <Select value={capabilities?.[model] || kind} onValueChange={(value) => onCapabilityChange(model, value as ModelCapability)}>
        <SelectTrigger className="w-24" aria-label={`${model} 的模型能力`}><SelectValue /></SelectTrigger>
        <SelectContent>{modelKinds.map((value) => <SelectItem key={value} value={value}>{modelKindMetadata[value].label}</SelectItem>)}</SelectContent>
      </Select> : <div />}
      <div className="flex w-28 items-center justify-end">
        {onConfigure ? <TooltipHint content={definitions?.[model] ? imageProtocolLabels[definitions[model].protocol] : "配置协议与能力"}>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`配置 ${model} 的协议与能力`} onClick={() => onConfigure(model)}><Settings2 /></Button>
        </TooltipHint> : null}
        <TooltipHint content="上移"><Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(moveModel(models, index, -1))}
          disabled={index === 0}
          aria-label={`上移 ${model}`}
        >
          <ArrowUp />
        </Button></TooltipHint>
        <TooltipHint content="下移"><Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(moveModel(models, index, 1))}
          disabled={index === models.length - 1}
          aria-label={`下移 ${model}`}
        >
          <ArrowDown />
        </Button></TooltipHint>
        <TooltipHint content="删除"><Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(models.filter((_, itemIndex) => itemIndex !== index))}
          aria-label={`删除 ${model}`}
        >
          <Trash2 />
        </Button></TooltipHint>
      </div>
    </SortableItem>
  );
}

function GlobalModelList({
  kind,
  models,
  onChange,
  onAdd,
  onClear,
  onConfigure,
  definitions,
  capabilities,
  onCapabilityChange,
  prices,
}: GlobalModelListProps) {
  const title = modelKindMetadata[kind].title;

  return (
    <SettingsSection title={title} description="首项为全局默认，拖动可调整顺序。" className="@container" contentClassName="gap-0 p-0 sm:p-0" action={
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm"  onClick={onClear} disabled={models.length === 0}>
            <Trash2  />
            清空
          </Button>
          <Button type="button" variant="outline" size="sm"  onClick={onAdd}>
            <Plus  />
            添加
          </Button>
        </div>
      }>
        {models.length > 0 ? <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 border-b px-4 py-2.5 text-xs text-muted-foreground @min-[40rem]:grid">
          <span className="pl-16">模型 / 价格</span>
          <span>模型能力</span>
          <span className="text-right">排序与管理</span>
        </div> : null}
        <SortableList values={models} onReorder={onChange} aria-label={`${title}排序`} className="divide-y divide-border/70">
          {(order) => order.map((model, index) => <GlobalModelRow key={model} model={model} index={index} kind={kind} models={order} onChange={onChange} onConfigure={onConfigure} definitions={definitions} capabilities={capabilities} onCapabilityChange={onCapabilityChange} prices={prices} />)}
        </SortableList>
        {models.length === 0 ? (
          <EmptyState compact title="暂无模型，点击“添加”进行配置" className="min-h-20 py-4" />
        ) : null}
    </SettingsSection>
  );
}

function AddModelDialog({
  modelsByKind,
  capabilities,
  onAdd,
  open,
  onOpenChange,
  session,
  initialKind,
  onPricesLoaded,
}: {
  modelsByKind: Record<ModelKind, string[]>;
  capabilities: Record<string, ModelCapability>;
  onAdd: (kind: ModelKind, models: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: StoredAuthSession;
  initialKind: ModelKind;
  onPricesLoaded: (kind: ModelKind, prices: ModelPriceQuotes) => void;
}) {
  const { tokenNames: relayTokenNames } = useRelayTokenPreferences();
  const [mode, setMode] = useState<AddMode>("automatic");
  const [kind, setKind] = useState<ModelKind>("image");
  const [tokenNames, setTokenNames] = useState<string[]>([]);
  const [customConfigs, setCustomConfigs] = useState<CustomRelayConfigStatus[]>([]);
  const [serviceTokenName, setServiceTokenName] = useState("");
  const [selectedTokenNames, setSelectedTokenNames] = useState<string[]>([]);
  const [isLoadingKeys, setIsLoadingKeys] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchedPrices, setFetchedPrices] = useState<ModelPriceQuotes>({});
  const [pricingNotices, setPricingNotices] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [customModels, setCustomModels] = useState("");
  const modelLoadControllerRef = useRef<AbortController | null>(null);
  const modelLoadVersionRef = useRef(0);
  const currentSessionKeyRef = useRef(session.key);
  currentSessionKeyRef.current = session.key;

  const configuredModels = modelsByKind[kind];
  const configuredSet = useMemo(() => new Set(configuredModels), [configuredModels]);
  const tokenOptions = useMemo(
    () => relayTokenOptions(tokenNames, customConfigs, kind),
    [customConfigs, kind, tokenNames],
  );
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return fetchedModels;
    return fetchedModels.filter((model) => model.toLowerCase().includes(query));
  }, [fetchedModels, search]);
  const selectableModels = filteredModels.filter((model) => !configuredSet.has(model));
  const selectedVisibleCount = selectableModels.filter((model) => selectedModels.has(model)).length;

  function invalidateModelLoad() {
    modelLoadVersionRef.current += 1;
    modelLoadControllerRef.current?.abort();
    modelLoadControllerRef.current = null;
    setIsLoadingModels(false);
  }

  useEffect(() => {
    if (!open) return;
    modelLoadVersionRef.current += 1;
    modelLoadControllerRef.current?.abort();
    modelLoadControllerRef.current = null;
    setIsLoadingModels(false);
    const controller = new AbortController();
    const preferredKind = initialKind;
    const preferredTokenNames = relayTokenNames[preferredKind];
    setMode("automatic");
    setKind(preferredKind);
    setSelectedTokenNames(preferredTokenNames);
    setFetchedModels([]);
    setFetchedPrices({});
    setPricingNotices([]);
    setSelectedModels(new Set());
    setSearch("");
    setCustomModels("");
    setIsLoadingKeys(true);
    void Promise.all([fetchProfileRelayKey(), fetchCustomRelayConfigs()])
      .then(([status, customConfigResponse]) => {
        if (controller.signal.aborted) return;
        const names = normalizeTokenNames(status.token_names);
        const availableOptions = relayTokenOptions(names, customConfigResponse.configs, preferredKind);
        const availableNames = new Set(availableOptions.map((option) => option.value));
        setTokenNames(names);
        setCustomConfigs(customConfigResponse.configs);
        const serviceSelection = String(status.token_name || "").trim();
        setServiceTokenName(serviceSelection);
        const preferredSelections = preferredTokenNames.filter((name) => availableNames.has(name));
        setSelectedTokenNames(
          preferredSelections.length > 0
            ? preferredSelections
            : availableNames.has(serviceSelection)
              ? [serviceSelection]
              : [],
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setTokenNames([]);
        setCustomConfigs([]);
        setServiceTokenName("");
        setSelectedTokenNames([]);
        toast.error(error instanceof Error ? error.message : "读取 Key 列表失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingKeys(false);
      });
    return () => controller.abort();
  }, [initialKind, open, relayTokenNames, session.key]);

  useEffect(() => () => {
    modelLoadVersionRef.current += 1;
    modelLoadControllerRef.current?.abort();
    modelLoadControllerRef.current = null;
  }, []);

  useEffect(() => {
    modelLoadVersionRef.current += 1;
    modelLoadControllerRef.current?.abort();
    modelLoadControllerRef.current = null;
    setIsLoadingModels(false);
  }, [open, session.key]);

  function selectTokenNames(values: string[]) {
    invalidateModelLoad();
    setSelectedTokenNames(values);
    setFetchedModels([]);
    setFetchedPrices({});
    setPricingNotices([]);
    setSelectedModels(new Set());
    setSearch("");
  }

  function selectModelKind(value: ModelKind) {
    invalidateModelLoad();
    setKind(value);
    const availableNames = new Set(relayTokenOptions(tokenNames, customConfigs, value).map((option) => option.value));
    const preferredSelections = relayTokenNames[value].filter((name) => availableNames.has(name));
    setSelectedTokenNames(
      preferredSelections.length > 0
        ? preferredSelections
        : availableNames.has(serviceTokenName)
          ? [serviceTokenName]
          : [],
    );
    setFetchedModels([]);
    setFetchedPrices({});
    setPricingNotices([]);
    setSelectedModels(new Set());
    setSearch("");
  }

  async function loadModels() {
    if (selectedTokenNames.length === 0) {
      toast.error("请至少选择一个用于获取模型的 Key");
      return;
    }
    modelLoadControllerRef.current?.abort();
    const controller = new AbortController();
    const requestVersion = modelLoadVersionRef.current + 1;
    modelLoadVersionRef.current = requestVersion;
    modelLoadControllerRef.current = controller;
    const requestTokenNames = [...selectedTokenNames];
    const requestKind = kind;
    const requestSessionKey = session.key;
    setIsLoadingModels(true);
    try {
      const [, responses] = await Promise.all([
        fetchModelConfig(),
        Promise.all(requestTokenNames.map((tokenName) => fetchRelayModels({ tokenName, includePricing: true, signal: controller.signal }))),
      ]);
      if (
        controller.signal.aborted
        || modelLoadVersionRef.current !== requestVersion
        || currentSessionKeyRef.current !== requestSessionKey
      ) return;
      const models = filterModelsByCapability(
        Array.from(new Set(responses.flatMap((response) => (
          relayModelOptionsFromList(response.data).map((option) => option.value)
        )))),
        requestKind,
        capabilities,
      );
      const prices = modelPriceQuotesFromResponses(responses.map((response, index) => ({ tokenName: requestTokenNames[index], displayName: tokenOptions.find((option) => option.value === requestTokenNames[index])?.label || "所选 Key", data: response.data, pricing_error: response.pricing_error })));
      setFetchedPrices(prices);
      setPricingNotices(Array.from(new Set(responses.map((response) => response.pricing_notice).filter((notice): notice is string => Boolean(notice)))));
      onPricesLoaded(requestKind, prices);
      setFetchedModels(models);
      setSelectedModels(new Set());
      setSearch("");
      if (models.length === 0) toast.info("所选 Key 没有返回可用模型");
      for (const notice of new Set(responses.map((response) => response.notice).filter(Boolean))) toast.info(notice);
    } catch (error) {
      if (controller.signal.aborted || modelLoadVersionRef.current !== requestVersion) return;
      toast.error(error instanceof Error ? error.message : "获取模型失败");
    } finally {
      if (modelLoadVersionRef.current === requestVersion) {
        modelLoadControllerRef.current = null;
        setIsLoadingModels(false);
      }
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

  function toggleVisibleModels(checked: boolean) {
    setSelectedModels((current) => {
      const next = new Set(current);
      for (const model of selectableModels) {
        if (checked) next.add(model);
        else next.delete(model);
      }
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
    invalidateModelLoad();
    onOpenChange(false);
    toast.success(`已加入 ${additions.length} 个全局模型，保存配置后生效`);
  }

  const canSubmit = mode === "automatic"
    ? selectedModels.size > 0
    : normalizeModelNames(customModels, []).some((model) => !configuredSet.has(model));

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) invalidateModelLoad();
      onOpenChange(nextOpen);
    }}>
      <DialogContent className="w-full max-w-[calc(100vw-2rem)] overflow-x-hidden sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="flex items-center"><ListPlus className="size-5 text-primary" />添加全局模型</DialogTitle>
          <DialogDescription>添加后的模型会在创作台、无限画布和任务接口中统一可用。</DialogDescription>
        </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">

        <div className="grid grid-cols-2 gap-1 p-1" role="group" aria-label="添加方式">
          <Button
            type="button"
            variant={mode === "automatic" ? "outline" : "ghost"}

            onClick={() => setMode("automatic")}
          >
            <WandSparkles  />自动获取
          </Button>
          <Button
            type="button"
            variant={mode === "custom" ? "outline" : "ghost"}

            onClick={() => {
              invalidateModelLoad();
              setMode("custom");
            }}
          >
            <PencilLine  />自定义
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <LabeledField className="grid gap-2 text-sm font-medium" label="模型类型">{(fieldId) => <><Select
              value={kind}
              onValueChange={(value) => selectModelKind(value as ModelKind)}
              disabled={isLoadingKeys}
            >
              <SelectTrigger id={fieldId} ><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(modelKindMetadata) as ModelKind[]).map((modelKind) => {
                  const metadata = modelKindMetadata[modelKind];
                  const Icon = metadata.icon;
                  return <SelectItem key={modelKind} value={modelKind}><span className="flex items-center gap-2"><Icon  />{metadata.title}</span></SelectItem>;
                })}
              </SelectContent>
            </Select></>}</LabeledField>

          {mode === "automatic" ? (
            <div className="grid gap-2 text-sm font-medium">
              <span>用于获取模型的 Key</span>
              <MultiSelect
                aria-label="用于获取模型的 Key"
                value={selectedTokenNames}
                options={tokenOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                  meta: option.custom ? "自定义" : null,
                }))}
                disabled={isLoadingKeys || tokenOptions.length === 0}
                placeholder={isLoadingKeys ? "正在读取 Key" : tokenOptions.length ? "选择 Key" : "暂无可用 Key"}
                emptyText="暂无可用 Key"
                collapseTags
                collapseTagsTooltip
                onValueChange={selectTokenNames}
              />
            </div>
          ) : (
            <div className="hidden sm:block" />
          )}
        </div>

        {mode === "automatic" ? (
          <div className="grid gap-3">
            <Card className="flex items-center justify-between gap-3 px-3 py-2.5 flex-row">
              <span>默认使用个人中心已选择的全部{modelKindMetadata[kind].label} Key；在此切换不会修改个人中心。</span>
              <Button type="button" size="sm" onClick={() => void loadModels()} disabled={selectedTokenNames.length === 0 || isLoadingModels}>
                {isLoadingModels ? <Spinner /> : <RefreshCw  />}
                获取模型并更新价格
              </Button>
            </Card>

            {pricingNotices.map((notice) => <p key={notice} className="text-xs leading-relaxed text-muted-foreground" role="status">{notice}</p>)}
            {fetchedModels.length > 0 ? (
              <Card className="overflow-hidden gap-0 p-0">
                <div className="border-b p-2.5">
                  <SearchInput value={search} onValueChange={setSearch} placeholder="筛选模型" />
                  <Label className="mt-3 flex w-fit cursor-pointer items-center gap-2 has-disabled:cursor-not-allowed">
                    <Checkbox
                      checked={selectableModels.length > 0 && selectedVisibleCount === selectableModels.length ? true : selectedVisibleCount > 0 ? "indeterminate" : false}
                      disabled={selectableModels.length === 0}
                      onCheckedChange={(checked) => toggleVisibleModels(checked === true)}
                    />
                    全选当前结果
                  </Label>
                </div>
                <ScrollAreaRoot data-slot="scroll-area" className={cn("h-[min(34vh,260px)]", "group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden")} onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0">
                  <div className="divide-y divide-border/60 p-1">
                    {filteredModels.map((model) => {
                      const configured = configuredSet.has(model);
                      const checked = configured || selectedModels.has(model);
                      return (
                        <Item key={model} asChild size="sm">
                        <Label className={cn("min-h-10", configured ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer")}>
                          <Checkbox checked={checked} disabled={configured} onCheckedChange={() => toggleFetchedModel(model)} />
                          <div className="min-w-0 flex-1">
                            <TooltipHint content={model}><code className="block truncate">{model}</code></TooltipHint>
                            <ModelPrice quotes={fetchedPrices[model]} />
                          </div>
                          {configured ? <span className="shrink-0 text-xs">已添加</span> : null}
                        </Label>
                        </Item>
                      );
                    })}
                    {filteredModels.length === 0 ? <EmptyState compact title="没有匹配的模型" /> : null}
                  </div>
                </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
              </Card>
            ) : (
              <EmptyState compact icon={WandSparkles} title="选择 Key 获取模型" description="选择一个或多个 Key 后点击“获取模型”" />
            )}
          </div>
        ) : (
          <LabeledField className="grid gap-2 text-sm font-medium" label="模型 ID">{(fieldId) => <><Input id={fieldId}
              value={customModels}
              onChange={(event) => setCustomModels(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) {
                  event.preventDefault();
                  submitModels();
                }
              }}
              placeholder={modelKindMetadata[kind].placeholder}

            />
            <span className="font-normal text-muted-foreground">可输入一个或多个模型 ID，多个模型使用英文逗号分隔。</span></>}</LabeledField>
        )}

        </ScrollArea><DialogFooter>
          <Button type="button" variant="outline" onClick={() => {
            invalidateModelLoad();
            onOpenChange(false);
          }}>取消</Button>
          <Button type="button" onClick={submitModels} disabled={!canSubmit}>
            <Plus  />
            {mode === "automatic" ? `添加已选模型${selectedModels.size ? ` (${selectedModels.size})` : ""}` : "添加模型"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ModelConfigCard({ session }: { session: StoredAuthSession }) {
  const { tokenNames: priceTokenNames } = useRelayTokenPreferences();
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const setImageModels = useSettingsStore((state) => state.setImageModels);
  const setImageModelDefinitions = useSettingsStore((state) => state.setImageModelDefinitions);
  const [definitionModel, setDefinitionModel] = useState("");
  const setVideoModels = useSettingsStore((state) => state.setVideoModels);
  const setTextModels = useSettingsStore((state) => state.setTextModels);
  const setAudioModels = useSettingsStore((state) => state.setAudioModels);
  const setModelCapabilities = useSettingsStore((state) => state.setModelCapabilities);
  const setModelGroups = useSettingsStore((state) => state.setModelGroups);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogKind, setAddDialogKind] = useState<ModelKind>("image");
  const [priceState, setPriceState] = useState<{ sessionKey: string; byKind: Partial<Record<ModelKind, ModelPriceQuotes>> }>({ sessionKey: session.key, byKind: {} });
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);
  const priceRefreshRef = useRef<AbortController | null>(null);
  const pricesByKind = priceState.sessionKey === session.key ? priceState.byKind : {};
  const priceTokenNamesKey = JSON.stringify(priceTokenNames);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const namesByKind = await priceKeysByKind(JSON.parse(priceTokenNamesKey) as Record<ModelKind, string[]>);
      if (controller.signal.aborted) return;
      const names = Array.from(new Set(modelKinds.flatMap((kind) => namesByKind[kind])));
      const responses = await Promise.all(names.map(async (tokenName) => {
        try {
          const response = await fetchRelayModels({ tokenName, includePricing: "cached", signal: controller.signal });
          return { tokenName, displayName: tokenName, data: response.data };
        } catch {
          return { tokenName, displayName: tokenName, data: [] };
        }
      }));
      if (controller.signal.aborted) return;
      setPriceState((current) => {
        const byKind: Partial<Record<ModelKind, ModelPriceQuotes>> = {};
        for (const kind of modelKinds) {
          const cached = modelPriceQuotesFromResponses(responses.filter((response) => namesByKind[kind].includes(response.tokenName)));
          byKind[kind] = hydrateModelPriceQuotes(current.sessionKey === session.key ? current.byKind[kind] || {} : {}, cached);
        }
        return { sessionKey: session.key, byKind };
      });
    })().catch(() => {});
    return () => controller.abort();
  }, [priceTokenNamesKey, session.key]);

  useEffect(() => {
    setIsRefreshingPrices(false);
    return () => {
      priceRefreshRef.current?.abort();
      priceRefreshRef.current = null;
    };
  }, [session.key]);

  async function refreshPrices() {
    if (priceRefreshRef.current) return;
    const controller = new AbortController();
    priceRefreshRef.current = controller;
    setIsRefreshingPrices(true);
    try {
      const namesByKind = await priceKeysByKind(priceTokenNames);
      if (controller.signal.aborted) return;
      const names = Array.from(new Set(modelKinds.flatMap((kind) => namesByKind[kind])));
      if (!names.length) {
        toast.error("请先配置用于获取模型价格的 Key");
        return;
      }
      const results = await Promise.allSettled(names.map((tokenName) => fetchRelayModels({ tokenName, includePricing: true, signal: controller.signal })));
      if (controller.signal.aborted) return;
      const responses = results.flatMap((result, index) => result.status === "fulfilled" && !result.value.pricing_error
        ? [{ tokenName: names[index], displayName: names[index], data: result.value.data }] : []);
      if (responses.length) {
        setPriceState((current) => {
          const byKind = { ...(current.sessionKey === session.key ? current.byKind : {}) };
          for (const kind of modelKinds) {
            const selected = responses.filter((response) => namesByKind[kind].includes(response.tokenName));
            if (selected.length) byKind[kind] = mergeModelPriceQuotes(byKind[kind] || {}, modelPriceQuotesFromResponses(selected), selected.map((response) => response.tokenName));
          }
          return { sessionKey: session.key, byKind };
        });
      }
      const failed = names.length - responses.length;
      if (failed) toast.error(`价格更新完成：${responses.length} 个 Key 成功，${failed} 个失败`);
      else toast.success(`已更新 ${responses.length} 个 Key 的模型价格`);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "更新模型价格失败");
    } finally {
      if (priceRefreshRef.current === controller) {
        priceRefreshRef.current = null;
        setIsRefreshingPrices(false);
      }
    }
  }

  const imageModels = normalizeModelNames(config?.image_models, []);
  const videoModels = normalizeModelNames(config?.video_models, []);
  const textModels = normalizeModelNames(config?.text_models, []);
  const audioModels = normalizeModelNames(config?.audio_models, []);
  const modelsByKind: Record<ModelKind, string[]> = { text: textModels, image: imageModels, video: videoModels, audio: audioModels };
  const capabilities = config?.model_capabilities || {};
  const modelGroups = config?.model_groups || { overrides: {}, order: [] };
  const allModels = Array.from(new Set([...textModels, ...imageModels, ...videoModels, ...audioModels]));
  const groups = groupModelsByFamily(allModels.map((value) => ({ value })), modelGroups);

  if (isLoadingConfig || !config) {
    return (
      <SettingsPanel className="max-w-5xl" title="模型服务" description="配置全站统一使用的文本、图片、视频与音频模型。">
        <LoadingState className="h-auto" label="正在加载模型设置" />
      </SettingsPanel>
    );
  }

  function updateModels(kind: ModelKind, models: string[]) {
    const normalized = normalizeModelNames(models, []);
    const serialized = normalized.join(", ");
    if (kind === "text") setTextModels(serialized);
    if (kind === "image") setImageModels(serialized);
    if (kind === "video") setVideoModels(serialized);
    if (kind === "audio") setAudioModels(serialized);
  }

  function addModels(kind: ModelKind, additions: string[]) {
    updateModels(kind, [...modelsByKind[kind], ...additions]);
    if (kind === "image" && additions.length === 1) setDefinitionModel(additions[0]);
  }

  function openAddDialog(kind: ModelKind) {
    setAddDialogKind(kind);
    setAddDialogOpen(true);
  }

  return (
    <>
      <SettingsPanel
        className="max-w-5xl gap-6"
        title="模型服务"
        description="管理全站统一使用的模型，按类型配置能力与默认顺序。"
        contentScrollable={false}
        action={
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => void refreshPrices()} disabled={isRefreshingPrices}>
              {isRefreshingPrices ? <Spinner /> : <RefreshCw />}更新价格
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setGroupsOpen(true)}><Settings2 />模型分组</Button>
            <Button type="button" size="sm" aria-label="保存模型配置" onClick={() => void saveConfig()} disabled={isSavingConfig}>
              {isSavingConfig ? <Spinner /> : <Save />}保存
            </Button>
          </>
        }
      >
        <Tabs defaultValue="text" className="min-h-0 flex-1 gap-5">
          <TabsList aria-label="模型类型" className="grid w-full shrink-0 grid-cols-4 sm:w-fit">
            {modelKinds.map((kind) => {
              const { label, icon: Icon } = modelKindMetadata[kind];
              return <TabsTrigger key={kind} value={kind} className="gap-1.5 px-2 sm:px-3 lg:px-4">
                <Icon className="hidden lg:block" />
                {label}
                <Badge variant="secondary" className="min-w-5 justify-center tabular-nums">{modelsByKind[kind].length}</Badge>
              </TabsTrigger>;
            })}
          </TabsList>
          {modelKinds.map((kind) => <TabsContent key={kind} value={kind} className="flex min-h-0 flex-col data-[state=inactive]:hidden">
            <ScrollArea className="-mr-3 -ml-1 min-h-0 flex-1" contentClassName="py-1 pl-1" onWheel={(event) => event.stopPropagation()}>
              <GlobalModelList
                kind={kind}
                prices={pricesByKind[kind]}
                models={modelsByKind[kind]}
                onChange={(models) => updateModels(kind, models)}
                onAdd={() => openAddDialog(kind)}
                onClear={() => updateModels(kind, [])}
                onConfigure={kind === "image" ? setDefinitionModel : undefined}
                definitions={kind === "image" ? config.image_model_definitions : undefined}
                capabilities={capabilities}
                onCapabilityChange={(model, capability) => setModelCapabilities({ ...capabilities, [model]: capability })}
              />
            </ScrollArea>
          </TabsContent>)}
        </Tabs>
        <p className="pt-4 text-xs leading-5 text-muted-foreground">价格单位为 USD，获取模型时同步更新；账户优惠以实际结算为准。</p>
      </SettingsPanel>
      <Dialog open={groupsOpen} onOpenChange={setGroupsOpen}>
        <DialogContent className="w-[min(92vw,720px)] sm:max-w-none">
          <DialogHeader><DialogTitle>模型分组</DialogTitle><DialogDescription>修改分组名称可整组重命名，同名分组会合并。模型所属分组留空时自动分组；拖动分组调整全站显示顺序。完成后点击“保存”生效。</DialogDescription></DialogHeader>
          <ScrollArea className="min-h-0 max-h-[65dvh]" contentClassName="space-y-4 py-2">
            <SortableList values={groups.map((group) => group.name)} onReorder={(order) => setModelGroups({ ...modelGroups, order })} aria-label="模型分组排序" className="space-y-4">
              {(order) => order.map((name) => {
                const group = groups.find((item) => item.name === name);
                if (!group) return null;
                return <SortableItem key={name} value={name} label={name} className="space-y-2">
                  <div className="flex items-center gap-2"><SortableHandle aria-label={`拖动 ${name} 分组排序`} /><div className="w-48 min-w-0"><ModelGroupInput label={`${name} 分组名称`} value={name} onChange={(newName) => setModelGroups(renameModelGroup(allModels, modelGroups, name, newName))} /></div><span className="text-xs text-muted-foreground">{group.options.length}</span></div>
                  <div className="space-y-2 pl-8">{group.options.map(({ value }) => <div key={value} className="grid min-w-0 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,12rem)]">
                    <code className="break-all text-xs">{value}</code><ModelGroupInput label={`${value} 的分组`} value={modelGroups.overrides[value] || ""} placeholder={automaticModelGroup(value)} onChange={(groupName) => {
                      const overrides = { ...modelGroups.overrides };
                      if (groupName) overrides[value] = groupName;
                      else delete overrides[value];
                      setModelGroups({ ...modelGroups, overrides });
                    }} />
                  </div>)}</div>
                </SortableItem>;
              })}
            </SortableList>
          </ScrollArea>
          <DialogFooter><Button type="button" onClick={() => setGroupsOpen(false)}>完成</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AddModelDialog
        modelsByKind={modelsByKind}
        capabilities={capabilities}
        onAdd={addModels}
        onPricesLoaded={(kind, prices) => setPriceState((current) => ({ sessionKey: session.key, byKind: { ...(current.sessionKey === session.key ? current.byKind : {}), [kind]: prices } }))}
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        session={session}
        initialKind={addDialogKind}
      />
      {definitionModel ? <ImageModelDefinitionDialog
        key={definitionModel}
        model={definitionModel}
        definition={config.image_model_definitions?.[definitionModel]}
        onClose={() => setDefinitionModel("")}
        onChange={(definition) => {
          const definitions = { ...config.image_model_definitions };
          if (definition) definitions[definitionModel] = definition;
          else delete definitions[definitionModel];
          setImageModelDefinitions(definitions);
        }}
      /> : null}
    </>
  );
}
