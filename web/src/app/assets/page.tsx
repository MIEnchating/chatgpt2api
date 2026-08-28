"use client";

import { useEffect, useMemo, useState } from "react";
import { AudioLines, ChevronLeft, ChevronRight, Download, FileText, Globe2, Image as ImageIcon, LockKeyhole, MoreHorizontal, Plus, Search, Trash2, Video, X } from "lucide-react";
import { toast } from "sonner";

import { AssetCard, AssetPreview } from "@/app/assets/asset-display";
import { AssetForm } from "@/app/assets/asset-form";
import { assetListKey, canManageAsset, collectAssetStorageKeys, managedImageAsset, mergeAssetLibrary } from "@/app/assets/asset-library";
import { downloadMyAsset } from "@/app/assets/asset-media";
import { useMyAssets } from "@/app/assets/use-my-assets";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteManagedImages, fetchManagedImages } from "@/lib/api";
import { fetchVisibleMyAssets, type MyAsset, type MyAssetKind, type MyAssetVisibility } from "@/lib/my-assets";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";
import { hasAPIPermission } from "@/store/auth";
import { fetchCanvasDocument } from "@/services/api/canvas";
import { deleteStoredMedia } from "@/services/file-storage";
import { deleteStoredImages } from "@/services/image-storage";

const kindOptions: Array<{ value: "all" | MyAssetKind; label: string; icon: typeof FileText }> = [
  { value: "all", label: "全部", icon: MoreHorizontal },
  { value: "text", label: "文本", icon: FileText },
  { value: "image", label: "图片", icon: ImageIcon },
  { value: "video", label: "视频", icon: Video },
  { value: "audio", label: "音频", icon: AudioLines },
];

const visibilityOptions: Array<{ value: "all" | MyAssetVisibility; label: string; icon?: typeof LockKeyhole }> = [
  { value: "all", label: "全部" },
  { value: "private", label: "个人", icon: LockKeyhole },
  { value: "public", label: "公开", icon: Globe2 },
];

