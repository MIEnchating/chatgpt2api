"use client";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ImagePlus,
  Minus,
  Plus,
  SlidersHorizontal,
  Store,
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
  ImageAspectRatioGlyph,
  ImageParameterLabel,
} from "@/app/image/components/image-parameter-ui";
import { imageParameterChoiceClass } from "@/app/image/components/image-parameter-styles";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  CUSTOM_IMAGE_ASPECT_RATIO,
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  buildImageSize,
  formatImageSizeDisplay,
  isHighResolutionImageSize,
  parseImageSizeDimensions,
  parseImageRatio,
  type ImageAspectRatio,
  type ImageResolution,
  type ImageSizeMode,
} from "@/app/image/image-options";
import {
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  supportsImageOutputControls,
  supportsImageOutputCompression,
  supportsStructuredImageParameters,
  type ImageModel,
  type ImageOutputFormat,
  type ImageQuality,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type ImageComposerProps = {
  composerMode: "chat" | "image";
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
  imageQuality: "" | ImageQuality;
  imageOutputFormat: ImageOutputFormat;
  imageOutputCompression: string;
  imageStreamEnabled: boolean;
  imagePartialImages: string;
  relayKeyConfigured: boolean;
  relayKeyStatusMessage?: string;
  highResolutionHint?: ReactNode;
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
  onImageQualityChange: (value: "" | ImageQuality) => void;
  onImageOutputFormatChange: (value: ImageOutputFormat) => void;
  onImageOutputCompressionChange: (value: string) => void;
  onImageStreamEnabledChange: (value: boolean) => void;
  onImagePartialImagesChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onOpenPromptMarket: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

const PROMPT_AREA_MIN_HEIGHT = 58;
const PROMPT_AREA_DEFAULT_HEIGHT = 72;
const PROMPT_AREA_MAX_HEIGHT = 320;
const PROMPT_AREA_KEYBOARD_STEP = 12;
const IMAGE_FILE_EXTENSION_PATTERN = /\.(avif|bmp|gif|heic|heif|jpeg|jpg|png|svg|webp)$/i;

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
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION_PATTERN.test(file.name);
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

  return items.some((item) => item.kind === "file" && (item.type === "" || item.type.startsWith("image/")));
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
  imageQuality,
  imageOutputFormat,
  imageOutputCompression,
  imageStreamEnabled,
  imagePartialImages,
  relayKeyConfigured,
  relayKeyStatusMessage,
  highResolutionHint,
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
  onImageQualityChange,
  onImageOutputFormatChange,
  onImageOutputCompressionChange,
  onImageStreamEnabledChange,
  onImagePartialImagesChange,
  onSubmit,
  onOpenPromptMarket,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isImageSettingsOpen, setIsImageSettingsOpen] = useState(false);
  const [isAdvancedImageSettingsOpen, setIsAdvancedImageSettingsOpen] = useState(false);
  const [promptAreaHeight, setPromptAreaHeight] = useState(PROMPT_AREA_DEFAULT_HEIGHT);
  const [isPromptAreaResizing, setIsPromptAreaResizing] = useState(false);
  const [isReferenceImageDragActive, setIsReferenceImageDragActive] = useState(false);
  const composerPanelRef = useRef<HTMLDivElement>(null);
  const composerToolbarRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const promptAreaResizeRef = useRef<{ pointerOffsetY: number } | null>(null);
  const referenceImageDragDepthRef = useRef(0);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const imageModelLabel = imageModelOptions.find((option) => option.value === imageModel)?.label || imageModel;
  const compressionSupported = supportsImageOutputCompression(imageOutputFormat);
  const structuredImageParameters = supportsStructuredImageParameters(imageModel);
  const outputControlsSupported = supportsImageOutputControls(imageModel);
  const effectiveImageSizeMode = structuredImageParameters || imageSizeMode !== "custom" ? imageSizeMode : "auto";
  const effectiveImageResolution = structuredImageParameters ? imageResolution : "auto";
  const submitLabel = referenceImages.length > 0 ? "编辑图片" : "生成图片";
  const relayApiKeyMissing = !relayKeyConfigured;
  const relayApiKeyMissingMessage = relayKeyStatusMessage || "请先在云棉为当前用户创建可用令牌";
  const computedImageSize = useMemo(
    () =>
      buildImageSize({
        mode: effectiveImageSizeMode,
        aspectRatio: imageAspectRatio,
        resolution: effectiveImageResolution,
        customRatio: imageCustomRatio,
        customWidth: imageCustomWidth,
        customHeight: imageCustomHeight,
      }),
    [effectiveImageResolution, effectiveImageSizeMode, imageAspectRatio, imageCustomHeight, imageCustomRatio, imageCustomWidth],
  );
  const isCustomRatioInvalid =
    effectiveImageSizeMode === "ratio" && imageAspectRatio === CUSTOM_IMAGE_ASPECT_RATIO && !parseImageRatio(imageCustomRatio);
  const sizePreviewLabel = computedImageSize
    ? formatImageSizeDisplay(computedImageSize)
    : effectiveImageSizeMode === "auto"
      ? "自动"
      : "尺寸无效";
  const sizeIsHighResolution = Boolean(computedImageSize && isHighResolutionImageSize(computedImageSize));
  const computedImageDimensions = computedImageSize ? parseImageSizeDimensions(computedImageSize) : null;
  const displayedImageWidth = effectiveImageSizeMode === "custom" ? imageCustomWidth : computedImageDimensions?.width || "";
  const displayedImageHeight = effectiveImageSizeMode === "custom" ? imageCustomHeight : computedImageDimensions?.height || "";
  const normalizedImageCount = Math.min(10, Math.max(1, Number.parseInt(imageCount, 10) || 1));

  useEffect(() => {
    if (!isModelMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!modelMenuRef.current?.contains(target)) {
        setIsModelMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isModelMenuOpen]);

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

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getImageFiles(event.clipboardData.files);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  const addReferenceImages = (files: File[]) => {
    const imageFiles = getImageFiles(files);
    if (imageFiles.length === 0) {
      return;
    }

    void onReferenceImageChange(imageFiles);
  };

  const resetReferenceImageDragState = () => {
    referenceImageDragDepthRef.current = 0;
    setIsReferenceImageDragActive(false);
  };

  const handleReferenceImageDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImage(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    referenceImageDragDepthRef.current += 1;
    setIsReferenceImageDragActive(true);
    event.dataTransfer.dropEffect = "copy";
  };

  const handleReferenceImageDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImage(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setIsReferenceImageDragActive(true);
    event.dataTransfer.dropEffect = "copy";
  };

  const handleReferenceImageDragLeave = (event: DragEvent<HTMLDivElement>) => {
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
    if (!hasDraggedFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    resetReferenceImageDragState();
    addReferenceImages(Array.from(event.dataTransfer.files));
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
    const toolbarHeight = composerToolbarRef.current?.getBoundingClientRect().height ?? 0;
    if (!panelRect) {
      return;
    }

    const handleHeight = event.currentTarget.getBoundingClientRect().height;
    const nextHeight = panelRect.bottom - toolbarHeight - handleHeight - event.clientY + resizeState.pointerOffsetY;
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
          addReferenceImages(files);
        }}
      />

      {referenceImages.length > 0 ? (
        <div className="hide-scrollbar mb-2 flex max-h-20 gap-2 overflow-x-auto px-1 py-1 sm:mb-3">
          {referenceImages.map((image, index) => (
            <div key={`${image.name}-${index}`} className="relative size-14 shrink-0 sm:size-16">
              <button
                type="button"
                onClick={() => {
                  setLightboxIndex(index);
                  setLightboxOpen(true);
                }}
                className="group size-14 overflow-hidden rounded-xl border border-stone-200 bg-stone-50 transition hover:border-stone-300 sm:size-16"
                aria-label={`预览参考图 ${image.name || index + 1}`}
              >
                <AuthenticatedImage
                  src={image.dataUrl}
                  alt={image.name || `参考图 ${index + 1}`}
                  className="h-full w-full object-cover"
                  placeholderClassName="min-h-0"
                />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveReferenceImage(index);
                }}
                className="absolute -right-1 -top-1 z-10 inline-flex size-5 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-sm transition hover:border-stone-300 hover:text-stone-800"
                aria-label={`移除参考图 ${image.name || index + 1}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div
        ref={composerPanelRef}
        className={cn(
          "relative overflow-visible rounded-[30px] border border-[#dedee3] bg-[#fffcff]/95 shadow-[0_20px_70px_-42px_rgba(15,23,42,0.5)] backdrop-blur-xl transition-colors dark:border-border dark:bg-card/95 dark:shadow-[0_24px_80px_-38px_rgba(0,0,0,0.78)] sm:rounded-[24px] sm:border-[#f2f3f5] sm:bg-white/95 sm:shadow-[0_24px_80px_-34px_rgba(15,23,42,0.42)] sm:dark:border-border sm:dark:bg-card/95",
          isReferenceImageDragActive &&
            "border-[#1456f0] bg-[#eef4ff]/95 dark:border-sky-500/70 dark:bg-sky-950/45 sm:border-[#1456f0] sm:bg-[#eef4ff]/95 sm:dark:border-sky-500/70 sm:dark:bg-sky-950/45",
        )}
        onDragEnter={handleReferenceImageDragEnter}
        onDragOver={handleReferenceImageDragOver}
        onDragLeave={handleReferenceImageDragLeave}
        onDrop={handleReferenceImageDrop}
      >
        {isReferenceImageDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[30px] border-2 border-dashed border-[#1456f0]/70 bg-white/70 text-sm font-medium text-[#1456f0] backdrop-blur-sm dark:border-sky-400/70 dark:bg-background/70 dark:text-sky-300 sm:rounded-[24px]">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 shadow-[0_10px_30px_-18px_rgba(15,23,42,0.5)] dark:bg-card/90">
              <ImagePlus className="size-4" />
              松开上传图片
            </span>
          </div>
        ) : null}
        <button
          type="button"
          className={cn(
            "hidden h-4 w-full cursor-[ns-resize] touch-none select-none items-center justify-center rounded-t-[24px] focus-visible:outline-none sm:flex",
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
          title="拖动调整输入区域高度"
        >
          <span className="h-1 w-10 rounded-full bg-[#8e8e93]/40 dark:bg-muted-foreground/35" />
        </button>
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
          <Textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onPaste={handleTextareaPaste}
            placeholder={
              referenceImages.length > 0
                ? "描述你希望如何修改参考图"
                : "输入你想要生成的画面，也可直接粘贴图片"
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSubmit();
              }
            }}
            className="min-h-[58px] resize-none rounded-none border-0 bg-transparent px-5 pt-4 pb-1 text-[16px] leading-6 text-[#222222] shadow-none placeholder:text-[#8e8e93] focus-visible:ring-0 dark:text-foreground dark:placeholder:text-muted-foreground sm:min-h-0 sm:px-5 sm:py-2.5 sm:text-[15px]"
            style={{ height: promptAreaHeight }}
          />

          <div
            ref={composerToolbarRef}
            className="rounded-b-[30px] bg-transparent px-3 pt-1 pb-3 sm:rounded-b-[24px] sm:border-t sm:border-[#f2f3f5] sm:bg-white/80 sm:px-4 sm:py-2.5 sm:dark:border-border sm:dark:bg-card/80"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:gap-3">
              <div className="flex min-w-0 flex-nowrap items-center gap-1.5 sm:gap-2">
                <div ref={modelMenuRef} className="relative shrink-0">
                  <button
                    type="button"
                    className={cn(
                      "inline-flex size-9 items-center justify-center gap-1.5 rounded-full text-xs font-medium text-[#686b73] transition hover:bg-black/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:text-muted-foreground dark:hover:bg-accent/60 dark:hover:text-foreground sm:h-8 sm:w-[190px] sm:border sm:border-[#e5e7eb] sm:bg-white sm:px-3 sm:text-[#45515e] sm:dark:border-border sm:dark:bg-background/70 sm:dark:text-muted-foreground",
                      isModelMenuOpen &&
                        "bg-[#eef4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300 sm:border-[#bfdbfe] sm:bg-[#eef4ff] sm:text-[#1456f0] sm:dark:border-sky-900/70 sm:dark:bg-sky-950/30 sm:dark:text-sky-300",
                    )}
                    onClick={() => {
                      setIsModelMenuOpen((open) => !open);
                      setIsImageSettingsOpen(false);
                    }}
                    aria-expanded={isModelMenuOpen}
                    aria-label={`选择模型，当前 ${imageModelLabel}`}
                    title={`模型：${imageModelLabel}`}
                  >
                    <Bot className="size-5 shrink-0 sm:hidden" />
                    <span className="hidden shrink-0 sm:inline">模型</span>
                    <span className="hidden min-w-0 flex-1 truncate text-left font-semibold sm:inline">
                      {imageModelLabel}
                    </span>
                    <ChevronDown className={cn("hidden size-4 shrink-0 opacity-60 transition sm:block", isModelMenuOpen && "rotate-180")} />
                  </button>
                  {isModelMenuOpen ? (
                    <div className="absolute bottom-[calc(100%+0.5rem)] left-0 z-[80] max-h-[45dvh] w-[min(14rem,calc(100vw-2rem))] overflow-y-auto rounded-[20px] border border-[#e5e7eb] bg-white p-1.5 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)] dark:border-border dark:bg-card dark:shadow-[0_24px_80px_-28px_rgba(0,0,0,0.72)] sm:bottom-[calc(100%+8px)] sm:w-[218px]">
                      {imageModelOptions.map((option) => {
                        const active = option.value === imageModel;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={cn(
                              "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-[#45515e] transition hover:bg-black/[0.05] dark:text-muted-foreground dark:hover:bg-accent/60",
                              active && "bg-black/[0.05] font-medium text-[#18181b] dark:bg-accent dark:text-foreground",
                            )}
                            onClick={() => {
                              onImageModelChange(option.value);
                              setIsModelMenuOpen(false);
                            }}
                          >
                            <span className="min-w-0 truncate">{option.label}</span>
                            {active ? <Check className="size-4 shrink-0" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="inline-flex size-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-[#686b73] transition hover:bg-black/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:text-muted-foreground dark:hover:bg-accent/60 dark:hover:text-foreground sm:h-8 sm:w-auto sm:border sm:border-[#e5e7eb] sm:bg-white sm:px-3 sm:text-xs sm:font-medium sm:text-[#45515e] sm:dark:border-border sm:dark:bg-background/70 sm:dark:text-muted-foreground"
                  onClick={onOpenPromptMarket}
                  aria-label="打开提示词市场"
                  title="提示词市场"
                >
                  <Store className="size-5 sm:size-3.5" />
                  <span className="hidden sm:inline">市场</span>
                </button>
                {composerMode === "image" ? (
                  <Popover open={isImageSettingsOpen} onOpenChange={handleImageSettingsOpenChange}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "inline-flex size-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-[#686b73] transition hover:bg-black/[0.05] dark:text-muted-foreground dark:hover:bg-accent/60 dark:hover:text-foreground sm:h-8 sm:w-auto sm:border sm:border-[#e5e7eb] sm:bg-white sm:px-3 sm:text-xs sm:font-medium sm:text-[#45515e] sm:dark:border-border sm:dark:bg-background/70 sm:dark:text-muted-foreground",
                          isImageSettingsOpen &&
                            "bg-[#eef4ff] text-[#1456f0] dark:bg-sky-950/30 dark:text-sky-300 sm:border-[#bfdbfe] sm:bg-[#eef4ff] sm:text-[#1456f0] sm:dark:border-sky-900/70 sm:dark:bg-sky-950/30 sm:dark:text-sky-300",
                        )}
                        aria-label={isImageSettingsOpen ? "收起图像设置" : "打开图像设置"}
                        aria-expanded={isImageSettingsOpen}
                        title={isImageSettingsOpen ? "收起参数" : "图像设置"}
                      >
                        <SlidersHorizontal className="size-5 sm:size-3.5" />
                        <span className="hidden sm:inline">参数</span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      side="top"
                      sideOffset={8}
                      className="hide-scrollbar z-[70] max-h-[min(calc(100dvh-2rem),32rem)] w-[min(calc(100vw-1rem),23rem)] overflow-y-auto overflow-x-hidden rounded-lg border-[#dedfe3] bg-white p-0 shadow-[0_18px_50px_-24px_rgba(15,23,42,0.28)] dark:border-border dark:bg-card dark:shadow-[0_18px_50px_-22px_rgba(0,0,0,0.68)] sm:w-[min(calc(100vw-2rem),23rem)]"
                      onOpenAutoFocus={(event) => event.preventDefault()}
                    >
                      <div className="p-3">
                        <div className="space-y-3.5">
                          <section className="space-y-1.5">
                            <div className="flex items-center justify-between gap-3">
                              <ImageParameterLabel help="选择常用画幅比例，系统会自动换算为合法像素尺寸。">
                                画幅比例
                              </ImageParameterLabel>
                              <span
                                className={cn(
                                  "rounded-md bg-[#f3f4f6] px-2 py-0.5 font-mono text-[11px] text-[#686b73] dark:bg-muted dark:text-muted-foreground",
                                  sizeIsHighResolution && "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
                                )}
                              >
                                {sizePreviewLabel}
                              </span>
                            </div>
                            <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="图片画幅比例">
                              {IMAGE_ASPECT_RATIO_OPTIONS.map((option) => {
                                const isAuto = option.value === "";
                                const isCustom = option.value === CUSTOM_IMAGE_ASPECT_RATIO;
                                const active = isAuto
                                  ? effectiveImageSizeMode === "auto"
                                  : effectiveImageSizeMode === "ratio" && imageAspectRatio === option.value;
                                return (
                                  <button
                                    key={option.value || "auto"}
                                    type="button"
                                    aria-pressed={active}
                                    className={cn(
                                      "flex h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-[#e5e7eb] bg-[#f7f7f8] px-1 text-[10px] font-medium text-[#686b73] transition hover:border-[#cfd1d5] hover:bg-white hover:text-[#222222] dark:border-border dark:bg-muted/55 dark:text-muted-foreground dark:hover:bg-background dark:hover:text-foreground",
                                      active &&
                                        "border-[#bfd1ff] bg-[#eef4ff] text-[#1456f0] shadow-[inset_0_0_0_1px_rgba(20,86,240,0.08)] hover:border-[#9db9ff] hover:bg-[#eef4ff] hover:text-[#1456f0] dark:border-sky-900/80 dark:bg-sky-950/35 dark:text-sky-300",
                                    )}
                                    onClick={() => {
                                      onImageAspectRatioChange(option.value);
                                      onImageSizeModeChange(isAuto ? "auto" : "ratio");
                                    }}
                                  >
                                    {isAuto || isCustom ? (
                                      <SlidersHorizontal className="size-3.5" />
                                    ) : (
                                      <ImageAspectRatioGlyph ratio={option.value} />
                                    )}
                                    <span className="truncate">{isAuto ? "自动" : isCustom ? "自定义" : option.value}</span>
                                  </button>
                                );
                              })}
                            </div>
                            {imageAspectRatio === CUSTOM_IMAGE_ASPECT_RATIO && effectiveImageSizeMode === "ratio" ? (
                              <Input
                                value={imageCustomRatio}
                                onChange={(event) => onImageCustomRatioChange(event.target.value)}
                                placeholder="例如 5:4 或 2.39:1"
                                aria-invalid={isCustomRatioInvalid}
                                className={cn(
                                  "h-8 rounded-lg text-xs shadow-none",
                                  isCustomRatioInvalid && "border-red-300 focus-visible:border-red-400",
                                )}
                              />
                            ) : null}
                          </section>

                          {outputControlsSupported ? (
                            <section className="space-y-1.5">
                              <ImageParameterLabel help="gpt-image-2 支持自动、低、中、高四档；质量越高，生成时间和费用通常越高。">
                                质量
                              </ImageParameterLabel>
                              <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70" role="group" aria-label="图片质量">
                                {[
                                  { value: "", label: "自动" },
                                  ...IMAGE_QUALITY_OPTIONS,
                                ].map((option) => {
                                  const active = imageQuality === option.value;
                                  return (
                                    <button
                                      key={option.value || "auto"}
                                      type="button"
                                      aria-pressed={active}
                                      className={imageParameterChoiceClass(active, "h-7")}
                                      onClick={() => onImageQualityChange(option.value as "" | ImageQuality)}
                                    >
                                      {option.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </section>
                          ) : null}

                          {structuredImageParameters ? (
                            <section className="space-y-1.5">
                              <ImageParameterLabel help="自动比例使用常规像素；1080P、2K、4K 会结合宽高比计算，并校正为官方允许的尺寸。2K 以上属于实验性高分辨率。">
                                分辨率
                              </ImageParameterLabel>
                              <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70" role="group" aria-label="图片分辨率">
                                {IMAGE_RESOLUTION_OPTIONS.map((option) => {
                                  const active =
                                    imageResolution === option.value &&
                                    (effectiveImageSizeMode !== "auto" || option.value === "auto");
                                  return (
                                    <button
                                      key={option.value}
                                      type="button"
                                      aria-pressed={active}
                                      className={imageParameterChoiceClass(active, "h-7")}
                                      onClick={() => {
                                        onImageResolutionChange(option.value);
                                        if (effectiveImageSizeMode === "auto" && option.value !== "auto") {
                                          onImageAspectRatioChange("1:1");
                                          onImageSizeModeChange("ratio");
                                        }
                                      }}
                                    >
                                      {option.label}
                                    </button>
                                  );
                                })}
                              </div>
                              {sizeIsHighResolution && highResolutionHint ? (
                                <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">{highResolutionHint}</p>
                              ) : null}
                            </section>
                          ) : null}

                          <section className="flex items-center justify-between gap-3 border-t border-[#ececef] pt-3 dark:border-border">
                            <ImageParameterLabel help="单次请求生成 1-10 张图片；系统会按并发额度拆分和排队。">
                              生成数量
                            </ImageParameterLabel>
                            <div className="grid h-8 grid-cols-[2rem_3.25rem_2rem] overflow-hidden rounded-lg border border-[#dedfe3] bg-white dark:border-border dark:bg-background/70" role="group" aria-label="生成数量">
                              <button
                                type="button"
                                disabled={normalizedImageCount <= 1}
                                className="inline-flex items-center justify-center text-[#686b73] transition hover:bg-[#f4f4f5] hover:text-[#18181b] disabled:cursor-not-allowed disabled:opacity-35 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground"
                                onClick={() => onImageCountChange(String(normalizedImageCount - 1))}
                                aria-label="减少生成数量"
                              >
                                <Minus className="size-3.5" />
                              </button>
                              <span className="inline-flex items-center justify-center border-x border-[#ececef] text-xs font-semibold text-[#18181b] dark:border-border dark:text-foreground">
                                {normalizedImageCount} 张
                              </span>
                              <button
                                type="button"
                                disabled={normalizedImageCount >= 10}
                                className="inline-flex items-center justify-center text-[#686b73] transition hover:bg-[#f4f4f5] hover:text-[#18181b] disabled:cursor-not-allowed disabled:opacity-35 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground"
                                onClick={() => onImageCountChange(String(normalizedImageCount + 1))}
                                aria-label="增加生成数量"
                              >
                                <Plus className="size-3.5" />
                              </button>
                            </div>
                          </section>

                          <details
                            open={isAdvancedImageSettingsOpen}
                            onToggle={(event) => setIsAdvancedImageSettingsOpen(event.currentTarget.open)}
                            className="group border-t border-[#ececef] pt-2.5 dark:border-border"
                          >
                            <summary className="flex h-8 cursor-pointer list-none items-center justify-between rounded-md px-1.5 text-xs font-semibold text-[#3f4147] outline-none transition hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:text-foreground dark:hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
                              <span>高级设置</span>
                              <ChevronDown className="size-3.5 opacity-60 transition group-open:rotate-180" />
                            </summary>

                            <div className="mt-2 space-y-3">
                              <section className="space-y-1.5">
                                <ImageParameterLabel help="手动输入像素尺寸后会覆盖上方画幅比例；边长不超过 3840，必须为 16 的倍数。">
                                  精确尺寸
                                </ImageParameterLabel>
                                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                                  <label className="grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[#e3e4e7] bg-white px-2.5 dark:border-border dark:bg-background/70">
                                    <span className="text-[11px] text-[#777a82] dark:text-muted-foreground">W</span>
                                    <Input
                                      type="number"
                                      inputMode="numeric"
                                      min="1"
                                      step="1"
                                      value={displayedImageWidth}
                                      placeholder="自动"
                                      onFocus={() => {
                                        if (effectiveImageSizeMode !== "custom") {
                                          onImageCustomWidthChange(computedImageDimensions?.width || imageCustomWidth || "1024");
                                          onImageCustomHeightChange(computedImageDimensions?.height || imageCustomHeight || "1024");
                                          onImageSizeModeChange("custom");
                                        }
                                      }}
                                      onChange={(event) => onImageCustomWidthChange(event.target.value)}
                                      className="h-7 border-0 bg-transparent px-0 text-xs font-medium shadow-none focus-visible:ring-0"
                                    />
                                  </label>
                                  <X className="size-3.5 text-[#9a9ca2]" aria-hidden="true" />
                                  <label className="grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[#e3e4e7] bg-white px-2.5 dark:border-border dark:bg-background/70">
                                    <span className="text-[11px] text-[#777a82] dark:text-muted-foreground">H</span>
                                    <Input
                                      type="number"
                                      inputMode="numeric"
                                      min="1"
                                      step="1"
                                      value={displayedImageHeight}
                                      placeholder="自动"
                                      onFocus={() => {
                                        if (effectiveImageSizeMode !== "custom") {
                                          onImageCustomWidthChange(computedImageDimensions?.width || imageCustomWidth || "1024");
                                          onImageCustomHeightChange(computedImageDimensions?.height || imageCustomHeight || "1024");
                                          onImageSizeModeChange("custom");
                                        }
                                      }}
                                      onChange={(event) => onImageCustomHeightChange(event.target.value)}
                                      className="h-7 border-0 bg-transparent px-0 text-xs font-medium shadow-none focus-visible:ring-0"
                                    />
                                  </label>
                                </div>
                              </section>

                              <div className="flex h-9 items-center justify-between rounded-lg bg-[#f4f4f5] px-2.5 dark:bg-muted/70">
                                <ImageParameterLabel help="开启后会使用流式返回，需要图片服务支持流式响应。">
                                  流式返回
                                </ImageParameterLabel>
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={imageStreamEnabled}
                                  aria-label="开启图片流式返回"
                                  className={cn(
                                    "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30",
                                    imageStreamEnabled ? "bg-[#1456f0]" : "bg-[#c8cbd1] dark:bg-muted-foreground/45",
                                  )}
                                  onClick={() => {
                                    const enabled = !imageStreamEnabled;
                                    onImageStreamEnabledChange(enabled);
                                    if (!enabled) {
                                      onImagePartialImagesChange("0");
                                    }
                                  }}
                                >
                                  <span
                                    className={cn(
                                      "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
                                      imageStreamEnabled ? "translate-x-[18px]" : "translate-x-0.5",
                                    )}
                                  />
                                </button>
                              </div>

                              {imageStreamEnabled ? (
                                <div className="space-y-1.5">
                                  <ImageParameterLabel help="可返回 0-3 张生成过程中的中间图；每张中间图会产生额外输出费用。">
                                    中间图数量
                                  </ImageParameterLabel>
                                  <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70">
                                    {["0", "1", "2", "3"].map((count) => (
                                      <button
                                        key={count}
                                        type="button"
                                        aria-pressed={imagePartialImages === count}
                                        className={imageParameterChoiceClass(imagePartialImages === count, "h-7")}
                                        onClick={() => onImagePartialImagesChange(count)}
                                      >
                                        {count} 张
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ) : null}

                            {outputControlsSupported ? (
                              <>
                                <div className="space-y-1.5">
                                  <ImageParameterLabel help="支持 PNG、JPEG、WebP；PNG 保留无损质量，JPEG 和 WebP 支持压缩。">
                                    输出格式
                                  </ImageParameterLabel>
                                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70">
                                    {IMAGE_OUTPUT_FORMAT_OPTIONS.map((option) => (
                                      <button
                                        key={option.value}
                                        type="button"
                                        aria-pressed={imageOutputFormat === option.value}
                                        className={imageParameterChoiceClass(imageOutputFormat === option.value, "h-7 uppercase")}
                                        onClick={() => {
                                          onImageOutputFormatChange(option.value);
                                          if (!supportsImageOutputCompression(option.value)) {
                                            onImageOutputCompressionChange("");
                                          }
                                        }}
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                {compressionSupported ? (
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between gap-3">
                                    <ImageParameterLabel help="仅适用于 JPEG 和 WebP，范围为 0-100；数值越低，文件通常越小。">
                                      压缩率
                                    </ImageParameterLabel>
                                    <span className="text-xs text-[#777a82] dark:text-muted-foreground">
                                      {imageOutputCompression ? `${imageOutputCompression}%` : "默认"}
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-2.5">
                                    <input
                                      type="range"
                                      min="0"
                                      max="100"
                                      step="1"
                                      value={imageOutputCompression || "100"}
                                      onChange={(event) => onImageOutputCompressionChange(event.target.value)}
                                      className="h-1.5 w-full accent-[#18181b] dark:accent-foreground"
                                      aria-label="图片输出压缩率"
                                    />
                                    <Input
                                      type="number"
                                      inputMode="numeric"
                                      min="0"
                                      max="100"
                                      step="1"
                                      value={imageOutputCompression}
                                      placeholder="默认"
                                      onChange={(event) => onImageOutputCompressionChange(event.target.value)}
                                      className="h-8 rounded-lg text-center text-xs shadow-none"
                                    />
                                  </div>
                                </div>
                                ) : null}
                              </>
                            ) : null}
                            </div>
                          </details>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                  ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handlePickReferenceImage}
                  className="inline-flex size-11 items-center justify-center rounded-full text-[#686b73] transition hover:bg-black/[0.05] dark:text-muted-foreground dark:hover:bg-accent/60 dark:hover:text-foreground sm:size-10 sm:border sm:border-[#e5e7eb] sm:bg-white sm:text-[#45515e] sm:dark:border-border sm:dark:bg-background/70 sm:dark:text-muted-foreground"
                  aria-label="上传参考图"
                  title="上传参考图"
                >
                  <Plus className="size-6 sm:hidden" />
                  <ImagePlus className="hidden size-4 sm:block" />
                </button>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[#181e25] text-white shadow-[0_4px_10px_rgba(24,30,37,0.12)] transition hover:bg-[#2a323d] disabled:cursor-not-allowed disabled:bg-[#e1e2e4] disabled:text-[#73777f] dark:bg-foreground dark:text-background dark:hover:bg-foreground/90 dark:disabled:bg-muted dark:disabled:text-muted-foreground sm:size-10"
                  aria-label={submitLabel}
                  title={relayApiKeyMissing ? relayApiKeyMissingMessage : submitLabel}
                >
                  <ArrowUp className="size-5 sm:size-4" />
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-2 text-[11px] leading-5 text-[#8e8e93] dark:text-muted-foreground">
              {imageStreamEnabled ? <span>{`流式开启，中间图最多 ${imagePartialImages || "0"} 张`}</span> : null}
              <span>{`预计生成 ${imageCount || "1"} 张`}</span>
            </div>
          </div>
        </div>
      </div>
    </ImageComposerDock>
  );
}
