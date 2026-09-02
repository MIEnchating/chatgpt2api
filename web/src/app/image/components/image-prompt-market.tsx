"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, ClipboardCopy, Images, LoaderCircle, RefreshCcw, Search, Star, Tags } from "lucide-react";
import { toast } from "sonner";

import {
  DEFAULT_PROMPT_MARKET_SOURCES,
  fetchPromptMarketPrompts,
  normalizePromptMarketSources,
  promptMatchesKeyword,
  sortPromptMarketPrompts,
  type BananaPrompt,
  type PromptMarketLocalization,
  type PromptMarketSourceId,
} from "@/app/image/banana-prompts";
import { fetchPromptSourcesConfig } from "@/lib/api";
import {
  createPromptFavorite,
  deletePromptFavorite,
  fetchPromptFavorites,
  promptFavoriteKey,
  promptFavoriteRecordKey,
  promptFavoriteToBananaPrompt,
  type PromptFavorite,
} from "@/app/image/prompt-favorites";
import { PromptFavoriteRequestLifecycle } from "@/app/image/prompt-favorite-request-lifecycle";
import { tagVariants } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ScrollArea, type ScrollAreaHandle } from "@/components/ui/scroll-area";
import { TooltipButton, TooltipHint } from "@/components/ui/tooltip";

type PromptMarketSourceFilter = "all" | PromptMarketSourceId;
type PromptMarketFavoriteFilter = "all" | "favorites";

type ImagePromptMarketProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplyPrompt: (prompt: BananaPrompt) => void | Promise<void>;
  onSavePrompt?: (prompt: BananaPrompt) => void | Promise<void>;
  presentation?: "dialog" | "page";
  initialSource?: string;
};

const INITIAL_VISIBLE_COUNT = 60;
const VISIBLE_COUNT_STEP = 60;
function formatPromptDate(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getPromptLocalization(prompt: BananaPrompt): PromptMarketLocalization | undefined {
  return prompt.localizations?.["zh-CN"] ?? prompt.localizations?.en;
}

function getLocalizedPrompt(prompt: BananaPrompt): BananaPrompt {
  const localization = getPromptLocalization(prompt);
  if (!localization) {
    return prompt;
  }

  return {
    ...prompt,
    title: localization.title,
    prompt: localization.prompt,
    category: localization.category,
    subCategory: localization.subCategory,
  };
}

function promptFilterTags(prompt: BananaPrompt) {
  const localizedPrompt = getLocalizedPrompt(prompt);
  return Array.from(new Set(localizedPrompt.tags.filter((value) => Boolean(value.trim()))));
}

function PromptPreviewImage({ prompt }: { prompt: BananaPrompt }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm font-medium text-muted-foreground">
        {prompt.title}
      </div>
    );
  }

  return (
    <img
      src={prompt.preview}
      alt={prompt.title}
      loading="lazy"
      className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
      onError={() => setFailed(true)}
    />
  );
}

