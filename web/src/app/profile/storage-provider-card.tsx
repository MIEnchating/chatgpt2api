import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { LabeledField as StorageField } from "@/components/labeled-field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PasswordInput } from "@/components/password-input";
import { Cloud, Database, Gauge, HardDrive, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsPanel, SettingsSection } from "@/components/settings-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  defaultUserStorageProvider,
  defaultUserWebDAVStorageProvider,
  fetchStorageConfig,
  fetchUserStorageProviders,
  measureUserStorageProvider,
  updateUserStorageProviders,
  type UserS3StorageProvider,
  type UserStorageProvider,
  type UserWebDAVStorageProvider,
} from "@/services/storage-provider";

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}



export function StorageProviderCard() {
  const [allowed, setAllowed] = useState(false);
  const [activeType, setActiveType] = useState<"s3" | "webdav">("s3");
  const [s3, setS3] = useState<UserS3StorageProvider>(defaultUserStorageProvider());
  const [webdav, setWebDAV] = useState<UserWebDAVStorageProvider>(defaultUserWebDAVStorageProvider());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [usage, setUsage] = useState<Record<"s3" | "webdav", string>>({ s3: "", webdav: "" });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchStorageConfig(), fetchUserStorageProviders()])
      .then(([config, providers]) => {
        if (cancelled) return;
        setAllowed(config.allowUserProvider);
        setS3({ ...defaultUserStorageProvider(), ...providers.s3, type: "s3" });
        setWebDAV({ ...defaultUserWebDAVStorageProvider(), ...providers.webdav, type: "webdav" });
        if (providers.webdav?.enabled) setActiveType("webdav");
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "读取存储配置失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <SettingsPanel title="素材存储"><LoadingState label="正在读取存储配置" /></SettingsPanel>;
  if (!allowed) return <SettingsPanel title="素材存储"><EmptyState icon={HardDrive} title="使用服务器本机存储" description="管理员暂未开放个人外部存储配置" /></SettingsPanel>;

  const provider: UserStorageProvider = activeType === "s3" ? s3 : webdav;

  const setProviderEnabled = (enabled: boolean) => {
    if (activeType === "s3") {
      setS3((value) => ({ ...value, enabled }));
      if (enabled) setWebDAV((value) => ({ ...value, enabled: false }));
    } else {
      setWebDAV((value) => ({ ...value, enabled }));
      if (enabled) setS3((value) => ({ ...value, enabled: false }));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const providers = await updateUserStorageProviders({ s3, webdav });
      setS3((current) => current === s3 ? { ...defaultUserStorageProvider(), ...providers.s3, type: "s3" } : current);
      setWebDAV((current) => current === webdav ? { ...defaultUserWebDAVStorageProvider(), ...providers.webdav, type: "webdav" } : current);
      toast.success("存储配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "存储配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const measure = async () => {
    setMeasuring(true);
    try {
      const response = await measureUserStorageProvider(provider);
      setUsage((current) => ({ ...current, [activeType]: formatBytes(response.result.bytes) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "容量统计失败");
    } finally {
      setMeasuring(false);
    }
  };

  return (
    <SettingsPanel
      title="素材存储"
      description="未启用时使用服务器本机，可选 S3、R2 或 WebDAV。"
      action={<Button type="button" onClick={() => void save()} disabled={saving}>{saving ? <Spinner /> : <Save />}保存</Button>}
    >
      <SettingsSection title="存储配置">
      <Tabs value={activeType} onValueChange={(value) => setActiveType(value as "s3" | "webdav")} className="grid min-w-0 gap-5">
        <TabsList aria-label="素材存储设置" className="h-auto">
          <TabsTrigger value="s3" ><Database className="size-4" />S3 / R2</TabsTrigger>
          <TabsTrigger value="webdav" ><Cloud className="size-4" />WebDAV</TabsTrigger>
        </TabsList>
        <div className="flex min-h-16 items-center justify-between gap-4 border-b py-3">
          <div><p className="text-sm font-medium">启用当前外部存储</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">S3/R2 与 WebDAV 不能同时启用；关闭后使用服务器本机</p></div>
          <Switch aria-label="启用当前外部存储" checked={provider.enabled} onCheckedChange={setProviderEnabled} />
        </div>
        {activeType === "s3" ? (
          <TabsContent value="s3" className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
            <StorageField label="配置名称">{(fieldId) => <Input id={fieldId} value={s3.name} onChange={(event) => setS3((value) => ({ ...value, name: event.target.value }))} placeholder="我的对象存储" />}</StorageField>
            <StorageField label="S3 / R2 服务地址">{(fieldId) => <Input id={fieldId} value={s3.endpoint} onChange={(event) => setS3((value) => ({ ...value, endpoint: event.target.value }))} placeholder="https://account.r2.cloudflarestorage.com" />}</StorageField>
            <StorageField label="存储桶名称">{(fieldId) => <Input id={fieldId} value={s3.bucket} onChange={(event) => setS3((value) => ({ ...value, bucket: event.target.value }))} placeholder="media-assets" />}</StorageField>
            <StorageField label="区域">{(fieldId) => <Input id={fieldId} value={s3.region} onChange={(event) => setS3((value) => ({ ...value, region: event.target.value }))} placeholder="auto" />}</StorageField>
            <StorageField label="Access Key ID">{(fieldId) => <Input id={fieldId} value={s3.accessKeyId} onChange={(event) => setS3((value) => ({ ...value, accessKeyId: event.target.value }))} placeholder="访问密钥 ID" autoComplete="off" />}</StorageField>
            <StorageField label="Secret Access Key" hint="编辑已有配置时留空表示保持原密钥">{(fieldId) => <PasswordInput id={fieldId} type="password" value={s3.secretAccessKey} onChange={(event) => setS3((value) => ({ ...value, secretAccessKey: event.target.value }))} placeholder="访问密钥" autoComplete="new-password" />}</StorageField>
            <StorageField label="素材目录前缀">{(fieldId) => <Input id={fieldId} value={s3.pathPrefix} onChange={(event) => setS3((value) => ({ ...value, pathPrefix: event.target.value }))} placeholder="assets" />}</StorageField>
            <StorageField label="公开访问地址（可选）" hint="仅填写可匿名访问的桶域名或 CDN；私有桶请留空，由本站鉴权代理读取。">{(fieldId) => <Input id={fieldId} value={s3.publicBaseUrl} onChange={(event) => setS3((value) => ({ ...value, publicBaseUrl: event.target.value }))} placeholder="https://cdn.example.com" />}</StorageField>
            <Label className="flex min-w-0 items-center justify-between gap-4 md:col-span-2">
              <span className="min-w-0"><span className="block text-sm font-medium">Bucket 使用子域名</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">COS / OSS 通常启用，服务地址不含 Bucket；关闭时使用路径模式。</span></span>
              <Switch checked={s3.bucketInHost} onCheckedChange={(bucketInHost) => setS3((value) => ({ ...value, bucketInHost }))} />
            </Label>
          </TabsContent>
        ) : (
          <TabsContent value="webdav" className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
            <StorageField label="配置名称">{(fieldId) => <Input id={fieldId} value={webdav.name} onChange={(event) => setWebDAV((value) => ({ ...value, name: event.target.value }))} placeholder="我的 WebDAV" />}</StorageField>
            <StorageField label="WebDAV 服务器地址">{(fieldId) => <Input id={fieldId} value={webdav.endpoint} onChange={(event) => setWebDAV((value) => ({ ...value, endpoint: event.target.value }))} placeholder="https://dav.example.com" />}</StorageField>
            <StorageField label="用户名">{(fieldId) => <Input id={fieldId} value={webdav.username} onChange={(event) => setWebDAV((value) => ({ ...value, username: event.target.value }))} placeholder="WebDAV 用户名" autoComplete="off" />}</StorageField>
            <StorageField label="密码或应用密码" hint="编辑已有配置时留空表示保持原密码">{(fieldId) => <PasswordInput id={fieldId} type="password" value={webdav.password} onChange={(event) => setWebDAV((value) => ({ ...value, password: event.target.value }))} placeholder="WebDAV 密码" autoComplete="new-password" />}</StorageField>
            <StorageField label="素材目录前缀">{(fieldId) => <Input id={fieldId} value={webdav.pathPrefix} onChange={(event) => setWebDAV((value) => ({ ...value, pathPrefix: event.target.value }))} placeholder="assets" />}</StorageField>
          </TabsContent>
        )}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span className="min-w-0 break-words text-sm text-muted-foreground">已用容量：{usage[activeType] || "尚未统计"}</span>
          <Button type="button" variant="outline" onClick={() => void measure()} disabled={measuring || !provider.enabled}>{measuring ? <Spinner /> : <Gauge />}统计容量</Button>
        </div>
      </Tabs>
      </SettingsSection>
    </SettingsPanel>
  );
}
