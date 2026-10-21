"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type Player from "xgplayer";

import { cn } from "@/lib/utils";

export function MediaVideoPlayer({
  aspectRatio = "16 / 9",
  className,
  src,
  title = "视频",
}: {
  aspectRatio?: string;
  className?: string;
  src: string;
  title?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !src) return;
    let disposed = false;
    let player: Player | undefined;
    void Promise.all([import("xgplayer"), import("xgplayer/dist/index.min.css")]).then(([{ default: Player }]) => {
      if (disposed) return;
      player = new Player({
        el: container,
        url: src,
        lang: "zh-cn",
        width: "100%",
        height: "100%",
        volume: 0.7,
        autoplay: false,
        playsinline: true,
        controls: {
          autoHide: true,
          initShow: true,
          mode: "normal",
        },
        videoFillMode: "contain",
        fitVideoSize: "fixed",
        pip: false,
        ignores: ["pip"],
        cssFullscreen: false,
        playbackRate: {
          toggleMode: "click",
          listType: "middle",
          list: [
            { rate: 2, text: "2 倍", iconText: "2x" },
            { rate: 1.5, text: "1.5 倍", iconText: "1.5x" },
            { rate: 1.25, text: "1.25 倍", iconText: "1.25x" },
            { rate: 1, text: "正常", iconText: "1x" },
            { rate: 0.75, text: "0.75 倍", iconText: "0.75x" },
            { rate: 0.5, text: "0.5 倍", iconText: "0.5x" },
          ],
        },
        keyShortcut: true,
        enableContextmenu: false,
        miniprogress: true,
        screenShot: false,
        download: true,
        mini: false,
        videoAttributes: {
          preload: "metadata",
          disablePictureInPicture: true,
        },
        commonStyle: {
          playedColor: "#1456f0",
          progressColor: "rgba(255, 255, 255, 0.28)",
          cachedColor: "rgba(255, 255, 255, 0.18)",
          volumeColor: "#1456f0",
        },
      });
    }).catch((error) => {
      if (!disposed) toast.error(error instanceof Error ? error.message : "视频播放器加载失败");
    });
    return () => {
      disposed = true;
      player?.destroy();
    };
  }, [src]);

  return (
    <div
      data-app-video-player
      className={cn(
        "relative isolate w-full overflow-hidden rounded-xl border border-white/10 bg-[#080b10] text-white shadow-[0_14px_40px_rgba(2,6,23,0.16)]",
        className,
      )}
      style={{ aspectRatio }}
      role="group"
      aria-label={title}
    >
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
