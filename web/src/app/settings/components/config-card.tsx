"use client";

import type { ReactNode } from "react";
import {
  CircleHelp,
  LoaderCircle,
  PlugZap,
  Save,
  Settings2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { testProxy, type ProxyTestResult } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SettingsCard, settingsInputClassName } from "./settings-ui";

const configSectionClassName = "flex flex-col gap-3 border-t border-border/60 pt-5 first:border-t-0 first:pt-0";
const configFieldClassName = "min-w-0 gap-1.5";
const configGridClassName = "grid gap-x-4 gap-y-3 sm:grid-cols-2";

function ConfigTip({ content }: { content: string }) {
  return (
    <span
      aria-label={content}
      title={content}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <CircleHelp className="size-4" />
    </span>
  );
}

function SectionHeading({
  action,
  tip,
  title,
}: {
  action?: ReactNode;
  tip: string;
  title: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <h3 className="truncate text-sm leading-6 font-semibold text-foreground">
          {title}
        </h3>
        <ConfigTip content={tip} />
      </div>
      {action ? (
        <div className="flex w-full shrink-0 sm:w-auto sm:justify-end">
          {action}
        </div>
      ) : null}
    </div>
  );
}

function ConfigFieldLabel({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <FieldLabel htmlFor={htmlFor} className="leading-6">
      {children}
    </FieldLabel>
  );
}

function NumberInputWithUnit({
  id,
  max,
  min,
  onChange,
  placeholder,
  unit,
  value,
}: {
  id: string;
  max?: number;
  min?: number;
  onChange: (value: string) => void;
  placeholder: string;
  unit: string;
  value: number | string;
}) {
  return (
    <div className="relative min-w-0">
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={1}
        inputMode="numeric"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(settingsInputClassName, "pr-12")}
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs font-medium text-muted-foreground">
        {unit}
      </span>
    </div>
  );
}

