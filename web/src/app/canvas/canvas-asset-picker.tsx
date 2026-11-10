import { LoadingState } from "@/components/ui/loading-state";
import { ItemMedia } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { AudioLines, ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Plus, Search, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AssetForm } from "@/app/assets/asset-form";
import { assetListKey, managedImageAsset } from "@/app/assets/asset-library";
import { assetLabels, assetMatchesGroup } from "@/app/assets/asset-filters";
import { useMyAssets } from "@/lib/use-my-assets";
import { canvasInsertPayloadFromMyAsset } from "@/app/canvas/agent/canvas-agent-starter";
import type { CanvasInsertAssetPayload } from "@/app/canvas/agent/canvas-agent-types";
import { ImagePreview } from "@/components/image-preview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { MultiSelect } from "@/components/ui/multi-select";
import { fetchAssetGroups, type AssetGroup } from "@/lib/asset-groups";
import { fetchManagedImages } from "@/lib/api";
import { fetchVisibleMyAssets, type MyAsset, type MyAssetKind } from "@/lib/my-assets";
import { cn } from "@/lib/utils";
import type { StoredAuthSession } from "@/lib/auth-session";

const PAGE_SIZE = 8;
const kinds: Array<{ value: "all" | MyAssetKind; label: string }> = [
  { value: "all", label: "全部" },
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
];

export function CanvasAssetPicker({ open, session, onInsert, onClose }: {
  open: boolean;
  session: StoredAuthSession;
  onInsert: (payload: CanvasInsertAssetPayload) => void;
  onClose: () => void;
}) {
  const { assets, upsertAsset, loading } = useMyAssets(session.key, open);
  const [sharedAssets, setSharedAssets] = useState<MyAsset[]>([]);
  const [managedAssets, setManagedAssets] = useState<MyAsset[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [tab, setTab] = useState<"my-assets" | "library">("my-assets");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | MyAssetKind>("all");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [groupFilters, setGroupFilters] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setTab("my-assets");
    setQuery("");
    setKind("all");
    setPage(1);
    setGroupFilters([]);
    setGroups([]);
    setGroupsLoaded(false);
    setSharedAssets([]);
    setManagedAssets([]);
    const controller = new AbortController();
    void fetchAssetGroups(controller.signal).then((items) => {
      if (!controller.signal.aborted) { setGroups(items); setGroupsLoaded(true); }
    }).catch((error) => {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "素材标签读取失败");
    });
    setRemoteLoading(true);
    const managed = session.role === "admin"
      ? fetchManagedImages({ scope: "all" }, { signal: controller.signal })
      : Promise.all([
        fetchManagedImages({ scope: "mine" }, { signal: controller.signal }),
        fetchManagedImages({ scope: "public" }, { signal: controller.signal }),
      ]).then(([mine, published]) => {
        const records = new Map(published.items.map((item) => [item.path, item]));
        mine.items.forEach((item) => records.set(item.path, item));
        return { items: [...records.values()], groups: [] };
      });
    void Promise.all([fetchVisibleMyAssets(session.key, controller.signal), managed])
      .then(([visible, images]) => {
        if (controller.signal.aborted) return;
        setSharedAssets(visible.filter((asset) => asset.owned !== true));
        setManagedAssets(images.items.map((item) => managedImageAsset(item, Boolean(item.owner_id && item.owner_id === session.subjectId))));
      })
      .catch((error) => {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? `素材库读取失败：${error.message}` : "素材库读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRemoteLoading(false);
      });
    return () => controller.abort();
  }, [open, session.key, session.role, session.subjectId]);

  const tabAssets = useMemo(() => {
    const source = tab === "my-assets"
      ? [...assets, ...managedAssets.filter((asset) => asset.owned === true)]
      : [...sharedAssets, ...managedAssets.filter((asset) => asset.owned !== true)];
    const records = new Map<string, MyAsset>();
    source.forEach((asset) => records.set(assetListKey(asset), asset));
    return [...records.values()].map((asset) => ({ ...asset, tags: assetLabels(asset, groups) }));
  }, [assets, managedAssets, sharedAssets, tab, groups]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tabAssets.filter((asset) => {
      if (kind !== "all" && asset.kind !== kind) return false;
      if (groupFilters.length && !groupFilters.some(group => assetMatchesGroup(asset, groups, group))) return false;
      return !keyword || [asset.title, asset.content, asset.source, ...(asset.tags || [])]
        .some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [groupFilters, groups, kind, query, tabAssets]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => setPage(1), [groupFilters, kind, query, tab]);
  useEffect(() => { setGroupFilters([]); }, [tab]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);

  const insert = (asset: MyAsset) => {
    const payload = canvasInsertPayloadFromMyAsset(asset);
    const content = payload.kind === "text" ? payload.content : payload.kind === "image" ? payload.dataUrl : payload.url;
    if (!content) return toast.error("素材内容不可用");
    onInsert(payload);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className={cn("sm:max-w-none", cn("h-[min(760px,92dvh)]", "flex w-[min(94vw,960px)] max-w-none flex-col overflow-hidden"))}>
          <DialogHeader className="shrink-0">
            <DialogTitle >选择素材</DialogTitle>
            <DialogDescription >选择文本、图片、视频或音频，点击即可插入画布。</DialogDescription>
          </DialogHeader>
          <div className="shrink-0 space-y-3 border-b border-border/60 px-4 py-3 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div role="group" aria-label="素材来源" className="inline-flex shrink-0 gap-1 p-1">
                {([{"value":"my-assets","label":"我的素材"},{"value":"library","label":"素材库"}] as const).map((item) => (
                  <Toggle  key={item.value} type="button" pressed={tab === item.value} onClick={() => setTab(item.value)} >{item.label}</Toggle>
                ))}
              </div>
              {tab === "my-assets" ? <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setCreateOpen(true)}><Plus  />新增素材</Button> : null}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <SearchInput containerClassName="min-w-0 flex-1"  value={query} onValueChange={setQuery} placeholder="搜索名称、内容或标签" aria-label="搜索素材" />
              <MultiSelect className="w-36 shrink-0 sm:w-48" value={groupFilters} onValueChange={setGroupFilters} disabled={!groupsLoaded} placeholder="全部标签" options={[{ value: "ungrouped", label: "未标签" }, ...groups.map(group => ({ value: group.id, label: group.name }))]} />
            </div>
            <ScrollAreaRoot role="group" data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-w-full" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain" aria-label="素材类型"><div className="min-w-0 flex w-max min-w-full gap-1">
              {kinds.map((item) => <Toggle  key={item.value} type="button" pressed={kind === item.value} onClick={() => setKind(item.value)} className="shrink-0">{item.label}</Toggle>)}
            </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
          </div>
          <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0 px-4 sm:px-6 py-4">
            {(loading || remoteLoading) && !tabAssets.length ? (
              <LoadingState className="h-72" label="正在加载素材" />
            ) : visible.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {visible.map((asset) => <CanvasAssetCard key={assetListKey(asset)} asset={asset} onInsert={() => insert(asset)} />)}
              </div>
            ) : (
              <EmptyState icon={Search} title={query || kind !== "all" || groupFilters.length > 0 ? "没有匹配的素材" : "暂无可用素材"} description={query || kind !== "all" || groupFilters.length > 0 ? "调整关键词、类型或标签后再试。" : "新增素材后，可以从这里插入画布。"} action={query || kind !== "all" || groupFilters.length > 0 ? <Button variant="outline" size="sm" onClick={() => { setQuery(""); setKind("all"); setGroupFilters([]); }}>清除筛选</Button> : tab === "my-assets" ? <Button size="sm" onClick={() => setCreateOpen(true)}><Plus />新增素材</Button> : undefined} />
            )}
          </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
          <DialogFooter className="m-0 shrink-0 min-h-14 flex-row items-center justify-between sm:justify-between">
            <span className="shrink-0 tabular-nums" role="status">{filtered.length} 个结果</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="icon"  aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft  /></Button>
              <span className="min-w-14 text-center tabular-nums">第 {page} / {totalPages} 页</span>
              <Button type="button" variant="ghost" size="icon"  aria-label="下一页" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight  /></Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AssetForm
        open={createOpen}
        asset={null}
        onClose={() => setCreateOpen(false)}
        onSave={async (asset) => {
          await upsertAsset(asset);
        }}
      />
    </>
  );
}

