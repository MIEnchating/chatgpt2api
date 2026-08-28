import { AudioLines, FileText, Image as ImageIcon, LoaderCircle, Plus, Search, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AssetForm } from "@/app/assets/asset-form";
import { assetListKey, managedImageAsset } from "@/app/assets/asset-library";
import { useMyAssets } from "@/app/assets/use-my-assets";
import { canvasInsertPayloadFromMyAsset } from "@/app/canvas/agent/canvas-agent-starter";
import type { CanvasInsertAssetPayload } from "@/app/canvas/agent/canvas-agent-types";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchManagedImages } from "@/lib/api";
import { fetchVisibleMyAssets, type MyAsset, type MyAssetKind } from "@/lib/my-assets";
import { cn } from "@/lib/utils";
import type { StoredAuthSession } from "@/store/auth";

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
  const { assets, setAssets, loading } = useMyAssets(session.key, open);
  const [sharedAssets, setSharedAssets] = useState<MyAsset[]>([]);
  const [managedAssets, setManagedAssets] = useState<MyAsset[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [tab, setTab] = useState<"my-assets" | "library">("my-assets");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | MyAssetKind>("all");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab("my-assets");
    setQuery("");
    setKind("all");
    setPage(1);
    const controller = new AbortController();
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
    void Promise.all([fetchVisibleMyAssets(controller.signal), managed])
      .then(([visible, images]) => {
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
  }, [open, session.role, session.subjectId]);

  const tabAssets = useMemo(() => {
    const source = tab === "my-assets"
      ? [...assets, ...managedAssets.filter((asset) => asset.owned === true)]
      : [...sharedAssets, ...managedAssets.filter((asset) => asset.owned !== true)];
    const records = new Map<string, MyAsset>();
    source.forEach((asset) => records.set(assetListKey(asset), asset));
    return [...records.values()];
  }, [assets, managedAssets, sharedAssets, tab]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tabAssets.filter((asset) => {
      if (kind !== "all" && asset.kind !== kind) return false;
      return !keyword || [asset.title, asset.content, asset.source, ...(asset.tags || [])]
        .some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [kind, query, tabAssets]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => setPage(1), [kind, query, tab]);
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
        <DialogContent scrollable={false} className="flex max-h-[90dvh] w-[min(94vw,900px)] max-w-none flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 sm:px-6">
            <DialogTitle>选择素材</DialogTitle>
            <DialogDescription>从我的素材或公开素材库插入文本、图片、视频和音频。</DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-5 pt-3 sm:px-6">
            {([{"value":"my-assets","label":"我的素材"},{"value":"library","label":"素材库"}] as const).map((item) => (
              <button key={item.value} type="button" onClick={() => setTab(item.value)} className={cn("h-9 border-b-2 px-3 text-sm font-medium text-muted-foreground", tab === item.value ? "border-[#1456f0] text-[#1456f0]" : "border-transparent")}>{item.label}</button>
            ))}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-4 sm:px-6">
            <div className="relative min-w-52 flex-1"><Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" placeholder="搜索素材" /></div>
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1">
              {kinds.map((item) => <button key={item.value} type="button" onClick={() => setKind(item.value)} className={cn("h-8 shrink-0 rounded-md px-2.5 text-xs font-medium text-muted-foreground", kind === item.value && "bg-card text-foreground shadow-sm")}>{item.label}</button>)}
            </div>
            {tab === "my-assets" ? <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}><Plus />新增素材</Button> : null}
          </div>
          <ScrollArea className="min-h-0 flex-1" viewportClassName="px-5 py-4 sm:px-6">
            {(loading || remoteLoading) && !tabAssets.length ? (
              <div className="grid h-72 place-items-center text-sm text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>
            ) : visible.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {visible.map((asset) => <CanvasAssetCard key={assetListKey(asset)} asset={asset} onInsert={() => insert(asset)} />)}
              </div>
            ) : (
              <div className="grid h-72 place-items-center text-sm text-muted-foreground">没有素材</div>
            )}
          </ScrollArea>
          {filtered.length > PAGE_SIZE ? (
            <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
              <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
              <span>第 {page} / {totalPages} 页</span>
              <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>下一页</Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <AssetForm
        open={createOpen}
        asset={null}
        onClose={() => setCreateOpen(false)}
        onSave={(asset) => {
          setAssets((current) => [asset, ...current]);
          setCreateOpen(false);
        }}
      />
    </>
  );
}

function CanvasAssetCard({ asset, onInsert }: { asset: MyAsset; onInsert: () => void }) {
  const Icon = asset.kind === "image" ? ImageIcon : asset.kind === "video" ? Video : asset.kind === "audio" ? AudioLines : FileText;
  const preview = asset.coverUrl || asset.url || "";
  return (
    <button type="button" className="group min-w-0 overflow-hidden rounded-lg border border-border bg-card text-left transition hover:border-[#9bb8f8] hover:shadow-md" onClick={onInsert}>
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/50">
        {asset.kind === "image" && preview ? <AuthenticatedImage src={preview} alt={asset.title} className="size-full object-cover" /> : null}
        {asset.kind === "video" && preview ? <video src={`${preview}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" /> : null}
        {asset.kind === "text" ? <p className="line-clamp-6 p-4 text-xs leading-5 text-muted-foreground">{asset.content}</p> : null}
        {asset.kind === "audio" || (!preview && asset.kind !== "text") ? <Icon className="size-9 text-muted-foreground" /> : null}
      </div>
      <div className="flex items-center justify-between gap-2 p-2.5">
        <span className="truncate text-xs font-medium">{asset.title}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{{ text: "文本", image: "图片", video: "视频", audio: "音频" }[asset.kind]}</span>
      </div>
    </button>
  );
}
