import { CircleHelp, Clock3, Cloud, Gauge, HardDrive, LoaderCircle, Plus, Save, Server, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";
import { measureAdminStorageProvider, type StorageProviderConfig, type StorageSettingConfig } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SettingsCard, settingsInputClassName } from "./settings-ui";

const DEFAULT_LIMIT = 9 * 1024 ** 3;

function newProvider(type: "s3" | "webdav", index: number): StorageProviderConfig {
  return {
    id: `storage-${Date.now().toString(36)}-${index}`,
    name: type === "webdav" ? "WebDAV 网络存储" : "S3 / R2 对象存储",
    type,
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    publicBaseUrl: "",
    pathPrefix: "assets",
    username: "",
    password: "",
    weight: 1,
    enabled: false,
    ownerUserId: "",
    capacityBytes: 0,
    capacityCheckedAt: "",
    capacityExceeded: false,
  };
}

function defaultSetting(): StorageSettingConfig {
  return {
    mode: "server_local",
    allowUserProvider: false,
    allowUserGlobalProvider: true,
    providers: [],
    capacityCheck: { enabled: false, cron: "0 */6 * * *" },
    capacityLimitBytes: DEFAULT_LIMIT,
    localCapacityLimitBytes: 0,
  };
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.max(0, bytes)} B`;
}

function StorageField({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={cn("min-w-0 space-y-1.5", className)}>
      <span className="flex min-h-4 items-center gap-1.5 text-xs font-medium text-foreground">
        <span>{label}</span>
        {hint ? <TooltipHint content={hint}><span tabIndex={0} role="img" aria-label={`${label}说明`} className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><CircleHelp className="size-3.5" aria-hidden="true" /></span></TooltipHint> : null}
      </span>
      {children}
    </label>
  );
}

function StorageMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <p className="text-xs leading-5 text-muted-foreground">{label}</p>
      <div className="mt-0.5 min-w-0 text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

function StorageToggle({ title, description, checked, onCheckedChange }: { title: string; description: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-16 cursor-pointer items-center justify-between gap-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

function GigabyteInput({ value, min = 0, onChange }: { value: number; min?: number; onChange: (value: number) => void }) {
  return (
    <NumberInput className={`${settingsInputClassName} max-w-56`} min={min} step={0.01} value={value} onValueChange={(nextValue) => onChange(Number(nextValue || 0))} controlsLayout="split" suffix="GB" />
  );
}

function providerTypeLabel(type: StorageProviderConfig["type"]) {
  return type === "webdav" ? "WebDAV 网络存储" : "S3 / R2 对象存储";
}

export function StorageProvidersCard() {
  const config = useSettingsStore((state) => state.config);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const setStorage = useSettingsStore((state) => state.setStorage);
  const isSaving = useSettingsStore((state) => state.isSavingConfig);
  const [measuringIndex, setMeasuringIndex] = useState<number | null>(null);
  const [localUsage, setLocalUsage] = useState<{ bytes: number; limitBytes: number; overLimit: boolean; checkedAt: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"local" | "providers">("local");
  const setting = config?.storage || defaultSetting();
  const enabledProviderCount = setting.providers.filter((provider) => provider.enabled).length;

  const updateSetting = (patch: Partial<StorageSettingConfig>) => setStorage({ ...setting, ...patch });
  const patchProvider = (index: number, patch: Partial<StorageProviderConfig>) => {
    const providers = setting.providers.map((provider, providerIndex) => providerIndex === index ? { ...provider, ...patch } : provider);
    if (patch.enabled === true) {
      const enabledType = providers[index].type;
      providers.forEach((provider, providerIndex) => {
        if (providerIndex !== index && provider.type !== enabledType) provider.enabled = false;
      });
    }
    updateSetting({ providers });
  };

  const measure = async (index: number) => {
    setMeasuringIndex(index);
    try {
      const response = await measureAdminStorageProvider(index, index >= 0 ? setting.providers[index] : undefined);
      if (index === -1) {
        setLocalUsage({ bytes: response.result.bytes, limitBytes: response.result.limitBytes, overLimit: response.result.overLimit, checkedAt: response.result.checkedAt });
      } else {
        patchProvider(index, {
          capacityBytes: response.result.bytes,
          capacityCheckedAt: response.result.checkedAt,
          capacityExceeded: response.result.overLimit,
          enabled: response.result.overLimit ? false : setting.providers[index].enabled,
        });
      }
      toast.success("容量统计已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "容量统计失败");
    } finally {
      setMeasuringIndex(null);
    }
  };

  return (
    <SettingsCard
      icon={Cloud}
      title="素材存储"
      description="仅管理图片、视频、音频等素材文件；画布文档、设置和业务数据不在此范围内。"
      tone="slate"
      action={<Button type="button" onClick={() => void saveConfig()} disabled={isSaving}>{isSaving ? <LoaderCircle className="animate-spin" /> : <Save />}保存</Button>}
    >
      <div>
        <div className="overflow-x-auto border-b border-border/70 pb-4">
          <div role="tablist" aria-label="素材存储设置" className="inline-flex min-w-max gap-1 rounded-lg bg-muted p-1">
            {([
              { id: "local", label: "基础设置", icon: HardDrive },
              { id: "providers", label: `外部存储${setting.providers.length ? ` (${setting.providers.length})` : ""}`, icon: Cloud },
            ] as const).map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return <button key={tab.id} type="button" role="tab" aria-selected={active} aria-controls={`storage-panel-${tab.id}`} onClick={() => setActiveTab(tab.id)} className={cn("flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors sm:px-4", active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon className="size-4" />{tab.label}</button>;
            })}
          </div>
        </div>

        {activeTab === "local" ? <section id="storage-panel-local" role="tabpanel" className="max-w-6xl space-y-6 pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-base font-semibold text-foreground">服务器本机</h3><p className="mt-1 text-sm text-muted-foreground">默认回退存储，素材保存在服务器目录并可跨设备访问。</p></div>
            <Button type="button" variant="outline" size="sm" onClick={() => void measure(-1)} disabled={measuringIndex !== null}>{measuringIndex === -1 ? <LoaderCircle className="animate-spin" /> : <Gauge />}统计容量</Button>
          </div>
          <div className="grid gap-3 border-y border-border/70 py-3 sm:grid-cols-3 sm:gap-0 sm:divide-x">
            <StorageMetric label="状态"><span className="inline-flex items-center gap-2">可用 <Badge variant="secondary">默认回退</Badge></span></StorageMetric>
            <StorageMetric label="素材占用">{localUsage ? formatBytes(localUsage.bytes) : "尚未统计"}</StorageMetric>
            <StorageMetric label="存储位置"><code className="break-all font-mono text-xs font-medium">data/storage_files</code></StorageMetric>
          </div>
          <div className="grid items-start gap-8 xl:grid-cols-[minmax(260px,360px)_minmax(420px,1fr)]">
            <div className="space-y-3">
              <div><h4 className="text-sm font-semibold text-foreground">本机容量限制</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">只限制图片、视频和音频等素材文件。</p></div>
              <StorageField label="容量上限" hint="0 表示不限制；达到上限后拒绝新上传，不删除已有文件。">
                <GigabyteInput value={setting.localCapacityLimitBytes > 0 ? Number((setting.localCapacityLimitBytes / 1024 ** 3).toFixed(2)) : 0} onChange={(value) => updateSetting({ localCapacityLimitBytes: Math.max(0, value * 1024 ** 3) })} />
              </StorageField>
              <p className="text-xs leading-5 text-muted-foreground">生成图库的原图和缩略图由“媒体治理”单独统计。</p>
            </div>
            <div className="space-y-3">
              <div><h4 className="text-sm font-semibold text-foreground">用户存储权限</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">控制普通用户可以使用哪些外部存储。</p></div>
              <div className="divide-y border-y border-border/70">
                <StorageToggle title="允许个人外部存储" description="用户可配置自己的 S3、R2 或 WebDAV" checked={setting.allowUserProvider} onCheckedChange={(checked) => updateSetting({ allowUserProvider: checked })} />
                <StorageToggle title="允许使用全局外部存储" description="关闭后普通用户使用服务器本机存储" checked={setting.allowUserGlobalProvider} onCheckedChange={(checked) => updateSetting({ allowUserGlobalProvider: checked })} />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">优先级：个人配置、全局配置、服务器本机。</p>
            </div>
          </div>
        </section> : null}

        {activeTab === "providers" ? <section id="storage-panel-providers" role="tabpanel" className="space-y-5 pt-5">
          <div data-storage-provider-toolbar className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0"><h3 className="text-base font-semibold text-foreground">全局外部存储</h3><p className="mt-1 text-sm leading-5 text-muted-foreground">统一配置 S3、R2 与 WebDAV；素材写入失败时自动回退到服务器本机。</p></div>
            <div className="flex shrink-0 flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => updateSetting({ providers: [...setting.providers, newProvider("s3", setting.providers.length)] })}><Plus />S3 / R2</Button><Button type="button" variant="outline" size="sm" onClick={() => updateSetting({ providers: [...setting.providers, newProvider("webdav", setting.providers.length)] })}><Plus />WebDAV</Button></div>
          </div>

          <div data-storage-provider-overview className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border/70 py-3 lg:grid-cols-4 lg:gap-0 lg:divide-x lg:divide-border/70">
            <StorageMetric label="已配置">{setting.providers.length} 个</StorageMetric>
            <StorageMetric label="已启用">{enabledProviderCount} 个</StorageMetric>
            <StorageMetric label="容量上限">{formatBytes(setting.capacityLimitBytes)}</StorageMetric>
            <StorageMetric label="自动统计">{setting.capacityCheck.enabled ? "已开启" : "已关闭"}</StorageMetric>
          </div>

          <div data-storage-provider-policy className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
            <section className="rounded-lg border border-border/70 bg-muted/20 p-4">
              <div className="flex min-h-10 items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border/70"><Clock3 className="size-4" /></span>
                  <div className="min-w-0"><h4 className="text-sm font-semibold text-foreground">自动统计容量</h4><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{setting.capacityCheck.enabled ? "按 Cron 计划定期检查所有外部存储" : "关闭时仍可在单个配置中手动统计"}</p></div>
                </div>
                <Switch aria-label="自动统计容量" checked={setting.capacityCheck.enabled} onCheckedChange={(checked) => updateSetting({ capacityCheck: { ...setting.capacityCheck, enabled: checked } })} />
              </div>
              {setting.capacityCheck.enabled ? <StorageField className="mt-4 max-w-lg border-t border-border/70 pt-4" label="检查计划（Cron）" hint="默认每 6 小时检查一次。"><Input className={settingsInputClassName} value={setting.capacityCheck.cron} onChange={(event) => updateSetting({ capacityCheck: { ...setting.capacityCheck, cron: event.target.value } })} placeholder="0 */6 * * *" /></StorageField> : null}
            </section>

            <section className="rounded-lg border border-border/70 bg-muted/20 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border/70"><Gauge className="size-4" /></span>
                <div className="min-w-0"><h4 className="text-sm font-semibold text-foreground">容量保护</h4><p className="mt-0.5 text-xs leading-5 text-muted-foreground">统计结果达到上限后自动停用对应存储</p></div>
              </div>
              <StorageField className="mt-4 border-t border-border/70 pt-4" label="每个外部存储的容量上限" hint="该上限应用于每个外部存储，不是所有存储的合计容量。">
                <GigabyteInput min={0.01} value={Number((setting.capacityLimitBytes / 1024 ** 3).toFixed(2))} onChange={(value) => updateSetting({ capacityLimitBytes: Math.max(1, value * 1024 ** 3) })} />
              </StorageField>
            </section>
          </div>

          {setting.providers.length === 0 ? <div data-storage-provider-empty className="flex min-h-36 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/10 px-6 py-6 text-center"><span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Server className="size-5" /></span><p className="mt-3 text-sm font-medium text-foreground">还没有外部存储</p><p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">当前素材保存在服务器本机。可从右上角添加 S3、R2 或 WebDAV。</p></div> : null}
          {setting.providers.map((provider, index) => (
            <div key={provider.id} className="space-y-4 rounded-lg border border-border/70 bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="text-sm font-semibold">{provider.name || providerTypeLabel(provider.type)}</p><p className="text-xs text-muted-foreground">{providerTypeLabel(provider.type)} · {formatBytes(provider.capacityBytes)}{provider.capacityCheckedAt ? ` · ${new Date(provider.capacityCheckedAt).toLocaleString("zh-CN")}` : ""}</p></div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground"><span>启用</span><Switch checked={provider.enabled} onCheckedChange={(checked) => patchProvider(index, { enabled: checked })} /></label>
                  <Button type="button" variant="outline" size="icon" title="统计容量" onClick={() => void measure(index)} disabled={measuringIndex !== null}>{measuringIndex === index ? <LoaderCircle className="animate-spin" /> : <Gauge />}</Button>
                  <Button type="button" variant="ghost" size="icon" title="删除外部存储" onClick={() => updateSetting({ providers: setting.providers.filter((_, providerIndex) => providerIndex !== index) })}><Trash2 /></Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
                <StorageField label="配置名称"><Input className={settingsInputClassName} value={provider.name} onChange={(event) => patchProvider(index, { name: event.target.value })} placeholder={providerTypeLabel(provider.type)} /></StorageField>
                <StorageField label={provider.type === "webdav" ? "WebDAV 服务器地址" : "S3 / R2 服务地址"}><Input className={settingsInputClassName} value={provider.endpoint} onChange={(event) => patchProvider(index, { endpoint: event.target.value })} placeholder={provider.type === "webdav" ? "https://dav.example.com" : "https://account.r2.cloudflarestorage.com"} /></StorageField>
                {provider.type === "s3" ? <>
                  <StorageField label="存储桶名称"><Input className={settingsInputClassName} value={provider.bucket} onChange={(event) => patchProvider(index, { bucket: event.target.value })} placeholder="media-assets" /></StorageField>
                  <StorageField label="区域"><Input className={settingsInputClassName} value={provider.region} onChange={(event) => patchProvider(index, { region: event.target.value })} placeholder="auto" /></StorageField>
                  <StorageField label="素材目录前缀"><Input className={settingsInputClassName} value={provider.pathPrefix} onChange={(event) => patchProvider(index, { pathPrefix: event.target.value })} placeholder="assets" /></StorageField>
                </> : <>
                  <StorageField label="用户名"><Input className={settingsInputClassName} value={provider.username} onChange={(event) => patchProvider(index, { username: event.target.value })} placeholder="WebDAV 用户名" autoComplete="off" /></StorageField>
                  <StorageField label="密码或应用密码" hint="编辑已有配置时留空表示保持原密码"><Input className={settingsInputClassName} type="password" value={provider.password} onChange={(event) => patchProvider(index, { password: event.target.value })} placeholder="WebDAV 密码" autoComplete="new-password" /></StorageField>
                  <StorageField label="素材目录前缀"><Input className={settingsInputClassName} value={provider.pathPrefix} onChange={(event) => patchProvider(index, { pathPrefix: event.target.value })} placeholder="assets" /></StorageField>
                </>}
                <StorageField label="分配权重" hint="同类型多个存储启用时，数值越大分配概率越高"><NumberInput className={settingsInputClassName} min={1} value={provider.weight} onValueChange={(nextValue) => patchProvider(index, { weight: Math.max(1, Number(nextValue) || 1) })} controlsLayout="split" /></StorageField>
                {provider.type === "s3" ? <>
                  <StorageField label="Access Key ID"><Input className={settingsInputClassName} value={provider.accessKeyId} onChange={(event) => patchProvider(index, { accessKeyId: event.target.value })} placeholder="访问密钥 ID" autoComplete="off" /></StorageField>
                  <StorageField label="Secret Access Key" hint="编辑已有配置时留空表示保持原密钥"><Input className={settingsInputClassName} type="password" value={provider.secretAccessKey} onChange={(event) => patchProvider(index, { secretAccessKey: event.target.value })} placeholder="访问密钥" autoComplete="new-password" /></StorageField>
                  <StorageField label="公开访问地址（可选）" hint="仅填写可匿名访问的桶域名或 CDN；私有桶请留空，由本站鉴权代理读取。"><Input className={settingsInputClassName} value={provider.publicBaseUrl} onChange={(event) => patchProvider(index, { publicBaseUrl: event.target.value })} placeholder="https://cdn.example.com" /></StorageField>
                </> : null}
              </div>
            </div>
          ))}
        </section> : null}
      </div>
    </SettingsCard>
  );
}
