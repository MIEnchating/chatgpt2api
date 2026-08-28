"use client";

import type { ReactNode } from "react";
import {
  LoaderCircle,
  PlugZap,
  Save,
  Settings2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { testProxy, type ProxyTestResult } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SiteIconSettings } from "./site-icon-card";
import { SettingsCard, settingsInputClassName } from "./settings-ui";

const configSectionClassName = "flex flex-col gap-4 rounded-lg border border-border/70 bg-muted/20 p-4 sm:p-5";
const configFieldClassName = "min-w-0 gap-1.5";
const configGridClassName = "grid gap-x-4 gap-y-3 sm:grid-cols-2 2xl:grid-cols-3";

function SectionHeading({
  action,
  title,
}: {
  action?: ReactNode;
  tip?: string;
  title: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <h3 className="truncate text-sm leading-6 font-semibold text-foreground">
          {title}
        </h3>
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
  tip?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <FieldLabel htmlFor={htmlFor} className="leading-6">{children}</FieldLabel>
    </div>
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
    <NumberInput
      id={id}
      min={min}
      max={max}
      step={1}
      inputMode="numeric"
      value={String(value)}
      onValueChange={onChange}
      placeholder={placeholder}
      controlsLayout="split"
      suffix={unit}
      className={settingsInputClassName}
    />
  );
}

