"use client";

import { I18nProvider } from "@videojs/react/i18n";
import zhCN from "@videojs/react/i18n/locales/zh-CN";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import "@videojs/react/video/skin.css";

import { cn } from "@/lib/utils";

export function MediaVideoPlayer({
  aspectRatio = "16 / 9",
  className,
  embedded = false,
  src,
  title = "视频",
}: {
  aspectRatio?: string;
  className?: string;
  embedded?: boolean;
  src: string;
  title?: string;
}) {
  return (
    <div
      data-app-video-player
      className={cn("relative isolate w-full overflow-hidden", className)}
      style={{ aspectRatio }}
      role="group"
      aria-label={title}
    >
      <I18nProvider locale="zh-CN" translations={zhCN}>
        <VideoPlayer>
          <VideoSkin className={cn("absolute inset-0 h-full w-full", embedded && "rounded-none")}>
            <Video src={src} preload="metadata" playsInline />
          </VideoSkin>
        </VideoPlayer>
      </I18nProvider>
    </div>
  );
}
