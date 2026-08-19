"use client";

import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { normalizePromptMarketSources, type PromptMarketSourceConfig, type PromptMarketSourceFormat } from "@/app/image/banana-prompts";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";
import { SettingsCard, SettingsNotice, settingsInputClassName, settingsListItemClassName } from "./settings-ui";

const formatOptions: Array<{ value: PromptMarketSourceFormat; label: string }> = [
  { value: "banana-json", label: "Banana JSON" },
  { value: "awesome-gpt-image-2-markdown", label: "GPT Image Markdown" },
  { value: "generic-json", label: "通用 JSON" },
];

function sourceID() {
  return `prompt-source-${Date.now().toString(36)}`;
}

export function PromptSourcesCard() {
  const config = useSettingsStore((state) => state.config);
  const setPromptSources = useSettingsStore((state) => state.setPromptSources);
  const sources = useMemo(() => normalizePromptMarketSources(config?.prompt_sources), [config?.prompt_sources]);

  const updateSource = (id: string, patch: Partial<PromptMarketSourceConfig>) => {
    setPromptSources(sources.map((source) => source.id === id ? { ...source, ...patch } : source));
  };

  const addSource = () => {
    setPromptSources([...sources, { id: sourceID(), label: "新提示词来源", url: "https://example.com/prompts.json", format: "generic-json", enabled: true }]);
  };

  const removeSource = (source: PromptMarketSourceConfig) => {
    if (source.builtin) {
      updateSource(source.id, { enabled: false });
      return;
    }
    setPromptSources(sources.filter((item) => item.id !== source.id));
  };

  return (
    <SettingsCard icon={BookOpen} title="提示词来源" description="管理提示词市场的来源、启用状态和解析格式。" tone="violet" action={<Button type="button" variant="outline" size="sm" onClick={addSource}><Plus className="size-4" />新增来源</Button>}>
      <div className="flex flex-col gap-3">
        <SettingsNotice className="px-3 py-2.5 text-xs leading-5 sm:text-sm">来源配置保存后会同步到服务端。自定义来源需要返回 JSON 数组，字段支持 title、prompt、preview、category、tags、author、mode。</SettingsNotice>
        {sources.map((source) => (
          <div key={source.id} className={cn(settingsListItemClassName, "p-3 sm:p-4", !source.enabled && "opacity-60")}>
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
              <Switch checked={source.enabled} aria-label={`启用${source.label}`} onCheckedChange={(enabled) => updateSource(source.id, { enabled })} className="mt-0.5" />
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-semibold">{source.label || "未命名来源"}</p>
                  {source.builtin ? <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">内置</span> : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={source.url}>{source.url}</p>
              </div>
              <Button type="button" variant="ghost" size="icon" className="size-8 text-rose-600" title={source.builtin ? "停用来源" : "删除来源"} aria-label={source.builtin ? "停用来源" : "删除来源"} onClick={() => removeSource(source)}><Trash2 className="size-4" /></Button>
            </div>
            <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <Input value={source.label} onChange={(event) => updateSource(source.id, { label: event.target.value })} placeholder="来源名称" className={cn(settingsInputClassName, "min-w-0")} />
              <Select value={source.format} onValueChange={(value) => updateSource(source.id, { format: value as PromptMarketSourceFormat })}>
                <SelectTrigger className={cn(settingsInputClassName, "min-w-0")} aria-label="解析格式">
                  <SelectValue placeholder="解析格式" />
                </SelectTrigger>
                <SelectContent>
                  {formatOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input value={source.url} onChange={(event) => updateSource(source.id, { url: event.target.value })} placeholder="https://..." className={cn(settingsInputClassName, "min-w-0 sm:col-span-2")} />
            </div>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}
