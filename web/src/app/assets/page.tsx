"use client";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

import { Label } from "@/components/ui/label";
import { LibraryWorkspace } from "@/components/library-workspace";
import { LayoutGrid, List, Folder, Tags } from "lucide-react";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Item } from "@/components/ui/item";

import { Alert } from "@/components/ui/alert";



import { Toggle } from "@/components/ui/toggle";


import { TooltipHint } from "@/components/ui/tooltip";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Download, FileText, Globe2, Image as ImageIcon, LockKeyhole, MoreHorizontal, Plus, RefreshCw, Trash2, Video, X } from "lucide-react";
import { toast } from "sonner";

import { AssetCard, AssetListRow, AssetPreview } from "@/app/assets/asset-display";
import { useNavigate } from "react-router-dom";
import { AssetGroupMenu } from "@/app/assets/asset-groups";
import { assetLabels } from "@/app/assets/asset-filters";
import { useAssetGroups } from "@/lib/use-asset-groups";
import { assetListKey, assetModel, canManageAsset, collectAssetStorageKeys, managedImageAsset, mergeAssetLibrary, selectPersistedAssets, settleAssetOperations } from "@/app/assets/asset-library";
import { downloadMyAsset } from "@/app/assets/asset-media";
import { useMyAssets } from "@/lib/use-my-assets";
import { ManagementPage, ManagementPagination, ManagementToolbar } from "@/components/management-page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteManagedImages, fetchManagedImages, updateManagedImageVisibility } from "@/lib/api";
import { fetchVisibleMyAssets, type MyAsset, type MyAssetKind, type MyAssetVisibility } from "@/lib/my-assets";
import { LoadingState } from "@/components/ui/loading-state";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { copyWithToast } from "@/lib/clipboard-text";
import { AUTH_SESSION_CHANGE_EVENT, hasAPIPermission, type StoredAuthSession } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
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
  const sessionRevision = useAuthSessionRevision();
  if (isCheckingAuth || !session || getCachedAuthSession()?.key !== session.key) return <LoadingState label="正在加载我的素材..." />;
  return <AssetsContent key={`${session.key}:${sessionRevision}`} session={session} />;
}

