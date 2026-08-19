"use client";

import { Cloud, ExternalLink, HardDrive, KeyRound, LoaderCircle, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SettingsCard, settingsInputClassName, settingsPanelClassName, settingsToggleClassName } from "./settings-ui";

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
  const governance = useSettingsStore((state) => state.imageStorageGovernance);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const setImageStorageBackend = useSettingsStore((state) => state.setImageStorageBackend);
  const setS3Endpoint = useSettingsStore((state) => state.setS3Endpoint);
  const setS3Region = useSettingsStore((state) => state.setS3Region);
  const setS3Bucket = useSettingsStore((state) => state.setS3Bucket);
  const setS3Prefix = useSettingsStore((state) => state.setS3Prefix);
  const setS3UsePathStyle = useSettingsStore((state) => state.setS3UsePathStyle);
  const backend = String(config?.image_storage_backend || "local").toLowerCase() === "s3" ? "s3" : "local";
  const isS3 = backend === "s3";
  const bucket = String(config?.s3_bucket || "").trim();
  const prefix = String(config?.s3_prefix || "").trim();
  const endpointConfigured = Boolean(config?.s3_endpoint_configured);
  const credentialsConfigured = Boolean(config?.s3_credentials_configured);
  const activeBackend = governance?.storage_backend === "s3" ? "s3" : "local";
  const activeBucket = String(governance?.object_storage_bucket || "").trim();
  const activePrefix = String(governance?.object_storage_prefix || "").trim();

  return (
    <SettingsCard
      icon={isS3 ? Cloud : HardDrive}
      title="对象存储配置"
      description="配置图片原图的存储位置；对象存储凭据只在服务端读取。"
      tone="blue"
      action={
        <Button type="button" onClick={() => void saveConfig()} disabled={isSavingConfig}>
          {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field className="min-w-0 gap-1.5">
            <FieldLabel htmlFor="settings-image-storage-backend">图片存储后端</FieldLabel>
            <Select value={backend} onValueChange={(value) => setImageStorageBackend(value === "s3" ? "s3" : "local")}>
              <SelectTrigger id="settings-image-storage-backend" className={settingsInputClassName}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">服务器本地存储</SelectItem>
                <SelectItem value="s3">S3 兼容对象存储</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-0 gap-1.5">
            <FieldLabel htmlFor="settings-s3-endpoint">服务地址</FieldLabel>
            <Input id="settings-s3-endpoint" value={String(config?.s3_endpoint || "")} onChange={(event) => setS3Endpoint(event.target.value)} placeholder="https://s3.example.com" className={settingsInputClassName} />
          </Field>
          <Field className="min-w-0 gap-1.5">
            <FieldLabel htmlFor="settings-s3-region">区域</FieldLabel>
            <Input id="settings-s3-region" value={String(config?.s3_region || "")} onChange={(event) => setS3Region(event.target.value)} placeholder="auto" className={settingsInputClassName} />
          </Field>
          <Field className="min-w-0 gap-1.5">
            <FieldLabel htmlFor="settings-s3-bucket">存储桶</FieldLabel>
            <Input id="settings-s3-bucket" value={String(config?.s3_bucket || "")} onChange={(event) => setS3Bucket(event.target.value)} placeholder="cloud-cotton-images" className={settingsInputClassName} />
          </Field>
          <Field className="min-w-0 gap-1.5 sm:col-span-2">
            <FieldLabel htmlFor="settings-s3-prefix">对象前缀</FieldLabel>
            <Input id="settings-s3-prefix" value={String(config?.s3_prefix || "")} onChange={(event) => setS3Prefix(event.target.value)} placeholder="images" className={settingsInputClassName} />
          </Field>
        </div>

        <label className={settingsToggleClassName}>
          <Checkbox checked={Boolean(config?.s3_use_path_style)} onCheckedChange={(checked) => setS3UsePathStyle(checked === true)} />
          <span className="min-w-0 flex-1">
            <span className="block">路径式访问</span>
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">MinIO 通常需要开启，AWS S3 和 Cloudflare R2 通常关闭。</span>
          </span>
        </label>

        <div className={settingsPanelClassName}>
          <StatusLine label="当前后端" value={activeBackend === "s3" ? "S3 兼容对象存储" : "服务器本地存储"} tone={activeBackend === "s3" ? "success" : "default"} />
          {activeBackend === "s3" ? (
            <>
              <StatusLine label="存储桶" value={activeBucket || bucket || "未配置"} />
              <StatusLine label="对象前缀" value={activePrefix || prefix || "未设置"} tone={activePrefix || prefix ? "default" : "muted"} />
              <StatusLine label="服务地址" value={endpointConfigured ? "已配置" : "未配置"} tone={endpointConfigured ? "success" : "muted"} />
              <StatusLine label="访问凭据" value={credentialsConfigured ? "已配置" : "未配置"} tone={credentialsConfigured ? "success" : "muted"} />
            </>
          ) : null}
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <p>
            访问密钥、私有密钥和会话令牌仅通过服务端环境变量配置。上方非敏感参数在线保存后立即生效，无需重启服务。
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
