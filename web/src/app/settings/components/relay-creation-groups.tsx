"use client";

import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchRelayCreationGroups } from "@/lib/api";
import { useSettingsStore } from "../store";
import { settingsInputClassName } from "./settings-ui";

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

  const hasSelection = kinds.some((kind) => Boolean(config?.[`relay_${kind}_group`]));

  return (
    <>
      <div className="sm:col-span-2 2xl:col-span-3 border-t border-border/60 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">新用户默认密钥分组</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={loading || isSaving} onClick={() => setRevision((value) => value + 1)}><RefreshCw className={loading ? "animate-spin" : ""} />刷新分组</Button>
            <Button type="button" variant="ghost" size="sm" disabled={!hasSelection || isSaving} onClick={() => kinds.forEach((kind) => setGroup(kind, ""))}><X />全部清空</Button>
          </div>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">分组选项来自已保存的上游数据库连接。按分组复用当前用户的可用 Key，同组多个 Key 参与匹配模型的任务轮询；没有可用 Key 时在账号密码登录后创建。多个分类可共用同一分组，清空则跳过，修改后需保存。</p>
        {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : !loading && groups.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">数据库中没有可选择的分组，请先在上游配置分组后刷新。</p> : null}
      </div>
      {kinds.map((kind) => {
        const value = config?.[`relay_${kind}_group`] || "";
        const unavailable = value !== "" && !groups.includes(value);
        return (
          <Field key={kind} className="min-w-0 gap-1.5">
            <FieldLabel htmlFor={`settings-relay-${kind}-group`} className="leading-6">{labels[kind]}</FieldLabel>
            <div className="flex min-w-0 gap-2">
              <Select value={value} onValueChange={(value) => setGroup(kind, value)} disabled={loading || isSaving || Boolean(error) || groups.length === 0}>
                <SelectTrigger id={`settings-relay-${kind}-group`} className={`${settingsInputClassName} min-w-0 flex-1`}><SelectValue placeholder={loading ? "正在读取分组…" : "未选择（跳过）"} /></SelectTrigger>
                <SelectContent>
                  {unavailable ? <SelectItem value={value} disabled>{value}（当前不可用）</SelectItem> : null}
                  {groups.map((group) => <SelectItem key={group} value={group}>{group}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button type="button" variant="ghost" size="icon" aria-label={`清空${labels[kind]}`} disabled={!value || isSaving} onClick={() => setGroup(kind, "")}><X /></Button>
            </div>
          </Field>
        );
      })}
    </>
  );
}
