"use client";

import { useState, type ReactNode } from "react";
import {
  Clock3,
  Info,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { LogView } from "@/lib/api";

import { useSettingsStore } from "../store";
import {
  SettingsCard,
  settingsInputClassName,
  settingsPanelClassName,
} from "./settings-ui";

const LOG_LEVEL_OPTIONS = ["debug", "info", "warning", "error"];
const LOG_CLEANUP_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const LOG_VIEW_OPTIONS: Array<{ value: LogView; label: string; description: string }> = [
  { value: "meaningful", label: "有意义日志", description: "默认隐藏成功的查询类 HTTP 审计日志。" },
  { value: "business", label: "仅业务日志", description: "只显示业务事件，隐藏 HTTP 审计日志。" },
  { value: "all", label: "全部日志", description: "显示所有业务和 HTTP 审计日志。" },
];

function formatLogTime(value?: string) {
  return value && value.trim() ? value : "暂无数据";
}

function LogMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 py-1 sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <p className="text-xs leading-5 text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-foreground sm:text-base">{value}</p>
    </div>
  );
}

function InlineHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function LogLevelOption({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-9 min-w-0 items-center gap-2.5 text-sm font-medium text-foreground">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(Boolean(value))}
      />
      <span className="min-w-0 leading-5">{label}</span>
    </label>
  );
}

function LogRetentionInput({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: number | string;
}) {
  return (
    <NumberInput
      id="settings-log-retention-days"
      min={1}
      max={3650}
      step={1}
      inputMode="numeric"
      value={String(value)}
      onValueChange={onChange}
      placeholder="7"
      controlsLayout="split"
      suffix="天"
      className={settingsInputClassName}
    />
  );
}