export function ImagePromptMarket({ open, onOpenChange, onApplyPrompt, onSavePrompt, presentation = "dialog", initialSource }: ImagePromptMarketProps) {
  const [prompts, setPrompts] = useState<BananaPrompt[]>([]);
  const [sourceConfigs, setSourceConfigs] = useState(DEFAULT_PROMPT_MARKET_SOURCES);
  const [favoriteItems, setFavoriteItems] = useState<PromptFavorite[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingFavorites, setIsLoadingFavorites] = useState(false);
  const [error, setError] = useState("");
  const [favoriteError, setFavoriteError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [categorySearch, setCategorySearch] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [favoriteFilter, setFavoriteFilter] = useState<PromptMarketFavoriteFilter>("all");
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [source, setSource] = useState<PromptMarketSourceFilter>(initialSource || "all");
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [favoriteBusyIds, setFavoriteBusyIds] = useState<Set<string>>(() => new Set());
  const [saveBusyIds, setSaveBusyIds] = useState<Set<string>>(() => new Set());
  const [selectedPrompt, setSelectedPrompt] = useState<BananaPrompt | null>(null);
  const scrollAreaRef = useRef<ScrollAreaHandle>(null);
  const openRef = useRef(open);
  const favoriteRequestLifecycleRef = useRef(new PromptFavoriteRequestLifecycle());
  openRef.current = open;

  useEffect(() => {
    setSource(initialSource || "all");
  }, [initialSource]);

  const updateFavoriteItems = (items: PromptFavorite[]) => {
    setFavoriteItems(Array.isArray(items) ? items : []);
  };

  const loadPromptData = () => {
    setIsLoading(true);
    setError("");

    void fetchPromptMarketPrompts(undefined, sourceConfigs)
      .then((items) => {
        setPrompts(items);
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "读取提示词市场失败");
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

  const loadFavoriteData = () => {
    const lifecycle = favoriteRequestLifecycleRef.current;
    const request = lifecycle.beginLoad();
    if (!request) return null;

    setIsLoadingFavorites(true);
    setFavoriteError("");

    void fetchPromptFavorites(request.controller.signal)
      .then((data) => {
        if (!openRef.current || !lifecycle.isCurrentLoad(request)) return;
        updateFavoriteItems(data.items);
      })
      .catch((loadError: unknown) => {
        if (!openRef.current || !lifecycle.isCurrentLoad(request)) return;
        const message = loadError instanceof Error ? loadError.message : "读取收藏失败";
        setFavoriteError(message);
        toast.error(message);
      })
      .finally(() => {
        if (openRef.current && lifecycle.isCurrentLoad(request)) {
          setIsLoadingFavorites(false);
        }
        lifecycle.releaseLoad(request);
      });

    return request;
  };

  useEffect(() => {
    const lifecycle = favoriteRequestLifecycleRef.current;
    if (open) {
      lifecycle.activate();
      return () => lifecycle.deactivate();
    }

    lifecycle.deactivate();
    setIsLoadingFavorites(false);
    setFavoriteBusyIds((current) => current.size === 0 ? current : new Set());
  }, [open]);

  useEffect(() => {
    if (!open || prompts.length > 0) {
      return;
    }

    setIsLoading(true);
    setError("");
    const controller = new AbortController();

    void fetchPromptSourcesConfig()
      .then(({ sources }) => {
        const configured = normalizePromptMarketSources(sources);
        setSourceConfigs(configured);
        return fetchPromptMarketPrompts(controller.signal, configured);
      })
      .then((items) => {
        setPrompts(items);
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "读取提示词市场失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => controller.abort();
  }, [open, prompts.length]);

  useEffect(() => {
    if (!open || favoriteItems.length > 0) {
      return;
    }

    const lifecycle = favoriteRequestLifecycleRef.current;
    const request = loadFavoriteData();
    return () => {
      if (request) lifecycle.cancelLoad(request);
    };
  }, [favoriteItems.length, open]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
    scrollAreaRef.current?.scrollTo({ top: 0 });
  }, [keyword, source, favoriteFilter, tagFilters]);

  useEffect(() => {
    if (open) {
      scrollAreaRef.current?.scrollTo({ top: 0 });
    }
  }, [open]);

  const favoritePrompts = useMemo(
    () => favoriteItems.map((item) => promptFavoriteToBananaPrompt(item)),
    [favoriteItems],
  );

  const visibleFavoritePrompts = favoritePrompts;

  const favoriteIds = useMemo(() => new Set(favoriteItems.map((item) => promptFavoriteRecordKey(item))), [favoriteItems]);

  const favoriteByPromptKey = useMemo(() => {
    const items = new Map<string, PromptFavorite>();
    favoriteItems.forEach((item) => {
      items.set(promptFavoriteRecordKey(item), item);
    });
    return items;
  }, [favoriteItems]);

  const promptPool = favoriteFilter === "favorites" ? visibleFavoritePrompts : prompts;

  const sourceFilteredPrompts = useMemo(() => {
    if (source === "all") return promptPool;
    return promptPool.filter((prompt) => prompt.source === source);
  }, [promptPool, source]);

  const keywordFilteredPrompts = useMemo(
    () => sourceFilteredPrompts.filter((prompt) => promptMatchesKeyword(getLocalizedPrompt(prompt), keyword)),
    [keyword, sourceFilteredPrompts],
  );

  const tags = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    keywordFilteredPrompts.forEach((prompt) => promptFilterTags(prompt).forEach((tag) => {
      if (seen.has(tag)) return;
      seen.add(tag);
      result.push(tag);
    }));
    return result;
  }, [keywordFilteredPrompts]);

  useEffect(() => {
    setTagFilters((current) => {
      const next = current.filter((tag) => tags.includes(tag));
      return next.length === current.length ? current : next;
    });
  }, [tags]);

  const filteredPrompts = useMemo(() => {
    const matchingPrompts = keywordFilteredPrompts.filter((prompt) => {
      const localizedPrompt = getLocalizedPrompt(prompt);
      const filterTags = promptFilterTags(localizedPrompt);
      return tagFilters.length === 0 || tagFilters.some((tag) => filterTags.includes(tag));
    });
    return sortPromptMarketPrompts(matchingPrompts);
  }, [keywordFilteredPrompts, tagFilters]);

  const visiblePrompts = filteredPrompts.slice(0, visibleCount);
  const hasMore = visiblePrompts.length < filteredPrompts.length;
  const categoryOptions = useMemo(
    () => [
      { id: "all", label: "全部" },
      ...sourceConfigs.filter((item) => item.enabled).map(({ id, label }) => ({ id, label })),
    ],
    [sourceConfigs],
  );
  const selectedCategory = categoryOptions.find((item) => item.id === source) ?? categoryOptions[0];
  const visibleCategoryOptions = categoryOptions.filter((item) => {
    const query = categorySearch.trim().toLowerCase();
    return !query || item.id.toLowerCase().includes(query) || item.label.toLowerCase().includes(query);
  });
  const setFavoriteBusy = (id: string, busy: boolean) => {
    setFavoriteBusyIds((current) => {
      const next = new Set(current);
      if (busy) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const toggleFavorite = async (prompt: BananaPrompt) => {
    const key = promptFavoriteKey(prompt);
    if (favoriteBusyIds.has(key)) {
      return;
    }

    const lifecycle = favoriteRequestLifecycleRef.current;
    const mutation = lifecycle.beginMutation();
    if (!mutation) return;

    const existing = favoriteByPromptKey.get(key);
    setIsLoadingFavorites(false);
    setFavoriteBusy(key, true);
    let reconcile = false;
    try {
      if (existing) {
        const data = await deletePromptFavorite(existing.id);
        const decision = lifecycle.completeMutation(mutation, true);
        if (!openRef.current || !decision.current) return;
        if (decision.applySnapshot) updateFavoriteItems(data.items);
        reconcile = decision.reconcile;
        toast.success("已取消收藏");
      } else {
        const data = await createPromptFavorite(prompt);
        const decision = lifecycle.completeMutation(mutation, true);
        if (!openRef.current || !decision.current) return;
        if (decision.applySnapshot) updateFavoriteItems(data.items);
        reconcile = decision.reconcile;
        toast.success("已收藏");
      }
    } catch (toggleError) {
      const decision = lifecycle.completeMutation(mutation, false);
      if (!openRef.current || !decision.current) return;
      reconcile = decision.reconcile;
      toast.error(toggleError instanceof Error ? toggleError.message : "收藏操作失败");
    } finally {
      if (openRef.current && lifecycle.isCurrentLifecycle(mutation)) {
        setFavoriteBusy(key, false);
      }
      if (reconcile && openRef.current) loadFavoriteData();
    }
  };

  const copyPrompt = async (prompt: BananaPrompt) => {
    try {
      await navigator.clipboard.writeText(prompt.prompt);
      toast.success("提示词已复制");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  const savePrompt = async (prompt: BananaPrompt) => {
    if (!onSavePrompt || saveBusyIds.has(prompt.id)) {
      return;
    }
    setSaveBusyIds((current) => new Set(current).add(prompt.id));
    try {
      await onSavePrompt(prompt);
    } finally {
      setSaveBusyIds((current) => {
        const next = new Set(current);
        next.delete(prompt.id);
        return next;
      });
    }
  };

  const renderFavoriteTabs = (className?: string) => (
    <div className={cn("flex h-10 rounded-full bg-[#f0f0f0] p-1", className)}>
      <button
        type="button"
        className={cn(
          "inline-flex min-w-0 flex-1 items-center justify-center rounded-full px-3 text-xs font-semibold text-muted-foreground transition",
          favoriteFilter === "all" && "bg-card text-foreground shadow-sm",
        )}
        onClick={() => setFavoriteFilter("all")}
      >
        全部
      </button>
      <button
        type="button"
        className={cn(
          "inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-semibold text-muted-foreground transition",
          favoriteFilter === "favorites" && "bg-card text-[#1456f0] shadow-sm",
        )}
        onClick={() => setFavoriteFilter("favorites")}
      >
        <Star className={cn("size-3.5", favoriteFilter === "favorites" && "fill-current")} />
        {visibleFavoritePrompts.length > 0 ? `收藏 ${visibleFavoritePrompts.length}` : "收藏"}
      </button>
    </div>
  );

  const renderCategoryFilters = () => (
    <Popover open={categoryOpen} onOpenChange={(nextOpen) => {
        setCategoryOpen(nextOpen);
        if (!nextOpen) setCategorySearch("");
      }}>
        <PopoverTrigger asChild>
          <Button
            data-prompt-category-select
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={categoryOpen}
            className="h-10 w-full min-w-0 justify-between px-3 font-normal"
          >
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">分类：</span>
              {selectedCategory.id === "all" ? selectedCategory.label : selectedCategory.id}
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(calc(100vw-2rem),32rem)] p-2">
          <div className="sticky top-0 z-10 bg-popover pb-2">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={categorySearch}
              onChange={(event) => setCategorySearch(event.target.value)}
              placeholder="搜索分类"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            {visibleCategoryOptions.length > 0 ? visibleCategoryOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setSource(item.id);
                  setCategoryOpen(false);
                  setCategorySearch("");
                }}
              >
                <Check className={cn("mt-0.5 size-4 shrink-0 text-primary", source !== item.id && "invisible")} />
                <span className="min-w-0 flex-1 break-words">{item.id === "all" ? item.label : item.id}</span>
              </button>
            )) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">没有匹配的分类</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
  );

  const content = (
    <>
        {presentation === "dialog" ? <DialogHeader className="block border-b border-border px-4 pt-4 pr-20 pb-3 sm:px-6 sm:pt-5 sm:pr-20 sm:pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-display text-xl font-semibold leading-tight sm:text-2xl">提示词库</h1>
              <p className="mt-2 hidden text-sm leading-6 text-muted-foreground sm:block">
                搜索、筛选并收藏提示词，也可以保存为文本素材或套用到创作台。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
              <span className="rounded-full bg-muted px-2.5 py-1 sm:px-3">
                {favoriteFilter === "favorites"
                  ? isLoadingFavorites
                    ? "读取收藏"
                    : `已收藏 ${filteredPrompts.length}`
                  : prompts.length > 0
                    ? `${filteredPrompts.length} / ${sourceFilteredPrompts.length}`
                    : "远程市场"}
              </span>
            </div>
          </div>
        </DialogHeader> : null}

        <div className="border-b border-border px-4 py-2.5 sm:px-6 sm:py-3">
          <div className="grid gap-2 md:grid-cols-[minmax(180px,1fr)_minmax(220px,340px)_150px]">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索标题或提示词"
                className="h-10 pl-9"
              />
            </div>
            {renderCategoryFilters()}
            {renderFavoriteTabs("w-full min-w-0")}
          </div>
          {tags.length > 0 ? (
            <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-[3rem_minmax(0,1fr)] sm:items-start">
              <span className="pt-1.5 text-xs font-medium text-muted-foreground">标签</span>
              <div className="flex min-w-0 items-start gap-2">
                <div className={cn(
                  "flex min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-hidden pb-0.5 transition-[max-height] duration-200",
                  tagsExpanded ? "max-h-64" : "max-h-8",
                )}>
                  <button
                    type="button"
                    onClick={() => setTagFilters([])}
                    aria-pressed={tagFilters.length === 0}
                    className={cn(
                      tagVariants({ selected: tagFilters.length === 0 }),
                      "shrink-0 cursor-pointer",
                    )}
                  >
                    全部
                  </button>
                  {tags.map((tag) => (
                    <TooltipButton
                      key={tag}
                      type="button"
                      onClick={() => setTagFilters((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}
                      className={cn(
                        tagVariants({ selected: tagFilters.includes(tag) }),
                        "max-w-44 shrink-0 cursor-pointer truncate",
                      )}
                      tooltip={tag}
                      aria-pressed={tagFilters.includes(tag)}
                    >
                      {tag}
                    </TooltipButton>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-xs text-muted-foreground"
                  onClick={() => setTagsExpanded((current) => !current)}
                  aria-expanded={tagsExpanded}
                >
                  {tagsExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                  {tagsExpanded ? "收起" : "展开"}
                </Button>
              </div>
            </div>
          ) : null}
          {favoriteError ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-[12px] bg-[#fff7ed] px-3 py-2 text-xs text-[#9a3412]">
              <span>{favoriteError}</span>
              <button type="button" className="font-semibold text-[#1456f0]" onClick={loadFavoriteData}>
                重试
              </button>
            </div>
          ) : null}
        </div>

        <ScrollArea ref={scrollAreaRef} className="min-h-0 flex-1 px-4 py-3 sm:px-6 sm:py-4">
          {favoriteFilter !== "favorites" && isLoading ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-muted-foreground">
              <LoaderCircle className="size-6 animate-spin text-[#1456f0]" />
              <p className="text-sm">正在读取远程提示词市场...</p>
            </div>
          ) : favoriteFilter !== "favorites" && error ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-4 text-center">
              <div className="max-w-[420px] text-sm leading-6 text-muted-foreground">{error}</div>
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                onClick={loadPromptData}
              >
                <RefreshCcw className="size-4" />
                重新加载
              </Button>
            </div>
          ) : favoriteFilter === "favorites" && isLoadingFavorites && favoriteItems.length === 0 ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-muted-foreground">
              <LoaderCircle className="size-6 animate-spin text-[#1456f0]" />
              <p className="text-sm">正在读取收藏...</p>
            </div>
          ) : visiblePrompts.length === 0 ? (
            <div className="flex h-full min-h-[320px] items-center justify-center text-sm text-muted-foreground">
              {favoriteFilter === "favorites"
                  ? visibleFavoritePrompts.length === 0
                    ? "还没有收藏提示词"
                    : "没有匹配的收藏提示词"
                : "没有找到匹配的提示词"}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div data-prompt-library-grid className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {visiblePrompts.map((prompt) => {
                  const localizedPrompt = getLocalizedPrompt(prompt);
                  const dateLabel = formatPromptDate(prompt.created);
                  const promptMetaLabels = [dateLabel].filter(
                    (label): label is string => Boolean(label),
                  );
                  const visibleTags = promptFilterTags(localizedPrompt).slice(0, 3);
                  const favoriteKey = promptFavoriteKey(prompt);
                  const isFavorite = favoriteIds.has(favoriteKey);
                  const isFavoriteBusy = favoriteBusyIds.has(favoriteKey);
                  return (
                    <article
                      key={prompt.id}
                      className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                    >
                      <button type="button" className="relative block aspect-[16/10] w-full overflow-hidden bg-muted text-left" onClick={() => setSelectedPrompt(localizedPrompt)} aria-label={`查看提示词：${localizedPrompt.title}`}>
                        <PromptPreviewImage prompt={localizedPrompt} />
                      </button>
                      <div className="flex min-h-[196px] flex-1 flex-col gap-3 p-4">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="font-display truncate text-base font-semibold text-foreground">
                              {localizedPrompt.title}
                            </h3>
                            {promptMetaLabels.length > 0 ? (
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                {promptMetaLabels.map((label) => (
                                  <span key={label}>{label}</span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <TooltipButton
                              type="button"
                              className={cn(
                                "inline-flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
                                isFavorite && "border-[#bfdbfe] bg-[#eef4ff] text-[#1456f0]",
                              )}
                              onClick={() => void toggleFavorite(prompt)}
                              disabled={isFavoriteBusy}
                              aria-label={isFavorite ? "取消收藏提示词" : "收藏提示词"}
                              tooltip={isFavorite ? "取消收藏" : "收藏"}
                            >
                              {isFavoriteBusy ? (
                                <LoaderCircle className="size-3.5 animate-spin" />
                              ) : (
                                <Star className={cn("size-3.5", isFavorite && "fill-current")} />
                              )}
                            </TooltipButton>
                          </div>
                        </div>
                        <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">{localizedPrompt.prompt}</p>
                        {prompt.source || prompt.referenceImageUrls.length > 0 || visibleTags.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                            {prompt.source ? (
                              <TooltipHint content={`分类：${prompt.source}`}><span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground/80">
                                <Tags className="size-3.5 shrink-0 text-[#1456f0]" />
                                <span className="max-w-52 truncate">分类：{prompt.source}</span>
                              </span></TooltipHint>
                            ) : null}
                            {prompt.referenceImageUrls.length > 0 ? (
                              <TooltipHint content="参考图数量"><span className="inline-flex items-center gap-1.5">
                                <Images className="size-3.5 shrink-0" />
                                参考图：{prompt.referenceImageUrls.length} 张
                              </span></TooltipHint>
                            ) : null}
                            {visibleTags.map((tag) => (
                              <TooltipButton
                                key={tag}
                                type="button"
                                onClick={() => setTagFilters((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}
                                className={cn(
                                  tagVariants({ selected: tagFilters.includes(tag) }),
                                  "max-w-40 cursor-pointer truncate",
                                )}
                                tooltip={tag}
                              >
                                {tag}
                              </TooltipButton>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-auto flex flex-wrap justify-end gap-2 border-t border-border pt-3">
                          {onSavePrompt ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-full border-border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                              disabled={saveBusyIds.has(localizedPrompt.id)}
                              onClick={() => void savePrompt(localizedPrompt)}
                            >
                              {saveBusyIds.has(localizedPrompt.id) ? <><LoaderCircle className="size-3.5 animate-spin" />保存中</> : "保存到我的素材"}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 rounded-full border-border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => void copyPrompt(localizedPrompt)}
                          >
                            <ClipboardCopy className="size-3.5" />
                            复制提示词
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 rounded-full bg-[#1456f0] px-4 text-xs text-white shadow-sm hover:bg-[#2563eb]"
                            onClick={() => void onApplyPrompt(localizedPrompt)}
                          >
                            套用
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              {hasMore ? (
                <div className="flex justify-center pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => setVisibleCount((current) => current + VISIBLE_COUNT_STEP)}
                  >
                    加载更多 ({visiblePrompts.length}/{filteredPrompts.length})
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </ScrollArea>
        <Dialog open={Boolean(selectedPrompt)} onOpenChange={(nextOpen) => !nextOpen && setSelectedPrompt(null)}>
          <DialogContent scrollable={false} className="flex max-h-[90dvh] w-[min(94vw,920px)] max-w-none flex-col overflow-hidden p-0">
            <div className="grid min-h-0 md:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
              <div className="flex min-h-64 items-center justify-center overflow-hidden bg-muted md:min-h-[560px]">
                {selectedPrompt ? <img src={selectedPrompt.preview} alt={selectedPrompt.title} className="max-h-[70dvh] size-full object-contain" /> : null}
              </div>
              <div className="flex min-h-0 flex-col p-5 pr-6 sm:p-6 sm:pr-7">
                <DialogTitle className="pr-20 text-xl leading-7">{selectedPrompt?.title}</DialogTitle>
                <DialogDescription className="mt-1.5">{selectedPrompt?.source}</DialogDescription>
                <ScrollArea className="mt-5 min-h-0 flex-1" viewportClassName="pr-3">
                  <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{selectedPrompt?.prompt}</p>
                  {selectedPrompt && promptFilterTags(selectedPrompt).length ? <div className="mt-4 flex flex-wrap gap-1.5">{promptFilterTags(selectedPrompt).map((tag) => <span key={tag} className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">{tag}</span>)}</div> : null}
                  {selectedPrompt?.referenceImageUrls.length ? <p className="mt-4 text-xs text-muted-foreground">包含 {selectedPrompt.referenceImageUrls.length} 张参考图，套用时会一并载入。</p> : null}
                </ScrollArea>
                <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                  {selectedPrompt && onSavePrompt ? <Button type="button" variant="outline" disabled={saveBusyIds.has(selectedPrompt.id)} onClick={() => void savePrompt(selectedPrompt)}>{saveBusyIds.has(selectedPrompt.id) ? <><LoaderCircle className="size-4 animate-spin" />保存中</> : "保存到我的素材"}</Button> : null}
                  {selectedPrompt ? <Button type="button" variant="outline" onClick={() => void copyPrompt(selectedPrompt)}><ClipboardCopy className="size-4" />复制提示词</Button> : null}
                  {selectedPrompt ? <Button type="button" onClick={() => void onApplyPrompt(selectedPrompt)}>套用到创作台</Button> : null}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
    </>
  );

  if (presentation === "page") {
    return <section className="card-surface flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border/80 shadow-[0_4px_16px_rgba(24,40,72,0.05)]">{content}</section>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent scrollable={false} className="flex h-[min(94dvh,860px)] w-[min(96vw,1180px)] max-w-none flex-col overflow-hidden rounded-[24px] p-0 sm:h-[min(90dvh,860px)] sm:rounded-[28px]">
        <DialogTitle className="sr-only">提示词库</DialogTitle>
        <DialogDescription className="sr-only">搜索、筛选、收藏并套用提示词。</DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  );
}
