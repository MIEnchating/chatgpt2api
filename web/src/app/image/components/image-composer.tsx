"use client";
import {
  ArrowUp,
  AudioLines,
  BookOpenText,
  ImagePlus,
  Link2,
  LoaderCircle,
  Plus,
  SlidersHorizontal,
  Video,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ImageLightbox } from "@/components/image-lightbox";
import { AuthenticatedImage } from "@/components/authenticated-image";
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
import { FileUploadButton } from "@/components/ui/file-upload-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
import { VideoModelContractButton } from "./video-task-contract";

type ImageComposerProps = {
  composerMode: "chat" | "image" | "video";
  prompt: string;
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
  onComposerModeChange: (value: "image" | "video") => void;
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

const PROMPT_AREA_MIN_HEIGHT = 58;
const PROMPT_AREA_DEFAULT_HEIGHT = 58;
const PROMPT_AREA_MAX_HEIGHT = 320;
const PROMPT_AREA_KEYBOARD_STEP = 12;

function VideoReferencePicker({ values, max, disabled, uploading, onChange, onRemove }: { values: string[]; max: number; disabled: boolean; uploading: boolean; onChange: (file: File) => void | Promise<void>; onRemove: (index: number) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <ImageParameterLabel help="用于参考动作、运镜，或编辑、延长已有片段，具体取决于模型。支持 MP4 / MOV，单个文件最大 50 MiB。">参考视频</ImageParameterLabel>
        <span className="text-[11px] text-muted-foreground dark:text-muted-foreground">{values.length}/{max}，MP4 / MOV，最大 50 MiB</span>
      </div>
      <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; files.slice(0, max - values.length).forEach((file) => void onChange(file)); }} />
      <FileUploadButton icon={Video} loading={uploading} disabled={disabled} onClick={() => inputRef.current?.click()}>
        {uploading ? "正在上传参考视频" : "上传参考视频"}
      </FileUploadButton>
      {values.length ? <div className="space-y-1.5">{values.map((value, index) => <div key={`${value}-${index}`} className="flex h-8 items-center gap-2 rounded-lg bg-muted px-2 dark:bg-muted/70"><Video className="size-3.5 shrink-0 text-brand" /><span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground dark:text-muted-foreground">参考视频 {index + 1}</span><button type="button" onClick={() => onRemove(index)} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`移除参考视频 ${index + 1}`}><X className="size-3.5" /></button></div>)}</div> : null}
      {disabled && max === 0 ? <p className="text-[11px] leading-4 text-muted-foreground">当前模型不支持参考视频</p> : null}
    </section>
  );
}

function AudioReferencePicker({ values, max, disabled, uploading, onChange, onRemove }: { values: string[]; max: number; disabled: boolean; uploading: boolean; onChange: (file: File) => void | Promise<void>; onRemove: (index: number) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between"><ImageParameterLabel help="用于声音参考；台词写在提示词中，是否支持录音驱动口型取决于模型。支持 MP3 / WAV，单个文件最大 15 MiB。">参考音频</ImageParameterLabel><span className="text-[11px] text-muted-foreground dark:text-muted-foreground">{values.length}/{max}，MP3 / WAV</span></div>
      <input ref={inputRef} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" multiple className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; files.slice(0, max - values.length).forEach((file) => void onChange(file)); }} />
      <FileUploadButton icon={AudioLines} loading={uploading} disabled={disabled} onClick={() => inputRef.current?.click()}>
        {uploading ? "正在上传参考音频" : "上传参考音频"}
      </FileUploadButton>
      {values.length ? <div className="space-y-1.5">{values.map((value, index) => <div key={`${value}-${index}`} className="grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1.5"><audio src={value} controls className="h-8 w-full min-w-0" /><button type="button" onClick={() => onRemove(index)} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`移除参考音频 ${index + 1}`}><X className="size-3.5" /></button></div>)}</div> : null}
      {disabled && max === 0 ? <p className="text-[11px] leading-4 text-muted-foreground">当前模型不支持参考音频</p> : null}
    </section>
  );
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
      <div className={cn("flex h-9 items-center gap-1 rounded-lg border border-input bg-background p-1 shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20", (disabled || max === 0 || populated.length >= max) && "bg-muted/35 opacity-60")}>
        <Link2 className="ml-1.5 size-3.5 shrink-0 text-muted-foreground" />
        <Input type="url" value={draft} placeholder={`${label}公网 URL`} disabled={disabled || max === 0 || populated.length >= max} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1.5 text-xs shadow-none focus-visible:border-transparent focus-visible:ring-0" aria-label={`${label}公网 URL`} />
        <TooltipButton type="button" tooltip={`添加${label} URL`} aria-label={`添加${label} URL`} disabled={disabled || !isPublicReferenceURL(draft.trim()) || populated.length >= max} onClick={add} className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-60"><Plus className="size-3.5" /></TooltipButton>
      </div>
      {showValues && populated.length ? <div className="space-y-1">{populated.map(({ value, index }) => <div key={`${value}-${index}`} className="grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1"><TooltipHint content={value}><span className="truncate rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground dark:bg-muted/70">{value}</span></TooltipHint><button type="button" onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`移除${label} URL ${index + 1}`}><X className="size-3.5" /></button></div>)}</div> : null}
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
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-1.5">
      <ImageParameterLabel help={slot === "first" ? "指定视频的起始画面，在提示词中描述后续动作；不保证人物全程不变。" : "指定视频的结束画面，在提示词中描述衔接动作；动作跨度需符合时长。"}>{label}</ImageParameterLabel>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void onFileChange(slot, file); }} />
      {value ? (
        <div className="grid grid-cols-[3rem_minmax(0,1fr)_1.75rem] items-center gap-2 rounded-lg border border-border p-1.5 dark:border-border">
          <AuthenticatedImage src={value} alt={label} className="size-12 rounded-md object-cover" />
          <TooltipHint content={value}><span className="truncate text-[11px] text-muted-foreground">{value}</span></TooltipHint>
          <button type="button" disabled={disabled} onClick={() => onURLChange("")} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" aria-label={`移除${label}`}><X className="size-3.5" /></button>
        </div>
      ) : (
        <FileUploadButton icon={ImagePlus} loading={uploading} disabled={disabled} onClick={() => inputRef.current?.click()} className="h-10">
          {uploading ? `正在上传${label}` : `上传${label}`}
        </FileUploadButton>
      )}
      <PublicReferenceURLList label={label} values={value ? [value] : []} max={1} disabled={disabled} showValues={false} onChange={(values) => onURLChange(values[0] || "")} />
    </div>
  );
}

