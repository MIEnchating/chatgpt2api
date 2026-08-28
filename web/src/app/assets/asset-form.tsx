"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, FileText, Globe2, Image as ImageIcon, LoaderCircle, LockKeyhole, Upload, Video } from "lucide-react";
import { toast } from "sonner";

import { assetMediaSummary, inspectAssetFile, type AssetMediaMetadata } from "@/app/assets/asset-media";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { createMyAsset, type MyAsset, type MyAssetKind, type MyAssetVisibility } from "@/lib/my-assets";
import { cn } from "@/lib/utils";

const kindOptions: Array<{ value: MyAssetKind; label: string; icon: typeof FileText }> = [
  { value: "text", label: "文本", icon: FileText },
  { value: "image", label: "图片", icon: ImageIcon },
  { value: "video", label: "视频", icon: Video },
  { value: "audio", label: "音频", icon: AudioLines },
];

export function AssetForm({ open, asset, onClose, onSave }: { open: boolean; asset: MyAsset | null; onClose: () => void; onSave: (asset: MyAsset) => void }) {
  const [kind, setKind] = useState<MyAssetKind>("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [visibility, setVisibility] = useState<MyAssetVisibility>("private");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [mediaMetadata, setMediaMetadata] = useState<AssetMediaMetadata>({});
  const [mediaStorageKey, setMediaStorageKey] = useState("");
  const [busyTarget, setBusyTarget] = useState<"cover" | "content" | "">("");
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const contentInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(asset?.kind || "text");
    setTitle(asset?.title || "");
    setContent(asset?.content || asset?.url || "");
    setCoverUrl(asset?.coverUrl || "");
    setVisibility(asset?.visibility || "private");
    setSource(asset?.source || "手动添加");
    setNote(asset?.note || "");
    setMediaMetadata({ bytes: asset?.bytes, mimeType: asset?.mimeType, width: asset?.width, height: asset?.height, durationMs: asset?.durationMs });
    setMediaStorageKey(asset?.storageKey || "");
    setBusyTarget("");
  }, [asset, open]);

  const changeKind = (nextKind: MyAssetKind) => {
    setKind(nextKind);
    setContent("");
    setMediaMetadata({});
    setMediaStorageKey("");
  };

  async function uploadCover(file?: File) {
    if (!file) return;
    setBusyTarget("cover");
    try {
      setCoverUrl(await readFileAsDataURL(file));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "封面上传失败");
    } finally {
      setBusyTarget("");
    }
  }

  async function uploadContent(file?: File) {
    if (!file || kind === "text") return;
    setBusyTarget("content");
    try {
      const [result, metadata] = await Promise.all([
        kind === "image" ? uploadImage(file) : uploadAssetMediaFile(file, kind === "video" ? "asset-video" : "asset-audio"),
        inspectAssetFile(file, kind),
      ]);
      setContent(result.url);
      setMediaStorageKey(result.storageKey);
      setMediaMetadata({
        ...metadata,
        mimeType: result.mimeType || metadata.mimeType,
        bytes: result.bytes ?? metadata.bytes,
        ...(kind === "image" && result.width && result.height ? { width: result.width, height: result.height } : {}),
      });
      if (kind === "image" && !coverUrl && !isBlobURL(result.url)) setCoverUrl(result.url);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "素材上传失败");
    } finally {
      setBusyTarget("");
    }
  }

  function submit() {
    const nextTitle = title.trim();
    const value = content.trim();
    const cover = coverUrl.trim();
    if (!nextTitle) return toast.error("请输入素材标题");
    if (!value) return toast.error(kind === "text" ? "请输入文本内容" : "请上传文件或填写媒体 URL");
    if ((kind !== "text" && isBlobURL(value) && !mediaStorageKey) || isBlobURL(cover)) return toast.error("blob 地址是临时地址，请先上传文件转为可保存的 URL");
    const base = {
      kind,
      title: nextTitle,
      ...(cover ? { coverUrl: cover } : {}),
      tags: [],
      visibility,
      ...(source.trim() ? { source: source.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(kind === "text" ? {} : mediaMetadata),
      ...(kind !== "text" && mediaStorageKey ? { storageKey: mediaStorageKey } : {}),
      metadata: asset?.metadata || { source: "manual" },
    };
    const next = asset
      ? { ...asset, ...base, ...(kind === "text" ? { content: value, url: undefined } : { url: value, content: undefined }), updatedAt: new Date().toISOString() }
      : createMyAsset({ ...base, ...(kind === "text" ? { content: value } : { url: value }) });
    onSave(next);
    toast.success(asset ? "素材已更新" : "素材已保存");
  }

  const previewAsset = previewMyAsset({ asset, kind, title, content, coverUrl, visibility, source, note, mediaMetadata, mediaStorageKey });
  const busy = Boolean(busyTarget);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent scrollable={false} className="flex max-h-[92dvh] w-[min(94vw,900px)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 sm:px-6">
          <DialogTitle>{asset ? "编辑素材" : "新增素材"}</DialogTitle>
          <DialogDescription>保存可重复使用的文本、图片、视频或音频。</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-5 py-5 sm:px-6">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid min-w-0 gap-4">
              <Field label="类型">
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
                  {kindOptions.map((option) => { const Icon = option.icon; return <button key={option.value} type="button" disabled={busy} onClick={() => changeKind(option.value)} className={cn("inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition", kind === option.value && "bg-card text-foreground shadow-sm")}><Icon className="size-3.5" />{option.label}</button>; })}
                </div>
              </Field>
              <Field label="标题"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给素材起一个容易检索的名字" /></Field>
              <Field label="可见范围">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                  <button type="button" disabled={busy} onClick={() => setVisibility("private")} className={cn("inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition", visibility === "private" && "bg-card text-foreground shadow-sm")}><LockKeyhole className="size-3.5" />个人</button>
                  <button type="button" disabled={busy} onClick={() => setVisibility("public")} className={cn("inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition", visibility === "public" && "bg-card text-foreground shadow-sm")}><Globe2 className="size-3.5" />公开</button>
                </div>
              </Field>
              <Field label="封面">
                <div className="flex gap-2"><Input value={coverUrl} onChange={(event) => setCoverUrl(event.target.value)} placeholder="封面图片 URL（可选）" /><Button type="button" variant="outline" disabled={busy} onClick={() => coverInputRef.current?.click()}>{busyTarget === "cover" ? <LoaderCircle className="animate-spin" /> : <Upload />}上传</Button></div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="来源"><Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="手动添加 / 画布 / 提示词库" /></Field>
                <Field label="备注"><Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选" /></Field>
              </div>
              {kind === "text" ? (
                <Field label="文本内容"><Textarea value={content} onChange={(event) => setContent(event.target.value)} rows={8} placeholder="保存提示词、说明文案或参考描述" /></Field>
              ) : (
                <Field label={`${kindLabel(kind)}内容`}>
                  <div className="rounded-lg border border-dashed border-border p-3">
                    <div className="flex gap-2"><Input value={content} onChange={(event) => { setContent(event.target.value); setMediaMetadata({}); setMediaStorageKey(""); }} placeholder={`填写${kindLabel(kind)} URL，或上传本地文件`} /><Button type="button" variant="outline" disabled={busy} onClick={() => contentInputRef.current?.click()}>{busyTarget === "content" ? <LoaderCircle className="animate-spin" /> : <Upload />}上传</Button></div>
                    <p className="mt-2 min-h-4 text-xs text-muted-foreground">{assetMediaSummary(previewAsset)}</p>
                  </div>
                </Field>
              )}
            </div>
            <AssetFormPreview asset={previewAsset} />
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 border-t border-border px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="button" disabled={busy} onClick={submit}>保存</Button>
        </DialogFooter>
        <input ref={coverInputRef} type="file" className="hidden" accept="image/*" onChange={(event) => { void uploadCover(event.target.files?.[0]); event.target.value = ""; }} />
        <input ref={contentInputRef} type="file" className="hidden" accept={kind === "image" ? "image/*" : kind === "video" ? "video/mp4,video/quicktime,.mp4,.mov" : "audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"} onChange={(event) => { void uploadContent(event.target.files?.[0]); event.target.value = ""; }} />
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-xs font-medium text-foreground"><span>{label}</span>{children}</label>;
}

function AssetFormPreview({ asset }: { asset: MyAsset }) {
  return <aside className="min-w-0 border-t border-border pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"><p className="text-xs font-semibold text-foreground">预览</p><div className="mt-3 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-muted/50">{asset.coverUrl ? <AuthenticatedImage src={asset.coverUrl} alt="" className="size-full object-cover" /> : asset.kind === "image" && asset.url ? <AuthenticatedImage src={asset.url} alt="" className="size-full object-contain" /> : asset.kind === "video" && asset.url ? <video src={asset.url} muted playsInline preload="metadata" className="size-full object-cover" /> : asset.kind === "audio" ? <AudioLines className="size-12 text-[#1456f0]" /> : <p className="line-clamp-6 px-5 text-center text-sm leading-6 text-muted-foreground">{asset.content || "文本内容预览"}</p>}</div><h3 className="mt-3 truncate text-sm font-semibold">{asset.title || "未命名素材"}</h3><p className="mt-1 text-xs text-muted-foreground">{asset.source || "未标注来源"}</p></aside>;
}

function previewMyAsset(input: { asset: MyAsset | null; kind: MyAssetKind; title: string; content: string; coverUrl: string; visibility: MyAssetVisibility; source: string; note: string; mediaMetadata: AssetMediaMetadata; mediaStorageKey: string }): MyAsset {
  const now = new Date().toISOString();
  return {
    id: input.asset?.id || "preview",
    kind: input.kind,
    title: input.title,
    coverUrl: input.coverUrl,
    ...(input.kind === "text" ? { content: input.content } : { url: input.content, ...input.mediaMetadata }),
    ...(input.kind !== "text" && input.mediaStorageKey ? { storageKey: input.mediaStorageKey } : {}),
    tags: [],
    visibility: input.visibility,
    source: input.source,
    note: input.note,
    createdAt: input.asset?.createdAt || now,
    updatedAt: now,
  };
}

function kindLabel(kind: MyAssetKind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : "文本";
}

function isBlobURL(value: string) {
  return value.toLowerCase().startsWith("blob:");
}

function readFileAsDataURL(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取封面失败"));
    reader.readAsDataURL(file);
  });
}
