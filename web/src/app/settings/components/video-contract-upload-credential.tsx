import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { deleteVideoMaterialUploadCredential, fetchVideoMaterialUploadCredential, saveVideoMaterialUploadCredential } from "@/lib/api";

export function VideoContractUploadCredential({ contractID, baseURL, disabled }: { contractID?: string; baseURL: string; disabled: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setAPIKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    if (contractID && baseURL) {
      void fetchVideoMaterialUploadCredential(contractID, baseURL, controller.signal).then(result => {
        if (active.current) setConfigured(result.configured);
      }).catch(error => {
        if (active.current && !controller.signal.aborted) setError(error instanceof Error ? error.message : "读取密钥状态失败");
      });
    }
    return () => { active.current = false; controller.abort(); };
  }, [contractID, baseURL]);
  const save = async (clear: boolean) => {
    if (!contractID || disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = clear
        ? await deleteVideoMaterialUploadCredential(contractID, baseURL)
        : await saveVideoMaterialUploadCredential(contractID, baseURL, apiKey);
      if (!active.current) return;
      setConfigured(result.configured);
      setAPIKey("");
      setConfirmClear(false);
      toast.success(clear ? "此契约的上传密钥已清除" : "此契约的上传密钥已保存");
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : "保存上传密钥失败");
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return <Field className="sm:col-span-2">
    <FieldLabel htmlFor="video-upload-api-key">此契约的供应商上传密钥</FieldLabel>
    {contractID ? <>
      <FieldDescription>{error || (configured === null ? "正在读取配置状态…" : configured ? "当前上传地址已配置密钥；留空可保留，填写新值后点击保存即可替换。" : "当前上传地址尚未配置密钥。")}</FieldDescription>
      {!disabled ? <>
        <Input id="video-upload-api-key" type="password" autoComplete="new-password" value={apiKey} disabled={busy || !baseURL} placeholder="输入供应商 API Key" onChange={event => setAPIKey(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy || !apiKey.trim() || !baseURL} onClick={() => void save(false)}>{busy ? <Spinner /> : null}保存密钥</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !configured} onClick={() => setConfirmClear(true)}>清除密钥</Button>
        </div>
        <ConfirmDialog open={confirmClear} onOpenChange={setConfirmClear} title="清除此契约的上传密钥？" description="清除后，此契约使用当前上传地址的本地素材任务将无法上传。" confirmLabel="清除密钥" destructive busy={busy} onConfirm={() => void save(true)} />
      </> : null}
      <FieldDescription>密钥按契约和上传地址单独保存，保存后立即生效；不包含在导出、复制和历史版本中。</FieldDescription>
    </> : <FieldDescription>先添加并发布契约，再打开契约配置上传密钥。</FieldDescription>}
  </Field>;
}
