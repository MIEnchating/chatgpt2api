"use client";

import { FieldSet, FieldLegend } from "@/components/ui/field";

import { Spinner } from "@/components/ui/spinner";

import { LabeledField as Field } from "@/components/labeled-field";

import { EditorWorkspace } from "@/components/editor-workspace";
import { Card } from "@/components/ui/card";

import { Toggle } from "@/components/ui/toggle";

import { useEffect, useRef, useState } from "react";
import { AudioLines, FileText, Globe2, Image as ImageIcon, LockKeyhole, Upload, Video } from "lucide-react";
import { toast } from "sonner";

import { assetMediaSummary, type AssetMediaMetadata } from "@/app/assets/asset-media";
import { inspectAssetImageURL } from "@/app/assets/asset-image-metadata";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { uploadAssetMediaFile, uploadTemporaryMedia } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { createMyAsset, type MyAsset, type MyAssetKind, type MyAssetVisibility } from "@/lib/my-assets";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";

const kindOptions: Array<{ value: MyAssetKind; label: string; icon: typeof FileText }> = [
  { value: "text", label: "文本", icon: FileText },
  { value: "image", label: "图片", icon: ImageIcon },
  { value: "video", label: "视频", icon: Video },
  { value: "audio", label: "音频", icon: AudioLines },
];

type AssetEditorProps = {
  asset: MyAsset | null;
  onClose: () => void;
  onSave: (asset: MyAsset) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
};

