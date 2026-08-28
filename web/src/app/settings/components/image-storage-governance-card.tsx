"use client";

import { useState } from "react";
import {
  Database,
  FileText,
  Film,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import {
  SettingsCard,
  SettingsNotice,
  settingsPanelClassName,
} from "./settings-ui";

type CleanupAction = "retention" | "quota" | "thumbnails";

function formatBytes(value?: number) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatTime(value?: string) {
  return value && value.trim() ? value : "暂无数据";
}

function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <div className="min-w-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <p className="text-xs leading-5 text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 break-words text-sm font-semibold text-foreground sm:text-base", warning && "text-destructive")}>{value}</p>
    </div>
  );
}

function UsageBar({
  label,
  value,
  total,
  tone = "blue",
}: {
  label: string;
  value: number;
  total: number;
  tone?: "amber" | "blue" | "green" | "neutral";
}) {
  const percent = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  const barClassName = {
    amber: "bg-amber-500",
    blue: "bg-blue-500",
    green: "bg-emerald-500",
    neutral: "bg-muted-foreground/55",
  }[tone];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-xs leading-5">
        <span className="font-medium text-foreground">{label}</span>
        <span className="shrink-0 text-muted-foreground">{formatBytes(value)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", barClassName)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function AssetKindMetric({
  icon: Icon,
  label,
  count,
  bytes,
  unit = "个",
  tone,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  bytes: number;
  unit?: "个" | "条";
  tone: "amber" | "blue" | "green" | "violet";
}) {
  const toneClassName = {
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  }[tone];
  return (
    <div className="flex min-w-0 items-center gap-3 xl:px-4 xl:first:pl-0 xl:last:pr-0">
      <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", toneClassName)}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-xs leading-5 text-muted-foreground">{label}</p>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <strong className="text-sm font-semibold text-foreground">{count} {unit}</strong>
          <span className="text-xs text-muted-foreground">{formatBytes(bytes)}</span>
        </div>
      </div>
    </div>
  );
}

