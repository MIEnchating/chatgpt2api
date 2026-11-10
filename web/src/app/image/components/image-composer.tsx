"use client";
import { ModelPicker } from "@/components/model-picker";
import { LoadingState } from "@/components/ui/loading-state";

import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { PromptInput, PromptInputFooter, PromptInputSubmit } from "@/components/ai-elements/prompt-input";

import { Toggle } from "@/components/ui/toggle";



import type { ImageGenerationOptions } from "@/lib/image-generation-options";
import type { ImageOutputFormat } from "@/lib/api";
import { ArrowUp, BookOpenText, ImagePlus, Link2, Plus, SlidersHorizontal, Settings2, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ImageLightbox } from "@/components/image-lightbox";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia, AttachmentTrigger, AttachmentContent, AttachmentTitle } from "@/components/ui/attachment";
import {
  ImageSettingsPanel,
  type ImageSettingsValue,
} from "@/components/generation/image-settings-panel";
import {
  VideoSettingsPanel,
  type VideoSettingsValue,
} from "@/components/generation/video-settings-panel";
import {
  ImageParameterLabel,
} from "@/components/generation/image-parameter-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ReferenceFileUpload } from "@/components/generation/reference-file-upload";
import { ReferenceMediaCard } from "@/components/generation/reference-media-card";

