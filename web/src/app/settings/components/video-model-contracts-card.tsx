"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Braces,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Copy,
  Download,
  Eye,
  FileText,
  Film,
  FlaskConical,
  History,
  ImagePlus,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { FileUploadButton } from "@/components/ui/file-upload-button";
import { Input } from "@/components/ui/input";
import { InputTag } from "@/components/ui/input-tag";
import { NumberInput } from "@/components/ui/number-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  VideoSettingsPanel,
  type VideoSettingsValue,
} from "@/components/generation/video-settings-panel";
import {
  createVideoModelContract,
  deleteVideoModelContract,
  fetchAdminVideoModelContracts,
  fetchImageGenerationPreferences,
  fetchModelConfig,
  fetchVideoModelContractVersions,
  importVideoModelContract,
  importVideoModelContractJSON,
  previewVideoModelContract,
  publishVideoModelContract,
  rollbackVideoModelContract,
  saveVideoModelContractDraft,
  setVideoModelContractEnabled,
  validateVideoModelContract,
  type ManagedVideoModelContract,
  type VideoModelContractPreviewResult,
  type VideoModelContractMutation,
  type VideoModelContractTransferDocument,
  type VideoModelContractVersion,
} from "@/lib/api";
import {
  activeVideoModelContracts,
  installVideoModelContracts,
  cloneVideoModelContract,
  videoContractUIState,
  type VideoModelContract,
  type VideoModelContractRule,
  type VideoModelContractRuleField,
  type VideoModelGenerationMode,
} from "@/lib/video-model-contracts";
import { cn } from "@/lib/utils";

import {
  ALL_VIDEO_MODEL_CONTRACTS_SCOPE,
  VideoModelContractMutationTracker,
  type VideoModelContractMutationDecision,
  type VideoModelContractMutationTicket,
} from "./video-model-contract-mutation-tracker";
import {
  SettingsCard,
  SettingsEmptyState,
  settingsDialogInputClassName,
  settingsPanelClassName,
} from "./settings-ui";

type ContractDraft = {
  contract: VideoModelContract;
  enabled: boolean;
  models: string[];
  sizes: string[];
  seconds: string[];
  resolutions: string[];
  queuedStatuses: string[];
  processingStatuses: string[];
  successStatuses: string[];
  failureStatuses: string[];
  taskIDFields: string[];
  statusFields: string[];
  progressFields: string[];
  errorFields: string[];
  resultFields: string[];
};

const CONTRACT_PREVIEW_MODEL = "__video-contract-parameter-preview__";

const VIDEO_CONTRACT_DRIVERS: Array<{
  value: VideoModelContract["driver"];
  label: string;
}> = [
  {
    value: "openai-videos",
    label: "OpenAI Videos / Sora",
  },
  {
    value: "xai-videos",
    label: "xAI Videos",
  },
  {
    value: "gemini-veo",
    label: "Gemini Veo",
  },
  {
    value: "vertex-veo",
    label: "Vertex AI Veo",
  },
  {
    value: "dashscope-video",
    label: "DashScope / 通义万相",
  },
  {
    value: "volcengine-video",
    label: "Volcengine / Seedance / 即梦",
  },
  {
    value: "kling-video",
    label: "Kling Video",
  },
  {
    value: "minimax-video",
    label: "MiniMax / Hailuo",
  },
  {
    value: "vidu-video",
    label: "Vidu Video",
  },
  {
    value: "kie-video",
    label: "KIE Video",
  },
  {
    value: "apimart-video",
    label: "APIMart Video",
  },
  {
    value: "custom-video",
    label: "自定义异步视频协议",
  },
];

function videoContractDriverLabel(driver: VideoModelContract["driver"]) {
  return VIDEO_CONTRACT_DRIVERS.find((item) => item.value === driver)?.label || driver;
}

const REQUEST_FIELD_HELP: Record<keyof VideoModelContract["request"], string> = {
  duration_field: "上游 API 请求体中接收视频时长的字段路径，例如 duration 或 metadata.durationSeconds。",
  aspect_ratio_field: "上游 API 请求体中接收画幅比例的字段路径，例如 ratio 或 metadata.aspectRatio。",
  resolution_field: "上游 API 请求体中接收清晰度的字段路径，例如 resolution 或 metadata.resolution。",
  generate_audio_field: "上游 API 请求体中控制是否生成音频的字段名，例如 generate_audio；接口不支持时留空。",
  watermark_field: "上游 API 请求体中控制水印开关的字段名；接口不支持时留空。",
  generation_mode_field: "上游 API 请求体中区分文生视频、首尾帧或多模态参考模式的字段名。",
  first_frame_field: "上游 API 请求体中接收首帧图片地址的字段名；不支持首帧时留空。",
  last_frame_field: "上游 API 请求体中接收尾帧图片地址的字段名；不支持尾帧时留空。",
  reference_images_field: "上游 API 请求体中接收普通参考图片列表的字段名。",
  reference_videos_field: "上游 API 请求体中接收参考视频列表的字段名。",
  reference_audios_field: "上游 API 请求体中接收参考音频列表的字段名。",
};

const emptyContract: VideoModelContract = {
  name: "",
  models: [],
  priority: 0,
  driver: "openai-videos",
  transport: {
    local_material: "url",
    multipart_file_field: "",
    multipart_repeatable: false,
    multipart_mixed_urls: false,
    create_path: "",
    query_path: "",
  },
  artifact: { mode: "response_url", content_path: "", auth: "none", allowed_hosts: [] },
  capability: {
    sizes: ["16:9", "9:16", "1:1"],
    seconds: [5],
    resolutions: ["720p"],
    default_size: "16:9",
    default_seconds: 5,
    default_resolution: "720p",
    references: { image: 0, video: 0, audio: 0, total: 0 },
    first_frame_image_limit: 0,
    reference_mode: false,
    audio_control: "none",
    watermark: false,
  },
  validation: { max_prompt_characters: 5000, allow_audio_only_reference: false },
  generation: {
    selection: "infer",
    default_mode: "text-to-video",
    modes: [{
      id: "text-to-video",
      label: "文生视频",
      kind: "text",
      request_value: "text-to-video",
      materials: {
        first_frame: { min: 0, max: 0 },
        last_frame: { min: 0, max: 0 },
        image: { min: 0, max: 0 },
        video: { min: 0, max: 0 },
        audio: { min: 0, max: 0 },
        total: { min: 0, max: 0 },
      },
    }],
  },
  rules: [],
  request: {
    duration_field: "duration",
    aspect_ratio_field: "ratio",
    resolution_field: "resolution",
    generate_audio_field: "",
    watermark_field: "watermark",
    generation_mode_field: "generation_mode",
    first_frame_field: "image_url",
    last_frame_field: "last_image_url",
    reference_images_field: "reference_image_urls",
    reference_videos_field: "reference_video_urls",
    reference_audios_field: "reference_audio_urls",
  },
  polling: {
    interval_seconds: 5,
    timeout_seconds: 900,
    task_id_fields: ["id", "task_id", "data.id", "data.task_id"],
    status_fields: ["status", "data.status"],
    progress_fields: ["progress", "data.progress"],
    error_fields: ["error.message", "message", "data.error.message", "data.message"],
    queued_statuses: ["queued"],
    processing_statuses: ["in_progress"],
    success_statuses: ["completed"],
    failure_statuses: ["failed", "cancelled"],
    result_fields: ["video_url", "video_urls", "url"],
  },
};

function cloneContract(contract: VideoModelContract) {
  return structuredClone(contract);
}

function draftFromContract(contract: VideoModelContract, enabled: boolean): ContractDraft {
  const value = cloneVideoModelContract(contract);
  return {
    contract: value,
    enabled,
    models: [...value.models],
    sizes: [...value.capability.sizes],
    seconds: value.capability.seconds.map(String),
    resolutions: [...value.capability.resolutions],
    queuedStatuses: [...(value.polling.queued_statuses || ["queued"])],
    processingStatuses: [...(value.polling.processing_statuses || ["in_progress"])],
    successStatuses: [...value.polling.success_statuses],
    failureStatuses: [...value.polling.failure_statuses],
    taskIDFields: [...value.polling.task_id_fields],
    statusFields: [...value.polling.status_fields],
    progressFields: [...(value.polling.progress_fields || ["progress"])],
    errorFields: [...value.polling.error_fields],
    resultFields: [...value.polling.result_fields],
  };
}

function newDraft() {
  return draftFromContract(emptyContract, true);
}

function normalizeTags(value: string[] | string | null | undefined) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function mutationFromDraft(draft: ContractDraft, existingID = ""): VideoModelContractMutation {
  const contract = cloneContract(draft.contract);
  contract.models = normalizeTags(draft.models);
  contract.capability.sizes = normalizeTags(draft.sizes);
  contract.capability.seconds = normalizeTags(draft.seconds)
    .map(Number)
    .filter((value) => Number.isInteger(value));
  contract.capability.resolutions = normalizeTags(draft.resolutions);
  contract.polling.queued_statuses = normalizeTags(draft.queuedStatuses);
  contract.polling.processing_statuses = normalizeTags(draft.processingStatuses);
  contract.polling.success_statuses = normalizeTags(draft.successStatuses);
  contract.polling.failure_statuses = normalizeTags(draft.failureStatuses);
  contract.polling.task_id_fields = normalizeTags(draft.taskIDFields);
  contract.polling.status_fields = normalizeTags(draft.statusFields);
  contract.polling.progress_fields = normalizeTags(draft.progressFields);
  contract.polling.error_fields = normalizeTags(draft.errorFields);
  contract.polling.result_fields = normalizeTags(draft.resultFields);
  const imageModes = contract.generation.modes.filter((mode) => mode.kind === "image");
  const referenceModes = contract.generation.modes.filter((mode) => mode.kind === "reference");
  contract.capability.first_frame_image_limit = Math.max(0, ...imageModes.map((mode) => mode.materials.first_frame.max + mode.materials.last_frame.max));
  contract.capability.reference_mode = referenceModes.length > 0;
  contract.capability.references = {
    image: Math.max(0, ...referenceModes.map((mode) => mode.materials.image.max)),
    video: Math.max(0, ...referenceModes.map((mode) => mode.materials.video.max)),
    audio: Math.max(0, ...referenceModes.map((mode) => mode.materials.audio.max)),
    total: Math.max(0, ...referenceModes.map((mode) => mode.materials.total.max)),
  };
  return { contract, enabled: draft.enabled, ...(existingID ? { existing_id: existingID } : {}) };
}

function installEnabledContracts(items: ManagedVideoModelContract[]) {
  installVideoModelContracts(items.filter((item) => item.enabled).map((item) => item.contract));
}