const IMAGE_FILE_EXTENSION_PATTERN = /\.(jpeg|jpg|png|webp)$/i;
const IMAGE_FILE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function getPromptAreaMaxHeight() {
  if (typeof window === "undefined") {
    return PROMPT_AREA_MAX_HEIGHT;
  }
  return Math.max(PROMPT_AREA_MIN_HEIGHT, Math.min(PROMPT_AREA_MAX_HEIGHT, Math.floor(window.innerHeight * 0.42)));
}

function clampPromptAreaHeight(height: number) {
  return Math.min(Math.max(height, PROMPT_AREA_MIN_HEIGHT), getPromptAreaMaxHeight());
}

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
  onComposerModeChange,
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
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isImageSettingsOpen, setIsImageSettingsOpen] = useState(false);
  const [videoSettingsSection, setVideoSettingsSection] = useState<"parameters" | "materials">("parameters");
  const [promptAreaHeight, setPromptAreaHeight] = useState(PROMPT_AREA_DEFAULT_HEIGHT);
  const [isPromptAreaResizing, setIsPromptAreaResizing] = useState(false);
  const [isReferenceImageDragActive, setIsReferenceImageDragActive] = useState(false);
  const [pendingReferenceImages, setPendingReferenceImages] = useState<PendingReferenceImage[]>([]);
  const composerPanelRef = useRef<HTMLDivElement>(null);
  const promptAreaResizeRef = useRef<{ pointerOffsetY: number } | null>(null);
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
  const imageModelLabel = activeModelOptions.find((option) => option.value === activeModel)?.label || "暂无可用模型";
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
    count: Number(imageCount) || 1,
  };

  function updateImageSettings(patch: Partial<ImageSettingsValue>) {
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
    const handleResize = () => {
      setPromptAreaHeight((height) => clampPromptAreaHeight(height));
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isPromptAreaResizing) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isPromptAreaResizing]);

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

  const handlePromptResizeStart = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handleRect = event.currentTarget.getBoundingClientRect();
    promptAreaResizeRef.current = {
      pointerOffsetY: event.clientY - handleRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPromptAreaResizing(true);
  };

  const handlePromptResizeMove = (event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = promptAreaResizeRef.current;
    if (!resizeState) {
      return;
    }

    event.preventDefault();
    const panelRect = composerPanelRef.current?.getBoundingClientRect();
    const promptRect = textareaRef.current?.getBoundingClientRect();
    if (!panelRect || !promptRect) {
      return;
    }

    const nextHeight = promptRect.height + panelRect.top - event.clientY + resizeState.pointerOffsetY;
    setPromptAreaHeight(clampPromptAreaHeight(nextHeight));
  };

  const handlePromptResizeEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (!promptAreaResizeRef.current) {
      return;
    }

    promptAreaResizeRef.current = null;
    setIsPromptAreaResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePromptResizeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setPromptAreaHeight((height) => clampPromptAreaHeight(height + PROMPT_AREA_KEYBOARD_STEP));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPromptAreaHeight((height) => clampPromptAreaHeight(height - PROMPT_AREA_KEYBOARD_STEP));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setPromptAreaHeight(PROMPT_AREA_MIN_HEIGHT);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setPromptAreaHeight(getPromptAreaMaxHeight());
    }
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

      {displayReferenceImages.length > 0 ? (
        <ScrollArea className="mb-2 max-h-20 sm:mb-3" viewClass="flex w-max min-w-full gap-2 px-1 py-1" >
          {displayReferenceImages.map((image, index) => (
            <div key={image.id} className="relative size-14 shrink-0 sm:size-16">
              <button
                type="button"
                onClick={() => {
                  setLightboxIndex(index);
                  setLightboxOpen(true);
                }}
                className="group size-14 overflow-hidden rounded-xl border border-border bg-muted transition hover:border-border sm:size-16"
                aria-label={`${image.uploading ? "正在上传" : "预览"}参考图 ${image.name || index + 1}`}
              >
                <AuthenticatedImage
                  src={image.dataUrl}
                  alt={image.name || `参考图 ${index + 1}`}
                  className="h-full w-full object-cover"
                  placeholderClassName="min-h-0"
                />
              </button>
              {image.uploading ? (
                <span
                  className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/30 text-white"
                  aria-hidden="true"
                >
                  <LoaderCircle className="size-4 animate-spin" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (image.storedIndex !== null) {
                      onRemoveReferenceImage(image.storedIndex);
                    }
                  }}
                  className="absolute -right-1 -top-1 z-10 inline-flex size-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition hover:border-border hover:text-foreground"
                  aria-label={`移除参考图 ${image.name || index + 1}`}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
        </ScrollArea>
      ) : null}

      <div
        ref={composerPanelRef}
        className={cn(
          "relative overflow-visible rounded-2xl border border-border/80 bg-card shadow-[0_4px_24px_-8px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] focus-within:border-brand/45 focus-within:ring-4 focus-within:ring-brand/5",
          isReferenceImageDragActive &&
            "border-brand bg-brand-soft",
        )}
        onDragEnter={handleReferenceImageDragEnter}
        onDragOver={handleReferenceImageDragOver}
        onDragLeave={handleReferenceImageDragLeave}
        onDrop={handleReferenceImageDrop}
      >
        {isReferenceImageDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-brand/70 bg-card/70 text-sm font-medium text-brand backdrop-blur-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-card/90 px-4 py-2 shadow-[0_10px_30px_-18px_rgba(15,23,42,0.5)] dark:bg-card/90">
              <ImagePlus className="size-4" />
              松开上传图片
            </span>
          </div>
        ) : null}
        <button
          type="button"
          className={cn(
            "group hidden h-3 w-full cursor-[ns-resize] touch-none select-none items-center justify-center rounded-t-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex",
            isPromptAreaResizing && "cursor-row-resize",
          )}
          onPointerDown={handlePromptResizeStart}
          onPointerMove={handlePromptResizeMove}
          onPointerUp={handlePromptResizeEnd}
          onPointerCancel={handlePromptResizeEnd}
          onLostPointerCapture={() => {
            promptAreaResizeRef.current = null;
            setIsPromptAreaResizing(false);
          }}
          onKeyDown={handlePromptResizeKeyDown}
          aria-label="调整提示词输入区域高度"
          title="拖动或使用上下方向键调整高度"
        ><span aria-hidden="true" className="h-1 w-8 rounded-full bg-border transition-colors group-hover:bg-muted-foreground" /></button>
        <div
          className="cursor-text"
          onClick={() => {
            textareaRef.current?.focus();
          }}
        >
          <ImageLightbox
            images={lightboxImages}
            currentIndex={lightboxIndex}
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            onIndexChange={setLightboxIndex}
          />
          <div className="flex items-center gap-3 px-3 pt-3 pb-1 sm:px-4 sm:pt-0" onClick={(event) => event.stopPropagation()}>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <div className="flex shrink-0 items-center rounded-lg border border-input bg-muted/70 p-0.5" role="group" aria-label="创作类型">
                <button
                  type="button"
                  className={cn("inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", composerMode === "image" && "bg-card text-brand shadow-sm")}
                  onClick={() => onComposerModeChange("image")}
                  aria-label="图片生成"
                  aria-pressed={composerMode === "image"}
                >
                  <ImagePlus className="size-4" />
                  图片
                </button>
                <button
                  type="button"
                  className={cn("inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", composerMode === "video" && "bg-card text-brand shadow-sm")}
                  onClick={() => onComposerModeChange("video")}
                  aria-label="视频生成"
                  aria-pressed={composerMode === "video"}
                >
                  <Video className="size-4" />
                  视频
                </button>
              </div>
              <Select
                value={activeModelAvailable ? activeModel : ""}
                disabled={activeModelOptions.length === 0}
                open={isModelMenuOpen}
                onOpenChange={(open) => {
                  setIsModelMenuOpen(open);
                  if (open) setIsImageSettingsOpen(false);
                }}
                onValueChange={(value) => {
                  if (composerMode === "video") {
                    onVideoModelChange(value);
                  } else {
                    onImageModelChange(value as ImageModel);
                  }
                }}
              >
                <SelectTrigger
                  className="h-auto min-h-9 w-auto min-w-[min(10rem,100%)] flex-1 py-1.5 whitespace-normal sm:min-w-52 sm:max-w-[min(32rem,100%)] sm:flex-none [&>span]:whitespace-normal [&>span]:overflow-visible [&>span>span]:whitespace-normal"
                  aria-label={`选择模型，当前 ${imageModelLabel}`}
                >
                  <SelectValue><span className="min-w-0 flex-1 whitespace-normal text-left [overflow-wrap:anywhere]">{imageModelLabel}</span></SelectValue>
                </SelectTrigger>
                <SelectContent
                  side="top"
                  align="start"
                  sideOffset={8}
                >
                  {activeModelOptions.map((option) => {
                    const unavailableForReferences = composerMode !== "video" && hasReferenceImages && !imageWorkbenchAcceptsReferenceImages(option.value);
                    return (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={unavailableForReferences}
                      >
                        {option.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Textarea
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
            className="min-h-[58px] resize-none rounded-none border-0 bg-transparent px-4 py-3 text-base leading-7 text-foreground shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0 sm:min-h-0 sm:px-5 sm:text-[15px]"
            style={{ height: promptAreaHeight }}
          />

          <div
            className="rounded-b-2xl px-2 pb-2 pt-1 sm:px-3 sm:pb-3"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {composerMode !== "chat" ? <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="px-2 text-xs has-[>svg]:px-2"
                  onClick={onOpenPromptMarket}
                  aria-label="打开提示词"
                >
                  <BookOpenText className="size-3.5" />
                  <span>提示词</span>
                </Button> : null}
                {composerMode === "image" ? (
                  <Popover open={isImageSettingsOpen} onOpenChange={handleImageSettingsOpenChange}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={cn(
                          "px-2 text-xs has-[>svg]:px-2",
                          isImageSettingsOpen &&
                            "border-brand-border bg-brand-soft text-brand",
                        )}
                        aria-label={isImageSettingsOpen ? "收起图像设置" : "打开图像设置"}
                        aria-expanded={isImageSettingsOpen}
                      >
                        <SlidersHorizontal className="size-3.5" />
                        <span>参数</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      scrollable={false}
                      align="start"
                      side="top"
                      sideOffset={8}
                      className="z-[70] w-[min(calc(100vw-1rem),26rem)] overflow-hidden rounded-2xl border-border bg-card p-0 shadow-[var(--shadow-elevated)]"
                    >
                      <ScrollArea className="max-h-[min(calc(100dvh-2rem),32rem)]" viewportClassName="max-h-[min(calc(100dvh-2rem),32rem)]">
                        <div className="border-b border-border/70 px-4 py-3"><p className="text-sm font-semibold">图片参数</p><p className="mt-1 truncate text-xs text-muted-foreground">{imageModelLabel}</p></div>
                        <div className="p-4">
                          <ImageSettingsPanel model={imageModel} value={imageSettingsValue} onChange={updateImageSettings} />
                        </div>
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
                ) : null}
                {composerMode === "video" ? (
                  <div className="contents">
                    <Popover open={isImageSettingsOpen} onOpenChange={handleImageSettingsOpenChange}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={cn(
                            "px-2 text-xs has-[>svg]:px-2",
                            isImageSettingsOpen && "border-brand-border bg-brand-soft text-brand",
                          )}
                          aria-label="打开视频设置"
                          aria-expanded={isImageSettingsOpen}
                        >
                          <SlidersHorizontal className="size-3.5" />
                          <span>参数</span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        scrollable={false}
                        align="start"
                        side="top"
                        sideOffset={8}
                        className="z-[70] w-[min(calc(100vw-1rem),26rem)] overflow-hidden rounded-2xl border-border bg-card p-0 shadow-[var(--shadow-elevated)]"
                      >
                        <div className="shrink-0 border-b border-border/70 px-4 pt-4 pb-3">
                          <div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold">视频设置</p><Video className="size-4 text-brand" /></div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{imageModelLabel}</p>
                          <div role="group" aria-label="视频设置分区" className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-muted/70 p-1">
                            {(["parameters", "materials"] as const).map((section) => <button key={section} type="button" aria-pressed={videoSettingsSection === section} onClick={() => setVideoSettingsSection(section)} className={cn("h-9 rounded-lg text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", videoSettingsSection === section && "bg-card text-foreground shadow-sm")}>
                              {section === "parameters" ? "生成参数" : "参考素材"}
                            </button>)}
                          </div>
                        </div>
                        <ScrollArea className="min-h-0 max-h-[min(55dvh,30rem)] flex-1" viewportClassName="max-h-[min(55dvh,30rem)]">
                          <div className="p-4">
                            <div hidden={videoSettingsSection !== "materials"}>
                              <div className="flex flex-col gap-4 [&>section]:space-y-3 [&>section]:rounded-xl [&>section]:border [&>section]:border-border/70 [&>section]:bg-muted/15 [&>section]:p-3">
                                <p className="text-xs leading-5 text-muted-foreground">按需添加素材，控制画面、动作与声音。支持的素材类型随模型变化。</p>
                                {activeVideoSupportsFrames && (videoFieldVisible("first_frame") || videoFieldVisible("last_frame")) ? <section className="space-y-2">
                                  <div className="flex items-center justify-between"><ImageParameterLabel help="首帧控制开场，尾帧控制收尾，中间动作由提示词引导。能否搭配参考图以当前模型配置为准。">首尾帧</ImageParameterLabel><span className="text-[11px] text-muted-foreground dark:text-muted-foreground">{[videoFirstFrameURL, videoLastFrameURL].filter(Boolean).length}/2</span></div>
                                  <div className={cn("grid gap-2", videoFieldVisible("first_frame") && videoFieldVisible("last_frame") ? "grid-cols-2" : "grid-cols-1")}>
                                    {videoFieldVisible("first_frame") ? <VideoFramePicker slot="first" label="首帧" value={videoFirstFrameURL} disabled={videoFieldDisabled("first_frame")} uploading={videoFrameUploading === "first"} onFileChange={onVideoFrameFileChange} onURLChange={onVideoFirstFrameURLChange} /> : null}
                                    {videoFieldVisible("last_frame") ? <VideoFramePicker slot="last" label="尾帧" value={videoLastFrameURL} disabled={videoFieldDisabled("last_frame")} uploading={videoFrameUploading === "last"} onFileChange={onVideoFrameFileChange} onURLChange={onVideoLastFrameURLChange} /> : null}
                                  </div>
                                </section> : null}
                                {activeVideoMaterialSections.image && videoFieldVisible("reference_image") ? <section className="space-y-1.5">
                                  <div className="flex items-center justify-between"><ImageParameterLabel help={activeVideoMaterialSections.imageLabel === "首尾帧" ? "图片按顺序指定开场和收尾画面，中间动作由提示词引导。" : "提供人物、场景或物品的外观依据，不限定开场构图，也不保证跨镜头完全一致。"}>{activeVideoMaterialSections.imageLabel}</ImageParameterLabel><span className="text-[11px] text-muted-foreground dark:text-muted-foreground">{activeVideoReferenceImageCount}/{activeVideoImageLimit}</span></div>
                                  <input id="video-reference-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void addReferenceImages(files); }} />
                                  <FileUploadButton icon={ImagePlus} loading={pendingReferenceImages.length > 0} disabled={videoFieldDisabled("reference_image") || activeVideoImageLimit === 0 || activeVideoReferenceImageCount >= activeVideoImageLimit} onClick={() => document.getElementById("video-reference-image-input")?.click()}>{pendingReferenceImages.length > 0 ? "正在上传参考图" : "上传参考图"}</FileUploadButton>
                                  {displayReferenceImages.length > 0 ? <ScrollArea className="" viewClass="flex w-max min-w-full gap-1.5" >{displayReferenceImages.map((image, index) => <div key={image.id} className="group relative size-12 shrink-0 overflow-hidden rounded-md border border-border"><AuthenticatedImage src={image.dataUrl} alt={image.name} className="size-full object-cover" placeholderClassName="min-h-0" />{image.uploading ? <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 text-white"><LoaderCircle className="size-3.5 animate-spin" /></span> : <button type="button" onClick={() => { if (image.storedIndex !== null) onRemoveReferenceImage(image.storedIndex); }} className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded bg-black/65 text-white group-hover:flex group-focus-within:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label={`移除参考图 ${index + 1}`}><X className="size-3" /></button>}</div>)}</ScrollArea> : null}
                                  <PublicReferenceURLList label="参考图片" values={videoReferenceImageURLs} max={Math.max(0, activeVideoImageLimit - referenceImages.length - pendingReferenceImages.length)} disabled={videoFieldDisabled("reference_image")} onChange={onVideoReferenceImageURLsChange} />
                                  {activeVideoImageLimit === 0 ? <p className="text-[11px] leading-4 text-muted-foreground">当前模型不支持参考图片</p> : null}
                                </section> : null}
                                <div className="space-y-3 empty:hidden">
                                  {activeVideoMaterialSections.video && videoFieldVisible("reference_video") ? <><VideoReferencePicker values={videoReferenceVideoURLs} max={activeVideoReferenceLimits.video} disabled={videoFieldDisabled("reference_video") || activeVideoReferenceLimits.video === 0 || videoReferenceVideoURLs.length >= activeVideoReferenceLimits.video} uploading={videoReferenceUploading} onChange={onVideoReferenceFileChange} onRemove={(index) => onVideoReferenceVideoURLsChange(videoReferenceVideoURLs.filter((_, itemIndex) => itemIndex !== index))} /><PublicReferenceURLList label="参考视频" values={videoReferenceVideoURLs} max={activeVideoReferenceLimits.video} disabled={videoFieldDisabled("reference_video")} showValues={false} onChange={onVideoReferenceVideoURLsChange} /></> : null}
                                  {activeVideoMaterialSections.audio && videoFieldVisible("reference_audio") ? <><AudioReferencePicker values={videoReferenceAudioURLs} max={activeVideoReferenceLimits.audio} disabled={videoFieldDisabled("reference_audio") || activeVideoReferenceLimits.audio === 0 || videoReferenceAudioURLs.length >= activeVideoReferenceLimits.audio} uploading={audioReferenceUploading} onChange={onAudioReferenceFileChange} onRemove={(index) => onVideoReferenceAudioURLsChange(videoReferenceAudioURLs.filter((_, itemIndex) => itemIndex !== index))} /><PublicReferenceURLList label="参考音频" values={videoReferenceAudioURLs} max={activeVideoReferenceLimits.audio} disabled={videoFieldDisabled("reference_audio")} showValues={false} onChange={onVideoReferenceAudioURLsChange} /></> : null}
                                </div>
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
                          </div>
                        </ScrollArea>
                      </PopoverContent>
                    </Popover>
                    <VideoModelContractButton model={videoModel} />
                  </div>
                ) : null}
              </div>

              <span className="mr-2 hidden text-[11px] text-muted-foreground/70 2xl:block">Enter 发送 · Shift + Enter 换行</span>
              <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
                {composerMode !== "video" ? <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handlePickReferenceImage}
                  disabled={!referenceEditingSupported}
                  className="size-8 shrink-0 rounded-lg"
                  aria-label="上传参考图"
                >
                  <ImagePlus className="size-4" />
                </Button> : null}

                <Button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={(!prompt.trim() && !(composerMode === "video" && videoModelContract(videoModel)?.capability.prompt?.required === false)) || !activeModelAvailable || submitDisabled}
                  title={submitDisabledReason}
                  className="h-9 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-semibold shadow-none sm:gap-2 sm:px-4"
                  aria-label={submitLabel}
                >
                  <span className="sm:hidden">生成</span>
                  <span className="hidden sm:inline">{submitLabel}</span>
                  <ArrowUp className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ImageComposerDock>
  );
}
