"use client";

import { Cloud, ExternalLink, HardDrive, KeyRound, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SettingsCard, settingsPanelClassName } from "./settings-ui";

function StatusLine({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" | "muted" }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 border-b border-border/60 py-2.5 last:border-b-0 last:pb-0 first:pt-0">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-sm", tone === "success" ? "text-emerald-700 dark:text-emerald-400" : tone === "muted" ? "text-muted-foreground" : "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

export function ImageObjectStorageCard() {
  const config = useSettingsStore((state) => state.config);
  const loadConfig = useSettingsStore((state) => state.loadConfig);
  const backend = String(config?.image_storage_backend || "local").toLowerCase() === "s3" ? "s3" : "local";
  const isS3 = backend === "s3";
  const bucket = String(config?.s3_bucket || "").trim();
  const prefix = String(config?.s3_prefix || "").trim();
  const endpointConfigured = Boolean(config?.s3_endpoint_configured);
  const credentialsConfigured = Boolean(config?.s3_credentials_configured);

  return (
    <SettingsCard
      icon={isS3 ? Cloud : HardDrive}
      title="对象存储配置"
      description="配置图片原图的存储位置；对象存储凭据只在服务端读取。"
      tone="blue"
      action={
        <Button type="button" variant="outline" size="icon" title="刷新对象存储状态" aria-label="刷新对象存储状态" onClick={() => void loadConfig()}>
          <RefreshCw className="size-4" />
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className={settingsPanelClassName}>
          <StatusLine label="当前后端" value={isS3 ? "S3 兼容对象存储" : "服务器本地存储"} tone={isS3 ? "success" : "default"} />
          {isS3 ? (
            <>
              <StatusLine label="Bucket" value={bucket || "未配置"} />
              <StatusLine label="对象前缀" value={prefix || "未设置"} tone={prefix ? "default" : "muted"} />
              <StatusLine label="Endpoint" value={endpointConfigured ? "已配置" : "未配置"} tone={endpointConfigured ? "success" : "muted"} />
              <StatusLine label="访问凭据" value={credentialsConfigured ? "已配置" : "未配置"} tone={credentialsConfigured ? "success" : "muted"} />
            </>
          ) : null}
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <p>
            {isS3
              ? "Endpoint、Bucket 和访问密钥通过服务端环境变量配置，修改后请重启服务。图片仍通过云棉鉴权地址访问。"
              : "如需使用 S3、R2 或 MinIO，请设置 CHATGPT2API_IMAGE_STORAGE_BACKEND=s3 及对应 S3 环境变量后重启服务。"}
          </p>
        </div>

        <a
          href="https://github.com/MIEnchating/chatgpt2api#配置说明"
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          查看对象存储配置说明
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    </SettingsCard>
  );
}