export function ImageStorageGovernanceCard() {
  const [cleanupAction, setCleanupAction] = useState<CleanupAction | null>(null);
  const config = useSettingsStore((state) => state.config);
  const imageStorageGovernance = useSettingsStore(
    (state) => state.imageStorageGovernance,
  );
  const lastImageStorageCleanup = useSettingsStore(
    (state) => state.lastImageStorageCleanup,
  );
  const isLoadingImageStorageGovernance = useSettingsStore(
    (state) => state.isLoadingImageStorageGovernance,
  );
  const isCleaningImageStorage = useSettingsStore(
    (state) => state.isCleaningImageStorage,
  );
  const loadImageStorageGovernance = useSettingsStore(
    (state) => state.loadImageStorageGovernance,
  );
  const cleanupImageStorageByRetention = useSettingsStore(
    (state) => state.cleanupImageStorageByRetention,
  );
  const cleanupImageStorageByQuota = useSettingsStore(
    (state) => state.cleanupImageStorageByQuota,
  );
  const cleanupImageThumbnails = useSettingsStore(
    (state) => state.cleanupImageThumbnails,
  );

  const governance = imageStorageGovernance;
  const totalBytes = governance?.total_bytes ?? 0;
  const localMedia = governance?.local_media;
  const localMediaBytes = localMedia?.total_bytes ?? 0;
  const localAssetCount = localMedia?.total_count ?? 0;
  const limitBytes = governance?.limit_bytes ?? 0;
  const retentionDays = Math.max(1, Number(config?.image_retention_days) || 30);
  const limitMb = Math.max(0, Number(config?.image_storage_limit_mb) || 0);
  const overLimit = (governance?.over_limit_bytes ?? 0) > 0;
  const storedImageCount = (governance?.images_count ?? 0) + (governance?.conversation_asset_count ?? 0);

  const handleCleanup = async () => {
    if (cleanupAction === "retention") {
      await cleanupImageStorageByRetention();
    } else if (cleanupAction === "quota") {
      await cleanupImageStorageByQuota(false);
    } else if (cleanupAction === "thumbnails") {
      await cleanupImageThumbnails();
    }
    setCleanupAction(null);
  };

  return (
    <SettingsCard
      icon={HardDrive}
      title="媒体治理"
      description="查看文本、图片、视频和音频素材，以及生成图库的存储占用。"
      tone="slate"
      action={
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => void loadImageStorageGovernance()}
          disabled={isLoadingImageStorageGovernance}
        >
          {isLoadingImageStorageGovernance ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          刷新
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {isLoadingImageStorageGovernance && !governance ? (
          <div className="flex items-center justify-center rounded-xl border border-border/80 bg-background py-10">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <section className="space-y-3.5">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><HardDrive className="size-4" /></div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">本机素材</h3>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">文本、图片、视频和音频均按服务器本机实际文件统计，容量上限在“存储配置”中设置。</p>
                </div>
              </div>
              <div className="grid gap-3 border-y border-border/70 py-3 sm:grid-cols-3 sm:gap-0 sm:divide-x">
                <Metric label="媒体文件占用" value={formatBytes(localMediaBytes)} warning={(localMedia?.over_limit_bytes ?? 0) > 0} />
                <Metric label="媒体容量上限" value={(localMedia?.limit_bytes ?? 0) > 0 ? formatBytes(localMedia?.limit_bytes) : "不限制"} />
                <Metric label="素材总数" value={`${localAssetCount} 项`} />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-4 py-1 xl:grid-cols-4 xl:gap-0 xl:divide-x xl:divide-border/70">
                <AssetKindMetric icon={FileText} label="文本" count={localMedia?.text_count ?? 0} bytes={localMedia?.text_bytes ?? 0} unit="条" tone="violet" />
                <AssetKindMetric icon={ImageIcon} label="图片" count={localMedia?.image_count ?? 0} bytes={localMedia?.image_bytes ?? 0} tone="green" />
                <AssetKindMetric icon={Film} label="视频" count={localMedia?.video_count ?? 0} bytes={localMedia?.video_bytes ?? 0} tone="blue" />
                <AssetKindMetric icon={Music2} label="音频" count={localMedia?.audio_count ?? 0} bytes={localMedia?.audio_bytes ?? 0} tone="amber" />
              </div>
              {(localMedia?.other_count ?? 0) > 0 || (localMedia?.untracked_bytes ?? 0) > 0 ? <p className="text-xs text-muted-foreground">另有 {localMedia?.other_count ?? 0} 个其他文件和 {formatBytes(localMedia?.untracked_bytes)} 未索引文件，不计入上方四类素材。</p> : null}
            </section>

            <section className="space-y-3.5 border-t border-border/70 pt-5">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><ImageIcon className="size-4" /></div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">生成图库</h3>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">缩略图用于列表和画布预览，清理后会按需重新生成，不影响原图。</p>
                </div>
              </div>
              <div className="grid gap-3 border-y border-border/70 py-3 sm:grid-cols-3 sm:gap-0 sm:divide-x">
                <Metric label="已用 / 上限" value={`${formatBytes(totalBytes)} / ${limitBytes > 0 ? formatBytes(limitBytes) : "不限制"}`} warning={overLimit} />
                <Metric label="图片总数" value={`${governance?.images_count ?? 0} 张`} />
                <Metric label="公开 / 私有" value={`${governance?.public_images_count ?? 0} / ${governance?.private_images_count ?? 0}`} />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <UsageBar label="原图" value={governance?.images_bytes ?? 0} total={totalBytes} tone="blue" />
                <UsageBar label={`参考附件 · ${(governance?.reference_files ?? 0) + (governance?.conversation_asset_count ?? 0)} 个`} value={(governance?.metadata_bytes ?? 0) + (governance?.reference_bytes ?? 0) + (governance?.conversation_asset_bytes ?? 0)} total={totalBytes} tone="green" />
                <UsageBar label={`缩略图 · ${governance?.thumbnail_files ?? 0} 个`} value={governance?.thumbnails_bytes ?? 0} total={totalBytes} tone="amber" />
              </div>
              <p className="text-xs text-muted-foreground">存储时间：{formatTime(governance?.oldest_image_at)} 至 {formatTime(governance?.latest_image_at)}</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button type="button" variant="outline" className="min-h-11" onClick={() => setCleanupAction("thumbnails")} disabled={isCleaningImageStorage || (governance?.thumbnail_files ?? 0) === 0}><ImageIcon data-icon="inline-start" />清缩略图</Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => setCleanupAction("retention")} disabled={isCleaningImageStorage || storedImageCount === 0}><Trash2 data-icon="inline-start" />按天数清理</Button>
                <Button type="button" variant={overLimit ? "destructive" : "outline"} className="min-h-11" onClick={() => setCleanupAction("quota")} disabled={isCleaningImageStorage || limitMb <= 0 || storedImageCount === 0}><Database data-icon="inline-start" />按容量清理</Button>
              </div>
            </section>
          </>
        )}

        {lastImageStorageCleanup ? (
          <SettingsNotice>
            上次清理删除 {lastImageStorageCleanup.deleted_images} 张图片、{" "}
            {lastImageStorageCleanup.deleted_conversation_assets} 张会话参考图、{" "}
            {lastImageStorageCleanup.deleted_thumbnails} 个缩略图，释放{" "}
            {formatBytes(lastImageStorageCleanup.deleted_bytes)}。
          </SettingsNotice>
        ) : null}
      </div>

      <Dialog
        open={cleanupAction !== null}
        onOpenChange={(open) => {
          if (!open) setCleanupAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认清理生成图库</DialogTitle>
            <DialogDescription>
              {cleanupAction === "thumbnails"
                ? "将删除缩略图缓存，原图和参考图不会被删除。"
                : cleanupAction === "quota"
                  ? "将按容量上限删除最旧的非公开图片，公开图库图片默认保留。"
                  : "将删除保留窗口以前的非公开图片，并同步清理缩略图、元数据和参考图。"}
            </DialogDescription>
          </DialogHeader>
          <div className={settingsPanelClassName}>
            {cleanupAction === "quota"
              ? `当前容量上限为 ${limitMb} MB。`
              : cleanupAction === "retention"
                ? `当前图片保留策略为最近 ${retentionDays} 天。`
                : `当前缩略图缓存占用 ${formatBytes(governance?.thumbnails_bytes)}。`}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleCleanup()}
              disabled={isCleaningImageStorage}
            >
              {isCleaningImageStorage ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <Trash2 data-icon="inline-start" />
              )}
              确认清理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}
