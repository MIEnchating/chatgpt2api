import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { LabeledField as StorageField } from "@/components/labeled-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PasswordInput } from "@/components/password-input";
import { Cloud, Gauge, HardDrive, Plus, Save, Server, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";
import { measureAdminStorageProvider, type StorageProviderConfig, type StorageSettingConfig } from "@/lib/api";

import { useSettingsStore } from "../store";
import { SettingsPanel, SettingsSection } from "@/components/settings-panel";

const DEFAULT_LIMIT = 9 * 1024 ** 3;

function newProvider(type: "s3" | "webdav", index: number): StorageProviderConfig {
  return {
    id: `storage-${Date.now().toString(36)}-${index}`,
    name: type === "webdav" ? "WebDAV 网络存储" : "S3 / R2 对象存储",
    type,
    endpoint: "",
    region: "auto",
    bucket: "",
    bucketInHost: false,
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
    <Label className="flex min-h-16 cursor-pointer items-center justify-between gap-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </Label>
  );
}

function GigabyteInput({ id, value, min = 0, onChange }: { id?: string; value: number; min?: number; onChange: (value: number) => void }) {
  return (
    <NumberInput id={id} className="max-w-56" min={min} step={0.01} value={value} onValueChange={(nextValue) => onChange(Number(nextValue || 0))} controlsLayout="split" suffix="GB" />
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
        if (providerIndex !== index && provider.type !== enabledType) providers[providerIndex] = { ...provider, enabled: false };
      });
    }
    updateSetting({ providers });
  };

  const measure = async (index: number) => {
    const requestState = useSettingsStore.getState();
    const requestedProvider = index >= 0 ? setting.providers[index] : undefined;
    setMeasuringIndex(index);
    try {
      const response = await measureAdminStorageProvider(index, requestedProvider);
      const state = useSettingsStore.getState();
      if (state.activeSessionKey !== requestState.activeSessionKey || state.sessionGeneration !== requestState.sessionGeneration) return;
      if (index === -1) {
        setLocalUsage({ bytes: response.result.bytes, limitBytes: response.result.limitBytes, overLimit: response.result.overLimit, checkedAt: response.result.checkedAt });
      } else {
        const latest = state.config?.storage;
        if (!latest || !latest.providers.includes(requestedProvider!)) return;
        state.setStorage({
          ...latest,
          providers: latest.providers.map((provider) => provider === requestedProvider ? {
            ...provider,
            capacityBytes: response.result.bytes,
            capacityCheckedAt: response.result.checkedAt,
            capacityExceeded: response.result.overLimit,
            enabled: response.result.overLimit ? false : provider.enabled,
          } : provider),
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
    <SettingsPanel
      title="全局存储"
      description="仅管理图片、视频、音频等素材文件；画布文档、设置和业务数据不在此范围内。"
      action={<Button type="button" onClick={() => void saveConfig()} disabled={isSaving}>{isSaving ? <Spinner /> : <Save />}保存</Button>}
    >
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "local" | "providers")} className="block">
        <TabsList aria-label="素材存储设置" className="h-auto">
            {([
              { id: "local", label: "基础设置", icon: HardDrive },
              { id: "providers", label: `外部存储${setting.providers.length ? ` (${setting.providers.length})` : ""}`, icon: Cloud },
            ] as const).map((tab) => {
              const Icon = tab.icon;
              return <TabsTrigger value={tab.id}  key={tab.id}><Icon className="size-4" />{tab.label}</TabsTrigger>;
            })}
        </TabsList>

        {activeTab === "local" ? <TabsContent value="local" className="grid gap-8">
          <SettingsSection title="服务器本机" description="素材保存在服务器目录，可跨设备访问。" action={<Button type="button" variant="outline" size="sm" onClick={() => void measure(-1)} disabled={measuringIndex !== null}>{measuringIndex === -1 ? <Spinner /> : <Gauge />}统计容量</Button>}>
          <div className="grid gap-3 sm:grid-cols-3 sm:gap-0 sm:divide-x">
            <StorageMetric label="状态"><span className="inline-flex items-center gap-2">可用 <Badge variant="secondary">默认回退</Badge></span></StorageMetric>
            <StorageMetric label="素材占用">{localUsage ? formatBytes(localUsage.bytes) : "尚未统计"}</StorageMetric>
            <StorageMetric label="存储位置"><code className="break-all font-mono text-xs font-medium">data/storage_files</code></StorageMetric>
          </div>
          </SettingsSection>
          <SettingsSection title="本机容量限制" description="只限制图片、视频和音频等素材文件。">
              <StorageField label="容量上限" hint="0 表示不限制；达到上限后拒绝新上传，不删除已有文件。">{(fieldId) => <GigabyteInput id={fieldId} value={setting.localCapacityLimitBytes > 0 ? Number((setting.localCapacityLimitBytes / 1024 ** 3).toFixed(2)) : 0} onChange={(value) => updateSetting({ localCapacityLimitBytes: Math.max(0, value * 1024 ** 3) })} />}</StorageField>
              <p className="text-xs leading-5 text-muted-foreground">生成图库的原图和缩略图由“媒体治理”单独统计。</p>
          </SettingsSection>
          <SettingsSection title="用户存储权限" description="控制普通用户可以使用哪些外部存储。" contentClassName="gap-3">
              <div className="divide-y">
                <StorageToggle title="允许个人外部存储" description="用户可配置自己的 S3、R2 或 WebDAV" checked={setting.allowUserProvider} onCheckedChange={(checked) => updateSetting({ allowUserProvider: checked })} />
                <StorageToggle title="允许使用全局外部存储" description="关闭后普通用户使用服务器本机存储" checked={setting.allowUserGlobalProvider} onCheckedChange={(checked) => updateSetting({ allowUserGlobalProvider: checked })} />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">优先级：个人配置、全局配置、服务器本机。</p>
          </SettingsSection>
        </TabsContent> : null}

        {activeTab === "providers" ? <TabsContent value="providers" className="grid gap-8">
          <div data-storage-provider-toolbar className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0"><h3 className="text-base font-semibold text-foreground">全局外部存储</h3><p className="mt-1 text-sm leading-5 text-muted-foreground">统一配置 S3、R2 与 WebDAV；素材写入失败时自动回退到服务器本机。</p></div>
            <div className="flex shrink-0 flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => updateSetting({ providers: [...setting.providers, newProvider("s3", setting.providers.length)] })}><Plus />S3 / R2</Button><Button type="button" variant="outline" size="sm" onClick={() => updateSetting({ providers: [...setting.providers, newProvider("webdav", setting.providers.length)] })}><Plus />WebDAV</Button></div>
          </div>

          <SettingsSection title="存储概览"><div data-storage-provider-overview className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4 lg:gap-0 lg:divide-x">
            <StorageMetric label="已配置">{setting.providers.length} 个</StorageMetric>
            <StorageMetric label="已启用">{enabledProviderCount} 个</StorageMetric>
            <StorageMetric label="容量上限">{formatBytes(setting.capacityLimitBytes)}</StorageMetric>
            <StorageMetric label="自动统计">{setting.capacityCheck.enabled ? "已开启" : "已关闭"}</StorageMetric>
          </div>

          </SettingsSection>

          <div data-storage-provider-policy className="grid items-start gap-8">
            <SettingsSection title="自动统计容量" description="按 Cron 计划定期检查所有外部存储，关闭后仍可手动统计。">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium">启用自动统计</span>
                <Switch aria-label="自动统计容量" checked={setting.capacityCheck.enabled} onCheckedChange={(checked) => updateSetting({ capacityCheck: { ...setting.capacityCheck, enabled: checked } })} />
              </div>
              {setting.capacityCheck.enabled ? <StorageField className="max-w-lg" label="检查计划（Cron）" hint="默认每 6 小时检查一次。">{(fieldId) => <Input id={fieldId}  value={setting.capacityCheck.cron} onChange={(event) => updateSetting({ capacityCheck: { ...setting.capacityCheck, cron: event.target.value } })} placeholder="0 */6 * * *" />}</StorageField> : null}
            </SettingsSection>

            <SettingsSection title="容量保护" description="统计结果达到上限后自动停用对应存储。">
              <StorageField  label="每个外部存储的容量上限" hint="该上限应用于每个外部存储，不是所有存储的合计容量。">{(fieldId) => <GigabyteInput id={fieldId} min={0.01} value={Number((setting.capacityLimitBytes / 1024 ** 3).toFixed(2))} onChange={(value) => updateSetting({ capacityLimitBytes: Math.max(1, value * 1024 ** 3) })} />}</StorageField>
            </SettingsSection>
          </div>

          {setting.providers.length === 0 ? <EmptyState compact data-storage-provider-empty icon={Server} title="还没有外部存储" description="当前素材保存在服务器本机。可从右上角添加 S3、R2 或 WebDAV。" className="min-h-36" /> : null}
          {setting.providers.map((provider, index) => (
            <SettingsSection key={provider.id} title={provider.name || providerTypeLabel(provider.type)} description={<>{providerTypeLabel(provider.type)} · {formatBytes(provider.capacityBytes)}{provider.capacityCheckedAt ? ` · ${new Date(provider.capacityCheckedAt).toLocaleString("zh-CN")}` : ""}</>} action={<div className="flex items-center gap-2">
                  <Label className="flex items-center gap-2 text-xs text-muted-foreground"><span>启用</span><Switch checked={provider.enabled} onCheckedChange={(checked) => patchProvider(index, { enabled: checked })} /></Label>
                  <TooltipHint content={"统计容量"}><Button aria-label="统计容量" type="button" variant="outline" size="icon" onClick={() => void measure(index)} disabled={measuringIndex !== null}>{measuringIndex === index ? <Spinner /> : <Gauge />}</Button></TooltipHint>
                  <TooltipHint content={"删除外部存储"}><Button aria-label="删除外部存储" type="button" variant="ghost" size="icon" onClick={() => updateSetting({ providers: setting.providers.filter((_, providerIndex) => providerIndex !== index) })}><Trash2 /></Button></TooltipHint>
                </div>}>
              <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
                <StorageField label="配置名称">{(fieldId) => <Input id={fieldId}  value={provider.name} onChange={(event) => patchProvider(index, { name: event.target.value })} placeholder={providerTypeLabel(provider.type)} />}</StorageField>
                <StorageField label={provider.type === "webdav" ? "WebDAV 服务器地址" : "S3 / R2 服务地址"} hint={provider.type === "webdav" ? "管理员存储支持服务器可访问的内网 WebDAV 地址；个人存储仅支持公网地址。" : undefined}>{(fieldId) => <Input id={fieldId}  value={provider.endpoint} onChange={(event) => patchProvider(index, { endpoint: event.target.value })} placeholder={provider.type === "webdav" ? "https://dav.example.com" : "https://account.r2.cloudflarestorage.com"} />}</StorageField>
                {provider.type === "s3" ? <>
                  <StorageField label="存储桶名称">{(fieldId) => <Input id={fieldId}  value={provider.bucket} onChange={(event) => patchProvider(index, { bucket: event.target.value })} placeholder="media-assets" />}</StorageField>
                  <StorageField label="Bucket 使用子域名" hint="COS / OSS 通常启用；服务地址填写不含 Bucket 的区域域名。关闭时将 Bucket 放在 URL 路径中。">{(fieldId) => <Switch id={fieldId} checked={provider.bucketInHost} onCheckedChange={(bucketInHost) => patchProvider(index, { bucketInHost })} />}</StorageField>
                  <StorageField label="区域">{(fieldId) => <Input id={fieldId}  value={provider.region} onChange={(event) => patchProvider(index, { region: event.target.value })} placeholder="auto" />}</StorageField>
                  <StorageField label="素材目录前缀">{(fieldId) => <Input id={fieldId}  value={provider.pathPrefix} onChange={(event) => patchProvider(index, { pathPrefix: event.target.value })} placeholder="assets" />}</StorageField>
                </> : <>
                  <StorageField label="用户名">{(fieldId) => <Input id={fieldId}  value={provider.username} onChange={(event) => patchProvider(index, { username: event.target.value })} placeholder="WebDAV 用户名" autoComplete="off" />}</StorageField>
                  <StorageField label="密码或应用密码" hint="编辑已有配置时留空表示保持原密码">{(fieldId) => <PasswordInput id={fieldId}  type="password" value={provider.password} onChange={(event) => patchProvider(index, { password: event.target.value })} placeholder="WebDAV 密码" autoComplete="new-password" />}</StorageField>
                  <StorageField label="素材目录前缀">{(fieldId) => <Input id={fieldId}  value={provider.pathPrefix} onChange={(event) => patchProvider(index, { pathPrefix: event.target.value })} placeholder="assets" />}</StorageField>
                </>}
                <StorageField label="分配权重" hint="同类型多个存储启用时，数值越大分配概率越高">{(fieldId) => <NumberInput id={fieldId}  min={1} value={provider.weight} onValueChange={(nextValue) => patchProvider(index, { weight: Math.max(1, Number(nextValue) || 1) })} controlsLayout="split" />}</StorageField>
                {provider.type === "s3" ? <>
                  <StorageField label="Access Key ID">{(fieldId) => <Input id={fieldId}  value={provider.accessKeyId} onChange={(event) => patchProvider(index, { accessKeyId: event.target.value })} placeholder="访问密钥 ID" autoComplete="off" />}</StorageField>
                  <StorageField label="Secret Access Key" hint="编辑已有配置时留空表示保持原密钥">{(fieldId) => <PasswordInput id={fieldId}  type="password" value={provider.secretAccessKey} onChange={(event) => patchProvider(index, { secretAccessKey: event.target.value })} placeholder="访问密钥" autoComplete="new-password" />}</StorageField>
                  <StorageField label="公开访问地址（可选）" hint="仅填写可匿名访问的桶域名或 CDN；私有桶请留空，由本站鉴权代理读取。">{(fieldId) => <Input id={fieldId}  value={provider.publicBaseUrl} onChange={(event) => patchProvider(index, { publicBaseUrl: event.target.value })} placeholder="https://cdn.example.com" />}</StorageField>
                </> : null}
              </div>
            </SettingsSection>
          ))}
        </TabsContent> : null}
      </Tabs>
    </SettingsPanel>
  );
}