function AssetsContent({ session }: { session: StoredAuthSession }) {
  const navigate = useNavigate();
  const scope = session.key;
  const { assets, upsertAsset, deleteAsset, loading } = useMyAssets(scope, true);
  const groupState = useAssetGroups(scope);
  const [groupFilter, setGroupFilter] = useState("all");
  const mutationControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    const handleSessionChange = () => {
      if (getCachedAuthSession()?.key !== session.key) controller.abort();
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
      controller.abort();
    };
  }, [session.key]);
  const [managedAssets, setManagedAssets] = useState<MyAsset[]>([]);
  const [managedLoading, setManagedLoading] = useState(true);
  const [managedError, setManagedError] = useState("");
  const [managedReloadKey, setManagedReloadKey] = useState(0);
  const [visibleRemoteAssets, setVisibleRemoteAssets] = useState<MyAsset[]>([]);
  const [visibleLoading, setVisibleLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [kind, setKind] = useState<"all" | MyAssetKind>("all");
  const [view, setView] = useState<"list" | "grid">("grid");
  const [visibility, setVisibility] = useState<"all" | MyAssetVisibility>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [preview, setPreview] = useState<MyAsset | null>(null);
  const [deleting, setDeleting] = useState<MyAsset | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const toolbarViewportRef = useRef<HTMLDivElement>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkActionBusy, setBulkActionBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setManagedLoading(true);
    setManagedError("");
    const load = async () => {
      if (session.role === "admin") {
        const { items } = await fetchManagedImages({ scope: "all" }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setManagedAssets(items.map((item) => managedImageAsset(item, Boolean(item.owner_id && item.owner_id === session.subjectId))));
        return;
      }
      const { items } = await fetchManagedImages({ scope: "visible" }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setManagedAssets(items.map((item) => managedImageAsset(item, Boolean(item.owner_id && item.owner_id === session.subjectId))));
    };
    void load()
      .catch((error) => {
        if (!controller.signal.aborted) setManagedError(error instanceof Error ? error.message : "生成图片读取失败");
      })
      .finally(() => { if (!controller.signal.aborted) setManagedLoading(false); });
    return () => controller.abort();
  }, [managedReloadKey, session]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setVisibleLoading(true);
    void fetchVisibleMyAssets(scope, controller.signal)
      .then((items) => { if (!controller.signal.aborted) setVisibleRemoteAssets(items.filter((item) => item.owned !== true)); })
      .catch((error) => {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? `共享素材读取失败：${error.message}` : "共享素材读取失败");
      })
      .finally(() => { if (!controller.signal.aborted) setVisibleLoading(false); });
    return () => controller.abort();
  }, [scope, session]);

  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const sourcesLoading = loading || visibleLoading || managedLoading;
  useEffect(() => {
    if (!sourcesLoading) setInitialLoadComplete(true);
  }, [sourcesLoading]);

  const allAssets = useMemo(() => {
    if (!initialLoadComplete) return [];
    return mergeAssetLibrary(assets, visibleRemoteAssets, managedAssets).map((asset) => ({ ...asset, tags: assetLabels(asset, groupState.groups) }));
  }, [assets, initialLoadComplete, managedAssets, visibleRemoteAssets, groupState.groups]);
  const availableGroupKeys = useMemo(() => new Set(allAssets.map(assetListKey)), [allAssets]);
  const groupedKeys = useMemo(() => new Set(groupState.groups.flatMap((group) => group.assetKeys)), [groupState.groups]);
  const activeGroupKeys = useMemo(() => new Set(groupState.groups.find((group) => group.id === groupFilter)?.assetKeys), [groupState.groups, groupFilter]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return allAssets.filter((asset) => {
      const key = assetListKey(asset);
      if (groupFilter === "ungrouped" && groupedKeys.has(key)) return false;
      if (groupFilter !== "all" && groupFilter !== "ungrouped" && !activeGroupKeys.has(key)) return false;
      if (kind !== "all" && asset.kind !== kind) return false;
      if (visibility !== "all" && asset.visibility !== visibility) return false;
      if (!query) return true;
      return [asset.title, asset.content || "", asset.url || "", asset.note || "", asset.source || "", asset.ownerName || "", asset.mimeType || "", assetModel(asset), ...asset.tags].join(" ").toLowerCase().includes(query);
    });
  }, [allAssets, kind, keyword, visibility, groupFilter, groupedKeys, activeGroupKeys]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleAssets = filtered.slice((page - 1) * pageSize, page * pageSize);
  const visibleKeys = visibleAssets.map(assetListKey);
  const selectedAssets = allAssets.filter((asset) => selectedKeys.has(assetListKey(asset)));
  const hasSelection = selectedAssets.length > 0;
  const selectedOnPage = visibleKeys.filter((key) => selectedKeys.has(key)).length;
  const allVisibleSelected = visibleKeys.length > 0 && selectedOnPage === visibleKeys.length;

  useLayoutEffect(() => {
    if (toolbarViewportRef.current) toolbarViewportRef.current.scrollLeft = 0;
  }, [hasSelection]);

  useEffect(() => setPage(1), [keyword, kind, pageSize, visibility, groupFilter]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  useEffect(() => {
    const availableKeys = new Set(allAssets.map(assetListKey));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => availableKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [allAssets]);

  const copyText = (asset: MyAsset) => copyWithToast(asset.content || "", "文本已复制");

  const download = async (asset: MyAsset) => {
    try {
      await downloadMyAsset(asset);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    }
  };

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    const signal = mutationControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    if (!canManageAsset(deleting)) {
      setDeleting(null);
      return toast.error("只能删除自己的素材");
    }
    setDeleteBusy(true);
    try {
      if (deleting.managedPath) {
        await deleteManagedImages([deleting.managedPath]);
        if (signal.aborted) return;
        setManagedAssets((current) => current.filter((item) => item.managedPath !== deleting.managedPath));
      } else {
        await deleteAsset(deleting.id);
        try {
          await createAssetStorageCleanup(assets.filter((item) => item.id !== deleting.id), signal)(deleting);
        } catch (error) {
          if (signal.aborted) return;
          toast.warning(error instanceof Error ? `素材记录已删除，文件清理失败：${error.message}` : "素材记录已删除，文件稍后清理");
        }
      }
      if (signal.aborted) return;
      if (preview?.id === deleting.id) setPreview(null);
      setSelectedKeys((current) => { const next = new Set(current); next.delete(assetListKey(deleting)); return next; });
      toast.success("素材已删除");
      setDeleting(null);
    } catch (error) {
      if (signal.aborted) return;
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
    const signal = mutationControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    setBulkActionBusy(true);
    let completed = 0;
    try {
      for (const asset of selectedAssets) {
        signal.throwIfAborted();
        await downloadMyAsset(asset);
        completed += 1;
      }
      if (!signal.aborted) toast.success(`已下载 ${completed} 个素材`);
    } catch (error) {
      if (signal.aborted) return;
      toast.error(error instanceof Error ? `已下载 ${completed} 个，剩余素材下载失败：${error.message}` : "批量下载失败");
    } finally {
      setBulkActionBusy(false);
    }
  };

  const deletableSelectedAssets = selectedAssets.filter((asset) => canManageAsset(asset) && (!asset.managedPath || hasAPIPermission(session, "DELETE", "/api/images")));
  const visibilityManageableAssets = selectedAssets.filter((asset) =>
    canManageAsset(asset) && (!asset.managedPath || hasAPIPermission(session, "PATCH", "/api/images/visibility")),
  );
  const selectedVisibility = visibilityManageableAssets.length > 0 && visibilityManageableAssets.every((asset) => asset.visibility === visibilityManageableAssets[0].visibility)
    ? visibilityManageableAssets[0].visibility
    : "";

  const updateSelectedVisibility = async (nextVisibility: MyAssetVisibility) => {
    if (bulkActionBusy) return;
    const signal = mutationControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    const targets = visibilityManageableAssets.filter((asset) => asset.visibility !== nextVisibility);
    if (!targets.length) return;
    setBulkActionBusy(true);
    const customTargets = selectPersistedAssets(assets, targets.filter((asset) => !asset.managedPath));
    const managedTargets = targets.filter((asset): asset is MyAsset & { managedPath: string } => Boolean(asset.managedPath));
    try {
      const managedResults = await settleAssetOperations(
        managedTargets, (asset) => updateManagedImageVisibility(asset.managedPath, nextVisibility), signal,
      );
      signal.throwIfAborted();
      const updatedAt = new Date().toISOString();
      const customResults = await settleAssetOperations(
        customTargets, (asset) => upsertAsset({ ...asset, visibility: nextVisibility, updatedAt }), signal,
      );
      signal.throwIfAborted();
      const updatedManagedPaths = new Set(managedResults.flatMap((result, index) =>
        result.status === "fulfilled" ? [managedTargets[index].managedPath] : [],
      ));
      const updatedCustomCount = customResults.filter((result) => result.status === "fulfilled").length;
      if (updatedManagedPaths.size) {
        setManagedAssets((current) => current.map((asset) =>
          asset.managedPath && updatedManagedPaths.has(asset.managedPath)
            ? { ...asset, visibility: nextVisibility, updatedAt }
            : asset,
        ));
      }
      const updatedCount = updatedCustomCount + updatedManagedPaths.size;
      const failedCount = managedTargets.length - updatedManagedPaths.size + customTargets.length - updatedCustomCount;
      if (failedCount) toast.error(`已更新 ${updatedCount} 项，${failedCount} 项更新失败`);
      else toast.success(`已将 ${updatedCount} 项设为${nextVisibility === "public" ? "公开" : "个人"}`);
    } catch (error) {
      if (signal.aborted) return;
      toast.error(error instanceof Error ? error.message : "可见范围更新失败");
    } finally {
      if (!signal.aborted) setBulkActionBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!deletableSelectedAssets.length || bulkActionBusy) return;
    const signal = mutationControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    setBulkActionBusy(true);
    const deletingKeys = new Set(deletableSelectedAssets.map(assetListKey));
    const managedPaths = deletableSelectedAssets.map((asset) => asset.managedPath).filter((path): path is string => Boolean(path));
    const ownedAssetsToDelete = assets.filter((asset) => deletingKeys.has(assetListKey(asset)));
    const deletedKeys = new Set<string>();
    const deletedOwnedAssets: MyAsset[] = [];
    let failedCount = 0;
    let firstError: unknown;
    try {
      if (managedPaths.length) {
        try {
          await deleteManagedImages(managedPaths);
          signal.throwIfAborted();
          for (const asset of deletableSelectedAssets) {
            if (asset.managedPath) deletedKeys.add(assetListKey(asset));
          }
          setManagedAssets((current) => current.filter((asset) => !asset.managedPath || !managedPaths.includes(asset.managedPath)));
        } catch (error) {
          signal.throwIfAborted();
          failedCount += managedPaths.length;
          firstError = error;
        }
      }
      signal.throwIfAborted();
      for (const asset of ownedAssetsToDelete) {
        signal.throwIfAborted();
        try {
          await deleteAsset(asset.id);
          deletedKeys.add(assetListKey(asset));
          deletedOwnedAssets.push(asset);
        } catch (error) {
          signal.throwIfAborted();
          failedCount += 1;
          firstError ??= error;
        }
      }
      const remainingOwnedAssets = assets.filter((asset) => !deletedKeys.has(assetListKey(asset)));
      const cleanup = createAssetStorageCleanup(remainingOwnedAssets, signal);
      const cleanupResults = await settleAssetOperations(deletedOwnedAssets, cleanup, signal);
      if (signal.aborted) return;
      setSelectedKeys((current) => new Set([...current].filter((key) => !deletedKeys.has(key))));
      setBulkDeleteOpen(false);
      if (failedCount) {
        toast.error(`已删除 ${deletedKeys.size} 个素材，${failedCount} 个删除失败${firstError instanceof Error ? `：${firstError.message}` : ""}`);
      } else {
        toast.success(`已删除 ${deletedKeys.size} 个素材`);
      }
      const cleanupFailures = cleanupResults.filter((result) => result.status === "rejected").length;
      if (cleanupFailures) toast.warning(`${cleanupFailures} 个素材文件清理失败，素材记录已删除`);
    } catch (error) {
      if (signal.aborted) return;
      toast.error(error instanceof Error ? error.message : "批量删除失败");
    } finally {
      setBulkActionBusy(false);
    }
  };


  const sectionTitle = groupFilter === "ungrouped" ? "未分类素材" : groupFilter !== "all" ? groupState.groups.find((group) => group.id === groupFilter)?.name || "素材标签" : kind === "all" ? "全部素材" : `${kindOptions.find((option) => option.value === kind)?.label}素材`;
  const createAsset = () => navigate("/assets/new");

  const Display = view === "list" ? AssetListRow : AssetCard;
  const assetItems = visibleAssets.map((asset, index) => {
    const key = assetListKey(asset);
    const canManage = canManageAsset(asset);
    return (
      <Display
        key={key}
        asset={asset}
        eager={index < 6}
        selected={selectedKeys.has(key)}
        onSelectedChange={(checked) =>
          setSelectedKeys((current) => {
            const next = new Set(current);
            if (checked) next.add(key);
            else next.delete(key);
            return next;
          })
        }
        onOpen={() => setPreview(asset)}
        onEdit={
          canManage && asset.kind !== "video" && !asset.managedPath
            ? () => {
                navigate(`/assets/${encodeURIComponent(asset.id)}/edit`);
              }
            : undefined
        }
        onDelete={
          canManage && (!asset.managedPath || hasAPIPermission(session, "DELETE", "/api/images"))
            ? () => setDeleting(asset)
            : undefined
        }
        onCopy={() => void copyText(asset)}
        onDownload={() => void download(asset)}
      />
    );
  });

  return (
    <ManagementPage data-assets-layout aria-label="我的素材">
      <LibraryWorkspace
        title="我的素材"
        sidebar={
          <>
            <nav aria-label="素材类型" className="space-y-1">
              {kindOptions.map((option) => {
                const Icon = option.value === "all" ? Folder : option.icon;
                return (
                  <Button
                    key={option.value}
                    data-library-filter
                    variant={groupFilter === "all" && kind === option.value ? "secondary" : "ghost"}
                    className="h-11 w-full justify-start font-normal"
                    onClick={() => {
                      setKind(option.value);
                      setGroupFilter("all");
                    }}
                  >
                    <Icon />
                    {option.value === "all" ? "全部素材" : option.label}
                  </Button>
                );
              })}
            </nav>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 px-2">
                <h2 className="text-xs text-muted-foreground">标签</h2>
                <AssetGroupMenu
                  state={groupState}
                  filter={groupFilter}
                  onFilterChange={(value) => {
                    setGroupFilter(value);
                    setKind("all");
                  }}
                  selectedKeys={[]}
                  availableKeys={availableGroupKeys}
                />
              </div>
              <Button
                data-library-filter
                variant={groupFilter === "ungrouped" ? "secondary" : "ghost"}
                className="h-11 w-full justify-start font-normal"
                onClick={() => {
                  setGroupFilter("ungrouped");
                  setKind("all");
                }}
              >
                <Tags />
                未分类素材
              </Button>
              {groupState.groups.map((group) => (
                <div key={group.id} className="flex min-w-0 items-center gap-1">
                  <Button
                    data-library-filter
                    variant={groupFilter === group.id ? "secondary" : "ghost"}
                    className="h-11 min-w-0 flex-1 justify-start font-normal"
                    onClick={() => {
                      setGroupFilter(group.id);
                      setKind("all");
                    }}
                  >
                    <Tags />
                    <span className="truncate">{group.name}</span>
                  </Button>
                  <AssetGroupMenu
                    state={groupState}
                    filter={groupFilter}
                    onFilterChange={setGroupFilter}
                    selectedKeys={[]}
                    availableKeys={availableGroupKeys}
                    group={group}
                  />
                </div>
              ))}
              {groupState.error ? (
                <Button variant="ghost" size="sm" onClick={groupState.reload}>
                  <RefreshCw />
                  重试读取标签
                </Button>
              ) : null}
            </div>
          </>
        }
      >
        {(sidebarToggle) => (
          <>
            <ManagementToolbar className="space-y-3">
              <div data-asset-filter-bar className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  {sidebarToggle}
                  <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{sectionTitle}</h1>
                </div>
                <div className="flex min-w-0 flex-1 basis-full items-center justify-end gap-2 sm:basis-auto">
                  <SearchInput
                    value={keyword}
                    onValueChange={setKeyword}
                    placeholder="搜索标题、标签、内容、来源或备注"
                    containerClassName="min-w-24 max-w-sm flex-1"
                  />
                  <Button onClick={createAsset}>
                    <Plus />
                    新增素材
                  </Button>
                </div>
              </div>
              <div data-asset-toolbar-row className="flex min-w-0 items-start gap-3">
                <ScrollAreaRoot type="auto" className="relative h-12 min-w-0 flex-1 overflow-hidden">
                  <ScrollAreaViewport ref={toolbarViewportRef} className="h-full w-full [&>div]:block!" tabIndex={0} role="region" aria-label="素材操作">
                    <div data-asset-selection-toolbar={hasSelection ? true : undefined} className="flex h-9 w-max min-w-full items-center gap-2">
                      {view === "grid" || hasSelection ? <Label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs has-disabled:cursor-not-allowed">
                        <Checkbox
                          aria-label="全选当前页"
                          checked={allVisibleSelected ? true : selectedOnPage > 0 ? "indeterminate" : false}
                          disabled={!visibleAssets.length}
                          onCheckedChange={(checked) => toggleVisibleSelection(checked === true)}
                        />
                        全选当前页
                      </Label> : null}
                      {hasSelection ? <>
                        <Item variant="muted" className="flex h-8 w-auto shrink-0 flex-nowrap items-center gap-1 py-1 pr-1 pl-2.5">
                          <span className="tabular-nums">已选 {selectedAssets.length} 项</span>
                          <TooltipHint content="清空选择">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="shrink-0"
                              onClick={() => setSelectedKeys(new Set())}
                              aria-label="清空选择"
                            >
                              <X />
                            </Button>
                          </TooltipHint>
                        </Item>
                        <AssetGroupMenu
                          state={groupState}
                          filter={groupFilter}
                          onFilterChange={setGroupFilter}
                          selectedKeys={selectedAssets.map(assetListKey)}
                          availableKeys={availableGroupKeys}
                        />
                        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
                          <Select
                            value={selectedVisibility}
                            disabled={!visibilityManageableAssets.length || bulkActionBusy}
                            onValueChange={(value: MyAssetVisibility) => void updateSelectedVisibility(value)}
                          >
                            <SelectTrigger className="w-28 shrink-0" aria-label="设置所选素材可见范围">
                              <SelectValue
                                placeholder="可见范围"
                                className="inline-flex min-w-0 items-center whitespace-nowrap [&>svg]:shrink-0"
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="private">
                                <LockKeyhole className="shrink-0" />
                                个人
                              </SelectItem>
                              <SelectItem value="public">
                                <Globe2 className="shrink-0" />
                                公开
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            variant="outline"
                            className="shrink-0"
                            disabled={!selectedAssets.length || bulkActionBusy}
                            onClick={() => void downloadSelected()}
                          >
                            <Download />
                            下载
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="shrink-0"
                            disabled={!deletableSelectedAssets.length || bulkActionBusy}
                            onClick={() => setBulkDeleteOpen(true)}
                          >
                            <Trash2 />
                            删除
                          </Button>
                        </div>
                      </> : (
                        <div role="group" aria-label="素材可见范围" className="flex items-center gap-1">
                          {visibilityOptions.map((option) => {
                            const Icon = option.icon;
                            return (
                              <Toggle
                                key={option.value}
                                pressed={visibility === option.value}
                                onPressedChange={() => setVisibility(option.value)}
                              >
                                {Icon ? <Icon /> : null}
                                {option.label}
                              </Toggle>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </ScrollAreaViewport>
                  <ScrollBar orientation="horizontal" />
                </ScrollAreaRoot>
                <div role="group" aria-label="素材视图" className="ml-auto flex items-center gap-1">
                  <Button
                    variant={view === "grid" ? "secondary" : "ghost"}
                    size="icon"
                    aria-label="卡片视图"
                    aria-pressed={view === "grid"}
                    onClick={() => setView("grid")}
                  >
                    <LayoutGrid />
                  </Button>
                  <Button
                    variant={view === "list" ? "secondary" : "ghost"}
                    size="icon"
                    aria-label="列表视图"
                    aria-pressed={view === "list"}
                    onClick={() => setView("list")}
                  >
                    <List />
                  </Button>
                </div>
              </div>
            </ManagementToolbar>
            <ScrollArea
              className="min-h-0 min-w-0 flex-1"
              contentClassName="p-4 pr-1 sm:p-6 sm:pr-3"
              onWheel={(event) => event.stopPropagation()}
            >
              <div data-asset-content className="flex min-w-0 w-full flex-col gap-[var(--page-section-gap)]">
                {managedError ? (
                  <Alert variant="destructive" role="alert" className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 break-words">生成图片读取失败：{managedError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setManagedReloadKey((value) => value + 1)}
                    >
                      <RefreshCw />
                      重试
                    </Button>
                  </Alert>
                ) : null}
                {!initialLoadComplete ? (
                  <LoadingState className="min-h-80" label="正在同步素材…" />
                ) : visibleAssets.length ? (
                  <>
                    {view === "list" ? (
                      <Table aria-label="素材列表" className="table-fixed">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10">
                              <Checkbox
                                aria-label="全选当前页"
                                checked={allVisibleSelected ? true : selectedOnPage > 0 ? "indeterminate" : false}
                                onCheckedChange={(checked) => toggleVisibleSelection(checked === true)}
                              />
                            </TableHead>
                            <TableHead>名称</TableHead>
                            <TableHead className="hidden w-36 md:table-cell">来源</TableHead>
                            <TableHead className="hidden w-44 xl:table-cell">更新时间</TableHead>
                            <TableHead className="w-12 text-right">操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>{assetItems}</TableBody>
                      </Table>
                    ) : (
                      <div data-asset-grid className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
                        {assetItems}
                      </div>
                    )}
                  </>
                ) : managedError && allAssets.length === 0 ? null : (
                  <EmptyState
                    icon={ImageIcon}
                    title={allAssets.length ? "没有找到匹配的素材" : "还没有可用素材"}
                    description={allAssets.length ? "调整搜索词或筛选条件后再试" : "上传或生成的素材会统一显示在这里"}
                    className="min-h-80"
                    action={
                      allAssets.length ? (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setKeyword("");
                            setKind("all");
                            setVisibility("all");
                            setGroupFilter("all");
                          }}
                        >
                          清除筛选
                        </Button>
                      ) : (
                        <Button
                          onClick={() => {
                            createAsset();
                          }}
                        >
                          <Plus />
                          新增素材
                        </Button>
                      )
                    }
                  />
                )}
              </div>
            </ScrollArea>
            {!initialLoadComplete ? (
              <div className="min-h-16 shrink-0 border-t border-border" />
            ) : (
              <ManagementPagination
                page={page}
                totalPages={totalPages}
                totalItems={filtered.length}
                pageSize={pageSize}
                pageSizeOptions={[12, 24, 48, 96]}
                itemLabel="项"
                onPageChange={setPage}
                onPageSizeChange={(value) => {
                  setPageSize(value);
                  setPage(1);
                }}
              />
            )}
          </>
        )}
      </LibraryWorkspace>
      <AssetPreview asset={preview ? { ...preview, tags: assetLabels(preview, groupState.groups) } : null} onClose={() => setPreview(null)} onDownload={() => preview && void download(preview)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && !deleteBusy && setDeleting(null)}
        title="删除素材？"
        description={<>{deleting?.managedPath ? `确定永久删除生成图片“${deleting.title}”吗？` : `确定删除“${deleting?.title}”吗？删除后会同步到当前账号。`}</>}
        confirmLabel="删除"
        busy={deleteBusy}
        destructive
        onConfirm={() => void confirmDelete()}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !bulkActionBusy && setBulkDeleteOpen(open)}
        title="批量删除素材？"
        description={<>将永久删除选中的 {deletableSelectedAssets.length} 个自有素材。共享素材和无删除权限的素材不会被删除。</>}
        confirmLabel={`删除 ${deletableSelectedAssets.length} 项`}
        busy={bulkActionBusy}
        destructive
        onConfirm={() => void deleteSelected()}
      />
    </ManagementPage>
  );
}

function createAssetStorageCleanup(remainingAssets: MyAsset[], signal: AbortSignal) {
  const usedKeys = collectAssetStorageKeys(remainingAssets);
  const deletionRequests = new Map<string, Promise<void>>();
  let canvasReferences: Promise<void> | null = null;
  const loadCanvasReferences = async () => {
    const workspace = await fetchCanvasDocument();
    signal.throwIfAborted();
    collectAssetStorageKeys(workspace.document, usedKeys);
    for (const project of workspace.projects) {
      if (project.id === workspace.document.id) continue;
      const projectWorkspace = await fetchCanvasDocument(project.id);
      signal.throwIfAborted();
      collectAssetStorageKeys(projectWorkspace.document, usedKeys);
    }
  };
  return async (asset: MyAsset) => {
    signal.throwIfAborted();
    if (asset.kind === "text" || !asset.storageKey || usedKeys.has(asset.storageKey)) return;
    // Share only this operation's reference reads; the server still checks each deletion.
    canvasReferences ??= loadCanvasReferences();
    await canvasReferences;
    signal.throwIfAborted();
    if (usedKeys.has(asset.storageKey)) return;
    let deletion = deletionRequests.get(asset.storageKey);
    if (!deletion) {
      deletion = asset.kind === "image"
        ? deleteStoredImages([asset.storageKey])
        : deleteStoredMedia([asset.storageKey]);
      deletionRequests.set(asset.storageKey, deletion);
    }
    await deletion;
  };
}
