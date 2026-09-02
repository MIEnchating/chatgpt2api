import {
  AudioLines,
  BookOpen,
  Camera,
  ChevronRight,
  Eye,
  FileText,
  FolderOpen,
  Group,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  RefreshCcw,
  Search,
  Settings2,
  Type,
  Video,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  fetchPromptMarketPrompts,
  normalizePromptMarketSources,
  promptMatchesKeyword,
  sortPromptMarketPrompts,
  type BananaPrompt,
} from "@/app/image/banana-prompts";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TooltipHint } from "@/components/ui/tooltip";
import { fetchPromptSourcesConfig, type ManagedImage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";

export type CanvasSidePanelTab = "canvas" | "assets" | "prompts";

type CanvasSidePanelProps = {
  sessionKey: string;
  nodes: CanvasNode[];
  selectedNodeIDs: Set<string>;
  open: boolean;
  width: number;
  tab: CanvasSidePanelTab;
  libraryImages: ManagedImage[];
  libraryLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onWidthChange: (width: number) => void;
  onTabChange: (tab: CanvasSidePanelTab) => void;
  onFocusNode: (nodeID: string) => void;
  onInsertLibraryImage: (image: ManagedImage) => void;
  onOpenAssets: () => void;
  onInsertPrompt: (prompt: string, title: string) => void;
};

const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 480;

const NODE_META: Record<CanvasNode["type"], { label: string; icon: LucideIcon }> = {
  image: { label: "图片", icon: ImageIcon },
  video: { label: "视频", icon: Video },
  audio: { label: "音频", icon: AudioLines },
  panorama: { label: "全景图", icon: Images },
  director: { label: "导演台", icon: Camera },
  group: { label: "组", icon: Group },
  text: { label: "文字", icon: Type },
  config: { label: "生成配置", icon: Settings2 },
};

const NODE_FILTERS: Array<{ value: "all" | CanvasNode["type"]; label: string }> = [
  { value: "all", label: "全部类型" },
  ...Object.entries(NODE_META).map(([value, meta]) => ({ value: value as CanvasNode["type"], label: meta.label })),
];

const STATUS_CLASS: Record<NonNullable<CanvasNode["generation_status"]>, string> = {
  idle: "bg-muted-foreground/35",
  loading: "bg-amber-500",
  success: "bg-emerald-500",
  error: "bg-rose-500",
};

type SidePanelPromptData = {
  prompts: BananaPrompt[];
  categories: Array<{ id: string; label: string; builtin?: boolean }>;
};

type SidePanelPromptCacheEntry = {
  data: SidePanelPromptData;
  expiresAt: number;
};

const sidePanelPromptCache = new Map<string, SidePanelPromptCacheEntry>();
const sidePanelPromptRequests = new Map<string, Promise<SidePanelPromptData>>();
const SIDE_PANEL_PROMPT_CATEGORY_PAGE_SIZE = 12;
const SIDE_PANEL_PROMPT_CACHE_TTL_MS = 5 * 60_000;
const SIDE_PANEL_PROMPT_CACHE_LIMIT = 8;

function localizedPrompt(prompt: BananaPrompt): BananaPrompt {
  const localization = prompt.localizations?.["zh-CN"] ?? prompt.localizations?.en;
  return localization ? {
    ...prompt,
    title: localization.title,
    prompt: localization.prompt,
    category: localization.category,
    subCategory: localization.subCategory,
  } : prompt;
}

function cachedSidePanelPrompts(sessionKey: string) {
  const key = sessionKey.trim();
  const cached = sidePanelPromptCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    sidePanelPromptCache.delete(key);
    return null;
  }
  return cached.data;
}

function cacheSidePanelPrompts(sessionKey: string, data: SidePanelPromptData) {
  sidePanelPromptCache.delete(sessionKey);
  sidePanelPromptCache.set(sessionKey, { data, expiresAt: Date.now() + SIDE_PANEL_PROMPT_CACHE_TTL_MS });
  while (sidePanelPromptCache.size > SIDE_PANEL_PROMPT_CACHE_LIMIT) {
    const oldestKey = sidePanelPromptCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    sidePanelPromptCache.delete(oldestKey);
  }
}