function CanvasAssetCard({ asset, onInsert }: { asset: MyAsset; onInsert: () => void }) {
  const Icon = asset.kind === "image" ? ImageIcon : asset.kind === "video" ? Video : asset.kind === "audio" ? AudioLines : FileText;
  const preview = asset.coverUrl || asset.url || "";
  const kindLabel = { text: "文本", image: "图片", video: "视频", audio: "音频" }[asset.kind];
  return (
    <Button variant="outline" type="button" aria-label={`插入素材：${asset.title}`} title={asset.title} className="block h-auto justify-start whitespace-normal p-0 group min-w-0 overflow-hidden text-left" onClick={onInsert}>
      <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden border-b border-border/40 bg-muted/35">
        {asset.kind === "image" && preview ? <PickerMediaPreview key={preview} src={preview} kind="image" title={asset.title} /> : null}
        {asset.kind === "video" && asset.coverUrl && asset.coverUrl !== asset.url ? <PickerMediaPreview key={asset.coverUrl} src={asset.coverUrl} kind="image" title={asset.title} /> : null}
        {asset.kind === "video" && (!asset.coverUrl || asset.coverUrl === asset.url) && asset.url ? <PickerMediaPreview key={asset.url} src={asset.url} kind="video" title={asset.title} /> : null}
        {asset.kind === "text" ? <p className="line-clamp-4 w-full whitespace-pre-wrap break-words px-3 text-xs leading-5 text-muted-foreground">{asset.content || "暂无文本内容"}</p> : null}
        {asset.kind === "audio" || (!preview && asset.kind !== "text") ? <ItemMedia variant="icon" className="grid size-12 place-items-center"><Icon  /></ItemMedia> : null}
        <Badge variant="secondary" className="pointer-events-none absolute right-2 top-2 size-6 p-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Plus /></Badge>
      </div>
      <div className="space-y-1.5 p-2.5 sm:p-3">
        <span className="line-clamp-2 min-h-8 break-words text-xs font-medium leading-4">{asset.title || "未命名素材"}</span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><Icon  />{kindLabel}</span>
      </div>
    </Button>
  );
}

function PickerMediaPreview({ src, kind, title }: { src: string; kind: "image" | "video"; title: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const mediaClass = cn("absolute inset-0 size-full object-cover", status !== "loaded" && "opacity-0");
  return <>
    {status === "loading" ? <LoadingState label="正在加载缩略图" className="absolute inset-0 min-h-0 gap-2 p-2" /> : status === "error" ? <EmptyState compact role="status" title="缩略图加载失败" className="absolute inset-0 min-h-0 p-2" /> : null}
    {kind === "image" ? <ImagePreview src={src} alt={title} loading="lazy" onLoad={() => setStatus("loaded")} onError={() => setStatus("error")} className={mediaClass} /> : <video src={`${src}#t=0.1`} muted playsInline preload="metadata" onLoadedData={() => setStatus("loaded")} onError={() => setStatus("error")} className={mediaClass} />}
  </>;
}
