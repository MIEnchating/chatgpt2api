"use client";

import { copyClipboardText } from "@/lib/clipboard-text";

import { Item , ItemMedia } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";

import { TooltipHint } from "@/components/ui/tooltip";

import { useEffect, useRef, useState } from "react";
import { AudioLines, Clock3, Copy, Cpu, Download, Eye, FileText, MoreHorizontal, Globe2, Image as ImageIcon, LockKeyhole, Pencil, Trash2, Video } from "lucide-react";
import { toast } from "sonner";

import { assetModel, assetPrompt, formatAssetCreatedTime } from "@/app/assets/asset-library";
import { assetMediaSummary } from "@/app/assets/asset-media";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { LabeledField } from "@/components/labeled-field";
import { MediaVideoPlayer } from "@/components/media-video-player";
import { OverflowMarqueeText } from "@/components/overflow-marquee-text";
import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { MyAsset, MyAssetKind } from "@/lib/my-assets";
import { resolveMediaURL } from "@/services/file-storage";
import { resolveImageURL } from "@/services/image-storage";

export function AssetCard({ asset, selected = false, eager = false, onSelectedChange, onOpen, onEdit, onDelete, onDownload }: { asset: MyAsset; selected?: boolean; eager?: boolean; onSelectedChange?: (selected: boolean) => void; onOpen: () => void; onEdit?: () => void; onDelete?: () => void; onDownload: () => void }) {
  const Icon = asset.kind === "text" ? FileText : asset.kind === "image" ? ImageIcon : asset.kind === "video" ? Video : AudioLines;
  const { coverURL, mediaURL } = useResolvedAssetURLs(asset);
  const previewCoverURL = asset.kind === "video" && (coverURL === mediaURL || coverURL === asset.url) ? "" : coverURL;
  const model = assetModel(asset);
  const source = asset.ownerName && !asset.owned ? asset.ownerName : asset.source;
  // Share media, title, badges, details, metadata, and action tracks across each grid row.
  return (
    <Card
      data-asset-card
      data-selected={selected}
      className="group relative row-span-6 grid min-w-0 grid-rows-subgrid gap-0 overflow-hidden p-0"
    >
      {onSelectedChange ? (
        <Card className="absolute left-3 top-3 z-10 w-fit gap-0 p-1.5">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange(checked === true)}

            aria-label={`选择素材 ${asset.title}`}
          />
        </Card>
      ) : null}
      <Button variant="ghost" type="button" className="block h-auto justify-start whitespace-normal p-0 w-full overflow-hidden text-left" onClick={onOpen} aria-label={`查看素材 ${asset.title}`}>
        <div className="flex aspect-[16/10] items-center justify-center overflow-hidden bg-muted/35">
          {previewCoverURL ? (
            <AuthenticatedImage src={previewCoverURL} alt={asset.title} loading={eager ? "eager" : "lazy"} className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.025]" />
          ) : asset.kind === "image" && mediaURL ? (
            <AuthenticatedImage src={mediaURL} alt={asset.title} loading={eager ? "eager" : "lazy"} className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.025]" />
          ) : asset.kind === "video" && mediaURL ? (
            <AssetVideoThumbnail key={mediaURL} src={mediaURL} eager={eager} />
          ) : asset.kind === "audio" ? (
            <div className="flex flex-col items-center gap-2 text-primary">
              <ItemMedia variant="icon" className="flex size-14 items-center justify-center"><AudioLines  /></ItemMedia>
              <span className="text-xs font-medium">音频素材</span>
            </div>
          ) : (
            <div className="flex w-full flex-col items-center gap-3 px-6 text-center">
              <ItemMedia variant="icon" className="flex size-12 items-center justify-center"><Icon  /></ItemMedia>
              <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{asset.content || "文本素材"}</p>
            </div>
          )}
        </div>
      </Button>
      <div data-asset-card-content className="row-span-4 grid min-h-0 min-w-0 grid-rows-subgrid items-start gap-2 p-3">
        <div className="min-w-0">
          <h2 className="line-clamp-2 min-h-10 break-words text-sm font-semibold leading-5 text-foreground">{asset.title || "未命名素材"}</h2>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            <Icon className="size-3" />
            {assetKindLabel(asset.kind)}
          </Badge>
          <Badge variant={asset.visibility === "public" ? "default" : "secondary"}>
            {asset.visibility === "public" ? <Globe2 className="size-3" /> : <LockKeyhole className="size-3" />}
            {asset.visibility === "public" ? "公开" : "个人"}
          </Badge>
        </div>
        <div className="min-w-0 space-y-2">
          {model ? (
            <p data-asset-model className="flex min-w-0 items-start gap-1.5 text-xs leading-5 text-muted-foreground">
              <Cpu className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{model}</span>
            </p>
          ) : null}
          {asset.kind === "text" ? <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{asset.content || "暂无文本内容"}</p> : null}
        </div>
        <div data-asset-card-metadata className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[11px] leading-5 text-muted-foreground">
          <span className="min-w-0 truncate" title={source}>{source}</span>
          <p className="flex shrink-0 items-center gap-1.5 tabular-nums">
            <Clock3 className="size-3.5 shrink-0" />
            <span>{formatAssetCreatedTime(asset.createdAt)}</span>
          </p>
        </div>
      </div>
      <div data-asset-card-actions className="flex min-h-10 items-center gap-1 border-t border-border px-3 py-1.5">
        <Button type="button" variant="ghost" size="sm" className="px-0" onClick={onOpen}><Eye />查看</Button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onEdit ? <TooltipHint content="编辑素材"><Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} aria-label="编辑素材"><Pencil /></Button></TooltipHint> : null}
          {asset.kind === "text" ? <CodeBlockCopyButton size="sm" value={asset.content || ""} aria-label="复制文本">复制</CodeBlockCopyButton> : <Button type="button" variant="ghost" size="sm" onClick={onDownload} aria-label="下载素材"><Download />下载</Button>}
          {onDelete ? <Button type="button" variant="ghost" size="sm" onClick={onDelete} aria-label="删除素材"><Trash2 />删除</Button> : null}
        </div>
      </div>
    </Card>
  );
}