export function LogGovernanceCard() {
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const logGovernance = useSettingsStore((state) => state.logGovernance);
  const lastLogCleanup = useSettingsStore((state) => state.lastLogCleanup);
  const isLoadingLogGovernance = useSettingsStore(
    (state) => state.isLoadingLogGovernance,
  );
  const isCleaningLogs = useSettingsStore((state) => state.isCleaningLogs);
  const setLogRetentionDays = useSettingsStore(
    (state) => state.setLogRetentionDays,
  );
  const setLogCleanupScheduleEnabled = useSettingsStore(
    (state) => state.setLogCleanupScheduleEnabled,
  );
  const setLogCleanupHour = useSettingsStore(
    (state) => state.setLogCleanupHour,
  );
  const setDefaultLogView = useSettingsStore((state) => state.setDefaultLogView);
  const setLogLevel = useSettingsStore((state) => state.setLogLevel);
  const loadLogGovernance = useSettingsStore((state) => state.loadLogGovernance);
  const cleanupLogsByRetention = useSettingsStore(
    (state) => state.cleanupLogsByRetention,
  );

  const retentionDays = Math.max(1, Number(config?.log_retention_days) || 7);
  const scheduleEnabled = config?.log_cleanup_schedule_enabled === true;
  const cleanupHour = Number(config?.log_cleanup_hour ?? 3);
  const defaultLogView = (config?.default_log_view || "meaningful") as LogView;
  const total = logGovernance?.total ?? 0;

  const handleCleanup = async () => {
    await cleanupLogsByRetention();
    setCleanupDialogOpen(false);
  };

  if (isLoadingConfig) {
    return (
      <SettingsCard
        icon={ScrollText}
        title="日志数据治理"
        description="配置日志保留周期、级别和历史数据清理。"
        tone="amber"
      >
        <div className="flex items-center justify-center py-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      icon={ScrollText}
      title="日志数据治理"
      description="配置日志保留周期、级别和历史数据清理。"
      tone="amber"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void loadLogGovernance()}
          disabled={isLoadingLogGovernance}
        >
          {isLoadingLogGovernance ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          刷新统计
        </Button>
      }
    >
      <div className="flex flex-col">
        <section className="flex flex-col gap-4 pb-5">
          <div>
            <h3 className="text-sm font-semibold text-foreground">保留与展示</h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">统一控制日志保存范围和日志页默认展示内容。</p>
          </div>
          <div className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="settings-log-retention-days">
                日志保留天数
              </FieldLabel>
              <LogRetentionInput
                value={config?.log_retention_days || ""}
                onChange={setLogRetentionDays}
              />
              <FieldDescription>
                按保留策略清理时会保留最近 N 天日志，删除更早的历史日志。
              </FieldDescription>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="settings-default-log-view">
                默认日志视图
              </FieldLabel>
              <Select value={defaultLogView} onValueChange={(value) => setDefaultLogView(value as LogView)}>
                <SelectTrigger id="settings-default-log-view" className={settingsInputClassName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_VIEW_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {LOG_VIEW_OPTIONS.find((option) => option.value === defaultLogView)?.description}
              </FieldDescription>
            </Field>
          </div>
          <div className="flex flex-col gap-3 border-y border-border/70 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Clock3 className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">每天自动清理</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">按上方保留天数删除过期日志</p>
              </div>
            </div>
            <div className="flex items-center gap-3 sm:justify-end">
              <Switch
                checked={scheduleEnabled}
                aria-label="启用日志定时清理"
                onCheckedChange={setLogCleanupScheduleEnabled}
              />
              <span className="text-xs text-muted-foreground">执行于</span>
              <Select
                value={String(cleanupHour)}
                onValueChange={(value) => setLogCleanupHour(Number(value))}
                disabled={!scheduleEnabled}
              >
                <SelectTrigger id="settings-log-cleanup-hour" className="h-9 w-28 bg-background" aria-label="日志清理执行时间">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_CLEANUP_HOURS.map((hour) => (
                    <SelectItem key={hour} value={String(hour)}>
                      {String(hour).padStart(2, "0")}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <InlineHint>
            {scheduleEnabled
              ? `保存后每天 ${String(cleanupHour).padStart(2, "0")}:00 执行，使用服务器本地时间。`
              : "定时清理默认关闭，可继续使用下方的手动清理。"}
          </InlineHint>
        </section>

        <section className="flex flex-col gap-3 border-t border-border/70 py-5">
          <div>
            <h3 className="text-sm font-semibold text-foreground">记录级别</h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">选择需要写入控制台和业务日志的级别。</p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-y border-border/70 py-2 sm:grid-cols-4">
            {LOG_LEVEL_OPTIONS.map((level) => (
              <LogLevelOption
                key={level}
                checked={Boolean(config?.log_levels?.includes(level))}
                onCheckedChange={(checked) => setLogLevel(level, checked)}
                label={level.charAt(0).toUpperCase() + level.slice(1)}
              />
            ))}
          </div>
          <InlineHint>不选择时默认记录 Info、Warning 和 Error；Debug 会明显增加日志量。</InlineHint>
        </section>

        <section className="flex flex-col gap-3 border-t border-border/70 pt-5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 className="truncate text-sm leading-6 font-semibold text-foreground">
              数据概览
            </h3>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => setCleanupDialogOpen(true)}
              disabled={isCleaningLogs || total === 0}
            >
              {isCleaningLogs ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <Trash2 data-icon="inline-start" />
              )}
              按策略清理
            </Button>
          </div>
          {isLoadingLogGovernance ? (
            <div className="flex items-center justify-center border-y border-border/70 py-8">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid gap-3 border-y border-border/70 py-3 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-border/70">
              <LogMetric label="日志总量" value={String(total)} />
              <LogMetric
                label="最早日志"
                value={formatLogTime(logGovernance?.oldest_time)}
              />
              <LogMetric
                label="最新日志"
                value={formatLogTime(logGovernance?.latest_time)}
              />
            </div>
          )}
          {lastLogCleanup ? (
            <InlineHint>上次清理删除 {lastLogCleanup.deleted} 条，保留自 {lastLogCleanup.cutoff_date} 起的最近日志。</InlineHint>
          ) : null}
        </section>
      </div>

      <Dialog open={cleanupDialogOpen} onOpenChange={setCleanupDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理历史日志</DialogTitle>
            <DialogDescription>
              将删除保留窗口以前的日志记录，此操作不会删除图片文件或账号数据。
            </DialogDescription>
          </DialogHeader>
          <div className={settingsPanelClassName}>
            当前保留策略为最近 {retentionDays} 天。确认后会清理更早的历史日志。
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
              disabled={isCleaningLogs}
            >
              {isCleaningLogs ? (
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
