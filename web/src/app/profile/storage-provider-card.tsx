import { CircleHelp, Cloud, Database, Gauge, HardDrive, LoaderCircle, Save } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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

function StorageField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="min-w-0 space-y-1.5"><span className="flex min-h-4 items-center gap-1.5 text-xs font-medium text-foreground"><span>{label}</span>{hint ? <TooltipHint content={hint}><span tabIndex={0} role="img" aria-label={`${label}说明`} className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><CircleHelp className="size-3.5" aria-hidden="true" /></span></TooltipHint> : null}</span>{children}</label>;
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

  if (loading) return <Card><CardContent className="flex min-h-48 items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></CardContent></Card>;
  if (!allowed) return <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center"><span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><HardDrive className="size-5" /></span><div><p className="text-sm font-semibold text-foreground">使用服务器本机存储</p><p className="mt-1 text-sm text-muted-foreground">管理员暂未开放个人外部存储配置</p></div></CardContent></Card>;

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
      setS3({ ...defaultUserStorageProvider(), ...providers.s3, type: "s3" });
      setWebDAV({ ...defaultUserWebDAVStorageProvider(), ...providers.webdav, type: "webdav" });
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
    <Card className="overflow-hidden">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border"><Cloud className="size-5" /></span>
            <div className="min-w-0"><CardTitle className="text-lg leading-7">个人素材存储</CardTitle><p className="mt-1 text-sm text-muted-foreground">未启用时使用服务器本机，可选 S3、R2 或 WebDAV</p></div>
          </div>
          <Button type="button" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}保存</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="overflow-x-auto border-b border-border/70 pb-4">
          <div role="tablist" aria-label="个人素材存储类型" className="inline-flex min-w-max gap-1 rounded-lg bg-muted p-1">
            <button type="button" role="tab" aria-selected={activeType === "s3"} className={cn("flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors", activeType === "s3" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={() => setActiveType("s3")}><Database className="size-4" />S3 / R2</button>
            <button type="button" role="tab" aria-selected={activeType === "webdav"} className={cn("flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors", activeType === "webdav" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={() => setActiveType("webdav")}><Cloud className="size-4" />WebDAV</button>
          </div>
        </div>
        <div className="flex min-h-16 items-center justify-between gap-4 border-y border-border/70 py-3">
          <div><p className="text-sm font-medium">启用当前外部存储</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">S3/R2 与 WebDAV 不能同时启用；关闭后使用服务器本机</p></div>
          <Switch checked={provider.enabled} onCheckedChange={setProviderEnabled} />
        </div>
        {activeType === "s3" ? (
          <div role="tabpanel" className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
            <StorageField label="配置名称"><Input value={s3.name} onChange={(event) => setS3((value) => ({ ...value, name: event.target.value }))} placeholder="我的对象存储" /></StorageField>
            <StorageField label="S3 / R2 服务地址"><Input value={s3.endpoint} onChange={(event) => setS3((value) => ({ ...value, endpoint: event.target.value }))} placeholder="https://account.r2.cloudflarestorage.com" /></StorageField>
            <StorageField label="存储桶名称"><Input value={s3.bucket} onChange={(event) => setS3((value) => ({ ...value, bucket: event.target.value }))} placeholder="media-assets" /></StorageField>
            <StorageField label="区域"><Input value={s3.region} onChange={(event) => setS3((value) => ({ ...value, region: event.target.value }))} placeholder="auto" /></StorageField>
            <StorageField label="素材目录前缀"><Input value={s3.pathPrefix} onChange={(event) => setS3((value) => ({ ...value, pathPrefix: event.target.value }))} placeholder="assets" /></StorageField>
            <StorageField label="公开访问地址（可选）" hint="仅填写可匿名访问的桶域名或 CDN；私有桶请留空，由本站鉴权代理读取。"><Input value={s3.publicBaseUrl} onChange={(event) => setS3((value) => ({ ...value, publicBaseUrl: event.target.value }))} placeholder="https://cdn.example.com" /></StorageField>
            <StorageField label="Access Key ID"><Input value={s3.accessKeyId} onChange={(event) => setS3((value) => ({ ...value, accessKeyId: event.target.value }))} placeholder="访问密钥 ID" autoComplete="off" /></StorageField>
            <StorageField label="Secret Access Key" hint="编辑已有配置时留空表示保持原密钥"><Input type="password" value={s3.secretAccessKey} onChange={(event) => setS3((value) => ({ ...value, secretAccessKey: event.target.value }))} placeholder="访问密钥" autoComplete="new-password" /></StorageField>
          </div>
        ) : (
          <div role="tabpanel" className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
            <StorageField label="配置名称"><Input value={webdav.name} onChange={(event) => setWebDAV((value) => ({ ...value, name: event.target.value }))} placeholder="我的 WebDAV" /></StorageField>
            <StorageField label="WebDAV 服务器地址"><Input value={webdav.endpoint} onChange={(event) => setWebDAV((value) => ({ ...value, endpoint: event.target.value }))} placeholder="https://dav.example.com" /></StorageField>
            <StorageField label="用户名"><Input value={webdav.username} onChange={(event) => setWebDAV((value) => ({ ...value, username: event.target.value }))} placeholder="WebDAV 用户名" autoComplete="off" /></StorageField>
            <StorageField label="密码或应用密码" hint="编辑已有配置时留空表示保持原密码"><Input type="password" value={webdav.password} onChange={(event) => setWebDAV((value) => ({ ...value, password: event.target.value }))} placeholder="WebDAV 密码" autoComplete="new-password" /></StorageField>
            <StorageField label="素材目录前缀"><Input value={webdav.pathPrefix} onChange={(event) => setWebDAV((value) => ({ ...value, pathPrefix: event.target.value }))} placeholder="assets" /></StorageField>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <span className="text-sm text-muted-foreground">已用容量：{usage[activeType] || "尚未统计"}</span>
          <Button type="button" variant="outline" onClick={() => void measure()} disabled={measuring || !provider.enabled}>{measuring ? <LoaderCircle className="animate-spin" /> : <Gauge />}统计容量</Button>
        </div>
      </CardContent>
    </Card>
  );
}
