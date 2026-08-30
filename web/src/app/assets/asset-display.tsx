"use client";

import { useEffect, useState } from "react";
import { AudioLines, Clock3, Copy, Download, Eye, FileText, Globe2, Image as ImageIcon, LockKeyhole, Pencil, Trash2, Video } from "lucide-react";

import { assetPrompt, formatAssetCreatedTime } from "@/app/assets/asset-library";
import { assetMediaSummary } from "@/app/assets/asset-media";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { MediaVideoPlayer } from "@/components/media-video-player";
import { OverflowMarqueeText } from "@/components/overflow-marquee-text";
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
  const previewCoverURL = asset.kind === "video" && (coverURL === mediaURL || coverURL === asset.url) ? "" : coverURL;
  return (
    <article
      data-asset-card
      data-selected={selected}
      data-interaction="trigger"
      className="interactive-card group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm"
    >
      {onSelectedChange ? (
        <div className="selection-control-frame absolute left-3 top-3 z-10 rounded-md">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange(checked === true)}
            className="selection-control size-5 shadow-none"
            aria-label={`选择素材 ${asset.title}`}
          />
        </div>
      ) : null}
      <button type="button" className="interactive-card-trigger block w-full overflow-hidden text-left" onClick={onOpen} aria-label={`查看素材 ${asset.title}`}>
        <div className="flex aspect-[16/10] items-center justify-center overflow-hidden bg-muted/35">
          {previewCoverURL ? (
            <AuthenticatedImage src={previewCoverURL} alt={asset.title} className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.025]" />
          ) : asset.kind === "image" && mediaURL ? (
            <AuthenticatedImage src={mediaURL} alt={asset.title} className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.025]" />
          ) : asset.kind === "video" && mediaURL ? (
            <video data-asset-video-thumbnail src={`${mediaURL}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.025]" />
          ) : asset.kind === "audio" ? (
            <div className="flex flex-col items-center gap-2 text-[#1456f0] dark:text-sky-300">
              <span className="flex size-14 items-center justify-center rounded-full bg-[#edf4ff] dark:bg-sky-950/50"><AudioLines className="size-7" /></span>
              <span className="text-xs font-medium">音频素材</span>
            </div>
          ) : (
            <div className="flex w-full flex-col items-center gap-3 px-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-lg bg-[#edf4ff] text-[#1456f0] dark:bg-sky-950/50 dark:text-sky-300"><Icon className="size-6" /></span>
              <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{asset.content || "文本素材"}</p>
            </div>
          )}
        </div>
      </button>
      <div data-asset-card-content className="flex flex-col gap-3 p-4">
        <div className="min-w-0">
          <h2 className="line-clamp-2 min-h-10 break-words text-sm font-semibold leading-5 text-foreground">{asset.title || "未命名素材"}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">{asset.ownerName && !asset.owned ? asset.ownerName : asset.source || "未标注来源"}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-muted/45 px-2 text-[11px] font-medium text-muted-foreground">
            <Icon className="size-3" />
            {assetKindLabel(asset.kind)}
          </span>
          <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-muted/45 px-2 text-[11px] font-medium text-muted-foreground">
            {asset.visibility === "public" ? <Globe2 className="size-3" /> : <LockKeyhole className="size-3" />}
            {asset.visibility === "public" ? "公开" : "个人"}
          </span>
        </div>
        <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
          {asset.kind === "text" ? asset.content || "暂无文本内容" : assetMediaSummary(asset)}
        </p>
        <p className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
          <Clock3 className="size-3.5 shrink-0" />
          <span>{formatAssetCreatedTime(asset.createdAt)}</span>
        </p>
      </div>
      <div className="flex min-h-12 items-center gap-1 border-t border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onOpen}><Eye className="size-3.5" />查看</Button>
        {asset.kind === "text" ? <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onCopy}><Copy className="size-3.5" />复制</Button> : <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onDownload}><Download className="size-3.5" />下载</Button>}
        {onEdit ? <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onEdit}><Pencil className="size-3.5" />编辑</Button> : null}
        {onDelete ? <Button type="button" variant="ghost" size="icon" className="ml-auto size-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40 dark:hover:text-rose-300" onClick={onDelete} aria-label="删除素材" title="删除"><Trash2 className="size-3.5" /></Button> : null}
      </div>
    </article>
  );
}

export function AssetPreview({ asset, onClose, onCopy, onCopyPrompt, onDownload }: { asset: MyAsset | null; onClose: () => void; onCopy: () => void; onCopyPrompt: () => void; onDownload: () => void }) {
  const { coverURL, mediaURL } = useResolvedAssetURLs(asset);
  const prompt = assetPrompt(asset);
  return (
    <Dialog open={Boolean(asset)} onOpenChange={(value) => !value && onClose()}>
      <DialogContent scrollable={false} className="flex max-h-[90dvh] w-[min(94vw,760px)] max-w-none flex-col gap-4 overflow-hidden">
        <DialogHeader className="pr-10"><DialogTitle className="overflow-hidden whitespace-nowrap text-base leading-6 sm:text-lg"><OverflowMarqueeText text={asset?.title || "素材详情"} play="always" delayMs={1500} /></DialogTitle><DialogDescription className="sr-only">素材详情</DialogDescription></DialogHeader>
        <ScrollArea data-asset-preview-scroll tabindex={0} ariaLabel="素材详情内容" className="min-h-0 flex-1" viewportClassName="overscroll-contain pr-3">
          <div className="space-y-4">
            {asset?.kind === "text" ? <div className="space-y-4">{coverURL ? <AuthenticatedImage src={coverURL} alt={asset.title} className="max-h-72 w-full rounded-lg object-contain" /> : null}<p className="whitespace-pre-wrap break-words rounded-lg bg-muted/55 p-4 text-sm leading-7">{asset.content}</p></div> : asset?.kind === "image" ? <AuthenticatedImage src={mediaURL} alt={asset.title} className="max-h-[58vh] w-full rounded-lg object-contain" /> : asset?.kind === "video" ? <MediaVideoPlayer src={mediaURL} title={asset.title || "素材视频"} className="max-h-[58vh] rounded-lg" /> : asset?.kind === "audio" ? <audio src={mediaURL} controls className="w-full" /> : null}
            {asset ? <div className="grid gap-2 text-sm sm:grid-cols-2"><Info label="媒体信息" value={assetMediaSummary(asset)} /><Info label="来源" value={asset.source || "未标注"} /><Info label="创建时间" value={formatAssetCreatedTime(asset.createdAt)} /><Info label="可见范围" value={asset.visibility === "public" ? "公开" : "个人"} />{asset.ownerName ? <Info label="所有者" value={asset.ownerName} /> : null}{asset.note ? <Info label="备注" value={asset.note} className="sm:col-span-2" /> : null}</div> : null}
          </div>
        </ScrollArea>
        <DialogFooter>{asset?.kind === "text" ? <Button type="button" variant="outline" onClick={onCopy}><Copy />复制文本</Button> : null}{asset && asset.kind !== "text" && prompt ? <Button type="button" variant="outline" onClick={onCopyPrompt}><Copy />复制提示词</Button> : null}{asset && asset.kind !== "text" ? <Button type="button" variant="outline" onClick={onDownload}><Download />下载{assetKindLabel(asset.kind)}</Button> : null}<Button type="button" onClick={onClose}>关闭</Button></DialogFooter>
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
        if (asset.kind === "image" && (!fallbackCoverURL || fallbackCoverURL.startsWith("blob:"))) setCoverURL(resolvedURL);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [asset?.coverUrl, asset?.kind, asset?.storageKey, asset?.url]);

  return { coverURL, mediaURL };
}
