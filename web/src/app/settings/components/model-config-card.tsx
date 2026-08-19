"use client";

import type { LucideIcon } from "lucide-react";
import { Clapperboard, Image as ImageIcon, LoaderCircle, Settings2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SettingsCard, SettingsNotice, settingsInputClassName } from "./settings-ui";

function modelListInputValue(value: unknown) {
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function ModelConfigField({
  icon: Icon,
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  icon: LucideIcon;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: unknown;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-muted/25 p-3.5 transition-colors focus-within:border-blue-300 focus-within:bg-blue-50/30">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border/70">
            <Icon className="size-4" />
          </span>
          <label htmlFor={id} className="truncate text-sm font-semibold text-foreground">
            {label}
          </label>
        </div>
        <span className="shrink-0 rounded-full bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border/60">
          首项默认
        </span>
      </div>
      <Input
        id={id}
        value={modelListInputValue(value)}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(settingsInputClassName, "h-11")}
      />
      <p className="mt-2 truncate text-xs text-muted-foreground" title={placeholder}>
        {placeholder}
      </p>
    </div>
  );
}

export function ModelConfigCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const setImageModels = useSettingsStore((state) => state.setImageModels);
  const setVideoModels = useSettingsStore((state) => state.setVideoModels);

  if (isLoadingConfig || !config) {
    return (
      <SettingsCard
        icon={Settings2}
        title="模型配置"
        description="管理图片和视频生成可用的模型。"
      >
        <div className="flex items-center justify-center py-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      icon={Settings2}
      title="模型配置"
      description="管理图片和视频生成可用的模型。"
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <ModelConfigField
            icon={ImageIcon}
            id="settings-image-models"
            label="图片模型"
            value={config.image_models}
            onChange={setImageModels}
            placeholder="gpt-image-2"
          />
          <ModelConfigField
            icon={Clapperboard}
            id="settings-video-models"
            label="视频模型"
            value={config.video_models}
            onChange={setVideoModels}
            placeholder="sora-2, grok-imagine-video-1.5"
          />
        </div>
        <SettingsNotice>
          多个模型请用英文逗号分隔，每类模型的第一项会作为默认模型。修改后点击页面顶部的“保存配置”生效。
        </SettingsNotice>
      </div>
    </SettingsCard>
  );
}
