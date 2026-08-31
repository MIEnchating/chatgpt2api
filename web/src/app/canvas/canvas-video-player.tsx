import { Download, Maximize, Maximize2, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { useRef, useState } from "react";

import { formatCanvasVideoTime } from "@/app/canvas/canvas-video-time";
import { TooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
  onMediaLoad: (width: number, height: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }

  const controlClassName = "absolute bottom-2 z-20 flex size-7 items-center justify-center rounded-md bg-black/55 text-white opacity-80 backdrop-blur transition-opacity hover:opacity-100";
  const keepVideoFocus = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (selected) videoRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      className="relative size-full overflow-hidden rounded-[inherit] bg-black"
      data-canvas-no-pan
      data-canvas-no-zoom
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <video
        ref={videoRef}
        src={src}
        aria-label={title}
        tabIndex={-1}
        playsInline
        preload="metadata"
        className="size-full object-contain outline-none"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(Number.isFinite(video.duration) ? video.duration : 0);
          onMediaLoad(video.videoWidth, video.videoHeight);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onKeyDown={(event) => {
          if (!selected || event.code !== "Space") return;
          event.preventDefault();
          event.stopPropagation();
          togglePlayback();
        }}
      />
      {duration > 0 ? (
        <span className="pointer-events-none absolute left-2 top-2 z-20 flex h-7 items-center rounded-md bg-black/55 px-2 text-[11px] font-medium text-white opacity-80 backdrop-blur">
          {formatCanvasVideoTime(duration)}
        </span>
      ) : null}
      <TooltipButton
        type="button"
        tooltip={playing ? "暂停" : "播放"}
        aria-label={playing ? "暂停" : "播放"}
        className={cn(controlClassName, "left-2")}
        onMouseDown={keepVideoFocus}
        onClick={(event) => {
          event.stopPropagation();
          togglePlayback();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </TooltipButton>
      <TooltipButton
        type="button"
        tooltip="放大预览"
        aria-label="放大预览"
        className={cn(controlClassName, "right-2")}
        onMouseDown={keepVideoFocus}
        onClick={(event) => {
          event.stopPropagation();
          videoRef.current?.pause();
          onOpen();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Maximize2 className="size-3.5" />
      </TooltipButton>
    </div>
  );
}

const previewControlClassName = "flex size-9 items-center justify-center rounded-lg text-white transition-colors hover:bg-white/10";

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
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={playerRef}
        className="relative flex max-h-[85vh] max-w-[85vw] items-center justify-center overflow-hidden rounded-xl bg-black shadow-2xl fullscreen:h-screen fullscreen:w-screen fullscreen:max-h-none fullscreen:max-w-none fullscreen:rounded-none [&:fullscreen>video]:h-screen [&:fullscreen>video]:w-screen [&:fullscreen>video]:max-h-none [&:fullscreen>video]:max-w-none"
        data-canvas-no-zoom
        onClick={(event) => event.stopPropagation()}
        onKeyDownCapture={(event) => {
          if (event.code !== "Space") return;
          event.preventDefault();
          event.stopPropagation();
          togglePlayback();
        }}
      >
        <video
          ref={videoRef}
          src={src}
          aria-label={title}
          tabIndex={-1}
          playsInline
          preload="metadata"
          className="block max-h-[85vh] max-w-[85vw] object-contain outline-none"
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
        <button type="button" aria-label="关闭预览" onClick={onClose} className="absolute right-4 top-4 z-20 flex size-9 items-center justify-center rounded-lg text-white transition-colors hover:bg-black/25">
          <X className="size-6" />
        </button>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-5 pb-3 pt-24">
          <div className="mb-2 flex justify-between text-xs font-medium tabular-nums text-white">
            <span>{formatCanvasVideoTime(currentTime)}</span>
            <span>{formatCanvasVideoTime(duration)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step="0.01"
            value={Math.min(currentTime, duration || 0)}
            aria-label="视频进度"
            onChange={(event) => {
              const time = Number(event.currentTarget.value);
              if (videoRef.current) videoRef.current.currentTime = time;
              setCurrentTime(time);
            }}
            onPointerUp={() => videoRef.current?.focus({ preventScroll: true })}
            className="pointer-events-auto block h-1 w-full cursor-pointer appearance-none rounded-full focus-visible:outline-none [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            style={{ background: `linear-gradient(to right, #67e8f9 ${duration ? Math.min(currentTime / duration, 1) * 100 : 0}%, rgba(255,255,255,0.35) 0)` }}
          />
          <div className="pointer-events-auto mt-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button type="button" aria-label={playing ? "暂停" : "播放"} onPointerDown={(event) => event.preventDefault()} onClick={togglePlayback} className={previewControlClassName}>
                {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
              </button>
              <div className="group/volume flex items-center">
                <button
                  type="button"
                  aria-label={volume === 0 ? "恢复声音" : "静音"}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
                  }}
                  className={previewControlClassName}
                >
                  {volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step="0.01"
                  value={volume}
                  aria-label="音量"
                  onChange={(event) => {
                    const nextVolume = Number(event.currentTarget.value);
                    if (!videoRef.current) return;
                    if (nextVolume === 0) videoRef.current.muted = true;
                    else {
                      videoRef.current.volume = nextVolume;
                      videoRef.current.muted = false;
                    }
                  }}
                  onPointerUp={() => videoRef.current?.focus({ preventScroll: true })}
                  className="h-1 w-0 pointer-events-none cursor-pointer appearance-none rounded-full opacity-0 transition-[width,opacity] duration-200 focus-visible:outline-none group-hover/volume:mx-1 group-hover/volume:w-20 group-hover/volume:pointer-events-auto group-hover/volume:opacity-100 [&::-moz-range-thumb]:size-2 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                  style={{ background: `linear-gradient(to right, white ${volume * 100}%, rgba(255,255,255,0.35) 0)` }}
                />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="下载视频" onPointerDown={(event) => event.preventDefault()} onClick={onDownload} className={previewControlClassName}>
                <Download className="size-5" />
              </button>
              <button
                type="button"
                aria-label="全屏播放"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else void playerRef.current?.requestFullscreen();
                }}
                className={previewControlClassName}
              >
                <Maximize className="size-5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