export function ConfigCard({ isAdmin }: { isAdmin: boolean }) {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] =
    useState<ProxyTestResult | null>(null);
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const setImageTaskTimeoutSeconds = useSettingsStore(
    (state) => state.setImageTaskTimeoutSeconds,
  );
  const setAppTitle = useSettingsStore((state) => state.setAppTitle);
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
  const setBaseUrl = useSettingsStore((state) => state.setBaseUrl);
  const setRelayBaseUrl = useSettingsStore((state) => state.setRelayBaseUrl);
  const setRelayDatabaseType = useSettingsStore((state) => state.setRelayDatabaseType);
  const setRelayDatabaseDriver = useSettingsStore((state) => state.setRelayDatabaseDriver);
  const setRelayDatabaseField = useSettingsStore((state) => state.setRelayDatabaseField);
  const databaseDriver = config?.relay_database_driver === "sqlite" ? "sqlite" : config?.relay_database_driver === "mysql" ? "mysql" : "postgres";

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
        description="配置站点接入、异步创作任务和媒体治理参数。"
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
      description="分组管理站点信息、运行限制、数据库和网络连接。"
      action={
        <Button type="button" size="sm" onClick={() => void saveConfig()} disabled={isSavingConfig}>
          {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存参数配置
        </Button>
      }
      contentClassName="pt-0 sm:pt-0"
    >
      <div className="grid gap-4">
        <section className={configSectionClassName}>
          <SectionHeading title="品牌信息" tip="网站名称和图标会用于浏览器标题、导航栏和登录页面。" />
          <div className={cn("grid min-w-0 gap-5", isAdmin && "md:grid-cols-2")}>
            <Field className="min-w-0 content-start gap-1.5">
              <ConfigFieldLabel htmlFor="settings-app-title" tip="修改后会同步更新网站标题和项目名称。">
                网站名称
              </ConfigFieldLabel>
              <Input
                id="settings-app-title"
                value={String(config?.app_title || "")}
                onChange={(event) => setAppTitle(event.target.value)}
                placeholder="云棉"
                className={settingsInputClassName}
              />
              <p className="text-xs leading-5 text-muted-foreground">保存参数配置后更新浏览器标题和站内名称</p>
            </Field>
            {isAdmin ? <SiteIconSettings /> : null}
          </div>
        </section>

        <section className={configSectionClassName}>
          <SectionHeading title="运行与存储" tip="配置创作任务超时、生成图库图片保留策略和对外访问地址。" />
          <div className={configGridClassName}>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-image-retention-days" tip="超过该天数的生成图库图片可由治理任务自动清理。">
                生成图库自动清理
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
              <ConfigFieldLabel htmlFor="settings-image-storage-limit-mb" tip="只限制生成图库、缩略图和参考附件；设置为 0 表示不限制。素材容量请在存储配置中设置。">
                生成图库容量上限
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
              <ConfigFieldLabel htmlFor="settings-image-task-timeout-seconds" tip="图片和视频异步任务超过该时间后会被判定为超时。">
                创作任务超时
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
              <ConfigFieldLabel htmlFor="settings-base-url" tip="仅覆盖服务器本机图片、缩略图和参考文件的公开地址；留空使用当前站点。外部存储使用各 Provider 自己的公开访问地址。">
                本机文件访问地址（可选）
              </ConfigFieldLabel>
              <Input
                id="settings-base-url"
                type="url"
                value={String(config?.base_url || "")}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="留空使用当前站点"
                className={settingsInputClassName}
              />
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-relay-base-url" tip="NewAPI 或 Sub2API 的 HTTP API 地址。">
                API 访问地址
              </ConfigFieldLabel>
              <Input
                id="settings-relay-base-url"
                value={String(config?.relay_base_url || "")}
                onChange={(event) => setRelayBaseUrl(event.target.value)}
                placeholder="http://newapi:3000"
                className={settingsInputClassName}
              />
            </Field>
          </div>
        </section>

        <section className={configSectionClassName}>
          <SectionHeading
            title="用户默认限制"
            tip="限制普通用户创作并发额度和提交速率；管理员不受限制。"
          />
          <div className={configGridClassName}>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-user-default-concurrent-limit" tip="普通用户同时运行的创作任务额度，0 表示不限制。">
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
              <ConfigFieldLabel htmlFor="settings-user-default-rpm-limit" tip="普通用户每分钟可提交的任务数，0 表示不限制。">
                每分钟请求数
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
            title="网络与代理"
            tip="配置服务端访问上游 API 时使用的出站代理；留空表示直连。"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => void handleTestProxy()}
                disabled={isTestingProxy}
              >
                {isTestingProxy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <PlugZap data-icon="inline-start" />}
                测试代理
              </Button>
            }
          />
          <Field className="gap-1.5">
            <ConfigFieldLabel htmlFor="settings-proxy" tip="支持 HTTP、HTTPS 和 SOCKS 代理地址。">
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
              <div className={cn("rounded-lg border px-3 py-2 text-xs leading-5", proxyTestResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800")}>
                {proxyTestResult.ok
                  ? `代理可用：HTTP ${proxyTestResult.status}，用时 ${proxyTestResult.latency_ms} ms`
                  : `代理不可用：${proxyTestResult.error ?? "未知错误"}（用时 ${proxyTestResult.latency_ms} ms）`}
              </div>
            ) : null}
          </Field>
        </section>

        {isAdmin ? <section id="database-connection" className={configSectionClassName}>
          <SectionHeading
            title="数据库连接"
            tip="用于读取 NewAPI 或 Sub2API 的用户余额、令牌和模型访问 Key；保存后立即生效。"
          />
          <div className={configGridClassName}>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-relay-database-type" tip="选择要读取账号、余额和令牌的数据源结构。">数据源</ConfigFieldLabel>
              <Select
                value={config?.relay_database_type === "sub2api" ? "sub2api" : "newapi"}
                onValueChange={(value: "newapi" | "sub2api") => setRelayDatabaseType(value)}
              >
                <SelectTrigger id="settings-relay-database-type" className={settingsInputClassName}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="newapi">NewAPI</SelectItem>
                  <SelectItem value="sub2api">Sub2API</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field className={configFieldClassName}>
              <ConfigFieldLabel htmlFor="settings-relay-database-driver" tip="SQLite 读取本地文件；PostgreSQL 和 MySQL 使用网络连接。">数据库引擎</ConfigFieldLabel>
              <Select value={databaseDriver} onValueChange={(value: "sqlite" | "postgres" | "mysql") => setRelayDatabaseDriver(value)}>
                <SelectTrigger id="settings-relay-database-driver" className={settingsInputClassName}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sqlite">SQLite</SelectItem>
                  <SelectItem value="postgres">PostgreSQL</SelectItem>
                  <SelectItem value="mysql">MySQL</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {databaseDriver === "sqlite" ? <Field className="sm:col-span-2">
              <ConfigFieldLabel htmlFor="settings-relay-database-name" tip="填写服务器上的 SQLite 数据库文件绝对路径。">数据库文件</ConfigFieldLabel>
              <Input id="settings-relay-database-name" value={String(config?.relay_database_name || "")} onChange={(event) => setRelayDatabaseField("name", event.target.value)} placeholder="/app/data/newapi.db" className={settingsInputClassName} />
            </Field> : <>
              <Field className={configFieldClassName}>
                <ConfigFieldLabel htmlFor="settings-relay-database-host" tip="数据库服务器的域名或 IP 地址。">主机</ConfigFieldLabel>
                <Input id="settings-relay-database-host" value={String(config?.relay_database_host || "")} onChange={(event) => setRelayDatabaseField("host", event.target.value)} placeholder="127.0.0.1" className={settingsInputClassName} />
              </Field>
              <Field className={configFieldClassName}>
                <ConfigFieldLabel htmlFor="settings-relay-database-port" tip="留空时 PostgreSQL 使用 5432，MySQL 使用 3306。">端口</ConfigFieldLabel>
                <NumberInput id="settings-relay-database-port" min={1} max={65535} step={1} inputMode="numeric" value={String(config?.relay_database_port || "")} onValueChange={(value) => setRelayDatabaseField("port", value)} placeholder={databaseDriver === "mysql" ? "3306" : "5432"} controlsLayout="split" className={settingsInputClassName} />
              </Field>
              <Field className={configFieldClassName}>
                <ConfigFieldLabel htmlFor="settings-relay-database-user" tip="用于只读访问数据源的数据库账号。">账号</ConfigFieldLabel>
                <Input id="settings-relay-database-user" value={String(config?.relay_database_user || "")} onChange={(event) => setRelayDatabaseField("user", event.target.value)} autoComplete="off" className={settingsInputClassName} />
              </Field>
              <Field className={configFieldClassName}>
                <ConfigFieldLabel htmlFor="settings-relay-database-password" tip="密码仅用于写入服务端，设置接口不会返回密码；留空表示保持现有密码。">密码</ConfigFieldLabel>
                <Input id="settings-relay-database-password" type="password" value={String(config?.relay_database_password || "")} onChange={(event) => setRelayDatabaseField("password", event.target.value)} placeholder={config?.relay_database_password_configured ? "已配置，留空表示不修改" : "请输入数据库密码"} autoComplete="new-password" className={settingsInputClassName} />
              </Field>
              <Field className="sm:col-span-2">
                <ConfigFieldLabel htmlFor="settings-relay-database-name" tip="NewAPI 或 Sub2API 使用的数据库名称。">数据库</ConfigFieldLabel>
                <Input id="settings-relay-database-name" value={String(config?.relay_database_name || "")} onChange={(event) => setRelayDatabaseField("name", event.target.value)} placeholder="newapi" className={settingsInputClassName} />
              </Field>
            </>}
          </div>
        </section> : null}

      </div>
    </SettingsCard>
  );
}