export function AssetListRow({
  asset,
  selected = false,
  onSelectedChange,
  onOpen,
  onEdit,
  onDelete,
  onCopy,
  onDownload,
}: Parameters<typeof AssetCard>[0] & { onCopy: () => void }) {
  const Icon =
    asset.kind === "text" ? FileText : asset.kind === "image" ? ImageIcon : asset.kind === "video" ? Video : AudioLines;
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell className="w-10">
        {onSelectedChange ? (
          <Checkbox
            aria-label={`选择素材 ${asset.title}`}
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange(checked === true)}
          />
        ) : null}
      </TableCell>
      <TableCell className="max-w-0 py-3">
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-3 px-0 py-2 text-left font-normal"
          onClick={onOpen}
          aria-label={`查看素材 ${asset.title}`}
        >
          <Icon className="size-5 shrink-0" />
          <span className="min-w-0 truncate">{asset.title}</span>
        </Button>
      </TableCell>
      <TableCell className="hidden truncate text-muted-foreground md:table-cell">
        {asset.ownerName && !asset.owned ? asset.ownerName : asset.source || "我的素材"}
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
        {formatAssetCreatedTime(asset.updatedAt || asset.createdAt)}
      </TableCell>
      <TableCell className="w-12 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`更多操作：${asset.title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={onOpen}>
              <Eye />
              查看
            </DropdownMenuItem>
            {asset.kind === "text" ? (
              <DropdownMenuItem onSelect={onCopy}>
                <Copy />
                复制文本
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={onDownload}>
                <Download />
                下载
              </DropdownMenuItem>
            )}
            {onEdit ? (
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                编辑
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 />
                  删除
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

export function AssetPreview({ asset, onClose, onDownload }: { asset: MyAsset | null; onClose: () => void; onDownload: () => void }) {
  const { coverURL, mediaURL } = useResolvedAssetURLs(asset);
  const prompt = assetPrompt(asset);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const videoAspectRatio = asset?.width && asset.height ? asset.width / asset.height : 16 / 9;

  const copyPrompt = async () => {
    const field = promptRef.current;
    if (!field || !prompt) return;
    try {
      await copyClipboardText(prompt);
      toast.success("提示词已复制");
    } catch {
      if (!field.isConnected || field !== promptRef.current || field.value !== prompt) return;
      field.focus({ preventScroll: true });
      field.select();
      field.scrollIntoView({ block: "nearest" });
      toast.error(window.isSecureContext ? "浏览器未允许自动复制" : "当前 HTTP 连接不支持自动复制", {
        description: window.isSecureContext ? "提示词已选中，可手动复制或检查浏览器剪贴板权限。" : "提示词已选中，可手动复制；使用 HTTPS 访问可启用自动复制。",
      });
    }
  };

  return (
    <Dialog open={Boolean(asset)} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="flex h-[min(85dvh,680px)] w-[min(94vw,1120px)] max-w-none flex-col overflow-hidden sm:max-w-none">
        <DialogHeader ><DialogTitle className="overflow-hidden whitespace-nowrap"><OverflowMarqueeText text={asset?.title || "素材详情"} play="always" delayMs={1500} /></DialogTitle><DialogDescription className="sr-only">素材详情</DialogDescription></DialogHeader>
        <div data-asset-preview-layout className="-mx-4 grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)] md:grid-rows-1">
          <div data-asset-preview-media className="flex h-[min(32dvh,240px)] min-h-0 min-w-0 items-center justify-center px-4 md:h-full md:pr-0">
            {asset?.kind === "image" ? (
              <AuthenticatedImage data-asset-preview-image src={mediaURL} alt={asset.title} className="size-full object-contain" />
            ) : asset?.kind === "video" ? (
              <div className="flex size-full items-center justify-center [container-type:size]">
                <div style={{ width: `min(100cqw, calc(100cqh * ${videoAspectRatio}))` }}>
                  <MediaVideoPlayer src={mediaURL} title={asset.title || "素材视频"} aspectRatio={String(videoAspectRatio)} />
                </div>
              </div>
            ) : asset?.kind === "audio" ? (
              <div className="flex size-full min-h-0 flex-col items-center justify-center gap-4">
                {coverURL ? <AuthenticatedImage src={coverURL} alt={asset.title} className="min-h-0 max-w-full flex-1 object-contain" /> : <AudioLines className="size-16 shrink-0" aria-hidden="true" />}
                <audio src={mediaURL} controls aria-label={asset.title || "素材音频"} className="w-full shrink-0" />
              </div>
            ) : asset?.kind === "text" ? (
              <ScrollArea className="h-full w-full" contentClassName="space-y-4 p-1" onWheel={(event) => event.stopPropagation()}>
                {coverURL ? <AuthenticatedImage src={coverURL} alt={asset.title} className="max-h-60 w-full object-contain" /> : null}
                <Item variant="muted" className="whitespace-pre-wrap p-4 [overflow-wrap:anywhere]">{asset.content}</Item>
              </ScrollArea>
            ) : null}
          </div>
        <ScrollAreaRoot data-asset-preview-scroll data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain" tabIndex={0} aria-label="素材详情内容"><div className="min-w-0 px-4 py-1 md:pl-1">
          <div className="space-y-4">
            {asset && asset.kind !== "text" && prompt ? <LabeledField label="提示词">{(id) => <Textarea id={id} key={asset.id} ref={promptRef} value={prompt} readOnly rows={6} className="resize-none" />}</LabeledField> : null}
            {asset ? <div className="grid gap-2 text-sm sm:grid-cols-2"><Info label="媒体信息" value={assetMediaSummary(asset)} />{assetModel(asset) ? <Info label="生成模型" value={assetModel(asset)} /> : null}{asset.tags.length ? <Info label="标签" value={asset.tags.join("、")} className="sm:col-span-2" /> : null}<Info label="来源" value={asset.source || "未标注"} /><Info label="创建时间" value={formatAssetCreatedTime(asset.createdAt)} /><Info label="可见范围" value={asset.visibility === "public" ? "公开" : "个人"} /><Info label="所有者" value={asset.ownerName || (asset.owned !== false ? "我" : "未知")} />{asset.note ? <Info label="备注" value={asset.note} className="sm:col-span-2" /> : null}</div> : null}
          </div>
        </div></ScrollAreaViewport><ScrollBar /></ScrollAreaRoot>
        </div>
        <DialogFooter>{asset?.kind === "text" ? <CodeBlockCopyButton variant="outline" size="default" value={asset.content || ""}>复制文本</CodeBlockCopyButton> : null}{asset && asset.kind !== "text" && prompt ? <Button type="button" variant="outline" onClick={() => void copyPrompt()}><Copy />复制提示词</Button> : null}{asset && asset.kind !== "text" ? <Button type="button" variant="outline" onClick={onDownload}><Download />下载{assetKindLabel(asset.kind)}</Button> : null}<Button type="button" onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssetVideoThumbnail({ src, eager }: { src: string; eager: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isVisible, setIsVisible] = useState(eager);
  const shouldLoad = eager || isVisible;

  useEffect(() => {
    if (eager) {
      setIsVisible(true);
      return;
    }
    if (isVisible) return;
    const video = videoRef.current;
    if (!video) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(video);
    return () => observer.disconnect();
  }, [eager, isVisible]);

  return <video ref={videoRef} data-asset-video-thumbnail src={shouldLoad ? `${src}#t=0.1` : undefined} muted playsInline disablePictureInPicture preload={shouldLoad ? "metadata" : "none"} className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.025]" />;
}

function Info({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return <Card className={`min-w-0 gap-1 px-3 py-2.5 ${className}`}><p className="text-[11px] text-muted-foreground">{label}</p><p className="text-xs leading-5 [overflow-wrap:anywhere]">{value || "无"}</p></Card>;
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
