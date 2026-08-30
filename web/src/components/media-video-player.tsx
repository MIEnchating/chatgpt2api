"use client";

import { useEffect, useRef } from "react";
import Player from "xgplayer";
import "xgplayer/dist/index.min.css";

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
    if (!containerRef.current || !src) return;
    const player = new Player({
      el: containerRef.current,
      url: src,
      lang: "zh-cn",
      width: "100%",
      height: "100%",
      volume: 0.7,
      autoplay: false,
      playsinline: true,
      controls: {
        autoHide: false,
        initShow: true,
      },
      videoFillMode: "contain",
      fitVideoSize: "fixed",
      pip: true,
      cssFullscreen: true,
      playbackRate: {
        toggleMode: "click",
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
      },
      commonStyle: {
        playedColor: "#1456f0",
        progressColor: "rgba(255, 255, 255, 0.28)",
        cachedColor: "rgba(255, 255, 255, 0.18)",
        volumeColor: "#1456f0",
      },
    });
    return () => player.destroy();
  }, [src]);

  return (
    <div
      ref={containerRef}
      data-app-video-player
      className={cn(
        "w-full overflow-hidden rounded-lg bg-[#080b10] text-white",
        className,
      )}
      style={{ aspectRatio }}
      role="group"
      aria-label={title}
    />
  );
}