function loadSidePanelPrompts(sessionKey: string, force = false) {
  const key = sessionKey.trim();
  if (!key) return Promise.reject(new Error("登录会话无效"));
  if (force) sidePanelPromptCache.delete(key);
  const cached = cachedSidePanelPrompts(key);
  if (cached) return Promise.resolve(cached);
  const currentRequest = sidePanelPromptRequests.get(key);
  if (currentRequest && !force) return currentRequest;
  const pending = fetchPromptSourcesConfig()
    .then(async ({ sources: configuredSources }) => {
      const sources = normalizePromptMarketSources(configuredSources).filter((source) => source.enabled);
      const prompts = await fetchPromptMarketPrompts(undefined, sources);
      return {
        prompts: sortPromptMarketPrompts(prompts.map(localizedPrompt)),
        categories: sources.map(({ id, label, builtin }) => ({ id, label, builtin })),
      };
    });
  let tracked: Promise<SidePanelPromptData>;
  tracked = pending
    .then((data) => {
      if (sidePanelPromptRequests.get(key) === tracked) {
        cacheSidePanelPrompts(key, data);
      }
      return data;
    })
    .finally(() => {
      if (sidePanelPromptRequests.get(key) === tracked) {
        sidePanelPromptRequests.delete(key);
      }
    });
  sidePanelPromptRequests.set(key, tracked);
  return tracked;
}

export function CanvasSidePanel({
  sessionKey,
  nodes,
  selectedNodeIDs,
  open,
  width,
  tab,
  libraryImages,
  libraryLoading,
  onOpenChange,
  onWidthChange,
  onTabChange,
  onFocusNode,
  onInsertLibraryImage,
  onOpenAssets,
  onInsertPrompt,
}: CanvasSidePanelProps) {
  const resizeRef = useRef<{ pointerID: number; startX: number; startWidth: number } | null>(null);
  const insertPromptRef = useRef(onInsertPrompt);
  insertPromptRef.current = onInsertPrompt;
  const insertPrompt = useCallback((prompt: string, title: string) => {
    insertPromptRef.current(prompt, title);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeRef.current = { pointerID: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerID !== event.pointerId) return;
    onWidthChange(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, active.startWidth + event.clientX - active.startX)));
  };

  const stopResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerID !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      data-canvas-no-zoom
      data-open={open}
      inert={!open}
      aria-hidden={!open}
      className="absolute inset-y-0 left-0 z-50 min-h-0 shrink-0 transition-[width] duration-300 ease-in-out md:relative md:z-30"
      style={{ width: open ? width : 0 }}
    >
      <aside
        className={cn(
          "absolute inset-y-0 left-0 flex min-h-0 max-w-[calc(100vw-1.5rem)] flex-col border-r bg-card/98 backdrop-blur-xl transition-[opacity,transform,box-shadow,border-color] duration-300 ease-in-out md:max-w-none",
          open
            ? "translate-x-0 border-border opacity-100 shadow-xl md:shadow-none"
            : "pointer-events-none -translate-x-full border-transparent opacity-0 shadow-none",
        )}
        style={{ width }}
      >
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          <div className="flex min-w-0 flex-1 items-stretch self-stretch" role="tablist" aria-label="画布侧栏">
            <SidePanelTab active={tab === "canvas"} onClick={() => onTabChange("canvas")}>画布</SidePanelTab>
            <SidePanelTab active={tab === "assets"} onClick={() => onTabChange("assets")}>素材库</SidePanelTab>
            <SidePanelTab active={tab === "prompts"} onClick={() => onTabChange("prompts")}>提示词库</SidePanelTab>
          </div>
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 transition-transform duration-200 hover:scale-105 active:scale-90" aria-label="收起侧栏" title="收起侧栏" onClick={() => onOpenChange(false)}>
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "canvas" ? (
            <CanvasNodesTab nodes={nodes} selectedNodeIDs={selectedNodeIDs} onFocusNode={onFocusNode} />
          ) : tab === "assets" ? (
            <CanvasAssetsTab images={libraryImages} loading={libraryLoading} onInsert={onInsertLibraryImage} onOpenAssets={onOpenAssets} />
          ) : (
            <CanvasPromptsTab sessionKey={sessionKey} onInsert={insertPrompt} />
          )}
        </div>

        <button
          type="button"
          className="absolute inset-y-0 right-0 z-30 hidden w-2 translate-x-full cursor-col-resize touch-none md:block"
          aria-label="调整侧栏宽度"
          onPointerDown={startResize}
          onPointerMove={resize}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
        >
          <span className="absolute inset-y-0 left-0 w-px bg-[#1456f0]/0 transition-colors hover:bg-[#1456f0]/70" />
        </button>
      </aside>
    </div>
  );
}