function modelListInputValue(value: unknown) {
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function tokenGroupOptions(config: { newapi_token_group?: string; newapi_token_groups?: string[] } | null) {
  const current = String(config?.newapi_token_group || "codex").trim() || "codex";
  return Array.from(
    new Set(
      [current, ...(Array.isArray(config?.newapi_token_groups) ? config.newapi_token_groups : [])]
        .map((group) => String(group || "").trim())
        .filter(Boolean),
    ),
  );
}

export function ConfigCard() {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] =
    useState<ProxyTestResult | null>(null);
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setImageTaskTimeoutSeconds = useSettingsStore(
    (state) => state.setImageTaskTimeoutSeconds,
  );
  const setImageStreamParameterEnabled = useSettingsStore((state) => state.setImageStreamParameterEnabled);
  const setImageModels = useSettingsStore((state) => state.setImageModels);
  const setChatModels = useSettingsStore((state) => state.setChatModels);
  const setUserDefaultConcurrentLimit = useSettingsStore(
    (state) => state.setUserDefaultConcurrentLimit,
  );
  const setUserDefaultRpmLimit = useSettingsStore(
    (state) => state.setUserDefaultRpmLimit,
  );
  const setImageRetentionDays = useSettingsStore(
    (state) => state.setImageRetentionDays,
  );
  const setImageStorageLimitMb = useSettingsStore(
    (state) => state.setImageStorageLimitMb,
  );
  const setProxy = useSettingsStore((state) => state.setProxy);
  const setRelayBaseUrl = useSettingsStore((state) => state.setRelayBaseUrl);
  const setNewAPITokenGroup = useSettingsStore((state) => state.setNewAPITokenGroup);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const newAPITokenGroup = String(config?.newapi_token_group || "codex").trim() || "codex";
  const newAPITokenGroupOptions = tokenGroupOptions(config);

  const handleTestProxy = async () => {
    const candidate = String(config?.proxy || "").trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      const data = await testProxy(candidate);
      setProxyTestResult(data.result);
      if (data.result.ok) {
        toast.success(
          `代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`,
        );
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  if (isLoadingConfig) {
    return (
      <SettingsCard
        icon={Settings2}
        title="参数配置"
        description="配置云棉接入、图片任务和模型下发。"
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
      title="参数配置"
      description="配置云棉接入、图片任务和模型下发。"
      action={
        <Button
          size="lg"
          onClick={() => void saveConfig()}
          disabled={isSavingConfig}
        >
          {isSavingConfig ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          保存
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <section className={configSectionClassName}>
          <SectionHeading
            title="基础参数"
            tip="配置云棉接入、图片任务超时和本地图片治理。"
          />
          <div className={configGridClassName}>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-image-retention-days">
                图片自动清理
              </ConfigFieldLabel>
              <NumberInputWithUnit
                id="settings-image-retention-days"
                min={1}
                value={config?.image_retention_days || ""}
                onChange={setImageRetentionDays}
                placeholder="30"
                unit="天"
              />
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-image-storage-limit-mb">
                图片容量上限
              </ConfigFieldLabel>
              <NumberInputWithUnit
                id="settings-image-storage-limit-mb"
                min={0}
                value={config?.image_storage_limit_mb ?? ""}
                onChange={setImageStorageLimitMb}
                placeholder="0"
                unit="MB"
              />
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-image-task-timeout-seconds">
                任务超时时间
              </ConfigFieldLabel>
              <NumberInputWithUnit
                id="settings-image-task-timeout-seconds"
                min={30}
                max={3600}
                value={config?.image_task_timeout_seconds || ""}
                onChange={setImageTaskTimeoutSeconds}
                placeholder="300"
                unit="秒"
              />
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-relay-base-url">
                RelayAI Base URL
              </ConfigFieldLabel>
              <Input
                id="settings-relay-base-url"
                value={String(config?.relay_base_url || "")}
                onChange={(event) => setRelayBaseUrl(event.target.value)}
                placeholder="http://newapi:3000"
                className={settingsInputClassName}
              />
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-newapi-token-group">
                云棉默认令牌分组
              </ConfigFieldLabel>
              <Select value={newAPITokenGroup} onValueChange={setNewAPITokenGroup}>
                <SelectTrigger id="settings-newapi-token-group" className={settingsInputClassName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {newAPITokenGroupOptions.map((group) => (
                    <SelectItem key={group} value={group}>
                      {group}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field className="min-w-0 gap-2 rounded-xl bg-muted/35 px-3 py-3 sm:col-span-2">
              <label
                htmlFor="settings-image-stream-parameter-enabled"
                className="flex min-w-0 cursor-pointer items-start gap-3"
              >
                <Checkbox
                  id="settings-image-stream-parameter-enabled"
                  className="mt-0.5"
                  checked={Boolean(config?.image_stream_parameter_enabled)}
                  onCheckedChange={(checked) => setImageStreamParameterEnabled(checked === true)}
                />
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    图片流式参数
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium",
                        config?.image_stream_parameter_enabled
                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
                          : "bg-background text-muted-foreground ring-1 ring-border",
                      )}
                    >
                      {config?.image_stream_parameter_enabled ? "已开启" : "默认关闭"}
                    </span>
                  </span>
                  <span className="text-xs leading-5 text-muted-foreground">
                    开启后图片生成/编辑会向 RelayAI 下发 <code className="font-mono">stream=true</code>，默认关闭。
                  </span>
                </span>
              </label>
            </Field>
          </div>
        </section>

        <section className={configSectionClassName}>
          <SectionHeading
            title="模型配置"
            tip="用英文逗号分隔；第一项作为默认模型。"
          />
          <div className={configGridClassName}>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-image-models">
                图片模型
              </ConfigFieldLabel>
              <Input
                id="settings-image-models"
                value={modelListInputValue(config?.image_models)}
                onChange={(event) => setImageModels(event.target.value)}
                placeholder="gpt-image-2"
                className={settingsInputClassName}
              />
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-chat-models">
                对话模型
              </ConfigFieldLabel>
              <Input
                id="settings-chat-models"
                value={modelListInputValue(config?.chat_models)}
                onChange={(event) => setChatModels(event.target.value)}
                placeholder="gpt-5.5, gpt-5.4"
                className={settingsInputClassName}
              />
            </Field>
          </div>
        </section>

        <section className={configSectionClassName}>
          <SectionHeading
            title="用户默认限制"
            tip="限制普通用户创作并发额度和速率；图片生成/编辑按请求张数计入，聊天任务按 1 个计入；管理员不受影响；0 表示不限制。"
          />
          <div className={configGridClassName}>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-user-default-concurrent-limit">
                创作并发额度
              </ConfigFieldLabel>
              <NumberInputWithUnit
                id="settings-user-default-concurrent-limit"
                min={0}
                value={config?.user_default_concurrent_limit ?? ""}
                onChange={setUserDefaultConcurrentLimit}
                placeholder="0"
                unit="个"
              />
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-user-default-rpm-limit">
                用户默认每分钟请求数
              </ConfigFieldLabel>
              <NumberInputWithUnit
                id="settings-user-default-rpm-limit"
                min={0}
                value={config?.user_default_rpm_limit ?? ""}
                onChange={setUserDefaultRpmLimit}
                placeholder="0"
                unit="次/分"
              />
            </Field>
          </div>
        </section>

        <section className={configSectionClassName}>
          <SectionHeading
            title="出站代理"
            tip="留空表示不使用代理。"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => void handleTestProxy()}
                disabled={isTestingProxy}
              >
                {isTestingProxy ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : (
                  <PlugZap data-icon="inline-start" />
                )}
                测试代理
              </Button>
            }
          />
          <Field className="gap-1.5">
            <ConfigFieldLabel htmlFor="settings-proxy">
              全局代理
            </ConfigFieldLabel>
            <Input
              id="settings-proxy"
              value={String(config?.proxy || "")}
              onChange={(event) => {
                setProxy(event.target.value);
                setProxyTestResult(null);
              }}
              placeholder="http://127.0.0.1:7890"
              className={settingsInputClassName}
            />
            {proxyTestResult ? (
              <div
                className={cn(
                  "rounded-[13px] border px-3 py-2 text-xs leading-5",
                  proxyTestResult.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-rose-200 bg-rose-50 text-rose-800",
                )}
              >
                {proxyTestResult.ok
                  ? `代理可用：HTTP ${proxyTestResult.status}，用时 ${proxyTestResult.latency_ms} ms`
                  : `代理不可用：${proxyTestResult.error ?? "未知错误"}（用时 ${proxyTestResult.latency_ms} ms）`}
              </div>
            ) : null}
          </Field>
        </section>

      </div>
    </SettingsCard>
  );
}
