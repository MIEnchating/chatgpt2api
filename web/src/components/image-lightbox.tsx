"use client";

import { Badge } from "@/components/ui/badge";

import { Button } from "@/components/ui/button";


import { OverlayLayerProvider, useOverlayLayer } from "@/lib/use-overlay-layer";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, Download, FlipHorizontal2, FlipVertical2, RefreshCw, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import { TooltipButton } from "@/components/ui/tooltip";
import { fetchAuthenticatedImageBlob, shouldUseAuthenticatedImageFallback } from "@/lib/authenticated-image";
import { cn } from "@/lib/utils";

type LightboxImage = {
  id: string;
  src: string;
  fileName?: string;
  outputFormat?: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  currentIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (index: number) => void;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

function normalizeImageExtension(value?: string) {
  const extension = String(value || "").toLowerCase().trim().replace(/^image\//, "").replace(/^\./, "");
  if (extension === "jpg" || extension === "jpeg") {
    return "jpg";
  }
  if (extension === "png" || extension === "webp") {
    return extension;
  }
  return "";
}

function imageExtensionFromSrc(src: string) {
  const dataUrlFormat = src.match(/^data:image\/([^;,]+)/i)?.[1];
  if (dataUrlFormat) {
    return normalizeImageExtension(dataUrlFormat);
  }
  const urlExtension = src.split(/[?#]/, 1)[0]?.match(/\.([a-z0-9]+)$/i)?.[1];
  return normalizeImageExtension(urlExtension);
}

function imageDownloadName(image: LightboxImage, blobType?: string) {
  if (image.fileName) {
    return image.fileName;
  }
  const extension =
    normalizeImageExtension(image.outputFormat) ||
    normalizeImageExtension(blobType) ||
    imageExtensionFromSrc(image.src) ||
    "png";
  return `image-${image.id}.${extension}`;
}

export function ImageLightbox({
  images,
  currentIndex,
  open,
  onOpenChange,
  onIndexChange,
}: ImageLightboxProps) {
  const layer = useOverlayLayer("modal");
  const current = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [flippedX, setFlippedX] = useState(false);
  const [flippedY, setFlippedY] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const zoomPercent = Math.round(zoom * 100);

  const resetZoom = useCallback(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setFlippedX(false);
    setFlippedY(false);
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((value) => {
      const next = Math.max(MIN_ZOOM, value - ZOOM_STEP);
      if (next === MIN_ZOOM) {
        setPan({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const goPrev = useCallback(() => {
    if (hasPrev) onIndexChange(currentIndex - 1);
  }, [hasPrev, currentIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (hasNext) onIndexChange(currentIndex + 1);
  }, [hasNext, currentIndex, onIndexChange]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, goPrev, goNext, resetZoom, zoomIn, zoomOut]);

  useEffect(() => {
    if (open) {
      resetZoom();
    }
  }, [current?.id, open, resetZoom]);

  useEffect(() => {
    if (!open) return;
    document.documentElement.dataset.imageLightboxOpen = "true";
    return () => {
      delete document.documentElement.dataset.imageLightboxOpen;
    };
  }, [open]);

  const handleDownload = useCallback(() => {
    if (!current) return;
    const download = async () => {
      let href = current.src;
      let objectURL = "";
      let blobType = "";

      if (shouldUseAuthenticatedImageFallback(current.src)) {
        try {
          const blob = await fetchAuthenticatedImageBlob(current.src);
          blobType = blob.type;
          objectURL = URL.createObjectURL(blob);
          href = objectURL;
        } catch {
          href = current.src;
        }
      }

      const link = document.createElement("a");
      link.href = href;
      link.download = imageDownloadName(current, blobType);
      link.click();

      if (objectURL) {
        window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
      }
    };

    void download();
  }, [current]);

  const handleImagePointerDown = useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      event.stopPropagation();
      if (zoom <= MIN_ZOOM) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    },
    [pan.x, pan.y, zoom],
  );

  const handleImagePointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    setPan({
      x: drag.panX + event.clientX - drag.startX,
      y: drag.panY + event.clientY - drag.startY,
    });
  }, []);

  const handleImagePointerEnd = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }, []);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const deltaMultiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientHeight : 1;
      const delta = Math.max(-200, Math.min(200, event.deltaY * deltaMultiplier));
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY)));

      if (nextZoom === zoom) {
        return;
      }
      if (nextZoom === MIN_ZOOM) {
        setPan({ x: 0, y: 0 });
        setZoom(nextZoom);
        return;
      }

      const bounds = event.currentTarget.getBoundingClientRect();
      const styles = window.getComputedStyle(event.currentTarget);
      const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
      const imageCenterX = paddingLeft + (bounds.width - paddingLeft - paddingRight) / 2;
      const imageCenterY = paddingTop + (bounds.height - paddingTop - paddingBottom) / 2;
      const cursorX = event.clientX - bounds.left - imageCenterX;
      const cursorY = event.clientY - bounds.top - imageCenterY;
      const zoomRatio = nextZoom / zoom;
      setPan({
        x: cursorX - (cursorX - pan.x) * zoomRatio,
        y: cursorY - (cursorY - pan.y) * zoomRatio,
      });
      setZoom(nextZoom);
    },
    [pan.x, pan.y, zoom],
  );

  if (!current) return null;

  return (
    <OverlayLayerProvider value={layer}>
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay style={{ zIndex: layer - 1 }} className="fixed inset-y-0 left-0 h-dvh w-screen bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-overlay-layer={layer}
          style={{ zIndex: layer }}
          className="dark fixed inset-y-0 left-0 flex h-dvh w-screen flex-col text-foreground outline-none"
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus({ preventScroll: true });
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            图片预览
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            查看、缩放、旋转、翻转、切换或下载当前图片。
          </DialogPrimitive.Description>

          <div className="relative z-20 flex w-full shrink-0 flex-wrap items-center justify-end gap-2 border-b bg-background px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
            {current.sizeLabel || current.dimensions ? (
              <Badge variant="secondary" className="mr-auto max-w-full basis-full truncate sm:basis-auto sm:max-w-[42vw]">
                {[current.sizeLabel, current.dimensions].filter(Boolean).join(" · ")}
              </Badge>
            ) : null}
            {images.length > 1 && (
              <Badge variant="secondary">
                {currentIndex + 1} / {images.length}
              </Badge>
            )}
            <DialogPrimitive.Close asChild><Button type="button" variant="ghost" size="icon-sm">
              <X className="size-4" />
              <span className="sr-only">关闭</span>
            </Button></DialogPrimitive.Close>
          </div>

          {hasPrev && (
            <Button variant="ghost" size="icon-sm"
              type="button"
              onClick={goPrev}
              className="absolute top-1/2 left-3 z-10 -translate-y-1/2 sm:left-5 inline-flex items-center justify-center"
              aria-label="上一张"
            >
              <ChevronLeft  />
            </Button>
          )}

          <div
            className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden p-4 sm:p-8"
            onClick={() => onOpenChange(false)}
            onWheel={handleWheel}
          >
            <div className="flex size-full items-center justify-center [container-type:size]">
            <AuthenticatedImage
              src={current.src}
              alt=""
              className={cn("max-h-full max-w-full rounded-lg object-contain", zoom > MIN_ZOOM ? "cursor-grab touch-none will-change-transform active:cursor-grabbing" : "cursor-zoom-in")}
              style={{ maxWidth: rotation % 180 === 0 ? undefined : "100cqh", maxHeight: rotation % 180 === 0 ? undefined : "100cqw", transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom}) rotate(${rotation}deg) scale(${flippedX ? -1 : 1}, ${flippedY ? -1 : 1})` }}
              onClick={(event) => {
                event.stopPropagation();
                if (zoom === MIN_ZOOM) {
                  zoomIn();
                }
              }}
              onPointerDown={handleImagePointerDown}
              onPointerMove={handleImagePointerMove}
              onPointerUp={handleImagePointerEnd}
              onPointerCancel={handleImagePointerEnd}
              onLostPointerCapture={handleImagePointerEnd}
              draggable={false}
            />
            </div>
          </div>

          {hasNext && (
            <Button variant="ghost" size="icon-sm"
              type="button"
              onClick={goNext}
              className="absolute top-1/2 right-3 z-10 -translate-y-1/2 sm:right-5 inline-flex items-center justify-center"
              aria-label="下一张"
            >
              <ChevronRight  />
            </Button>
          )}

          <div className="relative z-20 flex shrink-0 flex-wrap items-center justify-center gap-1 border-t bg-background px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" role="toolbar" aria-label="图片操作">
            <div className="flex items-center">
              <TooltipButton
                type="button"
                onClick={zoomOut}
                disabled={zoom <= MIN_ZOOM}
                className="inline-flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="缩小图片"
                tooltip="缩小图片"
              >
                <ZoomOut  />
              </TooltipButton>
              <span className="min-w-12 text-center text-xs font-medium tabular-nums">{zoomPercent}%</span>
              <TooltipButton
                type="button"
                onClick={zoomIn}
                disabled={zoom >= MAX_ZOOM}
                className="inline-flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="放大图片"
                tooltip="放大图片"
              >
                <ZoomIn  />
              </TooltipButton>
              <TooltipButton
                type="button"
                onClick={resetZoom}
                disabled={zoom === MIN_ZOOM && pan.x === 0 && pan.y === 0 && rotation % 360 === 0 && !flippedX && !flippedY}
                className="inline-flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="重置图片"
                tooltip="重置图片"
              >
                <RefreshCw />
              </TooltipButton>
            </div>
            <TooltipButton type="button" onClick={() => setRotation((value) => value - 90)} aria-label="向左旋转" tooltip="向左旋转"><RotateCcw /></TooltipButton>
            <TooltipButton type="button" onClick={() => setRotation((value) => value + 90)} aria-label="向右旋转" tooltip="向右旋转"><RotateCw /></TooltipButton>
            <TooltipButton type="button" onClick={() => setFlippedX((value) => !value)} aria-label="水平翻转" aria-pressed={flippedX} tooltip="水平翻转"><FlipHorizontal2 /></TooltipButton>
            <TooltipButton type="button" onClick={() => setFlippedY((value) => !value)} aria-label="垂直翻转" aria-pressed={flippedY} tooltip="垂直翻转"><FlipVertical2 /></TooltipButton>
            <TooltipButton type="button" onClick={handleDownload} aria-label="下载图片" tooltip="下载图片"><Download /></TooltipButton>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
    </OverlayLayerProvider>
  );
}
