import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Download, Maximize, Maximize2, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { formatCanvasVideoTime } from "@/app/canvas/canvas-video-time";
import { TooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

async function toggleVideoPlayback(video: HTMLVideoElement | null) {
  if (!video) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  try {
    await video.play();
  } catch (error) {
    // Pausing or closing a preview can cancel a pending play request.
    if (error instanceof DOMException && error.name === "AbortError") return;
    toast.error("视频播放失败，请检查视频地址、文件格式或浏览器支持");
  }
}

export function CanvasVideoNodePlayer({
  src,
  title,
  selected,
  onOpen,
  onMediaLoad,
}: {
  src: string;
  title: string;
  selected: boolean;
  onOpen: () => void;
  onMediaLoad: (width: number, height: number, durationMS: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!selected) {
      videoRef.current?.pause();
      if (document.activeElement === videoRef.current) videoRef.current?.blur();
    }
  }, [selected, src]);

  function togglePlayback() {
    void toggleVideoPlayback(videoRef.current);
  }

  const controlClassName = "dark absolute bottom-2 z-20";
  const keepVideoFocus = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (selected) videoRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      className="relative size-full overflow-hidden rounded-[inherit] bg-black"
      data-canvas-media
      data-canvas-no-zoom
      onMouseDown={(event) => { if (event.target instanceof Element && event.target.closest("button,input")) event.stopPropagation(); }}
      onWheel={(event) => event.stopPropagation()}
    >
      <video
        ref={videoRef}
        src={src}
        aria-label={title}
        tabIndex={-1}
        playsInline
        disablePictureInPicture
        preload="metadata"
        className="size-full object-contain outline-none"
        onLoadStart={() => { setCurrentTime(0); setDuration(0); setPlaying(false); }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(Number.isFinite(video.duration) ? video.duration : 0);
          onMediaLoad(video.videoWidth, video.videoHeight, Number.isFinite(video.duration) ? Math.round(video.duration*1000) : 0);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onKeyDown={(event) => {
          if (!selected || event.code !== "Space") return;
          event.preventDefault();
          event.stopPropagation();
          togglePlayback();
        }}
      />
      {duration > 0 ? (
        <Badge variant="secondary" className="pointer-events-none absolute left-2 top-2 z-20 flex h-7 items-center opacity-80">
          {formatCanvasVideoTime(duration)}
        </Badge>
      ) : null}
      <TooltipButton
        type="button"
        tooltip={playing ? "暂停" : "播放"}
        variant="secondary"
        aria-label={playing ? "暂停" : "播放"}
        data-canvas-no-pan
        className={cn(controlClassName, "left-2")}
        onMouseDown={keepVideoFocus}
        onClick={(event) => {
          event.stopPropagation();
          togglePlayback();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {playing ? <Pause  /> : <Play  />}
      </TooltipButton>
      <div className="absolute bottom-2 left-11 right-11 z-20 flex h-7 items-center" data-canvas-no-pan onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <Slider
          min={0}
          max={duration || 1}
          step={0.01}
          value={[Math.min(currentTime, duration)]}
          disabled={duration <= 0}
          aria-label="视频进度"
          className="w-full cursor-pointer"
          onValueChange={([time]) => {
            if (videoRef.current) videoRef.current.currentTime = time;
            setCurrentTime(time);
          }}
          onPointerUp={() => videoRef.current?.focus({ preventScroll: true })}
        />
      </div>
      <TooltipButton
        type="button"
        tooltip="放大预览"
        variant="secondary"
        aria-label="放大预览"
        data-canvas-no-pan
        className={cn(controlClassName, "right-2")}
        onMouseDown={keepVideoFocus}
        onClick={(event) => {
          event.stopPropagation();
          videoRef.current?.pause();
          onOpen();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Maximize2  />
      </TooltipButton>
    </div>
  );
}

const previewControlClassName = "shrink-0";

export function CanvasVideoPreview({
  src,
  title,
  onDownload,
  onClose,
}: {
  src: string;
  title: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);

  function togglePlayback() {
    void toggleVideoPlayback(videoRef.current);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="w-auto max-w-[85vw] gap-0 p-0 sm:max-w-[85vw]"
        onKeyDown={(event) => {
          if (event.code !== "Space" || (event.target !== event.currentTarget && event.target !== videoRef.current)) return;
          event.preventDefault();
          event.stopPropagation();
          togglePlayback();
        }}
      >
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <DialogDescription className="sr-only">视频预览，支持播放、进度调整、音量、下载和全屏。</DialogDescription>
      <div
        ref={playerRef}
        className="dark relative flex max-h-[85dvh] max-w-[85vw] items-center justify-center overflow-hidden bg-black text-foreground fullscreen:h-screen fullscreen:w-screen fullscreen:max-h-none fullscreen:max-w-none [&:fullscreen>video]:h-screen [&:fullscreen>video]:w-screen [&:fullscreen>video]:max-h-none [&:fullscreen>video]:max-w-none"
        data-canvas-no-zoom
      >
        <video
          ref={videoRef}
          src={src}
          aria-label={title}
          tabIndex={-1}
          playsInline
          disablePictureInPicture
          preload="metadata"
          className="block max-h-[85dvh] max-w-[85vw] object-contain outline-none"
          onLoadStart={() => {
            setDuration(0);
            setCurrentTime(0);
            setPlaying(false);
          }}
          onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onVolumeChange={(event) => setVolume(event.currentTarget.muted ? 0 : event.currentTarget.volume)}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
        <Button variant="ghost" size="icon-sm" type="button" aria-label="关闭预览" onClick={onClose} className="absolute right-4 top-4 z-20 flex items-center justify-center">
          <X  />
        </Button>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-5 pb-3 pt-24">
          <div className="mb-2 flex justify-between text-xs font-medium tabular-nums text-white">
            <span>{formatCanvasVideoTime(currentTime)}</span>
            <span>{formatCanvasVideoTime(duration)}</span>
          </div>
          <Slider
            min={0}
            max={duration || 1}
            step={0.01}
            value={[Math.min(currentTime, duration || 0)]}
            aria-label="视频进度"
            onValueChange={([time]) => {
              if (videoRef.current) videoRef.current.currentTime = time;
              setCurrentTime(time);
            }}
            onPointerUp={() => videoRef.current?.focus({ preventScroll: true })}
            disabled={duration <= 0}
            className="pointer-events-auto w-full cursor-pointer"
          />
          <div className="pointer-events-auto mt-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Button variant="ghost" type="button" aria-label={playing ? "暂停" : "播放"} onPointerDown={(event) => event.preventDefault()} onClick={togglePlayback} size="icon" className={previewControlClassName}>
                {playing ? <Pause  /> : <Play  />}
              </Button>
              <div className="group/volume flex items-center">
                <Button variant="ghost"
                  type="button"
                  aria-label={volume === 0 ? "恢复声音" : "静音"}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
                  }}
                  size="icon" className={previewControlClassName}
                >
                  {volume === 0 ? <VolumeX  /> : <Volume2  />}
                </Button>
                <Slider
                  min={0}
                  max={1}
                  step={0.01}
                  value={[volume]}
                  aria-label="音量"
                  onValueChange={([nextVolume]) => {
                    if (!videoRef.current) return;
                    if (nextVolume === 0) videoRef.current.muted = true;
                    else {
                      videoRef.current.volume = nextVolume;
                      videoRef.current.muted = false;
                    }
                  }}
                  onPointerUp={() => videoRef.current?.focus({ preventScroll: true })}
                  className="pointer-events-none w-0 cursor-pointer opacity-0 group-hover/volume:mx-1 group-hover/volume:w-20 group-hover/volume:pointer-events-auto group-hover/volume:opacity-100 group-focus-within/volume:mx-1 group-focus-within/volume:w-20 group-focus-within/volume:pointer-events-auto group-focus-within/volume:opacity-100"
                />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" type="button" aria-label="下载视频" onPointerDown={(event) => event.preventDefault()} onClick={onDownload} size="icon" className={previewControlClassName}>
                <Download  />
              </Button>
              <Button variant="ghost"
                type="button"
                aria-label="全屏播放"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else void playerRef.current?.requestFullscreen();
                }}
                size="icon" className={previewControlClassName}
              >
                <Maximize  />
              </Button>
            </div>
          </div>
        </div>
      </div>
      </DialogContent>
    </Dialog>
  );
}
