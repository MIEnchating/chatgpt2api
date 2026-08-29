"use client";

import { useEffect, useState } from "react";
import { AudioLines, Copy, Download, FileText, Globe2, Image as ImageIcon, LockKeyhole, Pencil, Trash2, Video } from "lucide-react";

import { assetMediaSummary } from "@/app/assets/asset-media";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { MyAsset, MyAssetKind } from "@/lib/my-assets";
import { resolveMediaURL } from "@/services/file-storage";
import { resolveImageURL } from "@/services/image-storage";

export function AssetCard({ asset, selected = false, onSelectedChange, onOpen, onEdit, onDelete, onCopy, onDownload }: { asset: MyAsset; selected?: boolean; onSelectedChange?: (selected: boolean) => void; onOpen: () => void; onEdit?: () => void; onDelete?: () => void; onCopy: () => void; onDownload: () => void }) {
  const Icon = asset.kind === "text" ? FileText : asset.kind === "image" ? ImageIcon : asset.kind === "video" ? Video : AudioLines;
  const { coverURL, mediaURL } = useResolvedAssetURLs(asset);
  return (
    <article data-selected={selected} data-interaction="trigger" className="interactive-card group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      {onSelectedChange ? <div className="selection-control-frame absolute top-3 left-3 z-10 rounded-md"><Checkbox checked={selected} onCheckedChange={(checked) => onSelectedChange(checked === true)} className="selection-control size-5 shadow-none" aria-label={`选择素材 ${asset.title}`} /></div> : null}
      <button type="button" className="interactive-card-trigger block w-full text-left" onClick={onOpen} aria-label={`查看素材 ${asset.title}`}>
        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/35">
          {coverURL ? <AuthenticatedImage src={coverURL} alt={asset.title} className="size-full object-cover" /> : asset.kind === "image" && mediaURL ? <AuthenticatedImage src={mediaURL} alt={asset.title} className="size-full object-cover" /> : asset.kind === "video" && mediaURL ? <video src={`${mediaURL}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" /> : asset.kind === "audio" ? <AudioLines className="size-12 text-[#1456f0]" /> : <div className="flex w-full flex-col items-center gap-3 px-5 text-center"><Icon className="size-9 text-[#1456f0]" /><p className="line-clamp-5 text-sm leading-6 text-muted-foreground">{asset.content || "文本素材"}</p></div>}
        </div>
      </button>
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{asset.title}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{asset.ownerName && !asset.owned ? asset.ownerName : asset.source || "未标注来源"}</p></div><div className="flex shrink-0 items-center gap-1"><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{assetKindLabel(asset.kind)}</span><span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{asset.visibility === "public" ? <Globe2 className="size-3" /> : <LockKeyhole className="size-3" />}{asset.visibility === "public" ? "公开" : "个人"}</span></div></div>
        <p className="mt-2 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">{asset.kind === "text" ? asset.content : assetMediaSummary(asset)}</p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-border px-2.5 py-2">
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onOpen}>查看</Button>
        {asset.kind === "text" ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onCopy}><Copy className="size-3.5" />复制</Button> : <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onDownload}><Download className="size-3.5" />下载</Button>}
        {onEdit ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onEdit}><Pencil className="size-3.5" />编辑</Button> : null}
        {onDelete ? <Button type="button" variant="ghost" size="icon" className="ml-auto size-7 text-rose-600" onClick={onDelete} aria-label="删除素材" title="删除"><Trash2 className="size-3.5" /></Button> : null}
      </div>
    </article>
  );
}

export function AssetPreview({ asset, onClose, onCopy, onDownload }: { asset: MyAsset | null; onClose: () => void; onCopy: () => void; onDownload: () => void }) {
  const { coverURL, mediaURL } = useResolvedAssetURLs(asset);
  return (
    <Dialog open={Boolean(asset)} onOpenChange={(value) => !value && onClose()}>
      <DialogContent scrollable={false} className="flex max-h-[90dvh] w-[min(94vw,760px)] max-w-none flex-col gap-4 overflow-hidden">
        <DialogHeader><DialogTitle>{asset?.title}</DialogTitle><DialogDescription>{asset ? `${assetKindLabel(asset.kind)} · ${asset.source || "我的素材"}` : "素材详情"}</DialogDescription></DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="pr-3">
          <div className="space-y-4">
            {asset?.kind === "text" ? <div className="space-y-4">{coverURL ? <AuthenticatedImage src={coverURL} alt={asset.title} className="max-h-72 w-full rounded-lg object-contain" /> : null}<p className="whitespace-pre-wrap break-words rounded-lg bg-muted/55 p-4 text-sm leading-7">{asset.content}</p></div> : asset?.kind === "image" ? <AuthenticatedImage src={mediaURL} alt={asset.title} className="max-h-[58vh] w-full rounded-lg object-contain" /> : asset?.kind === "video" ? <video src={mediaURL} controls className="max-h-[58vh] w-full rounded-lg bg-black" /> : asset?.kind === "audio" ? <audio src={mediaURL} controls className="w-full" /> : null}
            {asset ? <div className="grid gap-2 text-sm sm:grid-cols-2"><Info label="媒体信息" value={assetMediaSummary(asset)} /><Info label="来源" value={asset.source || "未标注"} /><Info label="可见范围" value={asset.visibility === "public" ? "公开" : "个人"} />{asset.ownerName ? <Info label="所有者" value={asset.ownerName} /> : null}{asset.note ? <Info label="备注" value={asset.note} className="sm:col-span-2" /> : null}</div> : null}
          </div>
        </ScrollArea>
        <DialogFooter>{asset?.kind === "text" ? <Button type="button" variant="outline" onClick={onCopy}><Copy />复制文本</Button> : asset ? <Button type="button" variant="outline" onClick={onDownload}><Download />下载{assetKindLabel(asset.kind)}</Button> : null}<Button type="button" onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return <div className={`rounded-lg border border-border px-3 py-2.5 ${className}`}><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 break-words text-xs leading-5">{value || "无"}</p></div>;
}

function assetKindLabel(kind: MyAssetKind) {
  return kind === "text" ? "文本" : kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

function useResolvedAssetURLs(asset: MyAsset | null) {
  const [mediaURL, setMediaURL] = useState(asset?.url || "");
  const [coverURL, setCoverURL] = useState(asset?.coverUrl || "");

  useEffect(() => {
    let active = true;
    const fallbackMediaURL = asset?.url || "";
    const fallbackCoverURL = asset?.coverUrl || "";
    setMediaURL(fallbackMediaURL);
    setCoverURL(fallbackCoverURL);
    if (!asset?.storageKey || asset.kind === "text") return () => { active = false; };

    const resolve = asset.kind === "image" ? resolveImageURL : resolveMediaURL;
    void resolve(asset.storageKey, fallbackMediaURL)
      .then((resolvedURL) => {
        if (!active) return;
        setMediaURL(resolvedURL);
        if (!fallbackCoverURL || fallbackCoverURL.startsWith("blob:")) setCoverURL(resolvedURL);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [asset?.coverUrl, asset?.kind, asset?.storageKey, asset?.url]);

  return { coverURL, mediaURL };
}