export default function AssetsPage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/assets");
  const scope = session?.key || "anonymous";
  const { assets, setAssets, loading } = useMyAssets(scope, Boolean(session));
  const [managedAssets, setManagedAssets] = useState<MyAsset[]>([]);
  const [visibleRemoteAssets, setVisibleRemoteAssets] = useState<MyAsset[]>([]);
  const [visibleLoading, setVisibleLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [kind, setKind] = useState<"all" | MyAssetKind>("all");
  const [visibility, setVisibility] = useState<"all" | MyAssetVisibility>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [editing, setEditing] = useState<MyAsset | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [preview, setPreview] = useState<MyAsset | null>(null);
  const [deleting, setDeleting] = useState<MyAsset | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkActionBusy, setBulkActionBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    const load = async () => {
      if (session.role === "admin") {
        const { items } = await fetchManagedImages({ scope: "all" }, { signal: controller.signal });
        setManagedAssets(items.map((item) => managedImageAsset(item, Boolean(item.owner_id && item.owner_id === session.subjectId))));
        return;
      }
      const [mine, published] = await Promise.all([
        fetchManagedImages({ scope: "mine" }, { signal: controller.signal }),
        fetchManagedImages({ scope: "public" }, { signal: controller.signal }),
      ]);
      const records = new Map<string, MyAsset>();
      published.items.forEach((item) => records.set(item.path, managedImageAsset(item, Boolean(item.owner_id && item.owner_id === session.subjectId))));
      mine.items.forEach((item) => records.set(item.path, managedImageAsset(item, true)));
      setManagedAssets(Array.from(records.values()));
    };
    void load()
      .catch((error) => {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? `生成图片读取失败：${error.message}` : "生成图片读取失败");
      });
    return () => controller.abort();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setVisibleLoading(true);
    void fetchVisibleMyAssets(controller.signal)
      .then((items) => setVisibleRemoteAssets(items.filter((item) => item.owned !== true)))
      .catch((error) => {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? `共享素材读取失败：${error.message}` : "共享素材读取失败");
      })
      .finally(() => { if (!controller.signal.aborted) setVisibleLoading(false); });
    return () => controller.abort();
  }, [session]);

  const allAssets = useMemo(() => {
    return mergeAssetLibrary(assets, visibleRemoteAssets, managedAssets);
  }, [assets, managedAssets, visibleRemoteAssets]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return allAssets.filter((asset) => {
      if (kind !== "all" && asset.kind !== kind) return false;
      if (visibility !== "all" && asset.visibility !== visibility) return false;
      if (!query) return true;
      return [asset.title, asset.content || "", asset.url || "", asset.note || "", asset.source || "", asset.ownerName || "", asset.mimeType || ""].join(" ").toLowerCase().includes(query);
    });
  }, [allAssets, kind, keyword, visibility]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleAssets = filtered.slice((page - 1) * pageSize, page * pageSize);
  const visibleKeys = visibleAssets.map(assetListKey);
  const selectedAssets = allAssets.filter((asset) => selectedKeys.has(assetListKey(asset)));
  const selectedOnPage = visibleKeys.filter((key) => selectedKeys.has(key)).length;
  const allVisibleSelected = visibleKeys.length > 0 && selectedOnPage === visibleKeys.length;

  useEffect(() => setPage(1), [keyword, kind, pageSize, visibility]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  useEffect(() => {
    const availableKeys = new Set(allAssets.map(assetListKey));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => availableKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [allAssets]);

  if (isCheckingAuth || !session) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载我的素材...</div>;

  const copyText = async (asset: MyAsset) => {
    try {
      await navigator.clipboard.writeText(asset.content || "");
      toast.success("文本已复制");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  const download = async (asset: MyAsset) => {
    try {
      await downloadMyAsset(asset);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    }
  };

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    if (!canManageAsset(deleting)) {
      setDeleting(null);
      return toast.error("只能删除自己的素材");
    }
    setDeleteBusy(true);
    try {
      if (deleting.managedPath) {
        await deleteManagedImages([deleting.managedPath]);
        setManagedAssets((current) => current.filter((item) => item.managedPath !== deleting.managedPath));
      } else {
        await deleteUnusedAssetStorage(deleting, assets.filter((item) => item.id !== deleting.id));
        setAssets((current) => current.filter((item) => item.id !== deleting.id));
      }
      if (preview?.id === deleting.id) setPreview(null);
      setSelectedKeys((current) => { const next = new Set(current); next.delete(assetListKey(deleting)); return next; });
      toast.success("素材已删除");
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleteBusy(false);
    }
  };

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      visibleKeys.forEach((key) => checked ? next.add(key) : next.delete(key));
      return next;
    });
  };

  const downloadSelected = async () => {
    if (!selectedAssets.length || bulkActionBusy) return;
    setBulkActionBusy(true);
    let completed = 0;
    try {
      for (const asset of selectedAssets) {
        await downloadMyAsset(asset);
        completed += 1;
      }
      toast.success(`已下载 ${completed} 个素材`);
    } catch (error) {
      toast.error(error instanceof Error ? `已下载 ${completed} 个，剩余素材下载失败：${error.message}` : "批量下载失败");
    } finally {
      setBulkActionBusy(false);
    }
  };

  const deletableSelectedAssets = selectedAssets.filter((asset) => canManageAsset(asset) && (!asset.managedPath || hasAPIPermission(session, "DELETE", "/api/images")));

  const deleteSelected = async () => {
    if (!deletableSelectedAssets.length || bulkActionBusy) return;
    setBulkActionBusy(true);
    const deletingKeys = new Set(deletableSelectedAssets.map(assetListKey));
    const managedPaths = deletableSelectedAssets.map((asset) => asset.managedPath).filter((path): path is string => Boolean(path));
    const ownedAssetsToDelete = assets.filter((asset) => deletingKeys.has(assetListKey(asset)));
    const remainingOwnedAssets = assets.filter((asset) => !deletingKeys.has(assetListKey(asset)));
    try {
      if (managedPaths.length) await deleteManagedImages(managedPaths);
      for (const asset of ownedAssetsToDelete) await deleteUnusedAssetStorage(asset, remainingOwnedAssets);
      if (managedPaths.length) setManagedAssets((current) => current.filter((asset) => !asset.managedPath || !managedPaths.includes(asset.managedPath)));
      if (ownedAssetsToDelete.length) setAssets(remainingOwnedAssets);
      setSelectedKeys(new Set());
      setBulkDeleteOpen(false);
      toast.success(`已删除 ${deletableSelectedAssets.length} 个素材`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量删除失败");
    } finally {
      setBulkActionBusy(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <PageHeader actions={<Button type="button" onClick={() => { setEditing(null); setFormOpen(true); }}><Plus />新增素材</Button>} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="shrink-0 border-b border-border px-5 py-3 sm:px-8">
        <div data-asset-filter-bar className="flex w-full flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、内容、来源、所有者或备注" className="pl-9" /></div>
          <div className="hide-scrollbar flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1">{kindOptions.map((option) => { const Icon = option.icon; return <button key={option.value} type="button" onClick={() => setKind(option.value)} className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition", kind === option.value && "bg-card text-foreground shadow-sm")}>{option.value === "all" ? null : <Icon className="size-3.5" />}{option.label}</button>; })}</div>
          <div className="hide-scrollbar flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1">{visibilityOptions.map((option) => { const Icon = option.icon; return <button key={option.value} type="button" onClick={() => setVisibility(option.value)} className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition", visibility === option.value && "bg-card text-foreground shadow-sm")}>{Icon ? <Icon className="size-3.5" /> : null}{option.label}</button>; })}</div>
        </div>
        </div>
        <div data-asset-selection-toolbar className="hide-scrollbar flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-5 sm:px-8">
          <label data-disabled={!visibleAssets.length} className="selection-trigger flex shrink-0 items-center gap-2 text-xs font-medium"><Checkbox checked={allVisibleSelected ? true : selectedOnPage > 0 ? "indeterminate" : false} disabled={!visibleAssets.length} onCheckedChange={(checked) => toggleVisibleSelection(checked === true)} /><span>全选当前页</span></label>
          <span className="min-w-16 shrink-0 text-xs text-muted-foreground tabular-nums">已选 {selectedAssets.length} 项</span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 w-[72px] shrink-0 px-2" disabled={!selectedAssets.length || bulkActionBusy} onClick={() => void downloadSelected()}><Download />下载</Button>
            <Button type="button" variant="outline" size="sm" className="h-8 w-[72px] shrink-0 px-2 text-rose-600 hover:text-rose-600" disabled={!deletableSelectedAssets.length || bulkActionBusy} onClick={() => setBulkDeleteOpen(true)}><Trash2 />删除</Button>
            <Button type="button" variant="ghost" size="icon" className={cn("size-8 shrink-0", !selectedAssets.length && "invisible")} disabled={!selectedAssets.length} onClick={() => setSelectedKeys(new Set())} aria-label="清空选择" title="清空选择"><X /></Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-5 py-5 sm:px-8">
        <div data-asset-content className="flex w-full flex-col gap-5">
          {(loading || visibleLoading) && allAssets.length === 0 ? <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">正在同步素材...</div> : visibleAssets.length ? <div data-asset-grid className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">{visibleAssets.map((asset) => { const key = assetListKey(asset); const canManage = canManageAsset(asset); return <AssetCard key={key} asset={asset} selected={selectedKeys.has(key)} onSelectedChange={(checked) => setSelectedKeys((current) => { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next; })} onOpen={() => setPreview(asset)} onEdit={canManage && !asset.managedPath ? () => { setEditing(asset); setFormOpen(true); } : undefined} onDelete={canManage && (!asset.managedPath || hasAPIPermission(session, "DELETE", "/api/images")) ? () => setDeleting(asset) : undefined} onCopy={() => void copyText(asset)} onDownload={() => void download(asset)} />; })}</div> : <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">{allAssets.length ? "没有找到匹配的素材" : "还没有可用素材"}</div>}
        </div>
        </ScrollArea>
        <div data-asset-pagination className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-2 sm:px-8">
          <span className="text-xs text-muted-foreground">共 {filtered.length} 项</span>
          <div className="flex items-center gap-2"><Button type="button" variant="outline" size="icon" disabled={page <= 1 || !filtered.length} onClick={() => setPage((value) => value - 1)} aria-label="上一页"><ChevronLeft /></Button><span className="min-w-24 text-center text-xs text-muted-foreground">第 {filtered.length ? page : 0} / {filtered.length ? totalPages : 0} 页</span><Button type="button" variant="outline" size="icon" disabled={page >= totalPages || !filtered.length} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight /></Button></div>
          <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{[12, 24, 48, 96].map((value) => <SelectItem key={value} value={String(value)}>{value} 条</SelectItem>)}</SelectGroup></SelectContent></Select>
        </div>
      </div>
      <AssetForm open={formOpen} asset={editing} onClose={() => setFormOpen(false)} onSave={(next) => { setAssets((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current]); setFormOpen(false); }} />
      <AssetPreview asset={preview} onClose={() => setPreview(null)} onCopy={() => preview && void copyText(preview)} onDownload={() => preview && void download(preview)} />
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && !deleteBusy && setDeleting(null)}><DialogContent className="w-[min(92vw,420px)]"><DialogHeader><DialogTitle>删除素材？</DialogTitle><DialogDescription>{deleting?.managedPath ? `确定永久删除生成图片“${deleting.title}”吗？` : `确定删除“${deleting?.title}”吗？删除后会同步到当前账号。`}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" disabled={deleteBusy} onClick={() => setDeleting(null)}>取消</Button><Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void confirmDelete()}>{deleteBusy ? "删除中" : "删除"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={bulkDeleteOpen} onOpenChange={(open) => !bulkActionBusy && setBulkDeleteOpen(open)}><DialogContent className="w-[min(92vw,440px)]"><DialogHeader><DialogTitle>批量删除素材？</DialogTitle><DialogDescription>将永久删除选中的 {deletableSelectedAssets.length} 个自有素材。共享素材和无删除权限的素材不会被删除。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" disabled={bulkActionBusy} onClick={() => setBulkDeleteOpen(false)}>取消</Button><Button type="button" variant="destructive" disabled={bulkActionBusy} onClick={() => void deleteSelected()}>{bulkActionBusy ? "删除中" : `删除 ${deletableSelectedAssets.length} 项`}</Button></DialogFooter></DialogContent></Dialog>
    </section>
  );
}

async function deleteUnusedAssetStorage(asset: MyAsset, remainingAssets: MyAsset[]) {
  if (asset.kind === "text" || !asset.storageKey) return;
  const usedKeys = collectAssetStorageKeys(remainingAssets);
  const workspace = await fetchCanvasDocument();
  collectAssetStorageKeys(workspace.document, usedKeys);
  for (const project of workspace.projects) {
    if (project.id === workspace.document.id) continue;
    const projectWorkspace = await fetchCanvasDocument(project.id);
    collectAssetStorageKeys(projectWorkspace.document, usedKeys);
  }
  if (usedKeys.has(asset.storageKey)) return;
  if (asset.kind === "image") await deleteStoredImages([asset.storageKey]);
  else await deleteStoredMedia([asset.storageKey]);
}
