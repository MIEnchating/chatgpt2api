"use client";

import { useEffect, useRef, useState } from "react";
import { ImageUp, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { DEFAULT_SITE_ICON, resolveSiteIconSrc } from "@/lib/app-meta";

import { useSettingsStore } from "../store";

const maxSiteIconSize = 2 * 1024 * 1024;
const supportedSiteIconTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function SiteIconSettings() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState("");
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveSiteIcon = useSettingsStore((state) => state.saveSiteIcon);

  useEffect(() => {
    return () => {
      if (pendingPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(pendingPreviewUrl);
      }
    };
  }, [pendingPreviewUrl]);

  const clearPendingFile = () => {
    setPendingFile(null);
    setPendingPreviewUrl((current) => {
      if (current.startsWith("blob:")) {
        URL.revokeObjectURL(current);
      }
      return "";
    });
  };

  if (isLoadingConfig || !config) {
    return <div className="flex items-center justify-center py-8"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  }

  const currentIconUrl = String(config.site_icon_url || "").trim();
  const previewUrl = pendingPreviewUrl || resolveSiteIconSrc(currentIconUrl) || DEFAULT_SITE_ICON;

  return (
    <div className="min-w-0 border-t border-border/70 pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-5">
      <div>
        <p className="text-sm leading-6 font-medium text-foreground">网站图标</p>
        <p className="text-xs leading-5 text-muted-foreground">PNG、JPEG、WebP 或 GIF，最大 2MB</p>
      </div>
      <div className="mt-3 flex min-w-0 items-center gap-4">
        <div className="flex size-[72px] shrink-0 items-center justify-center rounded-lg border border-border bg-background p-2 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <img src={previewUrl} alt="网站图标预览" className="size-full rounded-md object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) {
                return;
              }
              if (!supportedSiteIconTypes.has(file.type)) {
                toast.error("请选择 PNG、JPEG、WebP 或 GIF 图片");
                return;
              }
              if (file.size > maxSiteIconSize) {
                toast.error("网站图标不能超过 2MB");
                return;
              }
              setPendingFile(file);
              setPendingPreviewUrl((current) => {
                if (current.startsWith("blob:")) {
                  URL.revokeObjectURL(current);
                }
                return URL.createObjectURL(file);
              });
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isSavingConfig}>
              <ImageUp className="size-4" />
              更换
            </Button>
            {pendingFile ? (
              <Button
                type="button"
                size="sm"
                disabled={isSavingConfig}
                onClick={() => {
                  void saveSiteIcon({ file: pendingFile, action: "replace" }).then((saved) => {
                    if (saved) {
                      clearPendingFile();
                    }
                  });
                }}
              >
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                应用
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isSavingConfig || (!currentIconUrl && !pendingFile)}
              onClick={() => {
                if (pendingFile && !currentIconUrl) {
                  clearPendingFile();
                  return;
                }
                clearPendingFile();
                void saveSiteIcon({ action: "remove" });
              }}
            >
              <RotateCcw className="size-4" />
              默认
            </Button>
          </div>
          <TooltipHint content={pendingFile?.name || (currentIconUrl ? "当前为自定义图标" : "当前为默认图标")}><p className="mt-2 max-w-full truncate text-xs leading-5 text-muted-foreground">
            {pendingFile ? `待应用：${pendingFile.name}` : currentIconUrl ? "当前为自定义图标" : "当前为默认图标"}
          </p></TooltipHint>
        </div>
      </div>
    </div>
  );
}
