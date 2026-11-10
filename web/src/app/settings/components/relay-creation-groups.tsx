"use client";

import { Spinner } from "@/components/ui/spinner";

import { useEffect, useState } from "react";
import { CircleHelp, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { TooltipButton } from "@/components/ui/tooltip";
import { MultiSelect } from "@/components/ui/multi-select";
import { fetchRelayCreationGroups } from "@/lib/api";
import { useSettingsStore } from "../store";


const kinds = ["text", "image", "video", "audio"] as const;
const labels = { text: "文本分组", image: "图片分组", video: "视频分组", audio: "音频分组" };

export function RelayCreationGroups() {
  const config = useSettingsStore((state) => state.config);
  const setGroup = useSettingsStore((state) => state.setRelayCreationGroup);
  const isSaving = useSettingsStore((state) => state.isSavingConfig);
  const [groups, setGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setGroups([]);
    void fetchRelayCreationGroups(controller.signal)
      .then(({ groups }) => { if (!controller.signal.aborted) setGroups(groups); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取数据库分组失败");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, isSaving]);

  const hasSelection = kinds.some((kind) => (config?.[`relay_${kind}_group`]?.length || 0) > 0);

  return (
    <div className="col-span-full grid min-w-0 gap-4 border-t pt-4">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <p className="text-sm font-medium">新用户默认密钥分组</p>
            <TooltipButton type="button" tooltip="分组来自已保存的上游数据库。同组可用 Key 按模型匹配并轮询；没有可用 Key 时，在账号密码登录后创建。不同类型可共用分组，留空则跳过。" aria-label="查看默认密钥分组说明"><CircleHelp /></TooltipButton>
          </div>
          <div className="flex items-center gap-1">
            <TooltipButton type="button" tooltip="刷新分组" disabled={loading || isSaving} onClick={() => setRevision((value) => value + 1)}>{loading ? <Spinner /> : <RefreshCw />}</TooltipButton>
            <Button type="button" variant="ghost" size="sm" disabled={!hasSelection || isSaving} onClick={() => kinds.forEach((kind) => setGroup(kind, []))}>清空</Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">为新用户分配默认 Key，修改后需保存。</p>
        {error ? <FieldError>{error}</FieldError> : !loading && groups.length === 0 ? <FieldDescription>暂无分组，请在上游添加后刷新。</FieldDescription> : null}
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      {kinds.map((kind) => {
        const value = config?.[`relay_${kind}_group`] || [];
        const options = [...new Set([...groups, ...value])].map((group) => ({ value: group, label: groups.includes(group) ? group : `${group}（当前不可用）` }));
        return (
          <Field key={kind} className="min-w-0">
            <FieldLabel htmlFor={`settings-relay-${kind}-group`} >{labels[kind]}</FieldLabel>
            <div className="flex min-w-0 gap-2">
              <MultiSelect id={`settings-relay-${kind}-group`} aria-label={labels[kind]} className="min-w-0 flex-1" value={value} options={options} onValueChange={(value) => setGroup(kind, value)} disabled={loading || isSaving || Boolean(error) || options.length === 0} placeholder={loading ? "读取中…" : "不分配"} emptyText="不分配" />
              <TooltipButton type="button" tooltip={`清空${labels[kind]}`} disabled={value.length === 0 || isSaving} onClick={() => setGroup(kind, [])}><X /></TooltipButton>
            </div>
          </Field>
        );
      })}
      </div>
    </div>
  );
}
