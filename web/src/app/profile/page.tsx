"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  Clapperboard,
  HardDrive,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Settings2,
  TextCursorInput,
  UserCircle2,
  WalletCards,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  fetchImageGenerationPreferences,
  fetchGrokTTSVoices,
  fetchModelConfig,
  fetchProfileBalance,
  IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT,
  PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT,
  updateImageGenerationPreferences,
  type ImageGenerationPreferences,
  type ProfileBalanceStatus,
} from "@/lib/api";
import { displaySubjectId } from "@/lib/session";
import {
  getStoredRelayTokenName,
  relayTokenNameStorageKey,
  retainSelectedRelayTokenName,
  storeRelayTokenName,
  type RelayTokenKind,
} from "@/lib/relay-token-selection";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";
import {
  AUDIO_FORMAT_OPTIONS,
  AUDIO_VOICE_OPTIONS,
  GEMINI_TTS_VOICE_OPTIONS,
  GLM_TTS_FORMAT_OPTIONS,
  GLM_TTS_VOICE_OPTIONS,
  GROK_TTS_FORMAT_OPTIONS,
  MIMO_TTS_FORMAT_OPTIONS,
  MIMO_TTS_VOICE_OPTIONS,
  canvasAudioProvider,
} from "@/app/canvas/canvas-audio";
import { StorageProviderCard } from "./storage-provider-card";

function providerLabel(provider?: string) {
  if (provider === "local") {
    return "本地账号";
  }
  if (provider === "newapi") {
    return "云棉";
  }
  if (provider === "sub2api") {
    return "Sub2API";
  }
  if (provider === "linuxdo") {
    return "LinuxDo";
  }
  return provider || "未知";
}

function sessionRoleLabel(session: StoredAuthSession) {
  if (session.role === "admin") {
    return "管理员";
  }
  return session.roleName || "普通用户";
}

function creationConcurrentLimitLabel(session: StoredAuthSession) {
  if (session.role === "admin" || session.creationConcurrentLimit === 0) {
    return "不限制";
  }
  return `${session.creationConcurrentLimit} 个`;
}

function creationRpmLimitLabel(session: StoredAuthSession) {
  if (session.role === "admin" || session.creationRpmLimit === 0) {
    return "不限制";
  }
  return `${session.creationRpmLimit} 次/分`;
}

function formatYunMianQuota(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 500000);
}

function normalizeTokenNames(values: unknown) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((name) => String(name || "").trim()).filter(Boolean)))
    : [];
}

type InfoRowProps = {
  label: string;
  value: string;
  code?: boolean;
};

function SidebarInfoRow({ label, value, code = false }: InfoRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-3 last:border-b-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      {code ? <code className="min-w-0 truncate font-mono text-sm text-foreground">{value || "-"}</code> : <span className="min-w-0 truncate text-sm font-medium text-foreground">{value || "-"}</span>}
    </div>
  );
}