function SidePanelTab({ active, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "relative min-w-0 flex-1 px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
        active && "text-foreground",
        className,
      )}
      {...props}
    >
      {props.children}
      {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#1456f0]" /> : null}
    </button>
  );
}

function CanvasNodesTab({ nodes, selectedNodeIDs, onFocusNode }: {
  nodes: CanvasNode[];
  selectedNodeIDs: Set<string>;
  onFocusNode: (nodeID: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | CanvasNode["type"]>("all");
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const filteredNodes = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return nodes.filter((node) => {
      if (type !== "all" && node.type !== type) return false;
      const meta = NODE_META[node.type];
      return !keyword || [node.title, node.prompt, node.composer_content, meta.label]
        .some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [nodes, query, type]);

  useEffect(() => {
    const selectedID = [...selectedNodeIDs][0];
    if (selectedID) rowRefs.current[selectedID]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedNodeIDs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border/70 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">画布元素</span>
          <span className="text-xs tabular-nums text-muted-foreground/70">{nodes.length}</span>
          <Select value={type} onValueChange={(value) => setType(value as "all" | CanvasNode["type"])}>
            <SelectTrigger className="ml-auto h-8 w-[108px] rounded-md px-2 text-xs shadow-none"><SelectValue /></SelectTrigger>
            <SelectContent>
              {NODE_FILTERS.map((filter) => <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 rounded-md pl-8 text-xs" placeholder="搜索节点" />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
        {filteredNodes.length ? (
          <div className="space-y-1">
            {filteredNodes.map((node) => (
              <CanvasNodeRow
                key={node.id}
                ref={(element) => { rowRefs.current[node.id] = element; }}
                node={node}
                selected={selectedNodeIDs.has(node.id)}
                onClick={() => onFocusNode(node.id)}
              />
            ))}
          </div>
        ) : (
          <div className="grid min-h-48 place-items-center px-4 text-center text-xs text-muted-foreground">
            {nodes.length ? "没有匹配的节点" : "画布暂无节点"}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

const CanvasNodeRow = ({ ref, node, selected, onClick }: {
  ref?: React.Ref<HTMLButtonElement>;
  node: CanvasNode;
  selected: boolean;
  onClick: () => void;
}) => {
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  const preview = (node.type === "image" || node.type === "panorama") ? node.thumbnail_url || node.url : node.type === "video" ? node.thumbnail_url : "";
  const subtitle = node.type === "text" ? node.prompt || meta.label : meta.label;

  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex h-14 w-full items-center gap-2.5 rounded-md border px-2 text-left transition-colors",
        selected ? "border-[#8fb0f7] bg-[#edf3ff] dark:border-blue-700 dark:bg-blue-950/45" : "border-transparent hover:bg-muted/70",
      )}
      onClick={onClick}
    >
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-muted/75 text-muted-foreground">
        {preview ? <AuthenticatedImage src={preview} alt="" className="size-full object-cover" /> : <Icon className="size-4.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{node.title || meta.label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
      {node.generation_status && node.generation_status !== "idle" ? (
        <TooltipHint content={node.generation_status}>
          <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_CLASS[node.generation_status])} />
        </TooltipHint>
      ) : null}
    </button>
  );
};

function CanvasAssetsTab({ images, loading, onInsert, onOpenAssets }: {
  images: ManagedImage[];
  loading: boolean;
  onInsert: (image: ManagedImage) => void;
  onOpenAssets: () => void;
}) {
  const [query, setQuery] = useState("");
  const filteredImages = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword
      ? images.filter((image) => [image.name, image.prompt, image.model].some((value) => String(value || "").toLowerCase().includes(keyword)))
      : images;
  }, [images, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border/70 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">我的素材</span>
          <span className="text-xs tabular-nums text-muted-foreground/70">{images.length}</span>
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 gap-1.5 px-2 text-xs" onClick={onOpenAssets}>
            <FolderOpen className="size-3.5" />全部素材
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 rounded-md pl-8 text-xs" placeholder="搜索素材" />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2.5">
        {loading && !images.length ? (
          <div className="grid min-h-48 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
        ) : filteredImages.length ? (
          <div className="grid grid-cols-2 gap-2">
            {filteredImages.map((image) => {
              const title = image.name || image.prompt || "图片";
              return (
                <button
                  key={image.path}
                  type="button"
                  draggable
                  className="group min-w-0 overflow-hidden rounded-md border border-border bg-card text-left transition hover:border-[#8fb0f7] hover:shadow-sm"
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-yunmian-image", JSON.stringify(image));
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => onInsert(image)}
                >
                  <span className="block aspect-square overflow-hidden bg-muted">
                    <AuthenticatedImage src={image.thumbnail_url || image.url || image.path} alt={title} className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                  </span>
                  <span className="block truncate px-2 py-1.5 text-[11px] font-medium">{title}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-48 place-items-center px-4 text-center text-xs text-muted-foreground">
            {images.length ? "没有匹配的素材" : "暂无素材"}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

const CanvasPromptsTab = memo(function CanvasPromptsTab({ sessionKey, onInsert }: { sessionKey: string; onInsert: (prompt: string, title: string) => void }) {
  const initialData = cachedSidePanelPrompts(sessionKey);
  const [prompts, setPrompts] = useState<BananaPrompt[]>(() => initialData?.prompts || []);
  const [categories, setCategories] = useState<Array<{ id: string; label: string; builtin?: boolean }>>(() => initialData?.categories || []);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState("");
  const [expandedCategoryID, setExpandedCategoryID] = useState<string | null>(null);
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState<BananaPrompt | null>(null);
  const requestVersionRef = useRef(0);

  const load = useCallback((force = false) => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError("");
    void loadSidePanelPrompts(sessionKey, force)
      .then((data) => {
        if (requestVersionRef.current !== requestVersion) return;
        setPrompts(data.prompts);
        setCategories(data.categories);
      })
      .catch((loadError: unknown) => {
        if (requestVersionRef.current === requestVersion) {
          setError(loadError instanceof Error ? loadError.message : "提示词加载失败");
        }
      })
      .finally(() => {
        if (requestVersionRef.current === requestVersion) setLoading(false);
      });
  }, [sessionKey]);

  useEffect(() => {
    const cached = cachedSidePanelPrompts(sessionKey);
    setPrompts(cached?.prompts || []);
    setCategories(cached?.categories || []);
    setDetail(null);
    setExpandedCategoryID(null);
    setVisibleCounts({});
    load();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [load, sessionKey]);

  const filteredPrompts = useMemo(() => {
    const matching = prompts.filter((prompt) => promptMatchesKeyword(prompt, query));
    return sortPromptMarketPrompts(matching);
  }, [prompts, query]);

  const promptGroups = useMemo(() => {
    const promptsByCategory = new Map<string, BananaPrompt[]>();
    filteredPrompts.forEach((prompt) => {
      const categoryID = prompt.source.trim() || "unknown";
      const items = promptsByCategory.get(categoryID);
      if (items) items.push(prompt);
      else promptsByCategory.set(categoryID, [prompt]);
    });
    const configuredIDs = new Set(categories.map(({ id }) => id));
    return [
      ...categories.map((category) => ({ ...category, prompts: promptsByCategory.get(category.id) || [] })),
      ...[...promptsByCategory.entries()]
        .filter(([id]) => !configuredIDs.has(id))
        .map(([id, categoryPrompts]) => ({ id, label: categoryPrompts[0]?.sourceLabel || id, prompts: categoryPrompts })),
    ].filter((category) => category.prompts.length > 0);
  }, [categories, filteredPrompts]);

  useEffect(() => setVisibleCounts({}), [prompts, query]);

  useEffect(() => {
    setExpandedCategoryID((current) => (
      current && promptGroups.some((category) => category.id === current)
        ? current
        : promptGroups[0]?.id || null
    ));
  }, [promptGroups]);

  const insert = (prompt: BananaPrompt) => {
    onInsert(prompt.prompt, prompt.title);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/70 p-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 rounded-md pl-8 text-xs" placeholder="搜索提示词" />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{filteredPrompts.length}</span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
        {loading && !prompts.length ? (
          <div className="grid min-h-48 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
        ) : error && !prompts.length ? (
          <div className="grid min-h-48 place-items-center gap-3 px-5 text-center text-xs text-muted-foreground">
            <span className="line-clamp-3">{error}</span>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => load(true)}><RefreshCcw className="size-3.5" />重试</Button>
          </div>
        ) : promptGroups.length ? (
          <div className="space-y-1">
            {promptGroups.map((category) => {
              const opened = expandedCategoryID === category.id;
              const visibleCount = visibleCounts[category.id] || SIDE_PANEL_PROMPT_CATEGORY_PAGE_SIZE;
              const visiblePrompts = category.prompts.slice(0, visibleCount);
              return (
                <section key={category.id} className="pb-1">
                  <button
                    type="button"
                    className="sticky top-0 z-10 flex h-8 w-full items-center gap-1.5 rounded-md bg-background/95 px-1.5 text-left text-xs font-medium text-muted-foreground backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
                    aria-expanded={opened}
                    title={category.label !== category.id ? category.label : undefined}
                    onClick={() => setExpandedCategoryID((current) => current === category.id ? null : category.id)}
                  >
                    <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", opened && "rotate-90")} />
                    <BookOpen className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{category.id}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground/70">{category.prompts.length}</span>
                  </button>
                  {opened ? (
                    <div className="space-y-1 pt-1">
                      {visiblePrompts.map((prompt) => <CanvasPromptRow key={`${prompt.source}:${prompt.id}`} prompt={prompt} onView={() => setDetail(prompt)} onInsert={() => insert(prompt)} />)}
                      {visiblePrompts.length < category.prompts.length ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-full text-[11px] text-muted-foreground"
                          onClick={() => setVisibleCounts((current) => ({
                            ...current,
                            [category.id]: Math.min(category.prompts.length, visibleCount + SIDE_PANEL_PROMPT_CATEGORY_PAGE_SIZE),
                          }))}
                        >
                          加载更多（{visiblePrompts.length}/{category.prompts.length}）
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-48 place-items-center px-4 text-center text-xs text-muted-foreground">
            {prompts.length ? "没有匹配的提示词" : "暂无提示词"}
          </div>
        )}
      </ScrollArea>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent scrollable={false} className="flex max-h-[min(86dvh,680px)] w-[min(92vw,600px)] flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
            <DialogTitle className="text-base">{detail?.title || "提示词详情"}</DialogTitle>
            <DialogDescription>{detail ? `${detail.category} · ${detail.sourceLabel}` : ""}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1" viewportClassName="p-5">
            {detail?.preview ? <img src={detail.preview} alt={detail.title} className="mb-4 max-h-72 w-full rounded-md border border-border bg-muted object-contain" /> : null}
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{detail?.prompt}</p>
          </ScrollArea>
          <DialogFooter flush>
            <Button type="button" variant="outline" onClick={() => setDetail(null)}>关闭</Button>
            <Button type="button" onClick={() => { if (detail) insert(detail); setDetail(null); }}><Plus />插入画布</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

function CanvasPromptRow({ prompt, onView, onInsert }: { prompt: BananaPrompt; onView: () => void; onInsert: () => void }) {
  return (
    <div className="group flex min-h-14 items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/65">
      <PromptThumbnail prompt={prompt} />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onView}>
        <span className="block truncate text-xs font-medium">{prompt.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{prompt.prompt}</span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/75">
          {[prompt.sourceLabel, formatSidePanelPromptDate(prompt.created)].filter(Boolean).join(" · ")}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5">
        <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={`查看 ${prompt.title}`} title="查看详情" onClick={onView}><Eye className="size-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon" className="size-7 text-[#1456f0]" aria-label={`插入 ${prompt.title}`} title="插入画布" onClick={onInsert}><Plus className="size-3.5" /></Button>
      </span>
    </div>
  );
}

function formatSidePanelPromptDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function PromptThumbnail({ prompt }: { prompt: BananaPrompt }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground">
      {prompt.preview && !failed
        ? <img src={prompt.preview} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
        : <FileText className="size-4" />}
    </span>
  );
}
