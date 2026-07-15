"use client";

import { useEffect, useRef, useState } from "react";
import { AppWindow, LoaderCircle, RotateCcw, Save, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DEFAULT_SITE_ICON, resolveSiteIconSrc } from "@/lib/app-meta";

import { useSettingsStore } from "../store";
import { SettingsCard } from "./settings-ui";

const maxSiteIconSize = 2 * 1024 * 1024;
const supportedSiteIconTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function SiteIconCard() {
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
    return (
      <SettingsCard icon={AppWindow} title="网站图标" description="配置浏览器和站内品牌图标。" tone="violet">
        <div className="flex items-center justify-center py-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      </SettingsCard>
    );
  }

  const currentIconUrl = String(config.site_icon_url || "").trim();
  const previewUrl = pendingPreviewUrl || resolveSiteIconSrc(currentIconUrl) || DEFAULT_SITE_ICON;

  return (
    <SettingsCard
      icon={AppWindow}
      title="网站图标"
      description="配置浏览器和站内品牌图标。"
      tone="violet"
      action={
        <Button
          type="button"
          size="sm"
          disabled={!pendingFile || isSavingConfig}
          onClick={() => {
            if (!pendingFile) {
              return;
            }
            void saveSiteIcon({ file: pendingFile, action: "replace" }).then((saved) => {
              if (saved) {
                clearPendingFile();
              }
            });
          }}
        >
          {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存
        </Button>
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex size-20 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/35 p-2">
          <img src={previewUrl} alt="网站图标预览" className="size-full rounded-lg object-cover" />
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
            <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isSavingConfig}>
              <Upload className="size-4" />
              选择图片
            </Button>
            <Button
              type="button"
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
              恢复默认
            </Button>
          </div>
          <p className="mt-2 truncate text-xs text-muted-foreground">
            {pendingFile ? pendingFile.name : currentIconUrl ? "已使用自定义图标" : "当前使用默认图标"}
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}