function RelayKeyPreference({
  kind,
  onChange,
  selectedTokenName,
  tokenNameOptions,
}: {
  kind: RelayTokenKind;
  onChange: (value: string) => void;
  selectedTokenName: string;
  tokenNameOptions: string[];
}) {
  const metadata = {
    text: { icon: TextCursorInput, title: "文本模型 Key", description: "用于文本模型请求" },
    image: { icon: ImageIcon, title: "图片模型 Key", description: "用于图片生成任务" },
    video: { icon: Clapperboard, title: "视频模型 Key", description: "用于视频生成任务" },
    audio: { icon: AudioLines, title: "音频模型 Key", description: "用于音频模型请求" },
  }[kind];
  const Icon = metadata.icon;
  const activeTokenName = tokenNameOptions.includes(selectedTokenName) ? selectedTokenName : "";

  return (
    <label className="grid min-w-0 gap-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{metadata.title}</span>
          <span className="block text-xs text-muted-foreground">{metadata.description}</span>
        </div>
      </div>
      <Select value={activeTokenName || undefined} onValueChange={onChange}>
        <SelectTrigger className="h-9 rounded-lg bg-background shadow-none">
          <KeyRound className="size-4 text-muted-foreground" />
          <SelectValue placeholder="请选择 Key" />
        </SelectTrigger>
        <SelectContent>
          {tokenNameOptions.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}

function AccountResourcesCard({
  onTokenNameChange,
  selectedTokenNames,
  tokenNameOptions,
}: {
  onTokenNameChange: (kind: RelayTokenKind, value: string) => void;
  selectedTokenNames: Record<RelayTokenKind, string>;
  tokenNameOptions: string[];
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#edf4ff] text-[#1456f0] ring-1 ring-blue-100 dark:bg-sky-950/30 dark:text-sky-300 dark:ring-sky-900/50">
            <KeyRound className="size-5" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-lg leading-7">Key 选择</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">按模型类型设置个人默认 Key</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {tokenNameOptions.length > 0 ? <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
          {(["text", "image", "video", "audio"] as const).map((kind) => (
            <RelayKeyPreference
              key={kind}
              kind={kind}
              selectedTokenName={selectedTokenNames[kind]}
              tokenNameOptions={tokenNameOptions}
              onChange={(value) => onTokenNameChange(kind, value)}
            />
          ))}
        </div> : <div className="flex min-h-40 items-center justify-center border-y border-border/70 text-sm text-muted-foreground">当前账户暂无可选 Key</div>}
      </CardContent>
    </Card>
  );
}

const DEFAULT_IMAGE_GENERATION_PREFERENCES: ImageGenerationPreferences = {
  api_mode: "images",
  stream: false,
  partial_images: 1,
  response_format_b64_json: false,
  codex_cli_compatibility: false,
  system_prompt: "",
  video_system_prompt: "",
  audio_instructions: "",
  default_text_model: "",
  default_image_model: "",
  default_video_model: "",
  default_audio_model: "",
  canvas_default_image_count: 1,
  default_audio_voice: "",
  default_audio_format: "",
  default_audio_speed: 1,
};

type AudioPreferenceChoices = {
  voices: string[];
  formats: ImageGenerationPreferences["default_audio_format"][];
  minimumSpeed: number;
  maximumSpeed: number;
};

function audioPreferenceChoices(model: string, currentVoice: string, grokVoices: string[] = []): AudioPreferenceChoices {
  const provider = canvasAudioProvider(model);
  if (provider === "gemini") return { voices: [...GEMINI_TTS_VOICE_OPTIONS], formats: ["wav"], minimumSpeed: 1, maximumSpeed: 1 };
  if (provider === "glm") return { voices: [...GLM_TTS_VOICE_OPTIONS], formats: [...GLM_TTS_FORMAT_OPTIONS], minimumSpeed: 0.5, maximumSpeed: 2 };
  if (provider === "grok") return { voices: Array.from(new Set([currentVoice, ...grokVoices, "eve"].filter(Boolean))), formats: [...GROK_TTS_FORMAT_OPTIONS], minimumSpeed: 0.7, maximumSpeed: 1.5 };
  if (provider.startsWith("mimo-")) return { voices: [...MIMO_TTS_VOICE_OPTIONS], formats: [...MIMO_TTS_FORMAT_OPTIONS], minimumSpeed: 1, maximumSpeed: 1 };
  return { voices: [...AUDIO_VOICE_OPTIONS], formats: [...AUDIO_FORMAT_OPTIONS], minimumSpeed: 0.25, maximumSpeed: 4 };
}

function audioPreferenceDefaults(model: string) {
  const provider = canvasAudioProvider(model);
  if (provider === "gemini") return { default_audio_voice: "Kore", default_audio_format: "wav" as const, default_audio_speed: 1 };
  if (provider === "glm") return { default_audio_voice: "tongtong", default_audio_format: "wav" as const, default_audio_speed: 1 };
  if (provider === "grok") return { default_audio_voice: "eve", default_audio_format: "mp3" as const, default_audio_speed: 1 };
  if (provider.startsWith("mimo-")) return { default_audio_voice: "冰糖", default_audio_format: "wav" as const, default_audio_speed: 1 };
  return { default_audio_voice: "alloy", default_audio_format: "mp3" as const, default_audio_speed: 1 };
}

function PreferenceRow({
  checked,
  description,
  disabled = false,
  onCheckedChange,
  title,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: string;
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-label={title} />
    </div>
  );
}

function ImageGenerationPreferencesCard({ audioRelayTokenName, sessionKey }: { audioRelayTokenName: string; sessionKey: string }) {
  const [preferences, setPreferences] = useState<ImageGenerationPreferences>(DEFAULT_IMAGE_GENERATION_PREFERENCES);
  const [modelConfig, setModelConfig] = useState({
    text: { models: [] as string[], fallback: "" },
    image: { models: [] as string[], fallback: "" },
    video: { models: [] as string[], fallback: "" },
    audio: { models: [] as string[], fallback: "" },
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [grokVoices, setGrokVoices] = useState<string[]>([]);

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    void Promise.all([fetchImageGenerationPreferences(), fetchModelConfig()])
      .then(([{ preferences: loaded }, { config }]) => {
        if (ignore) return;
        setPreferences({ ...DEFAULT_IMAGE_GENERATION_PREFERENCES, ...loaded });
        setModelConfig({
          text: { models: config.text_models || [], fallback: config.default_text_model || config.text_models?.[0] || "" },
          image: { models: config.image_models || [], fallback: config.default_image_model || config.image_models?.[0] || "" },
          video: { models: config.video_models || [], fallback: config.default_video_model || config.video_models?.[0] || "" },
          audio: { models: config.audio_models || [], fallback: config.default_audio_model || config.audio_models?.[0] || "" },
        });
      })
      .catch((error) => {
        if (!ignore) setMessage(error instanceof Error ? error.message : "读取图片生成设置失败");
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [sessionKey]);

  const selectedAudioModel = modelConfig.audio.models.includes(preferences.default_audio_model) ? preferences.default_audio_model : modelConfig.audio.fallback;

  useEffect(() => {
    if (canvasAudioProvider(selectedAudioModel) !== "grok" || !selectedAudioModel) {
      setGrokVoices([]);
      return;
    }
    let ignore = false;
    void fetchGrokTTSVoices(selectedAudioModel, audioRelayTokenName)
      .then((voices) => { if (!ignore) setGrokVoices(voices.map((voice) => voice.voice_id.trim()).filter(Boolean)); })
      .catch(() => { if (!ignore) setGrokVoices([]); });
    return () => { ignore = true; };
  }, [audioRelayTokenName, selectedAudioModel]);

  const audioDefaults = audioPreferenceDefaults(selectedAudioModel);
  const audioChoices = audioPreferenceChoices(selectedAudioModel, preferences.default_audio_voice, grokVoices);
  const selectedAudioVoice = audioChoices.voices.includes(preferences.default_audio_voice) ? preferences.default_audio_voice : audioDefaults.default_audio_voice;
  const selectedAudioFormat = audioChoices.formats.includes(preferences.default_audio_format) ? preferences.default_audio_format : audioDefaults.default_audio_format;
  const selectedAudioSpeed = audioChoices.minimumSpeed === audioChoices.maximumSpeed
    ? 1
    : Math.max(audioChoices.minimumSpeed, Math.min(audioChoices.maximumSpeed, Number(preferences.default_audio_speed) || 1));

  const save = async () => {
    setIsSaving(true);
    setMessage("");
    try {
      const normalizedPreferences = { ...preferences, default_audio_voice: selectedAudioVoice, default_audio_format: selectedAudioFormat, default_audio_speed: selectedAudioSpeed };
      const { preferences: saved } = await updateImageGenerationPreferences(normalizedPreferences);
      setPreferences(saved);
      setMessage("设置已保存");
      window.dispatchEvent(new CustomEvent(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT, { detail: saved }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存图片生成设置失败");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/50">
              <Settings2 className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-lg leading-7">创作偏好</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">个人默认模型与生成参数</p>
            </div>
          </div>
          <Button type="button" className="h-9 rounded-lg" onClick={() => void save()} disabled={isLoading || isSaving}>
            {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            保存设置
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-4 border-t border-border/70 pt-5 first:border-t-0 first:pt-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">默认模型</h2>
            <p className="mt-1 text-xs text-muted-foreground">从管理员开放的模型中选择个人默认值，创作时仍可临时切换。</p>
          </div>
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            {([
              ["text", "文本模型", "default_text_model", TextCursorInput],
              ["image", "图片模型", "default_image_model", ImageIcon],
              ["video", "视频模型", "default_video_model", Clapperboard],
              ["audio", "音频模型", "default_audio_model", AudioLines],
            ] as const).map(([kind, label, field, Icon]) => {
              const options = modelConfig[kind].models;
              const current = options.includes(preferences[field]) ? preferences[field] : modelConfig[kind].fallback;
              return <label key={kind} className="grid min-w-0 gap-2 text-sm font-medium">
                <span className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" />{label}</span>
                <Select value={current || undefined} disabled={isLoading || options.length === 0} onValueChange={(value) => setPreferences((state) => field === "default_audio_model" ? { ...state, [field]: value, ...audioPreferenceDefaults(value) } : { ...state, [field]: value })}>
                  <SelectTrigger className="h-9 bg-background shadow-none"><SelectValue placeholder="暂无可用模型" /></SelectTrigger>
                  <SelectContent>{options.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
                </Select>
              </label>;
            })}
          </div>
        </section>

        <section className="space-y-4 border-t border-border/70 pt-5">
          <div><h2 className="text-sm font-semibold text-foreground">画布默认参数</h2><p className="mt-1 text-xs text-muted-foreground">仅用于新建的图片和音频节点；不同音频模型会自动使用其支持的选项范围。</p></div>
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            <label className="grid min-w-0 gap-2 text-sm font-medium"><span>默认生图张数</span><NumberInput min={1} max={15} step={1} value={preferences.canvas_default_image_count} controlsLayout="split" suffix="张" disabled={isLoading || isSaving} onValueChange={(value) => setPreferences((current) => ({ ...current, canvas_default_image_count: Math.max(1, Math.min(15, Math.floor(Number(value) || 1))) }))} /></label>
            <label className="grid min-w-0 gap-2 text-sm font-medium"><span>默认音频声音</span><Select value={selectedAudioVoice} disabled={isLoading || audioChoices.voices.length === 0} onValueChange={(default_audio_voice) => setPreferences((current) => ({ ...current, default_audio_voice }))}><SelectTrigger className="h-10 bg-background shadow-none"><SelectValue /></SelectTrigger><SelectContent>{audioChoices.voices.map((voice) => <SelectItem key={voice} value={voice}>{voice}</SelectItem>)}</SelectContent></Select></label>
            <label className="grid min-w-0 gap-2 text-sm font-medium"><span>默认音频格式</span><Select value={selectedAudioFormat} disabled={isLoading || audioChoices.formats.length <= 1} onValueChange={(default_audio_format: ImageGenerationPreferences["default_audio_format"]) => setPreferences((current) => ({ ...current, default_audio_format }))}><SelectTrigger className="h-10 bg-background shadow-none"><SelectValue /></SelectTrigger><SelectContent>{audioChoices.formats.map((format) => <SelectItem key={format} value={format}>{format.toUpperCase()}</SelectItem>)}</SelectContent></Select></label>
            <label className="grid min-w-0 gap-2 text-sm font-medium"><span>默认音频语速</span><NumberInput min={audioChoices.minimumSpeed} max={audioChoices.maximumSpeed} step={0.05} value={selectedAudioSpeed} controlsLayout="split" suffix="x" disabled={isLoading || isSaving || audioChoices.minimumSpeed === audioChoices.maximumSpeed} onValueChange={(value) => setPreferences((current) => ({ ...current, default_audio_speed: Math.max(audioChoices.minimumSpeed, Math.min(audioChoices.maximumSpeed, Number(Number(value || 1).toFixed(2)))) }))} /></label>
          </div>
        </section>

        <section className="space-y-4 border-t border-border/70 pt-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">接口行为</h2>
            <p className="mt-1 text-xs text-muted-foreground">控制图片请求的传输和兼容方式。</p>
          </div>
          <div className="grid gap-x-6 md:grid-cols-2 md:divide-x md:divide-border/70">
            <div className="divide-y divide-border/70 md:pr-6">
              <label className="grid min-h-20 content-center gap-2 py-3 text-sm font-medium">
                <span>默认图片接口模式</span>
                <Select value={preferences.api_mode} disabled={isLoading} onValueChange={(api_mode: ImageGenerationPreferences["api_mode"]) => setPreferences((current) => ({ ...current, api_mode }))}>
                  <SelectTrigger className="h-9 bg-background shadow-none"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="images">images</SelectItem><SelectItem value="responses">responses</SelectItem><SelectItem value="chat">chat</SelectItem></SelectContent>
                </Select>
              </label>
              <div className="flex min-h-20 flex-wrap items-center justify-between gap-3 py-3">
                <div><p className="text-sm font-medium text-foreground">中间图数量</p><p className="mt-0.5 text-xs text-muted-foreground">流式传输开启时可返回 0-3 张过程图</p></div>
                <Select value={String(preferences.partial_images)} onValueChange={(value) => setPreferences((current) => ({ ...current, partial_images: Number(value) }))} disabled={isLoading || !preferences.stream}>
                  <SelectTrigger className="h-9 w-28 rounded-lg bg-background shadow-none"><SelectValue /></SelectTrigger>
                  <SelectContent>{[0, 1, 2, 3].map((value) => <SelectItem key={value} value={String(value)}>{value} 张</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="divide-y divide-border/70 md:pl-6">
              <PreferenceRow title="流式传输" description="请求中发送 stream，并接收生成过程中的中间图片。" checked={preferences.stream} disabled={isLoading} onCheckedChange={(stream) => setPreferences((current) => ({ ...current, stream }))} />
              <PreferenceRow title="返回 Base64 图片数据" description="请求中发送 response_format=b64_json，适用于需要直接读取图片数据的接口。" checked={preferences.response_format_b64_json} disabled={isLoading} onCheckedChange={(response_format_b64_json) => setPreferences((current) => ({ ...current, response_format_b64_json }))} />
              <PreferenceRow title="Codex CLI 兼容模式" description="省略 quality，并给提示词添加防改写前缀，减少 Codex CLI 图片接口不兼容。" checked={preferences.codex_cli_compatibility} disabled={isLoading} onCheckedChange={(codex_cli_compatibility) => setPreferences((current) => ({ ...current, codex_cli_compatibility }))} />
            </div>
          </div>
        </section>

        <section className="space-y-4 border-t border-border/70 pt-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">音频与系统指令</h2>
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">默认音频指令</span>
            <Textarea
              value={preferences.audio_instructions}
              disabled={isLoading || isSaving}
              onChange={(event) => setPreferences((current) => ({ ...current, audio_instructions: event.target.value }))}
              placeholder="例如：自然、温暖、适合旁白。"
              className="min-h-28 resize-y"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">默认图片系统提示词</span>
            <Textarea
              value={preferences.system_prompt}
              disabled={isLoading || isSaving}
              onChange={(event) => setPreferences((current) => ({ ...current, system_prompt: event.target.value }))}
              placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。"
              className="min-h-28 resize-y"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">默认视频系统提示词</span>
            <Textarea
              value={preferences.video_system_prompt}
              disabled={isLoading || isSaving}
              onChange={(event) => setPreferences((current) => ({ ...current, video_system_prompt: event.target.value }))}
              placeholder="例如：你是一位擅长镜头运动、节奏和连续性的电影导演。"
              className="min-h-28 resize-y"
            />
          </label>
          </div>
        </section>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

function AccountOverviewCard({ balance, isLoading, onRefresh, session }: { balance: ProfileBalanceStatus | null; isLoading: boolean; onRefresh: () => void; session: StoredAuthSession }) {
  const roleLabel = sessionRoleLabel(session);
  const subjectId = displaySubjectId(session.subjectId, session.provider);
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><UserCircle2 className="size-5" /></div>
            <div className="min-w-0"><CardTitle className="truncate text-lg leading-7">{session.name || "用户"}</CardTitle><p className="mt-1 text-sm text-muted-foreground">账户信息与使用额度</p></div>
          </div>
          <Badge variant={session.role === "admin" ? "violet" : "secondary"} className="shrink-0 rounded-md">{roleLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-2 lg:divide-x lg:divide-border/70">
          <section className="min-w-0 lg:pr-6">
            <h2 className="mb-2 text-sm font-semibold text-foreground">基本信息</h2>
            <div className="border-y border-border/70 px-1">
              <SidebarInfoRow label="用户 ID" value={subjectId} code />
              <SidebarInfoRow label="登录来源" value={providerLabel(session.provider)} />
              <SidebarInfoRow label="创作并发额度" value={creationConcurrentLimitLabel(session)} />
              <SidebarInfoRow label="每分钟请求限制" value={creationRpmLimitLabel(session)} />
            </div>
          </section>
          <section className="min-w-0 lg:pl-6">
            <div className="mb-2 flex h-8 items-center justify-between gap-3">
              <div className="flex items-center gap-2"><WalletCards className="size-4 text-muted-foreground" /><h2 className="text-sm font-semibold text-foreground">账户概览</h2></div>
              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onRefresh} disabled={isLoading} aria-label="刷新账户概览" title="刷新账户概览">{isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}</Button>
            </div>
            {isLoading ? <div className="flex h-36 items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />正在读取</div> : balance?.has_balance ? (
              <div className="border-y border-border/70 px-1"><SidebarInfoRow label="当前余额" value={formatYunMianQuota(balance.quota)} /><SidebarInfoRow label="已用额度" value={formatYunMianQuota(balance.used_quota)} /><SidebarInfoRow label="邮箱" value={balance.email || "-"} /></div>
            ) : <div className="flex min-h-36 items-center justify-center border-y border-border/70 px-4 text-center text-xs leading-5 text-muted-foreground">{balance?.database_configured === false || /数据库连接/.test(balance?.message || "") ? session.role === "admin" ? "请先配置数据库连接" : "数据库连接未配置，请联系管理员" : balance?.message || "暂时无法读取账户余额"}</div>}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}

type ProfileSection = "account" | "keys" | "creation" | "storage";

function profileSectionFromHash(): ProfileSection {
  if (typeof window === "undefined") return "account";
  const hash = decodeURIComponent(window.location.hash.slice(1));
  return (["account", "keys", "creation", "storage"] as const).includes(hash as ProfileSection) ? hash as ProfileSection : "account";
}

function ProfileContent({ session }: { session: StoredAuthSession }) {
  const [balance, setBalance] = useState<ProfileBalanceStatus | null>(null);
  const relayTokenStorageKeys = useMemo(() => ({
    text: relayTokenNameStorageKey(session, "text"),
    image: relayTokenNameStorageKey(session, "image"),
    video: relayTokenNameStorageKey(session, "video"),
    audio: relayTokenNameStorageKey(session, "audio"),
  }), [session]);
  const [selectedTokenNames, setSelectedTokenNames] = useState<Record<RelayTokenKind, string>>(() => ({
    text: getStoredRelayTokenName(session, "text"),
    image: getStoredRelayTokenName(session, "image"),
    video: getStoredRelayTokenName(session, "video"),
    audio: getStoredRelayTokenName(session, "audio"),
  }));
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [activeSection, setActiveSection] = useState<ProfileSection>(profileSectionFromHash);

  const selectRelayTokenName = useCallback((kind: RelayTokenKind, value: string) => {
    const normalizedName = value.trim();
    storeRelayTokenName(session, kind, normalizedName);
    setSelectedTokenNames((current) => ({ ...current, [kind]: normalizedName }));
    window.dispatchEvent(
      new CustomEvent(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, { detail: { kind, tokenName: normalizedName } }),
    );
  }, [session]);

  const tokenNameOptions = useMemo(
    () => normalizeTokenNames([
      ...(balance?.token_names || []),
    ]),
    [balance?.token_names],
  );
  const loadBalance = useCallback(async () => {
    setIsLoadingBalance(true);
    try {
      const nextBalance = await fetchProfileBalance();
      setBalance(nextBalance);
    } catch (error) {
      setBalance({
        has_balance: false,
        source: "newapi",
        message: error instanceof Error ? error.message : "读取云棉用户余额失败",
      });
    } finally {
      setIsLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    if (isLoadingBalance) {
      return;
    }
    (["text", "image", "video", "audio"] as const).forEach((kind) => {
      const retainedName = retainSelectedRelayTokenName(selectedTokenNames[kind], tokenNameOptions);
      if (retainedName !== selectedTokenNames[kind]) selectRelayTokenName(kind, retainedName);
    });
  }, [
    isLoadingBalance,
    selectRelayTokenName,
    selectedTokenNames,
    tokenNameOptions,
  ]);

  useEffect(() => {
    setSelectedTokenNames({
      text: getStoredRelayTokenName(session, "text"),
      image: getStoredRelayTokenName(session, "image"),
      video: getStoredRelayTokenName(session, "video"),
      audio: getStoredRelayTokenName(session, "audio"),
    });
  }, [relayTokenStorageKeys, session]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleTokenNameChange = (event: Event) => {
      if (event instanceof StorageEvent) {
        const kind = (["text", "image", "video", "audio"] as const).find((candidate) => event.key === relayTokenStorageKeys[candidate]) || null;
        if (!kind) return;
        setSelectedTokenNames((current) => ({
          ...current,
          [kind]: getStoredRelayTokenName(session, kind),
        }));
        return;
      }
      const detail = (event as CustomEvent<{ kind?: RelayTokenKind; tokenName?: string }>).detail;
      if (!detail?.kind) return;
      setSelectedTokenNames((current) => ({
        ...current,
        [detail.kind!]: String(detail.tokenName ?? getStoredRelayTokenName(session, detail.kind!)).trim(),
      }));
    };
    window.addEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
    window.addEventListener("storage", handleTokenNameChange);
    return () => {
      window.removeEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
      window.removeEventListener("storage", handleTokenNameChange);
    };
  }, [relayTokenStorageKeys, session]);

  useEffect(() => {
    void loadBalance();
  }, [session.key, loadBalance]);

  useEffect(() => {
    const handleHashChange = () => setActiveSection(profileSectionFromHash());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const selectSection = (section: ProfileSection) => {
    setActiveSection(section);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${section}`);
  };

  const profileItems = [
    { id: "account" as const, label: "账户概览", icon: UserCircle2 },
    { id: "keys" as const, label: "Key 选择", icon: KeyRound },
    { id: "creation" as const, label: "创作偏好", icon: Settings2 },
    { id: "storage" as const, label: "素材存储", icon: HardDrive },
  ];

  return (
    <ScrollArea className="h-full min-h-0">
      <div data-profile-layout className="grid w-full grid-cols-[minmax(0,1fr)] items-start gap-4 pr-1 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-5 2xl:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-border bg-background p-2 lg:sticky lg:top-0">
          <div className="px-2 pb-2 pt-1 lg:pb-3"><h1 className="text-base font-semibold text-foreground">个人设置</h1><p className="mt-0.5 text-xs text-muted-foreground">管理账户与创作偏好</p></div>
          <nav className="flex gap-1 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0" aria-label="个人设置分类">
            {profileItems.map((item) => { const Icon = item.icon; const active = item.id === activeSection; return <button key={item.id} type="button" onClick={() => selectSection(item.id)} className={`flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-left text-sm transition lg:w-full lg:gap-2.5 ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon className="size-4" /><span>{item.label}</span></button>; })}
          </nav>
        </aside>
        <main id={activeSection} className="min-w-0">
          <div hidden={activeSection !== "account"}><AccountOverviewCard balance={balance} isLoading={isLoadingBalance} onRefresh={() => void loadBalance()} session={session} /></div>
          <div hidden={activeSection !== "keys"}><AccountResourcesCard selectedTokenNames={selectedTokenNames} tokenNameOptions={tokenNameOptions} onTokenNameChange={selectRelayTokenName} /></div>
          <div hidden={activeSection !== "creation"}><ImageGenerationPreferencesCard audioRelayTokenName={selectedTokenNames.audio} sessionKey={session.key} /></div>
          <div hidden={activeSection !== "storage"}><StorageProviderCard /></div>
        </main>
      </div>
    </ScrollArea>
  );
}

export default function ProfilePage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/profile");
  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }
  return <ProfileContent session={session} />;
}