export function AssetForm({ open, asset, onClose, onSave }: AssetEditorProps & { open: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[92dvh] w-[min(94vw,1000px)] max-w-none flex-col overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{asset ? "编辑素材" : "新增素材"}</DialogTitle>
        <DialogDescription className="sr-only">保存可重复使用的文本、图片、视频或音频。</DialogDescription>
        <AssetEditor asset={asset} onClose={onClose} onSave={onSave} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

export function AssetEditor({ asset, onClose, onSave, onBusyChange }: AssetEditorProps) {
  const initialAsset = useRef(asset).current;
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
  const [isSaving, setIsSaving] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const metadataRequestRef = useRef<{
    source: string;
    controller: AbortController;
    promise: Promise<AssetMediaMetadata | null>;
  } | null>(null);
  const formControllerRef = useRef<AbortController | null>(null);
  const savePendingRef = useRef(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const temporaryUploadRef = useRef(false);
  const contentInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    metadataRequestRef.current?.controller.abort();
    metadataRequestRef.current = null;
    const controller = new AbortController();
    formControllerRef.current = controller;
    const sessionKey = getCachedAuthSession()?.key;
    const sessionChanged = () => {
      if (getCachedAuthSession()?.key !== sessionKey) {
        controller.abort();
        metadataRequestRef.current?.controller.abort();
      }
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, sessionChanged);
    setKind(initialAsset?.kind || "text");
    setTitle(initialAsset?.title || "");
    setContent(initialAsset?.content || initialAsset?.url || "");
    setCoverUrl(initialAsset?.coverUrl || "");
    setVisibility(initialAsset?.visibility || "private");
    setSource(initialAsset?.source || "手动添加");
    setNote(initialAsset?.note || "");
    setMediaMetadata({
      bytes: initialAsset?.bytes,
      mimeType: initialAsset?.mimeType,
      width: initialAsset?.width,
      height: initialAsset?.height,
      durationMs: initialAsset?.durationMs,
    });
    setMediaStorageKey(initialAsset?.storageKey || "");
    setBusyTarget("");
    setMetadataLoading(false);
    setMetadataError("");
    savePendingRef.current = false;
    setIsSaving(false);
    return () => {
      controller.abort();
      metadataRequestRef.current?.controller.abort();
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, sessionChanged);
    };
  }, [initialAsset]);

  useEffect(() => {
    if (kind !== "image" || mediaStorageKey || !content.trim() || isBlobURL(content.trim())) return;
    const timer = window.setTimeout(() => {
      void readURLMetadata(content.trim());
    }, 400);
    return () => window.clearTimeout(timer);
  }, [content, kind, mediaStorageKey]);

  function cancelMetadata() {
    metadataRequestRef.current?.controller.abort();
    metadataRequestRef.current = null;
    setMetadataLoading(false);
    setMetadataError("");
  }

  function readURLMetadata(value: string): Promise<AssetMediaMetadata | null> {
    if (formControllerRef.current?.signal.aborted) return Promise.resolve(null);
    const pending = metadataRequestRef.current;
    if (pending?.source === value && !pending.controller.signal.aborted) return pending.promise;
    pending?.controller.abort();
    const controller = new AbortController();
    setMetadataLoading(true);
    setMetadataError("");
    const promise = inspectAssetImageURL(value, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
      .then((metadata) => {
        if (controller.signal.aborted) return null;
        setMediaMetadata(metadata);
        return metadata;
      })
      .catch(() => {
        if (!controller.signal.aborted) setMetadataError("无法读取图片信息，仍可保存 URL");
        return null;
      })
      .finally(() => {
        if (!controller.signal.aborted) setMetadataLoading(false);
      });
    metadataRequestRef.current = { source: value, controller, promise };
    return promise;
  }

  const changeKind = (nextKind: MyAssetKind) => {
    cancelMetadata();
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
    const formSignal = formControllerRef.current?.signal;
    if (!formSignal || formSignal.aborted) return;
    cancelMetadata();
    setBusyTarget("content");
    try {
      const result = temporaryUploadRef.current
        ? await uploadTemporaryMedia(file, formSignal)
        : kind === "image"
          ? await uploadImage(file)
          : await uploadAssetMediaFile(file, kind === "video" ? "asset-video" : "asset-audio");
      if (formSignal.aborted) return;
      setContent(result.url);
      setMediaStorageKey(result.storageKey || "");
      setMediaMetadata({
        bytes: result.bytes || file.size,
        mimeType: result.mimeType || file.type,
        ...(result.width && result.height ? { width: result.width, height: result.height } : {}),
        ...("durationMs" in result && result.durationMs ? { durationMs: result.durationMs } : {}),
      });
      if (kind === "image" && !coverUrl && !isBlobURL(result.url)) setCoverUrl(result.url);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
    } catch (error) {
      if (!formSignal.aborted) toast.error(error instanceof Error ? error.message : "素材上传失败");
    } finally {
      if (!formSignal.aborted) setBusyTarget("");
    }
  }

  async function submit() {
    if (savePendingRef.current) return;
    const nextTitle = title.trim();
    const value = content.trim();
    const cover = coverUrl.trim();
    if (!nextTitle) return toast.error("请输入素材标题");
    if (!value) return toast.error(kind === "text" ? "请输入文本内容" : "请上传文件或填写媒体 URL");
    if ((kind !== "text" && isBlobURL(value) && !mediaStorageKey) || isBlobURL(cover))
      return toast.error("blob 地址是临时地址，请先上传文件转为可保存的 URL");
    const formSignal = formControllerRef.current?.signal;
    if (!formSignal || formSignal.aborted) return;
    savePendingRef.current = true;
    setIsSaving(true);
    try {
      let metadata = mediaMetadata;
      if (kind === "image" && !mediaStorageKey && (!metadata.width || !metadata.height)) {
        metadata = (await readURLMetadata(value)) || metadata;
        if (formSignal.aborted) return;
      }
      const base = {
        kind,
        title: nextTitle,
        coverUrl: cover || undefined,
        tags: [],
        visibility,
        source: source.trim() || undefined,
        note: note.trim() || undefined,
        bytes: kind === "text" ? undefined : metadata.bytes,
        mimeType: kind === "text" ? undefined : metadata.mimeType,
        width: kind === "text" ? undefined : metadata.width,
        height: kind === "text" ? undefined : metadata.height,
        durationMs: kind === "text" ? undefined : metadata.durationMs,
        storageKey: kind !== "text" && mediaStorageKey ? mediaStorageKey : undefined,
        metadata: asset?.metadata || { source: "manual" },
      };
      const next = asset
        ? {
            ...asset,
            ...base,
            ...(kind === "text" ? { content: value, url: undefined } : { url: value, content: undefined }),
            updatedAt: new Date().toISOString(),
          }
        : createMyAsset({ ...base, ...(kind === "text" ? { content: value } : { url: value }) });
      await onSave(next);
      if (!formSignal.aborted) {
        toast.success(asset ? "素材已更新" : "素材已保存");
        onClose();
      }
    } catch (error) {
      if (!formSignal.aborted) toast.error(error instanceof Error ? error.message : "素材保存失败");
    } finally {
      if (!formSignal.aborted) {
        savePendingRef.current = false;
        setIsSaving(false);
      }
    }
  }

  const previewAsset = previewMyAsset({
    asset,
    kind,
    title,
    content,
    coverUrl,
    visibility,
    source,
    note,
    mediaMetadata,
    mediaStorageKey,
  });
  const busy = Boolean(busyTarget) || isSaving;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  return (
    <EditorWorkspace
      title={asset ? "编辑素材" : "新增素材"}
      description="保存可重复使用的文本、图片、视频或音频。"
      backLabel="返回素材库"
      onBack={onClose}
      busy={busy}
      actions={
        <Button type="submit" form="asset-editor-form" aria-label="保存素材" disabled={busy}>
          {isSaving ? (
            <>
              <Spinner />
              保存中…
            </>
          ) : (
            "保存"
          )}
        </Button>
      }
    >
      <form
        id="asset-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <FieldSet disabled={busy} className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_240px]">
          <div className="grid min-w-0 gap-4">
            <FieldSet className="grid min-w-0 gap-1.5">
              <FieldLegend variant="label">类型</FieldLegend>
              <div className="grid grid-cols-4 gap-1 p-1">
                {kindOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <Toggle
                      key={option.value}
                      type="button"
                      disabled={busy}
                      pressed={kind === option.value}
                      onClick={() => changeKind(option.value)}
                      className="inline-flex items-center justify-center transition"
                    >
                      <Icon />
                      {option.label}
                    </Toggle>
                  );
                })}
              </div>
            </FieldSet>
            <Field label="标题（必填）">{(fieldId) => <Input id={fieldId}
                aria-label="素材标题"
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="给素材起一个容易检索的名字"
              />}</Field>
            <FieldSet className="grid min-w-0 gap-1.5">
              <FieldLegend variant="label">可见范围</FieldLegend>
              <div className="grid grid-cols-2 gap-1 p-1">
                <Toggle
                  type="button"
                  disabled={busy}
                  pressed={visibility === "private"}
                  onClick={() => setVisibility("private")}
                  className="inline-flex items-center justify-center transition"
                >
                  <LockKeyhole />
                  个人
                </Toggle>
                <Toggle
                  type="button"
                  disabled={busy}
                  pressed={visibility === "public"}
                  onClick={() => setVisibility("public")}
                  className="inline-flex items-center justify-center transition"
                >
                  <Globe2 />
                  公开
                </Toggle>
              </div>
            </FieldSet>
            <Field label="封面">{(fieldId) => <div className="flex gap-2">
                <Input id={fieldId}
                  aria-label="封面 URL"
                  value={coverUrl}
                  onChange={(event) => setCoverUrl(event.target.value)}
                  placeholder="封面图片 URL（可选）"
                />
                <Button type="button" variant="outline" disabled={busy} onClick={() => coverInputRef.current?.click()}>
                  {busyTarget === "cover" ? <Spinner /> : <Upload />}上传
                </Button>
              </div>}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="来源">{(fieldId) => <Input id={fieldId}
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="手动添加 / 画布 / 提示词库"
                />}</Field>
              <Field label="备注">{(fieldId) => <Input id={fieldId} value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选" />}</Field>
            </div>
            {kind === "text" ? (
              <Field label="文本内容（必填）">{(fieldId) => <Textarea id={fieldId}
                  aria-label="文本内容"
                  required
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={8}
                  placeholder="保存提示词、说明文案或参考描述"
                />}</Field>
            ) : (
              <Field label={`${kindLabel(kind)}内容（必填）`}>{(fieldId) => <Card className="p-3 gap-0">
                  <div className="flex gap-2">
                    <Input id={fieldId}
                      aria-label={`${kindLabel(kind)}内容 URL`}
                      required
                      value={content}
                      onChange={(event) => {
                        cancelMetadata();
                        setContent(event.target.value);
                        setMediaMetadata({});
                        setMediaStorageKey("");
                      }}
                      placeholder={`填写${kindLabel(kind)} URL，或上传本地文件`}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        temporaryUploadRef.current = false;
                        contentInputRef.current?.click();
                      }}
                    >
                      {busyTarget === "content" ? <Spinner /> : <Upload />}上传
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      temporaryUploadRef.current = true;
                      contentInputRef.current?.click();
                    }}
                  >
                    临时公网上传（7 天）
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    临时文件上传至 tmpfile.link，持链接者可访问，7 天后失效。单个文件最多 100 MB。
                  </p>
                  <p className="mt-2 min-h-4 text-xs text-muted-foreground" aria-live="polite">
                    {metadataLoading ? "正在读取图片信息..." : metadataError || assetMediaSummary(previewAsset)}
                  </p>
                </Card>}</Field>
            )}
          </div>
          <AssetFormPreview asset={previewAsset} />
        </FieldSet>
        <input
          ref={coverInputRef}
          type="file"
          className="hidden"
          accept="image/*"
          onChange={(event) => {
            void uploadCover(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <input
          ref={contentInputRef}
          type="file"
          className="hidden"
          accept={
            kind === "image"
              ? "image/*"
              : kind === "video"
                ? "video/mp4,video/quicktime,.mp4,.mov"
                : "audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"
          }
          onChange={(event) => {
            void uploadContent(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </form>
    </EditorWorkspace>
  );
}



function AssetFormPreview({ asset }: { asset: MyAsset }) {
  return (
    <aside className="min-w-0 border-t border-border pt-5 md:sticky md:top-0 md:self-start md:border-t-0 md:border-l md:pt-0 md:pl-6">
      <p className="text-xs font-semibold text-foreground">预览</p>
      <div className="mt-3 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-muted/50">
        {asset.coverUrl ? (
          <AuthenticatedImage src={asset.coverUrl} alt="" className="size-full object-cover" />
        ) : asset.kind === "image" && asset.url ? (
          <AuthenticatedImage src={asset.url} alt="" className="size-full object-contain" />
        ) : asset.kind === "video" && asset.url ? (
          <video src={asset.url} muted playsInline preload="metadata" className="size-full object-cover" />
        ) : asset.kind === "audio" ? (
          <AudioLines className="size-12 text-primary" />
        ) : (
          <p className="line-clamp-6 px-5 text-center text-sm leading-6 text-muted-foreground">
            {asset.content || "文本内容预览"}
          </p>
        )}
      </div>
      <h3 className="mt-3 truncate text-sm font-semibold">{asset.title || "未命名素材"}</h3>
      <p className="mt-1 break-words text-xs text-muted-foreground">{asset.source || "未标注来源"}</p>
    </aside>
  );
}

function previewMyAsset(input: {
  asset: MyAsset | null;
  kind: MyAssetKind;
  title: string;
  content: string;
  coverUrl: string;
  visibility: MyAssetVisibility;
  source: string;
  note: string;
  mediaMetadata: AssetMediaMetadata;
  mediaStorageKey: string;
}): MyAsset {
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