import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea , InputGroupInput } from "@/components/ui/input-group";
import { TooltipButton, TooltipHint } from "@/components/ui/tooltip";
import {
  imageWorkbenchAcceptsReferenceImages,
  type ImageAspectRatio,
  type ImageResolution,
  type ImageSizeMode,
} from "@/lib/image-options";
import {
  type ImageModel,
  type ImageQuality,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { isPublicReferenceURL } from "@/lib/public-reference-url";
import { supportsVideoFrameReferences, videoWorkbenchMaterialSections, videoWorkbenchReferenceLimits } from "@/lib/video-model-capabilities";
import { videoContractUIState, videoModelContract } from "@/lib/video-model-contracts";
import { CreationModelSelector } from "./creation-model-selector";

type ImageComposerProps = {
  composerMode: "chat" | "image" | "video";
  prompt: string;
  contextSettingsReady: boolean;
  smartContextEnabled: boolean;
  contextTextModel: string;
  contextTextModels: string[];
  onSmartContextEnabledChange: (enabled: boolean) => void;
  onContextTextModelChange: (model: string) => void;
  onConfigureContextKey: () => void;
  imageCount: string;
  imageModel: ImageModel;
  imageModelOptions: ReadonlyArray<{ value: ImageModel; label: string }>;
  imageSizeMode: ImageSizeMode;
  imageAspectRatio: ImageAspectRatio;
  imageResolution: ImageResolution;
  imageCustomRatio: string;
  imageCustomWidth: string;
  imageCustomHeight: string;
  imageSnapToMultiple16: boolean;
  imageQuality: "" | ImageQuality;
  imageOptions?: ImageGenerationOptions;
  imageOutputFormat: ImageOutputFormat;
  onImageOptionsChange: (options: ImageGenerationOptions) => void;
  onImageOutputFormatChange: (format: ImageOutputFormat) => void;
  videoModel: string;
  videoModelOptions: ReadonlyArray<{ value: string; label: string }>;
  videoSize: string;
  videoParameters?: import("@/lib/video-model-contracts").VideoParameterValues;
  onVideoParametersChange?: (parameters: import("@/lib/video-model-contracts").VideoParameterValues) => void;
  videoSeconds: string;
  videoResolution: string;
  videoGenerateAudio: boolean;
  videoWatermark: boolean;
  videoTaskCount: number;
  videoFirstFrameURL: string;
  videoLastFrameURL: string;
  videoReferenceImageURLs: string[];
  videoReferenceVideoURLs: string[];
  videoReferenceAudioURLs: string[];
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageModelChange: (value: ImageModel) => void;
  onImageSizeModeChange: (value: ImageSizeMode) => void;
  onImageAspectRatioChange: (value: ImageAspectRatio) => void;
  onImageResolutionChange: (value: ImageResolution) => void;
  onImageCustomRatioChange: (value: string) => void;
  onImageCustomWidthChange: (value: string) => void;
  onImageCustomHeightChange: (value: string) => void;
  onImageSnapToMultiple16Change: (value: boolean) => void;
  onImageQualityChange: (value: "" | ImageQuality) => void;
  onVideoModelChange: (value: string) => void;
  onVideoSizeChange: (value: string) => void;
  onVideoSecondsChange: (value: string) => void;
  onVideoResolutionChange: (value: string) => void;
  onVideoGenerateAudioChange: (value: boolean) => void;
  onVideoWatermarkChange: (value: boolean) => void;
  onVideoTaskCountChange: (value: number) => void;
  onVideoFirstFrameURLChange: (value: string) => void;
  onVideoLastFrameURLChange: (value: string) => void;
  videoFrameUploading: "first" | "last" | null;
  onVideoFrameFileChange: (slot: "first" | "last", file: File) => void | Promise<void>;
  onVideoReferenceImageURLsChange: (value: string[]) => void;
  onVideoReferenceVideoURLsChange: (value: string[]) => void;
  onVideoReferenceAudioURLsChange: (value: string[]) => void;
  videoReferenceUploading: boolean;
  onVideoReferenceFileChange: (file: File) => void | Promise<void>;
  audioReferenceUploading: boolean;
  onAudioReferenceFileChange: (file: File) => void | Promise<void>;
  submitDisabled?: boolean;
  submitDisabledReason?: string;
  onSubmit: () => void | Promise<void>;
  onOpenPromptMarket: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

type PendingReferenceImage = {
  id: string;
  name: string;
  dataUrl: string;
};

type DisplayReferenceImage = {
  id: string;
  name: string;
  dataUrl: string;
  storedIndex: number | null;
  uploading: boolean;
};

function MediaReferencePicker({ kind, values, max, disabled, uploading, onChange, onRemove, children }: { kind: "video" | "audio"; values: string[]; max: number; disabled: boolean; uploading: boolean; onChange: (file: File) => void | Promise<void>; onRemove: (index: number) => void; children: ReactNode }) {
  const label = kind === "video" ? "参考视频" : "参考音频";
  return <Card size="sm">
    <CardHeader className="flex flex-row items-center justify-between gap-3">
      <CardTitle><ImageParameterLabel help={kind === "video" ? "参考动作、运镜，或编辑、延长已有片段，具体取决于模型。" : "用于声音参考；台词写在提示词中，是否支持录音驱动口型取决于模型。"}>{label}</ImageParameterLabel></CardTitle>
      <Badge variant="secondary" className="tabular-nums">{values.length} / {max}</Badge>
    </CardHeader>
    <CardContent className="grid gap-3">
    <AttachmentGroup className="grid grid-cols-3 gap-2 overflow-x-visible">
      {values.map((value, index) => <ReferenceMediaCard key={`${value}-${index}`} kind={kind} src={value} label={`${label} ${index + 1}`} removeDisabled={disabled} onRemove={() => onRemove(index)} />)}
      <ReferenceFileUpload
        label={`上传${label}`}
        showLabel={false} showHint={false}
        accept={kind === "video" ? "video/mp4,video/quicktime,.mp4,.mov" : "audio/mpeg,audio/wav,.mp3,.wav"}
        hint={kind === "video" ? "MP4 / MOV · 最大 50 MiB" : "MP3 / WAV · 最大 15 MiB"}
        loading={uploading} disabled={disabled} remaining={max - values.length}
        onFiles={async files => { await Promise.all(files.map(file => onChange(file))); }}
      />
    </AttachmentGroup>
    <p className="text-[11px] leading-4 text-muted-foreground">{kind === "video" ? "MP4 / MOV · 单个最大 50 MiB" : "MP3 / WAV · 单个最大 15 MiB"}</p>
    {children}
    </CardContent>
  </Card>;
}

function PublicReferenceURLList({ label, values, max, disabled = false, showValues = true, onChange }: { label: string; values: string[]; max: number; disabled?: boolean; showValues?: boolean; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const populated = values.map((value, index) => ({ value: value.trim(), index })).filter((item) => item.value);
  const add = () => {
    const value = draft.trim();
    if (!isPublicReferenceURL(value) || populated.length >= max) return;
    onChange([...values.filter((item) => item.trim()), value]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      <InputGroup className="min-w-0">
        <InputGroupAddon><Link2 /></InputGroupAddon>
        <InputGroupInput type="url" value={draft} placeholder={`${label}公网 URL`} disabled={disabled || max === 0 || populated.length >= max} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} className="min-w-0 flex-1 px-1.5" aria-label={`${label}公网 URL`} />
        <TooltipButton type="button" variant="ghost" size="icon-xs" tooltip={`添加${label} URL`} aria-label={`添加${label} URL`} disabled={disabled || !isPublicReferenceURL(draft.trim()) || populated.length >= max} onClick={add} className="flex shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-60"><Plus  /></TooltipButton>
      </InputGroup>
      {showValues && populated.length ? <AttachmentGroup className="flex-col gap-1 overflow-x-visible">{populated.map(({ value, index }) => <Attachment key={`${value}-${index}`} size="xs" className="w-full">
        <AttachmentMedia><Link2 /></AttachmentMedia><AttachmentContent><TooltipHint content={value}><AttachmentTitle>{value}</AttachmentTitle></TooltipHint></AttachmentContent>
        <AttachmentActions><AttachmentAction disabled={disabled} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除${label} URL ${index + 1}`}><X /></AttachmentAction></AttachmentActions>
      </Attachment>)}</AttachmentGroup> : null}
    </div>
  );
}

function VideoFramePicker({ slot, label, value, disabled, uploading, onFileChange, onURLChange }: {
  slot: "first" | "last";
  label: string;
  value: string;
  disabled: boolean;
  uploading: boolean;
  onFileChange: (slot: "first" | "last", file: File) => void | Promise<void>;
  onURLChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <ImageParameterLabel help={slot === "first" ? "指定视频的起始画面，在提示词中描述后续动作；不保证人物全程不变。" : "指定视频的结束画面，在提示词中描述衔接动作；动作跨度需符合时长。"}>{label}</ImageParameterLabel>
      {value ? <ReferenceMediaCard kind="image" src={value} label={label} removeDisabled={disabled} onRemove={() => onURLChange("")} /> : <ReferenceFileUpload showLabel={false} label={`上传${label}`} hint="PNG / JPG / WebP" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" loading={uploading} disabled={disabled} onFiles={async files => { await onFileChange(slot, files[0]); }} />}
      <PublicReferenceURLList label={label} values={value ? [value] : []} max={1} disabled={disabled || uploading} showValues={false} onChange={(values) => onURLChange(values[0] || "")} />
    </div>
  );
}

const IMAGE_FILE_EXTENSION_PATTERN = /\.(jpeg|jpg|png|webp)$/i;
const IMAGE_FILE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function isImageFile(file: File) {
  const mimeType = file.type.trim().toLowerCase().split(";", 1)[0];
  return IMAGE_FILE_MIME_TYPES.has(mimeType) ||
    ((mimeType === "" || mimeType === "application/octet-stream") && IMAGE_FILE_EXTENSION_PATTERN.test(file.name));
}

function getImageFiles(files: FileList | File[]) {
  return Array.from(files).filter(isImageFile);
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files");
}

function hasDraggedImage(dataTransfer: DataTransfer) {
  if (!hasDraggedFiles(dataTransfer)) {
    return false;
  }

  const items = Array.from(dataTransfer.items);
  if (items.length === 0) {
    return true;
  }

  return items.some((item) => {
    const mimeType = item.type.trim().toLowerCase().split(";", 1)[0];
    return item.kind === "file" && (mimeType === "" || IMAGE_FILE_MIME_TYPES.has(mimeType));
  });
}

function ImageComposerDock({ children }: { children: ReactNode }) {
  return (
    <div className="w-full">{children}</div>
  );
}

export function ImageComposer({
  composerMode,
  prompt,
  contextSettingsReady, smartContextEnabled, contextTextModel, contextTextModels,
  onSmartContextEnabledChange, onContextTextModelChange, onConfigureContextKey,
  imageCount,
  imageModel,
  imageModelOptions,
  imageSizeMode,
  imageAspectRatio,
  imageResolution,
  imageCustomRatio,
  imageCustomWidth,
  imageCustomHeight,
  imageSnapToMultiple16,
  imageQuality,
  imageOptions, imageOutputFormat, onImageOptionsChange, onImageOutputFormatChange,
  videoModel,
  videoModelOptions,
  videoSize,
  videoParameters,
  onVideoParametersChange,
  videoSeconds,
  videoResolution,
  videoGenerateAudio,
  videoWatermark,
  videoTaskCount,
  videoFirstFrameURL,
  videoLastFrameURL,
  videoReferenceImageURLs,
  videoReferenceVideoURLs,
  videoReferenceAudioURLs,
  referenceImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageModelChange,
  onImageSizeModeChange,
  onImageAspectRatioChange,
  onImageResolutionChange,
  onImageCustomRatioChange,
  onImageCustomWidthChange,
  onImageCustomHeightChange,
  onImageSnapToMultiple16Change,
  onImageQualityChange,
  onVideoModelChange,
  onVideoSizeChange,
  onVideoSecondsChange,
  onVideoResolutionChange,
  onVideoGenerateAudioChange,
  onVideoWatermarkChange,
  onVideoTaskCountChange,
  onVideoFirstFrameURLChange,
  onVideoLastFrameURLChange,
  videoFrameUploading,
  onVideoFrameFileChange,
  onVideoReferenceImageURLsChange,
  onVideoReferenceVideoURLsChange,
  onVideoReferenceAudioURLsChange,
  videoReferenceUploading,
  onVideoReferenceFileChange,
  audioReferenceUploading,
  onAudioReferenceFileChange,
  submitDisabled = false,
  submitDisabledReason,
  onSubmit,
  onOpenPromptMarket,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isImageSettingsOpen, setIsImageSettingsOpen] = useState(false);
  const [videoSettingsSection, setVideoSettingsSection] = useState<"parameters" | "materials">("parameters");
  const [isReferenceImageDragActive, setIsReferenceImageDragActive] = useState(false);
  const [pendingReferenceImages, setPendingReferenceImages] = useState<PendingReferenceImage[]>([]);
  const referenceImageDragDepthRef = useRef(0);
  const pendingReferenceImageSequenceRef = useRef(0);
  const pendingReferenceImageURLsRef = useRef(new Set<string>());
  const displayReferenceImages = useMemo<DisplayReferenceImage[]>(
    () => [
      ...referenceImages.map((image, index) => ({
        id: `stored-${image.name}-${index}`,
        name: image.name,
        dataUrl: image.dataUrl,
        storedIndex: index,
        uploading: false,
      })),
      ...pendingReferenceImages.map((image) => ({
        ...image,
        storedIndex: null,
        uploading: true,
      })),
    ],
    [pendingReferenceImages, referenceImages],
  );
  const lightboxImages = useMemo(
    () => displayReferenceImages.map((image) => ({ id: image.id, src: image.dataUrl })),
    [displayReferenceImages],
  );
  const activeModel = composerMode === "video" ? videoModel : imageModel;
  const activeModelOptions = composerMode === "video" ? videoModelOptions : imageModelOptions;
  const activeModelAvailable = activeModelOptions.some((option) => option.value === activeModel);
  const activeVideoSupportsFrames = supportsVideoFrameReferences(videoModel);
  const activeVideoReferenceLimits = videoWorkbenchReferenceLimits(videoModel);
  const activeVideoMaterialSections = videoWorkbenchMaterialSections(videoModel);
  const activeVideoImageLimit = activeVideoReferenceLimits.image;
  const activeVideoReferenceImageCount = referenceImages.length + pendingReferenceImages.length + videoReferenceImageURLs.filter(Boolean).length;
  const videoRuleValues = {
    first_frame: videoFirstFrameURL.trim(),
    last_frame: videoLastFrameURL.trim(),
    reference_image: activeVideoReferenceImageCount,
    reference_video: videoReferenceVideoURLs.filter(Boolean).length,
    reference_audio: videoReferenceAudioURLs.filter(Boolean).length,
    generate_audio: videoGenerateAudio,
    size: videoSize,
    resolution: videoResolution,
    duration: Number(videoSeconds),
    watermark: videoWatermark,
  };
  const activeVideoContractUI = videoContractUIState(videoModelContract(videoModel), videoRuleValues);
  const videoFieldVisible = (field: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio") => !activeVideoContractUI.hidden.has(field);
  const videoFieldDisabled = (field: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio") => activeVideoContractUI.disabled.has(field);
  const videoMaterials = [
    ...displayReferenceImages.map((image, index) => ({ id: image.id, kind: "image" as const, src: image.dataUrl, label: `参考图 ${index + 1}`, uploading: image.uploading, onRemove: () => { if (image.storedIndex !== null) onRemoveReferenceImage(image.storedIndex); } })),
    ...(activeVideoSupportsFrames && videoFieldVisible("first_frame") && videoFirstFrameURL ? [{ id: "first-frame", kind: "image" as const, src: videoFirstFrameURL, label: "首帧", onRemove: () => onVideoFirstFrameURLChange("") }] : []),
    ...(activeVideoSupportsFrames && videoFieldVisible("last_frame") && videoLastFrameURL ? [{ id: "last-frame", kind: "image" as const, src: videoLastFrameURL, label: "尾帧", onRemove: () => onVideoLastFrameURLChange("") }] : []),
    ...(activeVideoMaterialSections.image && videoFieldVisible("reference_image") ? videoReferenceImageURLs.map((src, index) => ({ id: `image-url-${index}`, kind: "image" as const, src, label: `参考图 ${referenceImages.length + index + 1}`, onRemove: () => onVideoReferenceImageURLsChange(videoReferenceImageURLs.filter((_, i) => i !== index)) })) : []),
    ...(activeVideoMaterialSections.video && videoFieldVisible("reference_video") ? videoReferenceVideoURLs.map((src, index) => ({ id: `video-${index}`, kind: "video" as const, src, label: `参考视频 ${index + 1}`, onRemove: () => onVideoReferenceVideoURLsChange(videoReferenceVideoURLs.filter((_, i) => i !== index)) })) : []),
    ...(activeVideoMaterialSections.audio && videoFieldVisible("reference_audio") ? videoReferenceAudioURLs.map((src, index) => ({ id: `audio-${index}`, kind: "audio" as const, src, label: `参考音频 ${index + 1}`, onRemove: () => onVideoReferenceAudioURLsChange(videoReferenceAudioURLs.filter((_, i) => i !== index)) })) : []),
  ];
  const referenceEditingSupported = composerMode === "video"
    ? true
    : imageWorkbenchAcceptsReferenceImages(imageModel);
  const hasReferenceImages = displayReferenceImages.length > 0;
  const hasVideoFrame = Boolean(videoFirstFrameURL.trim() || videoLastFrameURL.trim());
  const hasReferenceVideo = videoReferenceVideoURLs.some(Boolean);
  const hasMultimodalReferences = videoReferenceImageURLs.some(Boolean) || hasReferenceVideo || videoReferenceAudioURLs.some(Boolean);
  const submitLabel = composerMode === "video"
    ? hasReferenceVideo ? "视频生视频" : hasVideoFrame || hasReferenceImages || videoReferenceImageURLs.some(Boolean) ? "图片生视频" : hasMultimodalReferences ? "参考生成视频" : "生成视频"
    : hasReferenceImages ? "编辑图片" : "生成图片";
  const imageSettingsValue: ImageSettingsValue = {
    mode: imageSizeMode,
    aspectRatio: imageAspectRatio,
    resolution: imageResolution,
    customRatio: imageCustomRatio,
    customWidth: imageCustomWidth,
    customHeight: imageCustomHeight,
    snapToMultiple16: imageSnapToMultiple16,
    quality: imageQuality,
    imageOptions, outputFormat: imageOutputFormat,
    count: Number(imageCount) || 1,
  };

  function updateImageSettings(patch: Partial<ImageSettingsValue>) {
    if (patch.imageOptions !== undefined) onImageOptionsChange(patch.imageOptions);
    if (patch.outputFormat !== undefined) onImageOutputFormatChange(patch.outputFormat);
    if (patch.mode !== undefined) onImageSizeModeChange(patch.mode);
    if (patch.aspectRatio !== undefined) onImageAspectRatioChange(patch.aspectRatio);
    if (patch.resolution !== undefined) onImageResolutionChange(patch.resolution);
    if (patch.customRatio !== undefined) onImageCustomRatioChange(patch.customRatio);
    if (patch.customWidth !== undefined) onImageCustomWidthChange(patch.customWidth);
    if (patch.customHeight !== undefined) onImageCustomHeightChange(patch.customHeight);
    if (patch.snapToMultiple16 !== undefined) onImageSnapToMultiple16Change(patch.snapToMultiple16);
    if (patch.quality !== undefined) onImageQualityChange(patch.quality);
    if (patch.count !== undefined) onImageCountChange(String(patch.count));
  }

  const videoSettingsValue: VideoSettingsValue = {
    parameters: videoParameters,
    size: videoSize,
    seconds: videoSeconds,
    resolution: videoResolution,
    generateAudio: videoGenerateAudio,
    watermark: videoWatermark,
    taskCount: videoTaskCount,
  };

  function updateVideoSettings(patch: Partial<VideoSettingsValue>) {
    if (patch.parameters !== undefined) onVideoParametersChange?.(patch.parameters);
    if (patch.size !== undefined) onVideoSizeChange(patch.size);
    if (patch.seconds !== undefined) onVideoSecondsChange(patch.seconds);
    if (patch.resolution !== undefined) onVideoResolutionChange(patch.resolution);
    if (patch.generateAudio !== undefined) onVideoGenerateAudioChange(patch.generateAudio);
    if (patch.watermark !== undefined) onVideoWatermarkChange(patch.watermark);
    if (patch.taskCount !== undefined) onVideoTaskCountChange(patch.taskCount);
  }

  useEffect(() => {
    const pendingURLs = pendingReferenceImageURLsRef.current;
    return () => {
      pendingURLs.forEach((url) => URL.revokeObjectURL(url));
      pendingURLs.clear();
    };
  }, []);

  const addReferenceImages = async (files: File[]) => {
    if (!referenceEditingSupported) {
      return;
    }
    const imageFiles = getImageFiles(files);
    if (imageFiles.length === 0) {
      return;
    }

    const pendingImages = imageFiles.map((file) => {
      const dataUrl = URL.createObjectURL(file);
      pendingReferenceImageURLsRef.current.add(dataUrl);
      pendingReferenceImageSequenceRef.current += 1;
      return {
        id: `pending-${pendingReferenceImageSequenceRef.current}`,
        name: file.name,
        dataUrl,
      };
    });
    const pendingIDs = new Set(pendingImages.map((image) => image.id));
    setPendingReferenceImages((previous) => [...previous, ...pendingImages]);

    try {
      await onReferenceImageChange(imageFiles);
    } finally {
      setPendingReferenceImages((previous) => previous.filter((image) => !pendingIDs.has(image.id)));
      pendingImages.forEach((image) => {
        pendingReferenceImageURLsRef.current.delete(image.dataUrl);
        URL.revokeObjectURL(image.dataUrl);
      });
    }
  };

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!referenceEditingSupported) {
      return;
    }
    const imageFiles = getImageFiles(event.clipboardData.files);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void addReferenceImages(imageFiles);
  };

  const resetReferenceImageDragState = () => {
    referenceImageDragDepthRef.current = 0;
    setIsReferenceImageDragActive(false);
  };

  const handleReferenceImageDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!referenceEditingSupported) {
      return;
    }
    if (!hasDraggedImage(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    referenceImageDragDepthRef.current += 1;
    setIsReferenceImageDragActive(true);
    event.dataTransfer.dropEffect = "copy";
  };

  const handleReferenceImageDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!referenceEditingSupported) {
      return;
    }
    if (!hasDraggedImage(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setIsReferenceImageDragActive(true);
    event.dataTransfer.dropEffect = "copy";
  };

  const handleReferenceImageDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!referenceEditingSupported) {
      return;
    }
    if (!hasDraggedImage(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    referenceImageDragDepthRef.current = Math.max(0, referenceImageDragDepthRef.current - 1);
    if (referenceImageDragDepthRef.current === 0) {
      setIsReferenceImageDragActive(false);
    }
  };

  const handleReferenceImageDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!referenceEditingSupported) {
      return;
    }
    if (!hasDraggedFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    resetReferenceImageDragState();
    void addReferenceImages(Array.from(event.dataTransfer.files));
  };

  const handlePickReferenceImage = () => {
    if (!referenceEditingSupported) {
      return;
    }
    fileInputRef.current?.click();
  };

  const handleImageSettingsOpenChange = (open: boolean) => {
    setIsImageSettingsOpen(open);
  };

  return (
    <ImageComposerDock>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (files.length === 0) {
            return;
          }
          void addReferenceImages(files);
        }}
      />

      {composerMode !== "video" && displayReferenceImages.length > 0 ? (
        <AttachmentGroup className="mb-2 gap-2 px-1 sm:mb-3" onWheel={(event) => { event.stopPropagation(); }}>
          {displayReferenceImages.map((image, index) => (
            <Attachment key={image.id} orientation="vertical" size="sm" state={image.uploading ? "uploading" : "done"} aria-busy={image.uploading} className="w-14 sm:w-16">
              <AttachmentMedia variant="image">
                <AuthenticatedImage src={image.dataUrl} alt={image.name || `参考图 ${index + 1}`} className="size-full object-cover" placeholderClassName="min-h-0" />
                {image.uploading ? <Spinner className="absolute" aria-label={`正在上传参考图 ${image.name || index + 1}`} /> : null}
              </AttachmentMedia>
              <AttachmentTrigger
                disabled={image.uploading}
                onClick={() => { setLightboxIndex(index); setLightboxOpen(true); }}
                aria-label={`预览参考图 ${image.name || index + 1}`}
              />
              {!image.uploading ? <AttachmentActions className="group-data-[orientation=vertical]/attachment:top-0 group-data-[orientation=vertical]/attachment:right-0">
                <AttachmentAction type="button" onClick={() => { if (image.storedIndex !== null) onRemoveReferenceImage(image.storedIndex); }} aria-label={`移除参考图 ${image.name || index + 1}`}><X /></AttachmentAction>
              </AttachmentActions> : null}
            </Attachment>
          ))}
        </AttachmentGroup>
      ) : null}

      {composerMode === "video" && (videoMaterials.length > 0 || videoReferenceUploading || audioReferenceUploading || videoFrameUploading) ? <div className="mb-3">
        <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-muted-foreground [@media(max-height:600px)]:hidden"><span>参考素材</span><span className="tabular-nums">{videoMaterials.length}</span>{videoReferenceUploading || audioReferenceUploading || videoFrameUploading ? <LoadingState compact className="ml-auto" label="素材上传中" /> : null}</div>
        <AttachmentGroup className="gap-2 px-1" onWheel={(event) => { event.stopPropagation(); }}>
          {videoMaterials.map(material => <ReferenceMediaCard key={material.id} {...material} compact />)}
        </AttachmentGroup>
      </div> : null}

      <PromptInput
        data-studio-composer
        className="relative h-auto flex-col items-stretch"
        onDragEnter={handleReferenceImageDragEnter}
        onDragOver={handleReferenceImageDragOver}
        onDragLeave={handleReferenceImageDragLeave}
        onDrop={handleReferenceImageDrop}
      >
        {isReferenceImageDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <Badge variant="secondary" className="inline-flex items-center gap-2">
              <ImagePlus className="size-4" />
              松开上传图片
            </Badge>
          </div>
        ) : null}
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          onIndexChange={setLightboxIndex}
        />
        <InputGroupTextarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onPaste={handleTextareaPaste}
          aria-label={composerMode === "video" ? "视频提示词" : "图片提示词"}
          placeholder={
            composerMode === "video"
              ? hasReferenceImages || hasVideoFrame ? "描述参考画面如何动起来，补充镜头运动和氛围…" : "描述场景、主体动作、镜头运动和声音…"
              : hasReferenceImages
              ? "描述你希望如何修改参考图"
              : "输入你想要生成的画面，也可直接粘贴图片"
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              if (activeModelAvailable && !submitDisabled) void onSubmit();
            }
          }}
          className="min-h-20 max-h-48 w-full flex-none"
        />

        <PromptInputFooter
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
            {composerMode !== "video" ? <InputGroupButton size="icon-sm" onClick={handlePickReferenceImage} disabled={!referenceEditingSupported} aria-label="上传参考图"><Plus /></InputGroupButton> : null}
            {composerMode !== "chat" ? <InputGroupButton size="icon-sm" onClick={onOpenPromptMarket} aria-label="打开提示词"><BookOpenText /></InputGroupButton> : null}
            <div className="ml-auto flex w-full min-w-0 items-center justify-end gap-2 sm:w-auto">
              <CreationModelSelector kind={composerMode === "video" ? "video" : "image"} value={activeModel} options={activeModelOptions}
                isDisabled={(model) => composerMode !== "video" && hasReferenceImages && !imageWorkbenchAcceptsReferenceImages(model)}
                onChange={(model) => { if (composerMode === "video") onVideoModelChange(model); else onImageModelChange(model as ImageModel); }}
                onOpen={() => setIsImageSettingsOpen(false)} />
              <div className="flex shrink-0 items-center gap-1.5">
                  <Label className="flex items-center gap-2 text-xs">
                    <Switch checked={smartContextEnabled} disabled={!contextSettingsReady} onCheckedChange={onSmartContextEnabledChange} aria-label="智能生成" />
                    <span className="hidden sm:inline">智能生成</span>
                  </Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <InputGroupButton type="button" variant="ghost" size="icon-sm" disabled={!contextSettingsReady} aria-label="设置智能生成"><Settings2 /></InputGroupButton>
                    </PopoverTrigger>
                    <PopoverContent align="start" side="top" className="w-[min(calc(100vw-1rem),22rem)]">
                      <PopoverHeader><PopoverTitle>智能生成设置</PopoverTitle></PopoverHeader>
                      <ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
                        <p className="text-xs leading-5 text-muted-foreground">关闭时直接使用本轮提示词和参考图生成。开启后由 Agent 理解历史和参考图、调整本轮参数并调用生成工具，会额外调用文本模型。此开关对所有对话生效。</p>
                        <div className="grid gap-2">
                          <p id="studio-context-model-label" className="text-xs font-medium">Agent 文本模型（需支持工具调用和图片理解）</p>
                          <ModelPicker label="Agent 文本模型" value={contextTextModel} options={contextTextModels} onValueChange={onContextTextModelChange} placeholder="暂无可用文本模型" />
                        </div>
                        {contextTextModels.length === 0 ? <p className="text-xs leading-5 text-muted-foreground">管理员尚未启用文本模型。可关闭智能生成继续生成。</p> : null}
                        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={onConfigureContextKey}>选择文本 Key</Button>
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
              </div>
              {composerMode === "image" ? (
                <Popover open={isImageSettingsOpen} onOpenChange={handleImageSettingsOpenChange}>
                  <PopoverTrigger asChild>
                    <InputGroupButton
                      type="button"
                      variant="outline"
                      size="sm"

                      aria-label={isImageSettingsOpen ? "收起图像设置" : "打开图像设置"}
                      aria-expanded={isImageSettingsOpen}
                    >
                      <SlidersHorizontal  />
                      <span className="hidden sm:inline">参数</span>
                    </InputGroupButton>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    side="top"
                    sideOffset={8}
                    className="max-h-[min(80dvh,40rem,var(--radix-popover-content-available-height))] w-[min(calc(100vw-1rem),26rem)] overflow-hidden"
                  >
                    <PopoverHeader className="shrink-0 flex-row items-center justify-between px-1.5">
                      <PopoverTitle>图片参数</PopoverTitle>
                      <Button variant="ghost" size="icon-sm" type="button" onClick={() => setIsImageSettingsOpen(false)} aria-label="关闭图像设置"><X /></Button>
                    </PopoverHeader>
                    <ScrollArea className="min-h-0 flex-1" contentClassName="px-1.5 py-1" onWheel={(event) => event.stopPropagation()}>
                      <ImageSettingsPanel model={imageModel} value={imageSettingsValue} onChange={updateImageSettings} />
                    </ScrollArea>
                  </PopoverContent>
                </Popover>
              ) : null}
              {composerMode === "video" ? (
                <div className="contents">
                  <Popover open={isImageSettingsOpen} onOpenChange={handleImageSettingsOpenChange}>
                    <PopoverTrigger asChild>
                      <InputGroupButton
                        type="button"
                        variant="outline"
                        size="sm"

                        aria-label="打开视频设置"
                        aria-expanded={isImageSettingsOpen}
                      >
                        <SlidersHorizontal  />
                        <span className="hidden sm:inline">参数</span>
                      </InputGroupButton>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      side="top"
                      sideOffset={8}
                      className="max-h-[min(80dvh,40rem,var(--radix-popover-content-available-height))] w-[min(calc(100vw-1rem),30rem)] overflow-hidden"
                    >
                      <PopoverHeader className="shrink-0 px-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <PopoverTitle>视频参数</PopoverTitle>
                          <Button variant="ghost" size="icon-sm" type="button" onClick={() => setIsImageSettingsOpen(false)} aria-label="关闭视频设置"><X /></Button>
                        </div>
                        <div role="group" aria-label="视频设置分区" className="mt-3 grid grid-cols-2 gap-1 p-1">
                          {(["parameters", "materials"] as const).map((section) => <Toggle  key={section} type="button" pressed={videoSettingsSection === section} onClick={() => setVideoSettingsSection(section)} >
                            {section === "parameters" ? "生成参数" : `参考素材${videoMaterials.length ? ` · ${videoMaterials.length}` : ""}`}
                          </Toggle>)}
                        </div>
                      </PopoverHeader>
                      <ScrollArea key={videoSettingsSection} className="min-h-0 flex-1" contentClassName="px-1.5 py-1" onWheel={(event) => event.stopPropagation()}>
                        <div hidden={videoSettingsSection !== "materials"}>
                          <div className="flex flex-col gap-4">
                            {activeVideoSupportsFrames && (videoFieldVisible("first_frame") || videoFieldVisible("last_frame")) ? <Card size="sm">
                              <CardHeader className="flex flex-row items-center justify-between"><CardTitle><ImageParameterLabel help="首帧控制开场，尾帧控制收尾，中间动作由提示词引导。能否搭配参考图以当前模型配置为准。">首尾帧</ImageParameterLabel></CardTitle><span className="text-[11px] text-muted-foreground">{[videoFirstFrameURL, videoLastFrameURL].filter(Boolean).length}/2</span></CardHeader>
                              <CardContent>
                              <div className={cn("grid gap-2", videoFieldVisible("first_frame") && videoFieldVisible("last_frame") ? "grid-cols-2" : "grid-cols-1")}>
                                {videoFieldVisible("first_frame") ? <VideoFramePicker slot="first" label="首帧" value={videoFirstFrameURL} disabled={videoFieldDisabled("first_frame")} uploading={videoFrameUploading === "first"} onFileChange={onVideoFrameFileChange} onURLChange={onVideoFirstFrameURLChange} /> : null}
                                {videoFieldVisible("last_frame") ? <VideoFramePicker slot="last" label="尾帧" value={videoLastFrameURL} disabled={videoFieldDisabled("last_frame")} uploading={videoFrameUploading === "last"} onFileChange={onVideoFrameFileChange} onURLChange={onVideoLastFrameURLChange} /> : null}
                              </div>
                              </CardContent>
                            </Card> : null}
                            {activeVideoMaterialSections.image && videoFieldVisible("reference_image") ? <Card size="sm">
                              <CardHeader className="flex flex-row items-center justify-between"><CardTitle><ImageParameterLabel help={activeVideoMaterialSections.imageLabel === "首尾帧" ? "图片按顺序指定开场和收尾画面，中间动作由提示词引导。" : "提供人物、场景或物品的外观依据，不限定开场构图，也不保证跨镜头完全一致。"}>{activeVideoMaterialSections.imageLabel}</ImageParameterLabel></CardTitle><span className="text-[11px] text-muted-foreground">{activeVideoReferenceImageCount}/{activeVideoImageLimit}</span></CardHeader>
                              <CardContent className="grid gap-3">
                              <AttachmentGroup className="grid grid-cols-3 gap-2 overflow-x-visible">
                                {displayReferenceImages.map((image, index) => <ReferenceMediaCard key={image.id} kind="image" src={image.dataUrl} label={`参考图 ${index + 1}`} uploading={image.uploading} onRemove={() => { if (image.storedIndex !== null) onRemoveReferenceImage(image.storedIndex); }} />)}
                                {videoReferenceImageURLs.map((src, index) => <ReferenceMediaCard key={`${src}-${index}`} kind="image" src={src} label={`参考图 ${referenceImages.length + index + 1}`} onRemove={() => onVideoReferenceImageURLsChange(videoReferenceImageURLs.filter((_, i) => i !== index))} />)}
                                <ReferenceFileUpload showLabel={false} showHint={false} label="上传参考图" hint="PNG / JPG / WebP" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" loading={pendingReferenceImages.length > 0} disabled={videoFieldDisabled("reference_image")} remaining={activeVideoImageLimit - activeVideoReferenceImageCount} onFiles={addReferenceImages} />
                              </AttachmentGroup>
                              <p className="text-[11px] leading-4 text-muted-foreground">PNG / JPG / WebP</p>
                              <PublicReferenceURLList label="参考图片" values={videoReferenceImageURLs} max={Math.max(0, activeVideoImageLimit - referenceImages.length - pendingReferenceImages.length)} disabled={videoFieldDisabled("reference_image")} showValues={false} onChange={onVideoReferenceImageURLsChange} />
                              {activeVideoImageLimit === 0 ? <p className="text-[11px] leading-4 text-muted-foreground">当前模型不支持参考图片</p> : null}
                              </CardContent>
                            </Card> : null}
                            {activeVideoMaterialSections.video && videoFieldVisible("reference_video") ? <MediaReferencePicker kind="video" values={videoReferenceVideoURLs} max={activeVideoReferenceLimits.video} disabled={videoFieldDisabled("reference_video")} uploading={videoReferenceUploading} onChange={onVideoReferenceFileChange} onRemove={(index) => onVideoReferenceVideoURLsChange(videoReferenceVideoURLs.filter((_, i) => i !== index))}>
                              <PublicReferenceURLList label="参考视频" values={videoReferenceVideoURLs} max={activeVideoReferenceLimits.video} disabled={videoFieldDisabled("reference_video") || videoReferenceUploading} showValues={false} onChange={onVideoReferenceVideoURLsChange} />
                            </MediaReferencePicker> : null}
                            {activeVideoMaterialSections.audio && videoFieldVisible("reference_audio") ? <MediaReferencePicker kind="audio" values={videoReferenceAudioURLs} max={activeVideoReferenceLimits.audio} disabled={videoFieldDisabled("reference_audio")} uploading={audioReferenceUploading} onChange={onAudioReferenceFileChange} onRemove={(index) => onVideoReferenceAudioURLsChange(videoReferenceAudioURLs.filter((_, i) => i !== index))}>
                              <PublicReferenceURLList label="参考音频" values={videoReferenceAudioURLs} max={activeVideoReferenceLimits.audio} disabled={videoFieldDisabled("reference_audio") || audioReferenceUploading} showValues={false} onChange={onVideoReferenceAudioURLsChange} />
                            </MediaReferencePicker> : null}
                          </div>
                        </div>
                        <div hidden={videoSettingsSection !== "parameters"}>
                          <VideoSettingsPanel
                            model={videoModel}
                            value={videoSettingsValue}
                            ruleValues={videoRuleValues}
                            onChange={updateVideoSettings}
                          />
                        </div>
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
                </div>
              ) : null}
              <TooltipHint content={submitDisabledReason}><PromptInputSubmit
                type="button"
                onClick={() => void onSubmit()}
                disabled={(!prompt.trim() && !(composerMode === "video" && videoModelContract(videoModel)?.capability.prompt?.required === false)) || !activeModelAvailable || submitDisabled}
                className="shrink-0"
                aria-label={submitLabel}
              >
                <ArrowUp  />
              </PromptInputSubmit></TooltipHint>
            </div>
          </div>
        </PromptInputFooter>
      </PromptInput>
    </ImageComposerDock>
  );
}