function mergeManagedVideoModelContract(
  current: ManagedVideoModelContract[],
  item: ManagedVideoModelContract,
  responseItems: ManagedVideoModelContract[],
) {
  const next = current.some((candidate) => candidate.id === item.id)
    ? current.map((candidate) => candidate.id === item.id ? item : candidate)
    : [...current, item];
  const responseOrder = new Map(responseItems.map((candidate, index) => [candidate.id, index]));
  return next
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const leftOrder = responseOrder.get(left.candidate.id);
      const rightOrder = responseOrder.get(right.candidate.id);
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

function videoContractTransferDocument(items: Array<Pick<ManagedVideoModelContract, "contract" | "enabled">>): VideoModelContractTransferDocument {
  return {
    version: 4,
    contracts: items.map((item) => ({ contract: cloneContract(item.contract), enabled: item.enabled })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJSONObject(value: string, label: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label}必须是 JSON 对象`);
  return parsed;
}

function previewInputJSON(contract: VideoModelContract) {
  const pattern = contract.models[0] || "video-model";
  const model = pattern.replaceAll("*", "preview");
  return JSON.stringify({
    model,
    prompt: "示例视频提示词",
    seconds: contract.capability.default_seconds,
    size: contract.capability.default_size,
    resolution: contract.capability.default_resolution,
  }, null, 2);
}

function normalizeVideoContractTransferDocument(value: unknown): VideoModelContractTransferDocument {
  if (!isRecord(value)) {
    throw new Error("导入文件必须是视频模型契约 v4 JSON 对象");
  }
  if (value.version !== 4) {
    throw new Error(`不支持的契约导入版本 ${String(value.version ?? "未填写")}`);
  }
  if (!Array.isArray(value.contracts)) {
    throw new Error("导入文件缺少 contracts 数组");
  }
  const contracts = value.contracts.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.contract) || typeof entry.enabled !== "boolean") {
      throw new Error("导入文件中存在无效的契约条目");
    }
    return {
      contract: entry.contract as unknown as VideoModelContract,
      enabled: entry.enabled,
    };
  });
  if (contracts.length === 0) throw new Error("导入文件中没有视频模型契约");
  return { version: 4, contracts };
}

function downloadVideoContractDocument(bundle: VideoModelContractTransferDocument, filename: string) {
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function videoContractExportName(name: string) {
  const safeName = name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return `${safeName || "video-model-contract"}.json`;
}

function formatDateTime(value: string) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDurationRange(values: number[]) {
  if (values.length === 0) return "上游默认时长";
  if (values.length === 1) return `${values[0]} 秒`;
  return `${values[0]}-${values.at(-1)} 秒`;
}

function referenceTypeCount(contract: VideoModelContract) {
  const references = contract.capability.references;
  return [
    contract.capability.first_frame_image_limit > 0,
    references.image > 0,
    references.video > 0,
    references.audio > 0,
  ].filter(Boolean).length;
}

function SectionTitle({ children, description }: { children: string; description?: string }) {
  return (
    <div className="space-y-1 border-b border-border/70 pb-3">
      <h3 className="text-sm font-semibold text-foreground">{children}</h3>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function ContractHelpIcon({ help, label }: { help: string; label: string }) {
  return (
    <TooltipHint content={help}>
      <button
        type="button"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        aria-label={`${label}说明`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <CircleHelp className="size-3.5" />
      </button>
    </TooltipHint>
  );
}

function ContractFieldLabel({ help, htmlFor, label }: { help?: string; htmlFor: string; label: string }) {
  return (
    <div className="flex min-h-5 items-center gap-1.5">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {help ? <ContractHelpIcon help={help} label={label} /> : null}
    </div>
  );
}

function ContractCheckboxField({
  checked,
  className,
  disabled,
  help,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  help?: string;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex min-h-10 items-center gap-2.5 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm font-medium text-foreground transition-[border-color,background-color,color]",
        disabled && "border-border/60 bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(Boolean(value))} />
      <label htmlFor={id} className={cn("min-w-0 flex-1", disabled ? "cursor-not-allowed" : "cursor-pointer")}>{label}</label>
      {help ? <ContractHelpIcon help={help} label={label} /> : null}
    </div>
  );
}

function TextField({
  disabled,
  description,
  help,
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  description?: string;
  help?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <Field className="self-start">
      <ContractFieldLabel htmlFor={id} label={label} help={help} />
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        className={settingsDialogInputClassName}
        onChange={(event) => onChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function NumericField({
  disabled,
  id,
  help,
  label,
  max,
  min = 0,
  onChange,
  suffix,
  value,
}: {
  disabled?: boolean;
  id: string;
  help?: string;
  label: string;
  max: number;
  min?: number;
  onChange: (value: number) => void;
  suffix?: string;
  value: number;
}) {
  return (
    <Field>
      <ContractFieldLabel htmlFor={id} label={label} help={help} />
      <NumberInput
        id={id}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        suffix={suffix}
        onValueChange={(next) => onChange(Number(next) || 0)}
      />
    </Field>
  );
}

function TagListField({
  description,
  disabled,
  id,
  help,
  invalidMessage,
  label,
  onValueChange,
  placeholder,
  validateTag,
  value,
}: {
  description?: string;
  disabled?: boolean;
  id: string;
  help?: string;
  invalidMessage?: string;
  label: string;
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  validateTag?: (tag: string) => boolean;
  value: string[] | null | undefined;
}) {
  return (
    <Field className="self-start">
      <ContractFieldLabel htmlFor={id} label={label} help={help} />
      <InputTag
        id={id}
        value={normalizeTags(value)}
        disabled={disabled}
        className="min-h-11"
        placeholder={placeholder}
        validateTag={validateTag}
        onValueChange={onValueChange}
        onTagRejected={invalidMessage ? (_tag, reason) => {
          if (reason === "invalid") toast.error(invalidMessage);
        } : undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

const MATERIAL_RANGE_FIELDS = [
  ["first_frame", "首帧"],
  ["last_frame", "尾帧"],
  ["image", "参考图片"],
  ["video", "参考视频"],
  ["audio", "参考音频"],
  ["total", "素材合计"],
] as const;

const MODE_KIND_META: Record<VideoModelGenerationMode["kind"], { shortLabel: string }> = {
  text: { shortLabel: "文生" },
  image: { shortLabel: "图生" },
  reference: { shortLabel: "参考" },
};

const CONTRACT_RULE_FIELDS: Array<{ label: string; value: VideoModelContractRuleField }> = [
  { value: "first_frame", label: "首帧" },
  { value: "last_frame", label: "尾帧" },
  { value: "reference_image", label: "参考图片" },
  { value: "reference_video", label: "参考视频" },
  { value: "reference_audio", label: "参考音频" },
  { value: "generate_audio", label: "音频生成" },
  { value: "size", label: "画幅" },
  { value: "resolution", label: "清晰度" },
  { value: "duration", label: "时长" },
  { value: "watermark", label: "水印" },
];

const CONTRACT_RULE_FIELD_SET = new Set(CONTRACT_RULE_FIELDS.map((item) => item.value));

function recordTags(values: Record<string, string | number> | undefined) {
  return Object.entries(values || {}).map(([field, value]) => `${field}=${value}`);
}

function tagsToIntRecord(values: string[]) {
  return Object.fromEntries(values.flatMap((value) => {
    const [field, rawValue] = value.split("=", 2).map((item) => item.trim());
    const parsed = Number(rawValue);
    return CONTRACT_RULE_FIELD_SET.has(field as VideoModelContractRuleField) && Number.isInteger(parsed) ? [[field, parsed]] : [];
  }));
}

function tagsToStringRecord(values: string[]) {
  return Object.fromEntries(values.flatMap((value) => {
    const separator = value.indexOf("=");
    const field = value.slice(0, separator).trim();
    const fieldValue = value.slice(separator + 1).trim();
    return separator > 0 && CONTRACT_RULE_FIELD_SET.has(field as VideoModelContractRuleField) && fieldValue ? [[field, fieldValue]] : [];
  }));
}

function ContractModeEditor({
  canRemove,
  disabled,
  index,
  mode,
  onChange,
  onRemove,
}: {
  canRemove: boolean;
  disabled: boolean;
  index: number;
  mode: VideoModelGenerationMode;
  onChange: (mode: VideoModelGenerationMode) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(index === 0);
  const updateRange = (field: keyof VideoModelGenerationMode["materials"], key: "min" | "max", value: number) => {
    onChange({
      ...mode,
      materials: { ...mode.materials, [field]: { ...mode.materials[field], [key]: value } },
    });
  };
  const hasMaterialLimit = MATERIAL_RANGE_FIELDS.some(([field]) => mode.materials[field].min > 0 || mode.materials[field].max > 0);
  return (
    <details
      data-video-contract-mode
      className="group overflow-hidden rounded-lg border border-border/70 bg-background transition-colors open:border-border"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/35 [&::-webkit-details-marker]:hidden">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {mode.kind === "text" ? <FileText className="size-4" /> : mode.kind === "image" ? <ImagePlus className="size-4" /> : <Link2 className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{mode.label || "未命名模式"}</span>
            <Badge variant="secondary" className="h-5 shrink-0 rounded px-1.5 text-[11px] font-medium">{MODE_KIND_META[mode.kind].shortLabel}</Badge>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {hasMaterialLimit ? "已配置素材数量限制" : "不接收参考素材"}
          </span>
        </span>
        <code className="hidden max-w-48 truncate rounded bg-muted/70 px-2 py-1 text-[11px] text-muted-foreground md:block">{mode.request_value || "不发送模式值"}</code>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="space-y-5 border-t border-border/70 bg-muted/15 p-4">
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <TextField id={`video-contract-mode-label-${index}`} label="显示名称" value={mode.label} disabled={disabled} onChange={(label) => onChange({ ...mode, label })} />
          <Field>
            <ContractFieldLabel htmlFor={`video-contract-mode-kind-${index}`} label="模式类型" help="模式类型决定系统如何根据素材自动选择模式。" />
            <Select value={mode.kind} disabled={disabled} onValueChange={(kind) => onChange({ ...mode, kind: kind as VideoModelGenerationMode["kind"] })}>
              <SelectTrigger id={`video-contract-mode-kind-${index}`} className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="text">文生视频</SelectItem><SelectItem value="image">图生视频</SelectItem><SelectItem value="reference">参考素材生视频</SelectItem></SelectContent>
            </Select>
          </Field>
          <TextField id={`video-contract-mode-id-${index}`} label="模式标识" value={mode.id} disabled={disabled} onChange={(id) => onChange({ ...mode, id })} />
          <TextField id={`video-contract-mode-request-${index}`} label="上游请求值" value={mode.request_value} disabled={disabled} placeholder="例如 image-to-video" onChange={(request_value) => onChange({ ...mode, request_value })} />
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-foreground">素材数量限制</p>
              <p className="mt-0.5 text-xs text-muted-foreground">0 表示该模式不接收对应素材</p>
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground">最少 / 最多</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {MATERIAL_RANGE_FIELDS.map(([field, label]) => (
              <div key={field} className="min-w-0 rounded-lg border border-border/60 bg-background p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-foreground">{label}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{mode.materials[field].min}–{mode.materials[field].max}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput aria-label={`${mode.label}${label}最少数量`} controlsLayout="split" className="h-9" min={0} max={80} value={mode.materials[field].min} disabled={disabled} onValueChange={(value) => updateRange(field, "min", Number(value) || 0)} />
                  <NumberInput aria-label={`${mode.label}${label}最多数量`} controlsLayout="split" className="h-9" min={0} max={80} value={mode.materials[field].max} disabled={disabled} onValueChange={(value) => updateRange(field, "max", Number(value) || 0)} />
                </div>
              </div>
            ))}
          </div>
        </div>
        {!disabled && canRemove ? <div className="flex justify-end border-t border-border/60 pt-3"><Button type="button" variant="ghost" size="sm" className="text-rose-600 hover:text-rose-700" onClick={onRemove}><Trash2 className="size-4" />删除模式</Button></div> : null}
      </div>
    </details>
  );
}

function ContractRuleEditor({ disabled, index, onChange, onRemove, rule }: {
  disabled: boolean;
  index: number;
  onChange: (rule: VideoModelContractRule) => void;
  onRemove: () => void;
  rule: VideoModelContractRule;
}) {
  const fieldTagsValid = (value: string) => CONTRACT_RULE_FIELD_SET.has(value as VideoModelContractRuleField);
  return (
    <div data-video-contract-rule className="space-y-4 rounded-lg border border-border/70 bg-muted/15 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">规则 {index + 1}</p>
        {!disabled ? <Button type="button" variant="ghost" size="icon" className="size-8 text-rose-600" title="删除规则" onClick={onRemove}><Trash2 className="size-4" /></Button> : null}
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field>
          <FieldLabel>条件字段</FieldLabel>
          <Select value={rule.when.field} disabled={disabled} onValueChange={(field) => onChange({ ...rule, when: { ...rule.when, field: field as VideoModelContractRuleField } })}>
            <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
            <SelectContent>{CONTRACT_RULE_FIELDS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>判断方式</FieldLabel>
          <Select value={rule.when.operator} disabled={disabled} onValueChange={(operator) => onChange({ ...rule, when: { ...rule.when, operator: operator as "present" | "equals" } })}>
            <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="present">存在或已启用</SelectItem><SelectItem value="equals">等于指定值</SelectItem></SelectContent>
          </Select>
        </Field>
        <TextField id={`video-contract-rule-value-${index}`} label="比较值" value={rule.when.value || ""} disabled={disabled || rule.when.operator !== "equals"} placeholder="例如 pro 或 true" onChange={(value) => onChange({ ...rule, when: { ...rule.when, value } })} />
        <TagListField id={`video-contract-rule-require-${index}`} label="必须同时提供" value={rule.require || []} disabled={disabled} placeholder="输入字段名后按回车" validateTag={fieldTagsValid} invalidMessage="请输入受支持的规则字段名" onValueChange={(require) => onChange({ ...rule, require: require as VideoModelContractRuleField[] })} />
        <TagListField id={`video-contract-rule-require-any-${index}`} label="至少提供一项" value={rule.require_any || []} disabled={disabled} placeholder="输入字段名后按回车" validateTag={fieldTagsValid} invalidMessage="请输入受支持的规则字段名" onValueChange={(require_any) => onChange({ ...rule, require_any: require_any as VideoModelContractRuleField[] })} />
        <TagListField id={`video-contract-rule-forbid-${index}`} label="禁止同时提供" value={rule.forbid || []} disabled={disabled} placeholder="输入字段名后按回车" validateTag={fieldTagsValid} invalidMessage="请输入受支持的规则字段名" onValueChange={(forbid) => onChange({ ...rule, forbid: forbid as VideoModelContractRuleField[] })} />
        <TagListField id={`video-contract-rule-limits-${index}`} label="条件上限" value={recordTags(rule.limits)} disabled={disabled} placeholder="例如 reference_image=1" onValueChange={(values) => onChange({ ...rule, limits: tagsToIntRecord(values) })} />
        <TagListField id={`video-contract-rule-force-${index}`} label="强制参数值" value={recordTags(rule.force_values)} disabled={disabled} placeholder="例如 duration=8" onValueChange={(values) => onChange({ ...rule, force_values: tagsToStringRecord(values) })} />
        <TagListField id={`video-contract-rule-ui-show-${index}`} label="命中后显示" value={rule.ui?.show || []} disabled={disabled} placeholder="例如 watermark" validateTag={fieldTagsValid} invalidMessage="请输入受支持的规则字段名" onValueChange={(show) => onChange({ ...rule, ui: { ...rule.ui, show: show as VideoModelContractRuleField[] } })} />
        <TagListField id={`video-contract-rule-ui-hide-${index}`} label="命中后隐藏" value={rule.ui?.hide || []} disabled={disabled} placeholder="例如 reference_audio" validateTag={fieldTagsValid} invalidMessage="请输入受支持的规则字段名" onValueChange={(hide) => onChange({ ...rule, ui: { ...rule.ui, hide: hide as VideoModelContractRuleField[] } })} />
        <TagListField id={`video-contract-rule-ui-disable-${index}`} label="命中后禁用" value={rule.ui?.disable || []} disabled={disabled} placeholder="例如 duration" validateTag={fieldTagsValid} invalidMessage="请输入受支持的规则字段名" onValueChange={(disable) => onChange({ ...rule, ui: { ...rule.ui, disable: disable as VideoModelContractRuleField[] } })} />
        <div className="sm:col-span-2"><TextField id={`video-contract-rule-message-${index}`} label="校验提示" value={rule.message} disabled={disabled} placeholder="不满足关系时显示的中文提示" onChange={(message) => onChange({ ...rule, message })} /></div>
      </div>
    </div>
  );
}

function previewSettingsFromContract(contract: VideoModelContract): VideoSettingsValue {
  const resolution = contract.capability.default_resolution || contract.capability.resolutions[0] || "";
  return {
    size: contract.capability.default_size || contract.capability.sizes[0] || "",
    seconds: String(contract.capability.default_seconds || contract.capability.seconds[0] || 1),
    resolution,
    generateAudio: contract.capability.audio_control === "always",
    watermark: false,
    taskCount: 1,
  };
}

function ContractReferenceMaterialPreview({ contract, ruleValues }: { contract: VideoModelContract; ruleValues: Record<VideoModelContractRuleField, unknown> }) {
  const frameLimit = Math.min(2, Math.max(0, contract.capability.first_frame_image_limit));
  const referenceLimits = contract.capability.references;
  const uiState = videoContractUIState(contract, ruleValues);
  const visible = (field: VideoModelContractRuleField) => !uiState.hidden.has(field);
  const visibleFrameLimit = Number(visible("first_frame")) + Number(frameLimit > 1 && visible("last_frame"));
  const hasReferences = visibleFrameLimit > 0 || referenceLimits.image > 0 && visible("reference_image") || referenceLimits.video > 0 && visible("reference_video") || referenceLimits.audio > 0 && visible("reference_audio");
  if (!hasReferences) return null;

  const uploadPreview = (label: string, max: number, icon: typeof ImagePlus) => (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <ImageParameterLabel>{label}</ImageParameterLabel>
        <span className="text-[11px] text-muted-foreground">0/{max}</span>
      </div>
      <FileUploadButton icon={icon} disabled className="h-10 disabled:opacity-70">
        上传{label}
      </FileUploadButton>
    </section>
  );

  return (
    <section data-contract-material-preview className="space-y-3 border-b border-border pb-3.5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold text-foreground">参考素材</h4>
        <span className="text-[11px] text-muted-foreground">合计上限 {contract.capability.references.total}</span>
      </div>
      {visibleFrameLimit > 0 ? (
        <section className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <ImageParameterLabel help="首帧和尾帧是独立输入，不会与普通参考图混用。">首尾帧</ImageParameterLabel>
            <span className="text-[11px] text-muted-foreground">0/{visibleFrameLimit}</span>
          </div>
          <div className={visibleFrameLimit > 1 ? "grid grid-cols-2 gap-2" : "grid grid-cols-1"}>
            {visible("first_frame") ? <FileUploadButton icon={ImagePlus} disabled className="h-10 disabled:opacity-70">上传首帧</FileUploadButton> : null}
            {frameLimit > 1 && visible("last_frame") ? <FileUploadButton icon={ImagePlus} disabled className="h-10 disabled:opacity-70">上传尾帧</FileUploadButton> : null}
          </div>
        </section>
      ) : null}
      {referenceLimits.image > 0 && visible("reference_image") ? uploadPreview("参考图", referenceLimits.image, ImagePlus) : null}
      {referenceLimits.video > 0 && visible("reference_video") ? uploadPreview("参考视频", referenceLimits.video, Video) : null}
      {referenceLimits.audio > 0 && visible("reference_audio") ? uploadPreview("参考音频", referenceLimits.audio, AudioLines) : null}
    </section>
  );
}

function ContractParameterPreview({ contract }: { contract: VideoModelContract }) {
  const [isReady, setIsReady] = useState(false);
  const [value, setValue] = useState<VideoSettingsValue>(() => previewSettingsFromContract(contract));

  useEffect(() => {
    const previousContracts = activeVideoModelContracts();
    const previewContract = cloneContract(contract);
    previewContract.models = [CONTRACT_PREVIEW_MODEL];
    installVideoModelContracts([
      ...previousContracts.filter((item) => !item.models.includes(CONTRACT_PREVIEW_MODEL)),
      previewContract,
    ]);
    setIsReady(true);
    return () => installVideoModelContracts(
      activeVideoModelContracts().filter((item) => !item.models.includes(CONTRACT_PREVIEW_MODEL)),
    );
  }, [contract]);

  const modelLabel = contract.models[0] || "未填写模型名称";
  const ruleValues: Record<VideoModelContractRuleField, unknown> = {
    first_frame: "",
    last_frame: "",
    reference_image: 0,
    reference_video: 0,
    reference_audio: 0,
    generate_audio: value.generateAudio,
    size: value.size,
    resolution: value.resolution,
    duration: Number(value.seconds),
    watermark: value.watermark,
  };
  return (
    <section className="w-full overflow-hidden rounded-lg border border-border/70 bg-muted/10">
      <header className="flex min-w-0 items-center gap-2.5 border-b border-border/70 bg-background px-3.5 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <SlidersHorizontal className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">参数效果预览</h3>
          <p className="truncate text-[11px] text-muted-foreground" title={contract.models.join(", ")}>{modelLabel}</p>
        </div>
        <Badge variant="secondary" className="h-5 rounded px-1.5 text-[11px]">实时</Badge>
      </header>
      <div className="min-h-64 p-3.5">
        {isReady ? (
          <div className="flex flex-col gap-3.5">
            <ContractReferenceMaterialPreview contract={contract} ruleValues={ruleValues} />
            <VideoSettingsPanel
              model={CONTRACT_PREVIEW_MODEL}
              value={value}
              ruleValues={ruleValues}
              onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
            />
          </div>
        ) : (
          <div className="flex min-h-56 items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
        )}
      </div>
    </section>
  );
}

export function VideoModelContractsCard({ sessionKey }: { sessionKey: string }) {
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const jsonImportInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const currentSessionKeyRef = useRef(sessionKey);
  const itemsRef = useRef<ManagedVideoModelContract[]>([]);
  const contractLoadControllerRef = useRef<AbortController | null>(null);
  const contractLoadVersionRef = useRef(0);
  const contractLoadResetRef = useRef(false);
  const versionsLoadControllerRef = useRef<AbortController | null>(null);
  const versionsLoadVersionRef = useRef(0);
  const mutationTrackerRef = useRef<VideoModelContractMutationTracker | null>(null);
  currentSessionKeyRef.current = sessionKey;
  if (!mutationTrackerRef.current) {
    mutationTrackerRef.current = new VideoModelContractMutationTracker(sessionKey);
  } else {
    mutationTrackerRef.current.activateSession(sessionKey);
  }
  const [items, setItems] = useState<ManagedVideoModelContract[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ManagedVideoModelContract | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [draft, setDraft] = useState<ContractDraft>(newDraft);
  const [deletingItem, setDeletingItem] = useState<ManagedVideoModelContract | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSourceType, setImportSourceType] = useState<"file" | "url">("file");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importURL, setImportURL] = useState("");
  const [importModel, setImportModel] = useState("");
  const [importTokenName, setImportTokenName] = useState("");
  const [textModels, setTextModels] = useState<string[]>([]);
  const [isLoadingImportOptions, setIsLoadingImportOptions] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isJSONImporting, setIsJSONImporting] = useState(false);
  const [pendingJSONImport, setPendingJSONImport] = useState<{
    filename: string;
    bundle: VideoModelContractTransferDocument;
  } | null>(null);
  const [versionsItem, setVersionsItem] = useState<ManagedVideoModelContract | null>(null);
  const [versions, setVersions] = useState<VideoModelContractVersion[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [previewInput, setPreviewInput] = useState("{}");
  const [previewSubmitResponse, setPreviewSubmitResponse] = useState("{}");
  const [previewQueryResponse, setPreviewQueryResponse] = useState("{}");
  const [previewResult, setPreviewResult] = useState<VideoModelContractPreviewResult | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const isCurrentSession = useCallback((targetSessionKey: string) => (
    mountedRef.current && currentSessionKeyRef.current === targetSessionKey
  ), []);

  const commitItems = useCallback((
    targetSessionKey: string,
    value: ManagedVideoModelContract[] | ((current: ManagedVideoModelContract[]) => ManagedVideoModelContract[]),
  ) => {
    if (!isCurrentSession(targetSessionKey)) return false;
    const next = typeof value === "function" ? value(itemsRef.current) : value;
    itemsRef.current = next;
    setItems(next);
    installEnabledContracts(next);
    return true;
  }, [isCurrentSession]);

  const loadContracts = useCallback(async (targetSessionKey: string, reset: boolean) => {
    const controller = new AbortController();
    const requestVersion = contractLoadVersionRef.current + 1;
    contractLoadVersionRef.current = requestVersion;
    contractLoadControllerRef.current?.abort();
    contractLoadControllerRef.current = controller;
    contractLoadResetRef.current = reset;
    if (reset && isCurrentSession(targetSessionKey)) {
      itemsRef.current = [];
      setItems([]);
      setIsLoading(true);
    }
    try {
      const data = await fetchAdminVideoModelContracts({ signal: controller.signal });
      if (controller.signal.aborted || contractLoadVersionRef.current !== requestVersion) return;
      commitItems(targetSessionKey, data.items);
    } catch (error) {
      if (controller.signal.aborted || contractLoadVersionRef.current !== requestVersion || !isCurrentSession(targetSessionKey)) return;
      toast.error(error instanceof Error ? error.message : "加载视频模型契约失败");
    } finally {
      if (contractLoadVersionRef.current === requestVersion) {
        contractLoadControllerRef.current = null;
        contractLoadResetRef.current = false;
        if (isCurrentSession(targetSessionKey)) setIsLoading(false);
      }
    }
  }, [commitItems, isCurrentSession]);

  useEffect(() => {
    mountedRef.current = true;
    mutationTrackerRef.current?.activateSession(sessionKey);
    void loadContracts(sessionKey, true);
    return () => {
      mountedRef.current = false;
      mutationTrackerRef.current?.deactivateSession(sessionKey);
      contractLoadVersionRef.current += 1;
      contractLoadControllerRef.current?.abort();
      contractLoadControllerRef.current = null;
      contractLoadResetRef.current = false;
    };
  }, [loadContracts, sessionKey]);

  useEffect(() => () => {
    versionsLoadVersionRef.current += 1;
    versionsLoadControllerRef.current?.abort();
    versionsLoadControllerRef.current = null;
  }, []);

  const beginMutation = (scope: string) => {
    const interruptedResetLoad = contractLoadResetRef.current;
    contractLoadVersionRef.current += 1;
    contractLoadControllerRef.current?.abort();
    contractLoadControllerRef.current = null;
    contractLoadResetRef.current = false;
    if (interruptedResetLoad) setIsLoading(false);
    return mutationTrackerRef.current!.begin(scope);
  };

  const reconcileMutation = (
    ticket: VideoModelContractMutationTicket,
    decision: VideoModelContractMutationDecision,
  ) => {
    if (decision.reconcile) void loadContracts(ticket.sessionKey, false);
  };

  const applyMutationResult = (
    ticket: VideoModelContractMutationTicket,
    responseItems: ManagedVideoModelContract[],
    mergeConcurrent: (current: ManagedVideoModelContract[]) => ManagedVideoModelContract[],
  ) => {
    const decision = mutationTrackerRef.current!.complete(ticket, true);
    if (decision.current && decision.applySnapshot) {
      commitItems(ticket.sessionKey, decision.concurrent ? mergeConcurrent : responseItems);
    }
    reconcileMutation(ticket, decision);
    return decision.current;
  };

  const rejectMutation = (ticket: VideoModelContractMutationTicket) => {
    const decision = mutationTrackerRef.current!.complete(ticket, false);
    reconcileMutation(ticket, decision);
    return decision.current;
  };

  const updateContract = (update: (contract: VideoModelContract) => void) => {
    setDraft((current) => {
      const contract = cloneContract(current.contract);
      update(contract);
      return { ...current, contract };
    });
  };

  const updateGenerationMode = (index: number, mode: VideoModelGenerationMode) => {
    updateContract((contract) => {
      contract.generation.modes[index] = mode;
      if (!contract.generation.modes.some((item) => item.id === contract.generation.default_mode)) {
        contract.generation.default_mode = mode.id;
      }
    });
  };

  const addGenerationMode = () => {
    updateContract((contract) => {
      const kinds: VideoModelGenerationMode["kind"][] = ["text", "image", "reference"];
      const kind = kinds.find((candidate) => !contract.generation.modes.some((mode) => mode.kind === candidate));
      if (!kind) return;
      const baseID = `${kind}-to-video`;
      let id = baseID;
      let ordinal = 2;
      while (contract.generation.modes.some((mode) => mode.id.toLowerCase() === id.toLowerCase())) {
        id = `${baseID}-${ordinal}`;
        ordinal += 1;
      }
      contract.generation.modes.push({
        id,
        label: kind === "text" ? "文生视频" : kind === "image" ? "图生视频" : "参考素材生视频",
        kind,
        request_value: kind === "text" ? "text-to-video" : kind === "image" ? "image-to-video" : "reference-to-video",
        materials: {
          first_frame: kind === "image" ? { min: 1, max: 1 } : { min: 0, max: 0 },
          last_frame: { min: 0, max: 0 },
          image: kind === "reference" ? { min: 0, max: 1 } : { min: 0, max: 0 },
          video: { min: 0, max: 0 },
          audio: { min: 0, max: 0 },
          total: kind === "text" ? { min: 0, max: 0 } : { min: 1, max: 1 },
        },
      });
    });
  };

  const removeGenerationMode = (index: number) => {
    updateContract((contract) => {
      const [removed] = contract.generation.modes.splice(index, 1);
      if (removed?.id === contract.generation.default_mode) {
        contract.generation.default_mode = contract.generation.modes[0]?.id || "";
      }
    });
  };

  const updateContractRule = (index: number, rule: VideoModelContractRule) => {
    updateContract((contract) => { contract.rules[index] = rule; });
  };

  const addContractRule = () => {
    updateContract((contract) => {
      contract.rules.push({ when: { field: "last_frame", operator: "present" }, require: ["first_frame"], message: "添加尾帧前必须先添加首帧" });
    });
  };

  const openCreate = () => {
    setEditingItem(null);
    setReadOnly(false);
    const nextDraft = newDraft();
    setDraft(nextDraft);
    setPreviewInput(previewInputJSON(nextDraft.contract));
    setPreviewSubmitResponse("{}");
    setPreviewQueryResponse("{}");
    setPreviewResult(null);
    setDialogOpen(true);
  };

  const openImport = () => {
    setImportSourceType("file");
    setImportFile(null);
    setImportURL("");
    setImportOpen(true);
    if (textModels.length > 0 || isLoadingImportOptions) return;
    setIsLoadingImportOptions(true);
    void Promise.all([fetchModelConfig(), fetchImageGenerationPreferences()])
      .then(([{ config }, { preferences }]) => {
        const models = config.text_models || [];
        const preferred = models.includes(preferences.default_text_model)
          ? preferences.default_text_model
          : config.default_text_model || models[0] || "";
        setTextModels(models);
        setImportModel(preferred);
        setImportTokenName(preferences.default_text_relay_token_names[0] || "");
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "读取文本模型设置失败"))
      .finally(() => setIsLoadingImportOptions(false));
  };

  const generateFromDocument = async () => {
    if (importSourceType === "file" && !importFile) {
      toast.error("请选择要分析的文档");
      return;
    }
    if (importSourceType === "url" && !importURL.trim()) {
      toast.error("请输入文档链接");
      return;
    }
    setIsImporting(true);
    try {
      const data = await importVideoModelContract({
        sourceType: importSourceType,
        file: importSourceType === "file" ? importFile : null,
        url: importSourceType === "url" ? importURL : "",
        model: importModel,
        tokenName: importTokenName,
      });
      setImportOpen(false);
      setEditingItem(null);
      setReadOnly(false);
      setDraft(draftFromContract(data.contract, false));
      setPreviewInput(previewInputJSON(data.contract));
      setPreviewSubmitResponse("{}");
      setPreviewQueryResponse("{}");
      setPreviewResult(null);
      setDialogOpen(true);
      if (data.warnings.length > 0) {
        toast.warning(data.warnings.join("；"));
      } else {
        toast.success("契约草稿已生成，请校验后保存");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "分析文档失败");
    } finally {
      setIsImporting(false);
    }
  };

  const openView = (item: ManagedVideoModelContract) => {
    setEditingItem(item);
    setReadOnly(true);
    setDraft(draftFromContract(item.contract, item.enabled));
    setPreviewInput(previewInputJSON(item.contract));
    setPreviewSubmitResponse("{}");
    setPreviewQueryResponse("{}");
    setPreviewResult(null);
    setDialogOpen(true);
  };

  const openEdit = (item: ManagedVideoModelContract) => {
    setEditingItem(item);
    setReadOnly(false);
    const contract = item.draft || item.contract;
    setDraft(draftFromContract(contract, item.draft_enabled ?? item.enabled));
    setPreviewInput(previewInputJSON(contract));
    setPreviewSubmitResponse("{}");
    setPreviewQueryResponse("{}");
    setPreviewResult(null);
    setDialogOpen(true);
  };

  const openCopy = (item: ManagedVideoModelContract) => {
    const copied = cloneContract(item.contract);
    copied.name = `${copied.name} 副本`.slice(0, 100);
    copied.models = [];
    setEditingItem(null);
    setReadOnly(false);
    setDraft(draftFromContract(copied, false));
    setPreviewInput(previewInputJSON(copied));
    setPreviewSubmitResponse("{}");
    setPreviewQueryResponse("{}");
    setPreviewResult(null);
    setDialogOpen(true);
  };

  const validate = async (
    showSuccess = true,
    mutationTicket?: VideoModelContractMutationTicket,
  ) => {
    const payload = mutationFromDraft(draft, editingItem?.id || "");
    const data = await validateVideoModelContract(payload);
    if (mutationTicket && !mutationTrackerRef.current!.canApply(mutationTicket)) return null;
    setDraft(draftFromContract(data.contract, draft.enabled));
    if (showSuccess) toast.success("契约校验通过");
    return { ...payload, contract: data.contract };
  };

  const saveDraft = async () => {
    if (!editingItem) return;
    const item = editingItem;
    const ticket = beginMutation(item.id);
    let current = true;
    setIsSaving(true);
    try {
      const payload = await validate(false, ticket);
      if (!payload) {
        current = rejectMutation(ticket);
        return;
      }
      const data = await saveVideoModelContractDraft(item.id, payload);
      current = applyMutationResult(ticket, data.items, (items) => mergeManagedVideoModelContract(items, data.item, data.items));
      if (!current) return;
      setDialogOpen(false);
      toast.success("草稿已保存，当前已发布版本不受影响");
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) toast.error(error instanceof Error ? error.message : "保存视频模型契约草稿失败");
    } finally {
      if (current) setIsSaving(false);
    }
  };

  const publish = async () => {
    const item = editingItem;
    const ticket = beginMutation(item?.id || "create");
    let current = true;
    setIsSaving(true);
    try {
      const payload = await validate(false, ticket);
      if (!payload) {
        current = rejectMutation(ticket);
        return;
      }
      const data = item
        ? await publishVideoModelContract(item.id, payload)
        : await createVideoModelContract(payload);
      current = applyMutationResult(ticket, data.items, (items) => mergeManagedVideoModelContract(items, data.item, data.items));
      if (!current) return;
      setDialogOpen(false);
      toast.success(item ? `契约已发布为第 ${data.item.revision} 版` : "视频模型契约已添加并发布");
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) toast.error(error instanceof Error ? error.message : "发布视频模型契约失败");
    } finally {
      if (current) setIsSaving(false);
    }
  };

  const openVersions = async (item: ManagedVideoModelContract) => {
    versionsLoadControllerRef.current?.abort();
    const controller = new AbortController();
    const requestVersion = versionsLoadVersionRef.current + 1;
    versionsLoadVersionRef.current = requestVersion;
    versionsLoadControllerRef.current = controller;
    setVersionsItem(item);
    setVersions([]);
    setIsLoadingVersions(true);
    try {
      const data = await fetchVideoModelContractVersions(item.id, { signal: controller.signal });
      if (controller.signal.aborted || versionsLoadVersionRef.current !== requestVersion) return;
      setVersions(data.versions);
    } catch (error) {
      if (controller.signal.aborted || versionsLoadVersionRef.current !== requestVersion) return;
      toast.error(error instanceof Error ? error.message : "加载契约版本失败");
    } finally {
      if (versionsLoadVersionRef.current === requestVersion) {
        versionsLoadControllerRef.current = null;
        setIsLoadingVersions(false);
      }
    }
  };

  const closeVersions = () => {
    versionsLoadVersionRef.current += 1;
    versionsLoadControllerRef.current?.abort();
    versionsLoadControllerRef.current = null;
    setVersionsItem(null);
    setVersions([]);
    setIsLoadingVersions(false);
  };

  const rollback = async (revision: number) => {
    if (!versionsItem) return;
    const item = versionsItem;
    const ticket = beginMutation(item.id);
    let current = true;
    setIsRollingBack(true);
    try {
      const data = await rollbackVideoModelContract(item.id, revision);
      current = applyMutationResult(ticket, data.items, (items) => mergeManagedVideoModelContract(items, data.item, data.items));
      if (!current) return;
      closeVersions();
      toast.success(`已基于第 ${revision} 版发布新版本`);
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) toast.error(error instanceof Error ? error.message : "回滚契约失败");
    } finally {
      if (current) setIsRollingBack(false);
    }
  };

  const toggleEnabled = async (item: ManagedVideoModelContract) => {
    const ticket = beginMutation(item.id);
    let current = true;
    setPendingIds((current) => new Set(current).add(item.id));
    try {
      const data = await setVideoModelContractEnabled(item.id, !item.enabled);
      current = applyMutationResult(ticket, data.items, (items) => mergeManagedVideoModelContract(items, data.item, data.items));
      if (!current) return;
      toast.success(item.enabled ? "契约已停用" : "契约已启用");
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) toast.error(error instanceof Error ? error.message : "更新契约状态失败");
    } finally {
      if (current) {
        setPendingIds((pending) => {
          const next = new Set(pending);
          next.delete(item.id);
          return next;
        });
      }
    }
  };

  const remove = async () => {
    if (!deletingItem) return;
    const id = deletingItem.id;
    const ticket = beginMutation(id);
    let current = true;
    setPendingIds((current) => new Set(current).add(id));
    try {
      const data = await deleteVideoModelContract(id);
      current = applyMutationResult(ticket, data.items, (items) => items.filter((item) => item.id !== id));
      if (!current) return;
      setDeletingItem(null);
      toast.success("视频模型契约已删除");
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) toast.error(error instanceof Error ? error.message : "删除视频模型契约失败");
    } finally {
      if (current) {
        setPendingIds((pending) => {
          const next = new Set(pending);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const prepareJSONImport = async (file: File | null) => {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("契约 JSON 文件不能超过 2 MB");
      const value = JSON.parse(await file.text()) as unknown;
      setPendingJSONImport({ filename: file.name, bundle: normalizeVideoContractTransferDocument(value) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取契约 JSON 失败");
    } finally {
      if (jsonImportInputRef.current) jsonImportInputRef.current.value = "";
    }
  };

  const confirmJSONImport = async () => {
    if (!pendingJSONImport) return;
    const importBundle = pendingJSONImport.bundle;
    const ticket = beginMutation(ALL_VIDEO_MODEL_CONTRACTS_SCOPE);
    let current = true;
    setIsJSONImporting(true);
    try {
      const data = await importVideoModelContractJSON(importBundle);
      current = applyMutationResult(ticket, data.items, () => data.items);
      if (!current) return;
      setPendingJSONImport(null);
      toast.success(`已导入 ${data.imported} 个契约（新增 ${data.created}，更新 ${data.updated}）`);
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) toast.error(error instanceof Error ? error.message : "导入视频模型契约失败");
    } finally {
      if (current) setIsJSONImporting(false);
    }
  };

  const capability = draft.contract.capability;
  const request = draft.contract.request;
  const transport = draft.contract.transport;
  const artifact = draft.contract.artifact;
  const polling = draft.contract.polling;
  const normalizedContract = useMemo(() => mutationFromDraft(draft).contract, [draft]);
  const contractJSON = useMemo(() => JSON.stringify(normalizedContract, null, 2), [normalizedContract]);
  const parameterPreviewKey = useMemo(() => JSON.stringify({
    models: normalizedContract.models,
    capability: normalizedContract.capability,
  }), [normalizedContract]);
  const pendingImportSummary = useMemo(() => {
    if (!pendingJSONImport) return { created: 0, updated: 0 };
    const existingNames = new Set(items.map((item) => item.contract.name.trim().toLowerCase()));
    const updated = pendingJSONImport.bundle.contracts.filter((item) => existingNames.has(item.contract.name.trim().toLowerCase())).length;
    return { created: pendingJSONImport.bundle.contracts.length - updated, updated };
  }, [items, pendingJSONImport]);

  const copyContractJSON = async () => {
    try {
      await navigator.clipboard.writeText(contractJSON);
      toast.success("契约 JSON 已复制");
    } catch {
      toast.error("复制契约 JSON 失败");
    }
  };

  const runPreview = async () => {
    setIsPreviewing(true);
    try {
      const result = await previewVideoModelContract({
        contract: normalizedContract,
        ...(editingItem ? { existing_id: editingItem.id } : {}),
        input: parseJSONObject(previewInput, "示例请求"),
        submit_response: parseJSONObject(previewSubmitResponse, "创建响应"),
        query_response: parseJSONObject(previewQueryResponse, "查询响应"),
      });
      setPreviewResult(result);
      toast.success("契约模拟通过");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "契约模拟失败");
    } finally {
      setIsPreviewing(false);
    }
  };

  return (
    <>
      <input
        ref={jsonImportInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => void prepareJSONImport(event.target.files?.[0] || null)}
      />
      <SettingsCard
        className="lg:h-auto"
        contentClassName="p-0 sm:p-0"
        icon={Film}
        tone="violet"
        title="视频模型契约"
        description="管理视频模型能力、请求字段和异步轮询规则。"
        meta={<Badge variant="secondary" className="rounded-md">{items.length} 个契约</Badge>}
        action={
          <div data-video-contract-toolbar className="flex flex-wrap items-center justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" disabled={isJSONImporting} onClick={() => jsonImportInputRef.current?.click()}>
              <Upload className="size-4" />
              导入 JSON
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={items.length === 0} onClick={() => downloadVideoContractDocument(videoContractTransferDocument(items), "video-model-contracts.json")}>
              <Download className="size-4" />
              导出
            </Button>
            <span aria-hidden="true" className="mx-0.5 hidden h-5 w-px bg-border xl:block" />
            <Button type="button" size="sm" variant="outline" onClick={openImport}>
              <WandSparkles className="size-4" />
              从文档生成
            </Button>
            <Button type="button" size="sm" onClick={openCreate}>
              <Plus className="size-4" />
              添加契约
            </Button>
          </div>
        }
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-10"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <div className="p-5 sm:p-6"><SettingsEmptyState icon={Film} title="暂无视频模型契约" description="添加后可为模型设置中的视频模型提供参数和请求转换规则。" /></div>
        ) : (
          <div data-video-contract-list>
            <div className="hidden grid-cols-[minmax(220px,1.2fr)_minmax(180px,0.95fr)_minmax(280px,1.35fr)_150px_210px] items-center gap-5 border-b border-border/70 bg-muted/35 px-6 py-2.5 text-xs font-medium text-muted-foreground xl:grid">
              <span>契约</span>
              <span>匹配模型</span>
              <span>能力范围</span>
              <span>更新时间</span>
              <span className="text-right">操作</span>
            </div>
            <div className="divide-y divide-border/70">
              {items.map((item) => {
                const pending = pendingIds.has(item.id);
                const referenceTypes = referenceTypeCount(item.contract);
                return (
                  <div
                    key={item.id}
                    data-video-contract-row
                    className="grid min-w-0 gap-4 px-5 py-4 transition-colors hover:bg-muted/25 sm:px-6 xl:grid-cols-[minmax(220px,1.2fr)_minmax(180px,0.95fr)_minmax(280px,1.35fr)_150px_210px] xl:items-center xl:gap-5"
                  >
                  <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                    <TooltipHint content={item.enabled ? "停用契约" : "启用契约"}>
                      <Switch
                        checked={item.enabled}
                        disabled={pending}
                        onCheckedChange={() => void toggleEnabled(item)}
                        aria-label={item.enabled ? "停用契约" : "启用契约"}
                      />
                    </TooltipHint>
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">{item.contract.name}</h3>
                        <Badge variant={item.enabled ? "success" : "secondary"} className="rounded-md">
                          {item.enabled ? "已启用" : "已停用"}
                        </Badge>
                        <Badge variant="outline" className="rounded-md">v{item.revision}</Badge>
                        {item.draft ? <Badge variant="warning" className="rounded-md">有草稿</Badge> : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{videoContractDriverLabel(item.contract.driver)}</p>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground xl:hidden">匹配模型</p>
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                      {item.contract.models.length > 0 ? item.contract.models.slice(0, 2).map((model) => (
                        <Badge key={model} variant="outline" className="max-w-full font-normal">
                          <span className="truncate">{model}</span>
                        </Badge>
                      )) : <span className="text-sm text-muted-foreground">未设置</span>}
                      {item.contract.models.length > 2 ? (
                        <Badge variant="secondary">+{item.contract.models.length - 2}</Badge>
                      ) : null}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground xl:hidden">能力范围</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="rounded-md bg-muted/65 px-2 py-1">{formatDurationRange(item.contract.capability.seconds)}</span>
                      <span className="rounded-md bg-muted/65 px-2 py-1">{item.contract.capability.resolutions.join(" / ") || "上游默认清晰度"}</span>
                      <span className="rounded-md bg-muted/65 px-2 py-1">{item.contract.capability.sizes.length || 0} 种画幅</span>
                      {referenceTypes > 0 ? <span className="rounded-md bg-muted/65 px-2 py-1">{referenceTypes} 类参考素材</span> : null}
                      {item.contract.rules.length > 0 ? <span className="rounded-md bg-muted/65 px-2 py-1">{item.contract.rules.length} 条条件规则</span> : null}
                    </div>
                  </div>

                  <div className="min-w-0 text-xs text-muted-foreground">
                    <p className="mb-1.5 font-medium xl:hidden">更新时间</p>
                    <time dateTime={item.updated_at} className="block tabular-nums leading-5">{formatDateTime(item.updated_at)}</time>
                    <span className="block text-[11px] text-muted-foreground/75">轮询 {item.contract.polling.interval_seconds} 秒</span>
                  </div>

                  <div className="flex items-center gap-1 border-t border-border/60 pt-3 xl:justify-end xl:border-t-0 xl:pt-0">
                    <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => openView(item)} aria-label="查看契约" title="查看契约"><Eye className="size-4" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => void openVersions(item)} aria-label="版本历史" title="版本历史"><History className="size-4" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => downloadVideoContractDocument(videoContractTransferDocument([item]), videoContractExportName(item.contract.name))} aria-label="导出契约" title="导出契约"><Download className="size-4" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => openCopy(item)} aria-label="复制契约" title="复制契约"><Copy className="size-4" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8" disabled={pending} onClick={() => openEdit(item)} aria-label="编辑契约" title="编辑契约"><Pencil className="size-4" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/30" disabled={pending} onClick={() => setDeletingItem(item)} aria-label="删除契约" title="删除契约"><Trash2 className="size-4" /></Button>
                  </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </SettingsCard>

      <Dialog open={importOpen} onOpenChange={(open) => !isImporting && setImportOpen(open)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>从文档生成契约</DialogTitle>
            <DialogDescription>读取 API 文档并生成可编辑的契约草稿</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5 py-1">
            <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
              <Button
                type="button"
                variant={importSourceType === "file" ? "outline" : "ghost"}
                className={importSourceType === "file" ? "bg-background shadow-sm" : "shadow-none"}
                disabled={isImporting}
                onClick={() => setImportSourceType("file")}
              >
                <FileText className="size-4" />上传文档
              </Button>
              <Button
                type="button"
                variant={importSourceType === "url" ? "outline" : "ghost"}
                className={importSourceType === "url" ? "bg-background shadow-sm" : "shadow-none"}
                disabled={isImporting}
                onClick={() => setImportSourceType("url")}
              >
                <Link2 className="size-4" />文档链接
              </Button>
            </div>

            {importSourceType === "file" ? (
              <Field>
                <FieldLabel>API 文档</FieldLabel>
                <input
                  ref={importFileInputRef}
                  type="file"
                  className="hidden"
                  accept=".txt,.md,.markdown,.json,.yaml,.yml,.html,.htm,.docx,text/plain,text/markdown,text/html,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={isImporting}
                  onChange={(event) => setImportFile(event.target.files?.[0] || null)}
                />
                {importFile ? (
                  <div className="flex h-11 min-w-0 items-center gap-3 rounded-lg border border-border bg-background px-3">
                    <FileText className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate text-sm">{importFile.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{Math.max(1, Math.ceil(importFile.size / 1024))} KB</span>
                    <Button type="button" variant="ghost" size="icon" className="size-7" disabled={isImporting} onClick={() => { setImportFile(null); if (importFileInputRef.current) importFileInputRef.current.value = ""; }} aria-label="移除文档" title="移除文档"><X className="size-4" /></Button>
                  </div>
                ) : (
                  <FileUploadButton icon={FileText} disabled={isImporting} onClick={() => importFileInputRef.current?.click()}>
                    选择 DOCX、TXT、Markdown、JSON、YAML 或 HTML
                  </FileUploadButton>
                )}
                <FieldDescription>文件大小不超过 8 MB</FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="video-contract-import-url">文档链接</FieldLabel>
                <Input id="video-contract-import-url" type="url" value={importURL} disabled={isImporting} placeholder="https://docs.example.com/video-api" className={settingsDialogInputClassName} onChange={(event) => setImportURL(event.target.value)} />
                <FieldDescription>仅支持公网可访问的 HTTP 或 HTTPS 页面</FieldDescription>
              </Field>
            )}

            <Field>
              <FieldLabel>分析模型</FieldLabel>
              <Select value={importModel || undefined} disabled={isImporting || isLoadingImportOptions || textModels.length === 0} onValueChange={setImportModel}>
                <SelectTrigger className="h-11"><SelectValue placeholder={isLoadingImportOptions ? "读取模型中" : "暂无可用文本模型"} /></SelectTrigger>
                <SelectContent>{textModels.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
              </Select>
              <FieldDescription>使用个人默认文本 Key，请确认生成结果后再保存</FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportOpen(false)} disabled={isImporting}>取消</Button>
            <Button type="button" disabled={isImporting || isLoadingImportOptions || !importModel || (importSourceType === "file" ? !importFile : !importURL.trim())} onClick={() => void generateFromDocument()}>
              {isImporting ? <LoaderCircle className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
              {isImporting ? "正在分析" : "生成契约草稿"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          scrollable={false}
          className="h-[min(90dvh,860px)] w-[min(96vw,1280px)] max-w-none"
        >
          <DialogHeader>
            <DialogTitle>
              {readOnly ? "查看视频模型契约" : editingItem ? "编辑视频模型契约" : "添加视频模型契约"}
            </DialogTitle>
            <DialogDescription>{draft.contract.name || "配置模型能力和上游字段映射"}</DialogDescription>
          </DialogHeader>
          <div data-video-contract-layout className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-5 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(300px,20rem)] lg:grid-rows-[minmax(0,1fr)]">
            <ScrollArea
              data-video-contract-details
              className="h-full min-h-0 min-w-0"
              viewportClassName="h-full overscroll-y-contain pr-3"
              viewClass="flex min-w-0 flex-col gap-7 pb-1"
              ariaLabel="契约表单"
            >
              <section className="flex flex-col gap-4">
                <SectionTitle>基本信息</SectionTitle>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <TextField id="video-contract-name" label="契约名称" value={draft.contract.name} disabled={readOnly} placeholder="例如 MiniMax H3" onChange={(value) => updateContract((contract) => { contract.name = value; })} />
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-driver" label="接口协议" help="选择当前模型采用的视频协议。协议决定请求结构和参数转换，不控制创作页面显示哪些模型。" />
                    <Select value={draft.contract.driver} disabled={readOnly} onValueChange={(value) => updateContract((contract) => { contract.driver = value as VideoModelContract["driver"]; })}>
                      <SelectTrigger id="video-contract-driver" className="h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>{VIDEO_CONTRACT_DRIVERS.map((driver) => <SelectItem key={driver.value} value={driver.value}>{driver.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <NumericField id="video-contract-priority" label="同级优先级" help="仅在通配符具体度相同时生效，数值越大越优先；精确模型始终优先于通配符。" min={-1000} max={1000} value={draft.contract.priority} disabled={readOnly} onChange={(value) => updateContract((contract) => { contract.priority = value; })} />
                  <div className="sm:col-span-2"><TagListField id="video-contract-models" label="模型匹配规则" help="填写上游实际接收的模型 ID，支持 * 通配符。精确匹配优先，其次选择固定字符更多、通配符更少的规则。这里只负责匹配契约，不控制创作页面显示哪些模型。" value={draft.models} disabled={readOnly} placeholder="例如 minimax-h3-*" onValueChange={(value) => setDraft((current) => ({ ...current, models: value }))} /></div>
                </div>
                {!readOnly ? <label className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm font-medium text-foreground"><Checkbox checked={draft.enabled} onCheckedChange={(checked) => setDraft((current) => ({ ...current, enabled: Boolean(checked) }))} />保存后启用</label> : null}
              </section>

              <section className="flex flex-col gap-4">
                <SectionTitle>生成能力</SectionTitle>
                <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <TagListField id="video-contract-sizes" label="画幅选项" value={draft.sizes} disabled={readOnly} placeholder="例如 16:9" onValueChange={(value) => setDraft((current) => ({ ...current, sizes: value }))} />
                  <TagListField id="video-contract-seconds" label="时长选项" value={draft.seconds} disabled={readOnly} placeholder="例如 5" validateTag={(tag) => Number.isInteger(Number(tag)) && Number(tag) >= 1 && Number(tag) <= 3600} invalidMessage="时长必须是 1–3600 的整数" onValueChange={(value) => setDraft((current) => ({ ...current, seconds: value }))} />
                  <TagListField id="video-contract-resolutions" label="清晰度选项" value={draft.resolutions} disabled={readOnly} placeholder="例如 720p" onValueChange={(value) => setDraft((current) => ({ ...current, resolutions: value }))} />
                  <TextField id="video-contract-default-size" label="默认画幅" value={capability.default_size} disabled={readOnly} onChange={(value) => updateContract((contract) => { contract.capability.default_size = value; })} />
                  <NumericField id="video-contract-default-seconds" label="默认时长" min={1} max={3600} value={capability.default_seconds} disabled={readOnly} suffix="秒" onChange={(value) => updateContract((contract) => { contract.capability.default_seconds = value; })} />
                  <TextField id="video-contract-default-resolution" label="默认清晰度" value={capability.default_resolution} disabled={readOnly} onChange={(value) => updateContract((contract) => { contract.capability.default_resolution = value; })} />
                  <NumericField id="video-contract-prompt-limit" label="提示词上限" min={1} max={100000} value={draft.contract.validation.max_prompt_characters} disabled={readOnly} suffix="字符" onChange={(value) => updateContract((contract) => { contract.validation.max_prompt_characters = value; })} />
                  <Field><ContractFieldLabel htmlFor="video-contract-audio-control" label="音频生成" help="控制创作参数面板是否显示音频开关。不支持表示不生成音频，用户开关表示由用户选择，始终生成表示请求固定携带音频。" /><Select value={capability.audio_control} disabled={readOnly} onValueChange={(value) => updateContract((contract) => { contract.capability.audio_control = value as VideoModelContract["capability"]["audio_control"]; })}><SelectTrigger id="video-contract-audio-control" className="h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">不支持</SelectItem><SelectItem value="toggle">用户开关</SelectItem><SelectItem value="always">始终生成</SelectItem></SelectContent></Select></Field>
                  <ContractCheckboxField id="video-contract-watermark" label="支持水印开关" checked={capability.watermark} disabled={readOnly} className="min-h-11 self-end" onCheckedChange={(checked) => updateContract((contract) => { contract.capability.watermark = checked; })} />
                </div>
              </section>

              <section data-video-contract-generation className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 pb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">生成模式与约束</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">定义系统如何根据输入素材选择上游生成模式。</p>
                  </div>
                </div>
                <div className="grid items-end gap-3 rounded-lg bg-muted/30 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(260px,1fr)]">
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-default-mode" label="默认模式" help="没有任何素材时优先使用的模式；通常设置为文生视频。" />
                    <Select value={draft.contract.generation.default_mode} disabled={readOnly} onValueChange={(default_mode) => updateContract((contract) => { contract.generation.default_mode = default_mode; })}>
                      <SelectTrigger id="video-contract-default-mode" className="h-10 bg-background"><SelectValue /></SelectTrigger>
                      <SelectContent>{draft.contract.generation.modes.filter((mode) => mode.kind === "text").map((mode) => <SelectItem key={mode.id} value={mode.id}>{mode.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <ContractCheckboxField id="video-contract-audio-only-reference" label="允许仅使用参考音频" help="开启后，没有参考图片或视频时也可以只上传音频发起参考素材生成。" checked={draft.contract.validation.allow_audio_only_reference} disabled={readOnly} onCheckedChange={(checked) => updateContract((contract) => { contract.validation.allow_audio_only_reference = checked; })} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-semibold text-foreground">生成模式</h4>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{draft.contract.generation.modes.length}/3</span>
                  </div>
                  {!readOnly ? <Button type="button" variant="outline" size="sm" disabled={draft.contract.generation.modes.length >= 3} onClick={addGenerationMode}><Plus className="size-4" />添加模式</Button> : null}
                </div>
                <div className="space-y-3">
                  {draft.contract.generation.modes.map((mode, index) => (
                    <ContractModeEditor key={index} canRemove={draft.contract.generation.modes.length > 1 && mode.kind !== "text"} disabled={readOnly} index={index} mode={mode} onChange={(next) => updateGenerationMode(index, next)} onRemove={() => removeGenerationMode(index)} />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-start justify-between gap-3 border-t border-border/70 pt-4">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">高级条件规则</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">仅用于尾帧依赖首帧等跨参数关系，普通素材数量在模式内配置。</p>
                  </div>
                  {!readOnly ? <Button type="button" variant="outline" size="sm" disabled={draft.contract.rules.length >= 32} onClick={addContractRule}><Plus className="size-4" />添加规则</Button> : null}
                </div>
                {draft.contract.rules.length > 0 ? (
                  <div className="space-y-3">{draft.contract.rules.map((rule, index) => (
                    <ContractRuleEditor key={index} disabled={readOnly} index={index} rule={rule} onChange={(next) => updateContractRule(index, next)} onRemove={() => updateContract((contract) => { contract.rules.splice(index, 1); })} />
                  ))}</div>
                ) : <p className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-3 text-center text-xs text-muted-foreground">暂无高级规则，当前仅按各模式的素材数量校验</p>}
              </section>

              <section className="flex flex-col gap-4">
                <SectionTitle>请求字段映射</SectionTitle>
                <div className={`${settingsPanelClassName} grid items-start gap-4 sm:grid-cols-2`}>
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-local-material" label="平台本地素材" help="选择平台暂存的图片、视频和音频如何提交给上游。使用 multipart 时，只有实际存在本地文件的任务才会切换为表单提交。" />
                    <Select value={transport.local_material} disabled={readOnly} onValueChange={(value) => updateContract((contract) => {
                      contract.transport.local_material = value as VideoModelContract["transport"]["local_material"];
                      if (value === "multipart" && !contract.transport.multipart_file_field) {
                        contract.transport.multipart_file_field = "input_reference[]";
                      }
                    })}>
                      <SelectTrigger id="video-contract-local-material" className="h-11"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="url">使用平台 URL</SelectItem><SelectItem value="multipart">转为 multipart 文件</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <TextField id="video-contract-multipart-field" label="multipart 文件字段" help="上游接收文件的表单字段名，可包含末尾方括号，例如 input_reference[]。" value={transport.multipart_file_field} disabled={readOnly || transport.local_material !== "multipart"} placeholder="例如 input_reference[]" onChange={(value) => updateContract((contract) => { contract.transport.multipart_file_field = value; })} />
                  <ContractCheckboxField id="video-contract-multipart-repeatable" label="允许重复文件字段" help="开启后，同一任务的多个本地素材会使用相同字段名逐个提交。" checked={transport.multipart_repeatable} disabled={readOnly || transport.local_material !== "multipart"} onCheckedChange={(checked) => updateContract((contract) => { contract.transport.multipart_repeatable = checked; })} />
                  <ContractCheckboxField id="video-contract-multipart-mixed-urls" label="允许文件与 URL 混用" help="开启后，本地素材转为文件，外部公网 URL 仍保留在各自请求字段中。" checked={transport.multipart_mixed_urls} disabled={readOnly || transport.local_material !== "multipart"} onCheckedChange={(checked) => updateContract((contract) => { contract.transport.multipart_mixed_urls = checked; })} />
                  <TextField id="video-contract-create-path" label="任务创建路径" help="可选。留空时使用厂家驱动的默认入口；自定义协议必须填写站内绝对路径。" value={transport.create_path} disabled={readOnly} placeholder="例如 /v1/videos" onChange={(value) => updateContract((contract) => { contract.transport.create_path = value; })} />
                  <TextField id="video-contract-query-path" label="任务查询路径" help="可选。留空时使用厂家驱动默认入口；自定义路径必须包含 {task_id}。" value={transport.query_path} disabled={readOnly} placeholder="例如 /v1/videos/{task_id}" onChange={(value) => updateContract((contract) => { contract.transport.query_path = value; })} />
                </div>
                <div className={`${settingsPanelClassName} grid gap-4 sm:grid-cols-2`}>
                  {([
					["duration_field", "时长字段"], ["aspect_ratio_field", "画幅字段"], ["resolution_field", "清晰度字段"],
					["generate_audio_field", "生成音频字段"], ["watermark_field", "水印字段"], ["generation_mode_field", "生成模式字段"], ["first_frame_field", "首帧字段"],
                    ["last_frame_field", "尾帧字段"], ["reference_images_field", "参考图片字段"], ["reference_videos_field", "参考视频字段"],
                    ["reference_audios_field", "参考音频字段"],
                  ] as const).map(([key, label]) => <TextField key={key} id={`video-contract-${key}`} label={label} help={REQUEST_FIELD_HELP[key]} value={request[key]} disabled={readOnly} onChange={(value) => updateContract((contract) => { contract.request[key] = value; })} />)}
                </div>
              </section>

              <section className="flex flex-col gap-4">
                <SectionTitle description="显式声明视频最终从哪里获取，适配 NewAPI 内容端点和其他厂家的 CDN 返回地址。">视频产物</SectionTitle>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-artifact-mode" label="获取方式" help="响应地址读取轮询 JSON 中的结果字段；任务内容端点使用任务 ID 组成下载路径。" />
                    <Select value={artifact.mode} disabled={readOnly} onValueChange={(value) => updateContract((contract) => {
                      contract.artifact.mode = value as VideoModelContract["artifact"]["mode"];
                      if (value === "task_content") {
                        contract.artifact.content_path ||= "/v1/videos/{task_id}/content";
                        contract.artifact.auth = "relay";
                      } else {
                        contract.artifact.content_path = "";
                        contract.artifact.auth = "none";
                      }
                    })}>
                      <SelectTrigger id="video-contract-artifact-mode" className="h-11"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="response_url">响应中的视频地址</SelectItem><SelectItem value="task_content">任务内容端点</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-artifact-auth" label="下载鉴权" help="不鉴权不会发送中转 Key；中转鉴权仅允许向中转域名或允许域名发送 Bearer Key。" />
                    <Select value={artifact.auth} disabled={readOnly || artifact.mode === "task_content"} onValueChange={(value) => updateContract((contract) => { contract.artifact.auth = value as VideoModelContract["artifact"]["auth"]; })}>
                      <SelectTrigger id="video-contract-artifact-auth" className="h-11"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="none">不携带鉴权</SelectItem><SelectItem value="relay">携带中转鉴权</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <TextField id="video-contract-content-path" label="任务产物路径" help="必须包含 {task_id}，适用于 /v1/videos/{task_id}/content 这类内容代理。" value={artifact.content_path} disabled={readOnly || artifact.mode !== "task_content"} placeholder="/v1/videos/{task_id}/content" onChange={(value) => updateContract((contract) => { contract.artifact.content_path = value; })} />
                  <TagListField id="video-contract-artifact-hosts" label="允许域名" help="限制结果地址或允许携带中转鉴权的域名；支持 *.example.com。留空时，relay 鉴权只能发送到中转自身。" value={artifact.allowed_hosts} disabled={readOnly} placeholder="例如 cdn.example.com" onValueChange={(value) => updateContract((contract) => { contract.artifact.allowed_hosts = value; })} />
                </div>
              </section>

              <section className="flex flex-col gap-4">
                <SectionTitle>异步轮询</SectionTitle>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <NumericField id="video-contract-poll-interval" label="轮询间隔" help="创建异步视频任务后，每隔多少秒向上游查询一次任务状态。间隔过短可能触发上游限流。" min={1} max={300} value={polling.interval_seconds} disabled={readOnly} suffix="秒" onChange={(value) => updateContract((contract) => { contract.polling.interval_seconds = value; })} />
                  <NumericField id="video-contract-poll-timeout" label="超时时间" help="上游任务提交成功后最多轮询多长时间；视频任务总时限会自动覆盖该时间和一次轮询间隔。" min={1} max={86400} value={polling.timeout_seconds} disabled={readOnly} suffix="秒" onChange={(value) => updateContract((contract) => { contract.polling.timeout_seconds = value; })} />
                  <TagListField id="video-contract-task-id-fields" label="任务 ID 路径" help="创建响应中任务 ID 的 JSON 路径，按顺序读取，例如 id 或 data.task_id。" value={draft.taskIDFields} disabled={readOnly} placeholder="例如 id" onValueChange={(value) => setDraft((current) => ({ ...current, taskIDFields: value }))} />
                  <TagListField id="video-contract-status-fields" label="任务状态路径" help="查询响应中任务状态的 JSON 路径，按顺序读取，例如 status 或 data.status。" value={draft.statusFields} disabled={readOnly} placeholder="例如 status" onValueChange={(value) => setDraft((current) => ({ ...current, statusFields: value }))} />
                  <TagListField id="video-contract-progress-fields" label="任务进度路径" help="查询响应中生成进度的 JSON 路径，按顺序读取，例如 progress 或 data.progress；无法提供进度时可以留空。" value={draft.progressFields} disabled={readOnly} placeholder="例如 progress" onValueChange={(value) => setDraft((current) => ({ ...current, progressFields: value }))} />
                  <TagListField id="video-contract-queued-statuses" label="排队状态" help="上游返回这些状态时，任务保持排队中。" value={draft.queuedStatuses} disabled={readOnly} placeholder="例如 queued" onValueChange={(value) => setDraft((current) => ({ ...current, queuedStatuses: value }))} />
                  <TagListField id="video-contract-processing-statuses" label="处理中状态" help="上游返回这些状态时，任务显示为生成中。" value={draft.processingStatuses} disabled={readOnly} placeholder="例如 in_progress" onValueChange={(value) => setDraft((current) => ({ ...current, processingStatuses: value }))} />
                  <TagListField id="video-contract-success-statuses" label="成功状态" help="上游任务查询接口返回这些状态值时，系统认为视频已生成完成，例如 completed 或 succeeded。" value={draft.successStatuses} disabled={readOnly} placeholder="例如 completed" onValueChange={(value) => setDraft((current) => ({ ...current, successStatuses: value }))} />
                  <TagListField id="video-contract-failure-statuses" label="失败状态" help="上游任务查询接口返回这些状态值时，系统停止轮询并标记生成失败，例如 failed 或 cancelled。" value={draft.failureStatuses} disabled={readOnly} placeholder="例如 failed" onValueChange={(value) => setDraft((current) => ({ ...current, failureStatuses: value }))} />
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-unknown-status" label="未知状态" help="没有匹配以上四组的状态统一归为 unknown。系统会保留原始状态并继续轮询，不会误判为成功或失败。" />
                    <div id="video-contract-unknown-status" className="flex h-11 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 text-sm">
                      <Badge variant="secondary" className="rounded-md font-mono">unknown</Badge>
                      <span className="text-xs text-muted-foreground">继续轮询</span>
                    </div>
                  </Field>
                  <TagListField id="video-contract-error-fields" label="错误信息路径" help="任务失败时错误信息的 JSON 路径，按顺序读取；可以留空。" value={draft.errorFields} disabled={readOnly} placeholder="例如 error.message" onValueChange={(value) => setDraft((current) => ({ ...current, errorFields: value }))} />
                  <TagListField id="video-contract-result-fields" label="结果地址路径" help="任务成功后视频地址的 JSON 路径，按顺序读取，例如 video_url 或 data.output.video_url。" value={draft.resultFields} disabled={readOnly} placeholder="例如 video_url" onValueChange={(value) => setDraft((current) => ({ ...current, resultFields: value }))} />
                </div>
              </section>
            </ScrollArea>
            <ScrollArea
              data-video-contract-preview
              className="h-full min-h-0 min-w-0 border-t border-border/70 pt-4 lg:border-t-0 lg:border-l lg:pt-0"
              viewportClassName="h-full overscroll-y-contain pr-3 lg:pl-5"
              viewClass="space-y-3 pb-1"
              ariaLabel="契约预览"
            >
              <ContractParameterPreview key={parameterPreviewKey} contract={normalizedContract} />
              <details className="group overflow-hidden rounded-lg border border-border/70 bg-background">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/35 [&::-webkit-details-marker]:hidden">
                  <FlaskConical className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">请求与响应模拟</span>
                  <span className="text-xs font-normal text-muted-foreground group-open:hidden">展开</span>
                  <span className="hidden text-xs font-normal text-muted-foreground group-open:inline">收起</span>
                </summary>
                <div className="space-y-3 border-t border-border p-3">
                  <Field>
                    <FieldLabel htmlFor="video-contract-preview-input">示例请求</FieldLabel>
                    <Textarea id="video-contract-preview-input" className="min-h-32 font-mono text-xs" value={previewInput} onChange={(event) => setPreviewInput(event.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="video-contract-preview-submit">创建响应</FieldLabel>
                    <Textarea id="video-contract-preview-submit" className="min-h-24 font-mono text-xs" value={previewSubmitResponse} onChange={(event) => setPreviewSubmitResponse(event.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="video-contract-preview-query">查询响应</FieldLabel>
                    <Textarea id="video-contract-preview-query" className="min-h-24 font-mono text-xs" value={previewQueryResponse} onChange={(event) => setPreviewQueryResponse(event.target.value)} />
                  </Field>
                  <Button type="button" size="sm" className="w-full" disabled={isPreviewing} onClick={() => void runPreview()}>
                    {isPreviewing ? <LoaderCircle className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
                    运行模拟
                  </Button>
                  {previewResult ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100"><code>{JSON.stringify(previewResult, null, 2)}</code></pre> : null}
                </div>
              </details>
              <details className="group overflow-hidden rounded-lg border border-border/70 bg-background">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/35 [&::-webkit-details-marker]:hidden">
                  <Braces className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">原始 JSON</span>
                  <span className="text-xs font-normal text-muted-foreground group-open:hidden">展开</span>
                  <span className="hidden text-xs font-normal text-muted-foreground group-open:inline">收起</span>
                </summary>
                <div className="border-t border-border p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-xs text-muted-foreground">{normalizedContract.name || "未填写契约名称"}</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => void copyContractJSON()}>
                      <Copy className="size-4" />复制 JSON
                    </Button>
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-100 shadow-inner dark:bg-black/45"><code>{contractJSON}</code></pre>
                </div>
              </details>
            </ScrollArea>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>{readOnly ? "关闭" : "取消"}</Button>
            {!readOnly ? <Button type="button" variant="outline" onClick={() => void validate().catch((error) => toast.error(error instanceof Error ? error.message : "契约校验失败"))} disabled={isSaving}><ShieldCheck className="size-4" />校验配置</Button> : null}
            {!readOnly && editingItem ? <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={isSaving}><FileText className="size-4" />保存草稿</Button> : null}
            {!readOnly ? <Button type="button" onClick={() => void publish()} disabled={isSaving}>{isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{editingItem ? "发布新版本" : "添加并发布"}</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingJSONImport)} onOpenChange={(open) => (!open && !isJSONImporting ? setPendingJSONImport(null) : undefined)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>导入视频模型契约</DialogTitle>
            <DialogDescription>{pendingJSONImport?.filename}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-muted/20 text-center">
              <div className="px-3 py-3"><p className="text-lg font-semibold text-foreground">{pendingJSONImport?.bundle.contracts.length || 0}</p><p className="text-xs text-muted-foreground">全部</p></div>
              <div className="px-3 py-3"><p className="text-lg font-semibold text-foreground">{pendingImportSummary.created}</p><p className="text-xs text-muted-foreground">新增</p></div>
              <div className="px-3 py-3"><p className="text-lg font-semibold text-foreground">{pendingImportSummary.updated}</p><p className="text-xs text-muted-foreground">更新</p></div>
            </div>
            <div className="max-h-52 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {pendingJSONImport?.bundle.contracts.map((item, index) => (
                <div key={`${item.contract.name}-${index}`} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5">
                  <span className="truncate text-sm font-medium text-foreground">{item.contract.name || "未命名契约"}</span>
                  <Badge variant={item.enabled ? "success" : "secondary"} className="shrink-0 rounded-md">{item.enabled ? "启用" : "停用"}</Badge>
                </div>
              ))}
            </div>
            {pendingImportSummary.updated > 0 ? <p className="text-sm text-muted-foreground">同名契约将更新，未出现在文件中的现有契约不会改变。</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isJSONImporting} onClick={() => setPendingJSONImport(null)}>取消</Button>
            <Button type="button" disabled={isJSONImporting} onClick={() => void confirmJSONImport()}>
              {isJSONImporting ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {isJSONImporting ? "正在导入" : "确认导入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(versionsItem)} onOpenChange={(open) => (!open && !isRollingBack ? closeVersions() : undefined)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>契约版本历史</DialogTitle>
            <DialogDescription>{versionsItem?.contract.name} · 当前第 {versionsItem?.revision} 版</DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(60dvh,520px)] overflow-y-auto rounded-lg border border-border">
            {isLoadingVersions ? (
              <div className="flex min-h-32 items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
            ) : versions.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">暂无历史版本</div>
            ) : (
              <div className="divide-y divide-border/70">
                {versions.map((version) => {
                  const current = version.revision === versionsItem?.revision;
                  return (
                    <div key={version.revision} className="flex min-w-0 items-center gap-3 px-4 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold">v{version.revision}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{version.contract.name}</p>
                        <time dateTime={version.published_at} className="text-xs text-muted-foreground">{formatDateTime(version.published_at)}</time>
                      </div>
                      {current ? <Badge variant="success">当前版本</Badge> : (
                        <Button type="button" size="sm" variant="outline" disabled={isRollingBack} onClick={() => void rollback(version.revision)}>
                          {isRollingBack ? <LoaderCircle className="size-4 animate-spin" /> : <History className="size-4" />}回滚到此版本
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter><Button type="button" variant="outline" disabled={isRollingBack} onClick={closeVersions}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingItem)} onOpenChange={(open) => (!open ? setDeletingItem(null) : undefined)}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除视频模型契约</DialogTitle><DialogDescription>删除“{deletingItem?.contract.name}”后，对应模型将立即停止使用这份契约。</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingItem(null)}>取消</Button>
            <Button type="button" variant="destructive" onClick={() => void remove()} disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}>{deletingItem && pendingIds.has(deletingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
