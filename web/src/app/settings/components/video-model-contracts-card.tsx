"use client";
import { VideoContractDocumentUpload } from "./video-contract-document-upload";
import { TestResults } from "@/components/ai-elements/test-results";
import { ModelPicker } from "@/components/model-picker";

import { Separator } from "@/components/ui/separator";


import { LoadingState } from "@/components/ui/loading-state";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { nanoid } from "nanoid";

import { stopAgentExecution } from "@/lib/agent-executions";
import { AgentExecutionRecovery } from "@/components/agent/agent-execution-recovery";

import { Alert } from "@/components/ui/alert";
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block";

import { ItemMedia, Item } from "@/components/ui/item";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";



import { ContractParametersEditor } from "./video-contract-parameters";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContractRequestEditor } from "./video-contract-request";
import { VideoContractAgentDetails } from "./video-contract-agent-details";
import { VideoContractImportProgress } from "./video-contract-import-progress";
import { updateVideoContractAgentDetails, updateVideoContractImportActivity, type VideoContractImportActivity } from "@/lib/video-contract-agent-progress";
import { ContractMaterialsEditor } from "./video-contract-capabilities";
import { ContractRuleEditor } from "./video-contract-rules";
import { VIDEO_RULE_SCENARIOS } from "./video-contract-rule-scenarios";
import { AutoDLContractImport } from "./autodl-contract-import";
import { VideoContractPluginDialog, type VideoContractPluginTarget } from "./video-contract-plugin-dialog";
import { AudioLines, Braces, CheckCircle2, CheckCheck, ChevronDown, CircleAlert, CircleHelp, Code2, Copy, Download, Eye, FileText, Film, FlaskConical, History, ImagePlus, LayoutGrid, Link2, MoreHorizontal, Pencil, Plus, Power, PowerOff, ShieldCheck, SlidersHorizontal, Square, Table2, Trash2, Upload, Video, WandSparkles, X } from "lucide-react";
import { toast } from "sonner";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";

import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import { ManagementPagination } from "@/components/management-page";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldSet } from "@/components/ui/field";
import { ReferenceFileUpload } from "@/components/generation/reference-file-upload";
import { Input } from "@/components/ui/input";
import { InputTag } from "@/components/ui/input-tag";
import { NumberInput } from "@/components/ui/number-input";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  VideoSettingsPanel,
  type VideoSettingsValue,
} from "@/components/generation/video-settings-panel";
import {
  createVideoModelContract,
  createVideoModelContractBatch,
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
  type VideoModelContractImportResult,
  type VideoContractAgentDetail,
  type VideoModelContractPreviewResult,
  type VideoModelContractMutation,
  type VideoModelContractTransferDocument,
  type VideoModelContractVersion,
} from "@/lib/api";
import {
  installVideoModelContracts,
  cloneVideoModelContract,
  resolveVideoModelContract,
  videoModelProfile,
  type VideoModelContractProfile,
  videoContractUIState,
  type VideoModelContract,
  type VideoModelContractRule,
  type VideoModelContractRuleField,
} from "@/lib/video-model-contracts";
import { applyVideoFrameDefaults } from "@/lib/video-contract-editor";
import { resolveConfiguredModel } from "@/lib/model-config-selection";
import { cn } from "@/lib/utils";

import {
  ALL_MUTATIONS_SCOPE,
  mergeScopedMutationItem,
  ScopedMutationLifecycle,
  type ScopedMutationDecision,
  type ScopedMutationToken,
} from "@/lib/scoped-mutation-lifecycle";
import { SettingsEmptyState } from "./settings-ui";
import { SettingsPanel } from "@/components/settings-panel";

type ContractDraft = {
  profileModel: string;
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

const VIDEO_CONTRACT_EDITOR_SECTIONS = [
  { id: "basic", label: "基本信息", description: "契约与模型匹配", icon: Film },
  { id: "capability", label: "模型能力", description: "参数、素材与规则", icon: SlidersHorizontal },
  { id: "request", label: "上游接口", description: "请求映射与结果读取", icon: Upload },
  { id: "preview", label: "效果预览", description: "查看创作参数面板", icon: Eye },
];

function formatElapsedSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${String(remainingSeconds).padStart(2, "0")}秒` : `${remainingSeconds}秒`;
}

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
  { value: "ark-seedance", label: "火山方舟 Seedance / Agent Plan" },
  { value: "autodl-comfyui", label: "AutoDL ComfyUI 工作流" },
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
    duration_value_type: "number",
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
    error_fields: ["error.message", "message", "data.error.message", "data.message", "fail_reason", "error", "data.error"],
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

function normalizeVideoModelContractCollections(contract: VideoModelContract) {
  const value = cloneVideoModelContract(contract);
  value.models = Array.isArray(value.models) ? value.models : [];
  value.artifact.allowed_hosts = Array.isArray(value.artifact.allowed_hosts) ? value.artifact.allowed_hosts : [];
  value.capability.sizes = Array.isArray(value.capability.sizes) ? value.capability.sizes : [];
  value.capability.seconds = Array.isArray(value.capability.seconds) ? value.capability.seconds : [];
  value.capability.resolutions = Array.isArray(value.capability.resolutions) ? value.capability.resolutions : [];
  value.generation.modes = Array.isArray(value.generation.modes) ? value.generation.modes : [];
  value.rules = Array.isArray(value.rules) ? value.rules : [];
  value.polling.task_id_fields = Array.isArray(value.polling.task_id_fields) ? value.polling.task_id_fields : [];
  value.polling.status_fields = Array.isArray(value.polling.status_fields) ? value.polling.status_fields : [];
  value.polling.progress_fields = Array.isArray(value.polling.progress_fields) ? value.polling.progress_fields : [];
  value.polling.error_fields = Array.isArray(value.polling.error_fields) ? value.polling.error_fields : [];
  value.polling.queued_statuses = Array.isArray(value.polling.queued_statuses) ? value.polling.queued_statuses : [];
  value.polling.processing_statuses = Array.isArray(value.polling.processing_statuses) ? value.polling.processing_statuses : [];
  value.polling.success_statuses = Array.isArray(value.polling.success_statuses) ? value.polling.success_statuses : [];
  value.polling.failure_statuses = Array.isArray(value.polling.failure_statuses) ? value.polling.failure_statuses : [];
  value.polling.result_fields = Array.isArray(value.polling.result_fields) ? value.polling.result_fields : [];
  return value;
}

function draftFromContract(contract: VideoModelContract, enabled: boolean, profileModel = contract.model_profiles?.[0]?.model || ""): ContractDraft {
  const value = normalizeVideoModelContractCollections(contract);
  value.generation = applyVideoFrameDefaults(value.generation);
  for (const profile of value.model_profiles || []) profile.generation = applyVideoFrameDefaults(profile.generation);
  const profile = resolveVideoModelContract(value, profileModel);
  return {
    contract: value,
    profileModel,
    enabled,
    models: [...value.models],
    sizes: [...profile.capability.sizes],
    seconds: profile.capability.seconds.map(String),
    resolutions: [...profile.capability.resolutions],
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
  const profile = contract.model_profiles?.find((item) => item.model === draft.profileModel) || contract;
  profile.capability.sizes = normalizeTags(draft.sizes);
  profile.capability.seconds = profile.capability.seconds_range ? [] : normalizeTags(draft.seconds)
    .map(Number)
    .filter((value) => Number.isInteger(value));
  profile.capability.resolutions = normalizeTags(draft.resolutions);
  contract.polling.queued_statuses = normalizeTags(draft.queuedStatuses);
  contract.polling.processing_statuses = normalizeTags(draft.processingStatuses);
  contract.polling.success_statuses = normalizeTags(draft.successStatuses);
  contract.polling.failure_statuses = normalizeTags(draft.failureStatuses);
  contract.polling.task_id_fields = normalizeTags(draft.taskIDFields);
  contract.polling.status_fields = normalizeTags(draft.statusFields);
  contract.polling.progress_fields = normalizeTags(draft.progressFields);
  contract.polling.error_fields = normalizeTags(draft.errorFields);
  contract.polling.result_fields = normalizeTags(draft.resultFields);
  for (const profile of [contract, ...(contract.model_profiles || [])]) {
    const imageModes = profile.generation.modes.filter((mode) => mode.kind === "image");
    const referenceModes = profile.generation.modes.filter((mode) => mode.kind === "reference");
    profile.capability.first_frame_image_limit = Math.max(0, ...imageModes.map((mode) => mode.materials.first_frame.max + mode.materials.last_frame.max));
    profile.capability.reference_mode = referenceModes.length > 0;
    profile.capability.references = {
      image: Math.max(0, ...referenceModes.map((mode) => mode.materials.image.max)),
      video: Math.max(0, ...referenceModes.map((mode) => mode.materials.video.max)),
      audio: Math.max(0, ...referenceModes.map((mode) => mode.materials.audio.max)),
      total: Math.max(0, ...referenceModes.map((mode) => mode.materials.total.max)),
    };
  }
  return { contract, enabled: draft.enabled, ...(existingID ? { existing_id: existingID } : {}) };
}

function installEnabledContracts(items: ManagedVideoModelContract[]) {
  installVideoModelContracts(items.filter((item) => item.enabled).map((item) => item.contract));
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
  contract = resolveVideoModelContract(contract, model);
  return JSON.stringify({
    model,
    prompt: "示例视频提示词",
    ...(contract.capability.parameters?.length ? {parameters:Object.fromEntries(contract.capability.parameters.filter(p=> !p.modes?.length || p.modes.includes("text")).filter(p=>p.required || p.default != null).map(p=>[p.name,p.default ?? p.enum?.[0] ?? (p.type === "boolean" ? false : p.type === "string" ? p.format === "uri" ? "https://example.com/callback" : "示例" : p.minimum ?? 0)]))} : {}),
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
    if (typeof entry.contract.name !== "string" || entry.contract.name.trim() === "") {
      throw new Error("导入文件中的契约名称必须是非空字符串");
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
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-foreground">{children}</h3>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function ContractHelpIcon({ help, label }: { help: string; label: string }) {
  return (
    <TooltipHint content={help}>
      <Button variant="ghost" size="icon-xs"
        type="button"
        className="inline-flex shrink-0 items-center justify-center transition"
        aria-label={`${label}说明`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <CircleHelp  />
      </Button>
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
    <Card
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      className={cn("flex min-h-10 items-center gap-2.5 px-3 py-2 flex-row", className)}
    >
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(Boolean(value))} />
      <Label htmlFor={id} className={cn("min-w-0 flex-1", disabled ? "cursor-not-allowed" : "cursor-pointer")}>{label}</Label>
      {help ? <ContractHelpIcon help={help} label={label} /> : null}
    </Card>
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

function ContractModelProfileSummary({ contract }: { contract: VideoModelContract }) {
  if (!contract.model_profiles?.length) return null;
  return <div className="mt-3 space-y-2 p-3 text-xs">
    {contract.models.filter((model) => !model.includes("*")).map((model) => {
      const value = resolveVideoModelContract(contract, model);
      return <div key={model} className="space-y-1">
        <p className="break-all font-medium text-foreground">{model}</p>
        <p className="leading-5 text-muted-foreground">{formatDurationRange(value.capability.seconds)} · {value.capability.resolutions.join(" / ") || "上游默认清晰度"} · {value.generation.modes.map((mode) => mode.label).join(" / ")}{value.capability.references.image > 0 ? ` · 参考图最多 ${value.capability.references.image} 张` : ""}</p>
      </div>;
    })}
  </div>;
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
  const visibleFrameLimit = Number(frameLimit > 0 && visible("first_frame")) + Number(frameLimit > 1 && visible("last_frame"));
  const hasReferences = visibleFrameLimit > 0 || referenceLimits.image > 0 && visible("reference_image") || referenceLimits.video > 0 && visible("reference_video") || referenceLimits.audio > 0 && visible("reference_audio");
  if (!hasReferences) return null;

  const uploadPreview = (label: string, max: number, Icon: typeof ImagePlus, accept: string, hint: string) => (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <ImageParameterLabel>{label}</ImageParameterLabel>
        <span className="text-[11px] text-muted-foreground">0/{max}</span>
      </div>
      <ReferenceFileUpload label={`上传${label}`} icon={<Icon />} accept={accept} hint={hint} remaining={max} disabled onFiles={() => {}} />
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
            <ImageParameterLabel help="首帧控制开场，尾帧控制收尾，中间动作由提示词引导。能否搭配参考图以当前模型配置为准。">首尾帧</ImageParameterLabel>
            <span className="text-[11px] text-muted-foreground">0/{visibleFrameLimit}</span>
          </div>
          <div className={visibleFrameLimit > 1 ? "grid grid-cols-2 gap-2" : "grid grid-cols-1"}>
            {visible("first_frame") ? <ReferenceFileUpload label="上传首帧" showLabel={false} accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hint="PNG / JPG / WebP" disabled onFiles={() => {}} /> : null}
            {frameLimit > 1 && visible("last_frame") ? <ReferenceFileUpload label="上传尾帧" showLabel={false} accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hint="PNG / JPG / WebP" disabled onFiles={() => {}} /> : null}
          </div>
        </section>
      ) : null}
      {referenceLimits.image > 0 && visible("reference_image") ? uploadPreview("参考图", referenceLimits.image, ImagePlus, "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp", "PNG / JPG / WebP") : null}
      {referenceLimits.video > 0 && visible("reference_video") ? uploadPreview("参考视频", referenceLimits.video, Video, "video/mp4,video/quicktime,.mp4,.mov", "MP4 / MOV · 最大 50 MiB") : null}
      {referenceLimits.audio > 0 && visible("reference_audio") ? uploadPreview("参考音频", referenceLimits.audio, AudioLines, "audio/mpeg,audio/wav,.mp3,.wav", "MP3 / WAV · 最大 15 MiB") : null}
    </section>
  );
}

function ContractParameterPreview({ contract }: { contract: VideoModelContract }) {
  const [value, setValue] = useState<VideoSettingsValue>(() => previewSettingsFromContract(contract));

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
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="size-4" />参数效果预览</CardTitle>
        <CardDescription className="break-all" title={contract.models.join(", ")}>{modelLabel}</CardDescription>
        <CardAction><Badge variant="secondary">实时</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3.5">
          <ContractReferenceMaterialPreview contract={contract} ruleValues={ruleValues} />
          <VideoSettingsPanel
            model={contract.models[0] || ""}
            contract={contract}
            showTaskCount={false}
            value={value}
            ruleValues={ruleValues}
            onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
          />
        </div>
      </CardContent>
    </Card>
  );
}

type VideoModelContractEditorProps = {
  sessionKey: string;
  item: ManagedVideoModelContract;
  onClose: () => void;
  onDraftSaved: (items: ManagedVideoModelContract[]) => void;
  onPublished: (items: ManagedVideoModelContract[]) => void;
};

export function VideoModelContractsCard({ sessionKey }: { sessionKey: string }) {
  return <VideoModelContractsWorkspace sessionKey={sessionKey} />;
}

export function VideoModelContractEditor(props: VideoModelContractEditorProps) {
  return <VideoModelContractsWorkspace sessionKey={props.sessionKey} editor={props} />;
}

function VideoModelContractsWorkspace({ sessionKey, editor }: { sessionKey: string; editor?: VideoModelContractEditorProps }) {
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const importControllerRef = useRef<AbortController | null>(null);
  const importRunIDRef = useRef("");
  const importStartedAtRef = useRef(0);
  const jsonImportInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const currentSessionKeyRef = useRef(sessionKey);
  const itemsRef = useRef<ManagedVideoModelContract[]>([]);
  const contractLoadControllerRef = useRef<AbortController | null>(null);
  const contractLoadVersionRef = useRef(0);
  const contractLoadResetRef = useRef(false);
  const versionsLoadControllerRef = useRef<AbortController | null>(null);
  const versionsLoadVersionRef = useRef(0);
  const mutationTrackerRef = useRef<ScopedMutationLifecycle | null>(null);
  currentSessionKeyRef.current = sessionKey;
  if (!mutationTrackerRef.current) {
    mutationTrackerRef.current = new ScopedMutationLifecycle(sessionKey);
  } else {
    mutationTrackerRef.current.activateSession(sessionKey);
  }
  const [items, setItems] = useState<ManagedVideoModelContract[]>([]);
  const [listPage, setListPage] = useState(1);
  const [listPageSize, setListPageSize] = useState(10);
  const [listView, setListView] = useState<"table" | "cards">("table");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [optimisticEnabledByID, setOptimisticEnabledByID] = useState<Map<string, boolean>>(() => new Map());
  const [selectedContractIds, setSelectedContractIds] = useState<Set<string>>(() => new Set());
  const [isBulkActionBusy, setIsBulkActionBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [editorSection, setEditorSection] = useState("basic");
  const [dialogOpen, setDialogOpen] = useState(Boolean(editor));
  const [editingItem, setEditingItem] = useState<ManagedVideoModelContract | null>(editor?.item ?? null);
  const [readOnly, setReadOnly] = useState(false);
  const [draft, setDraft] = useState<ContractDraft>(() => editor ? draftFromContract(editor.item.draft || editor.item.contract, editor.item.draft_enabled ?? editor.item.enabled) : newDraft());
  const currentDraftRef = useRef(draft);
  currentDraftRef.current = draft;
  const [deletingItem, setDeletingItem] = useState<ManagedVideoModelContract | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSourceType, setImportSourceType] = useState<"file" | "url">("file");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importURL, setImportURL] = useState("");
  const importURLs = useMemo(() => [...new Set(importURL.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))], [importURL]);
  const [importModel, setImportModel] = useState("");
  const [importTokenName, setImportTokenName] = useState("");
  const [importGeneratePlugin, setImportGeneratePlugin] = useState(false);
  const [importError, setImportError] = useState("");
  const [importStatus, setImportStatus] = useState<VideoContractImportActivity | null>(null);
  const [importDetails, setImportDetails] = useState<VideoContractAgentDetail[]>([]);
  const [importElapsedSeconds, setImportElapsedSeconds] = useState(0);
  const [generatedContracts, setGeneratedContracts] = useState<VideoModelContract[]>([]);
  const [generatedDryRun, setGeneratedDryRun] = useState<VideoModelContractImportResult["dry_run"]>([]);
  const [generatedWarnings, setGeneratedWarnings] = useState<string[]>([]);
  const [generatedPublishError, setGeneratedPublishError] = useState("");
  const [generatedReviewOpen, setGeneratedReviewOpen] = useState(false);
  const [generatedEditingIndex, setGeneratedEditingIndex] = useState<number | null>(null);
  const [isPublishingGeneratedContracts, setIsPublishingGeneratedContracts] = useState(false);
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
  const [previewInput, setPreviewInput] = useState(() => editor ? previewInputJSON(editor.item.draft || editor.item.contract) : "{}");
  const [previewSubmitResponse, setPreviewSubmitResponse] = useState("{}");
  const [previewQueryResponse, setPreviewQueryResponse] = useState("{}");
  const [previewResult, setPreviewResult] = useState<VideoModelContractPreviewResult | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [pluginTargets, setPluginTargets] = useState<VideoContractPluginTarget[]>([]);
  const [pluginReturnToReview, setPluginReturnToReview] = useState(false);

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
      if (!commitItems(targetSessionKey, data.items)) return;
      if (reset && editorRef.current) {
        const latest = data.items.find((item) => item.id === editorRef.current!.item.id);
        if (!latest) {
          toast.error("此视频契约已被删除");
          editorRef.current.onClose();
          return;
        }
        const contract = latest.draft || latest.contract;
        setEditingItem(latest);
        setDraft(draftFromContract(contract, latest.draft_enabled ?? latest.enabled));
        setPreviewInput(previewInputJSON(contract));
      }
    } catch (error) {
      if (controller.signal.aborted || contractLoadVersionRef.current !== requestVersion || !isCurrentSession(targetSessionKey)) return;
      toast.error(error instanceof Error ? error.message : "加载视频模型契约失败");
      if (reset) editorRef.current?.onClose();
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
    const handleSessionChange = () => {
      if (getCachedAuthSession()?.key !== sessionKey) mutationTrackerRef.current?.deactivateSession(sessionKey);
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
      mountedRef.current = false;
      mutationTrackerRef.current?.deactivateSession(sessionKey);
      contractLoadVersionRef.current += 1;
      contractLoadControllerRef.current?.abort();
      contractLoadControllerRef.current = null;
      contractLoadResetRef.current = false;
      importControllerRef.current?.abort();
      importControllerRef.current = null;
    };
  }, [loadContracts, sessionKey]);

  useEffect(() => {
    if (!isImporting) return;
    const updateElapsed = () => setImportElapsedSeconds(Math.max(0, Math.floor((Date.now() - importStartedAtRef.current) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [isImporting]);

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
    ticket: ScopedMutationToken,
    decision: ScopedMutationDecision,
    force = false,
  ) => {
    if (decision.reconcile && (force || decision.concurrent)) void loadContracts(ticket.sessionKey, false);
  };

  const applyMutationResult = (
    ticket: ScopedMutationToken,
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

  const rejectMutation = (ticket: ScopedMutationToken) => {
    const decision = mutationTrackerRef.current!.complete(ticket, false);
    reconcileMutation(ticket, decision, true);
    return decision.current;
  };

  const updateContract = (update: (contract: VideoModelContract) => void) => {
    setDraft((current) => {
      const contract = cloneContract(current.contract);
      update(contract);
      return { ...current, contract };
    });
  };

  const updateProfile = (update: (profile: Pick<VideoModelContractProfile, "capability" | "generation" | "rules" | "transport" | "request">) => void) => {
    setDraft((current) => {
      const contract = cloneContract(current.contract);
      const profile = contract.model_profiles?.find((item) => item.model === current.profileModel) || contract;
      if (profile !== contract) {
        const resolved = resolveVideoModelContract(contract, current.profileModel);
        profile.transport ||= structuredClone(resolved.transport);
        profile.request ||= structuredClone(resolved.request);
      }
      update(profile);
      return { ...current, contract };
    });
  };

  const selectProfile = (model: string) => {
    const contract = mutationFromDraft(draft).contract;
    if (model && !contract.model_profiles?.some((item) => item.model === model) && !readOnly) {
      contract.model_profiles = [...(contract.model_profiles || []), videoModelProfile(contract, model)];
    }
    setDraft(draftFromContract(contract, draft.enabled, model));
    const effective = resolveVideoModelContract(contract, model);
    if (model) effective.models = [model];
    setPreviewInput(previewInputJSON(effective));
    setPreviewResult(null);
  };

  const updateContractRule = (index: number, rule: VideoModelContractRule) => {
    updateProfile((contract) => { contract.rules[index] = rule; });
  };

  const addContractRule = (rule = VIDEO_RULE_SCENARIOS[0].rule) => {
    updateProfile((contract) => {
      if (contract.rules.length < 32) contract.rules.push(structuredClone(rule));
    });
  };

  const clearImportFeedback = () => {
    setImportError("");
    setImportStatus(null);
    setImportDetails([]);
    setImportElapsedSeconds(0);
  };

  const openCreate = () => {
    setEditorSection("basic");
    setGeneratedContracts([]);
    setGeneratedReviewOpen(false);
    setGeneratedEditingIndex(null);
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
    setImportGeneratePlugin(false);
    setImportSourceType("file");
    setImportFile(null);
    setImportURL("");
    clearImportFeedback();
    setImportOpen(true);
    if (isLoadingImportOptions) return;
    setIsLoadingImportOptions(true);
    void Promise.all([fetchModelConfig(), fetchImageGenerationPreferences()])
      .then(([{ config }, { preferences }]) => {
        if (!isCurrentSession(sessionKey)) return;
        const models = config.text_models || [];
        const preferred = resolveConfiguredModel(models, preferences.default_text_model, config.default_text_model);
        setTextModels(models);
        setImportModel(preferred);
        setImportTokenName(preferences.default_text_relay_token_names[0] || "");
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "读取文本模型设置失败"))
      .finally(() => setIsLoadingImportOptions(false));
  };

  function acceptImportedContracts(data: Awaited<ReturnType<typeof importVideoModelContract>>) {
      const contracts = Array.isArray(data.contracts)
        ? data.contracts.map(normalizeVideoModelContractCollections)
        : [];
      if (contracts.length === 0) throw new Error("文档分析完成，但未生成任何契约草稿");
      const dryRun = Array.isArray(data.dry_run) ? data.dry_run : [];
      if (dryRun.length !== contracts.length || dryRun.some((item) => !item.passed)) throw new Error("契约干跑测试未通过，暂不进入初审");
      setImportOpen(false);
      setEditingItem(null);
      setReadOnly(false);
      const warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), ...dryRun.flatMap(item => [
        ...item.missing_evidence.map(field => `文档证据待补充：${field}`),
        ...item.review_issues.map(issue => `契约待确认：${issue}`),
      ])];
      setGeneratedContracts(contracts);
      setGeneratedDryRun(dryRun);
      setGeneratedWarnings(warnings);
      setGeneratedPublishError("");
      setGeneratedEditingIndex(null);
      const generatePlugin = importGeneratePlugin && dryRun.every(item => item.review_passed);
      setGeneratedReviewOpen(!generatePlugin);
      if (generatePlugin) {
        setPluginReturnToReview(true);
        setPluginTargets(contracts.map((contract, index) => ({ id: `document-${index + 1}`, contract: cloneVideoModelContract(contract), label: `文档生成草稿 ${index + 1}（未发布）`, warnings })));
      }
  }

  const generateFromDocument = async () => {
    if (importSourceType === "file" && !importFile) {
      toast.error("请选择要分析的文档");
      return;
    }
    if (importSourceType === "url" && importURLs.length === 0) {
      toast.error("请输入文档链接");
      return;
    }
    if (importSourceType === "url" && importURLs.length > 24) {
      toast.error("文档地址最多 24 个，请减少地址后重试");
      return;
    }
    const controller = new AbortController();
    importControllerRef.current?.abort();
    importControllerRef.current = controller;
    importStartedAtRef.current = Date.now();
    importRunIDRef.current = nanoid();
    setImportDetails([]);
    setImportError("");
    setImportStatus({
      stage: "reading_document",
      message: importSourceType === "file" ? "正在上传并读取文档" : `正在读取 ${importURLs.length} 份文档`,
      step: 0,
      completedSteps: [],
      connected: false,
    });
    setImportElapsedSeconds(0);
    setIsImporting(true);
    try {
      const data = await importVideoModelContract({
        runID: importRunIDRef.current,
        sourceType: importSourceType,
        generatePlugin: importGeneratePlugin,
        file: importSourceType === "file" ? importFile : null,
        urls: importSourceType === "url" ? importURLs : [],
        model: importModel,
        tokenName: importTokenName,
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted || importControllerRef.current !== controller || !isCurrentSession(sessionKey)) return;
          setImportStatus((current) => updateVideoContractImportActivity(current, progress));
          if (progress.detail) setImportDetails((current) => updateVideoContractAgentDetails(current, progress.detail!));
        },
      });
      if (controller.signal.aborted || !isCurrentSession(sessionKey)) return;
      acceptImportedContracts(data);
    } catch (error) {
      const message = controller.signal.aborted ? "已停止分析" : error instanceof Error ? error.message : "分析文档失败";
      setImportError(message);
      if (!controller.signal.aborted) toast.error(message);
    } finally {
      if (importControllerRef.current === controller) {
        importControllerRef.current = null;
        setIsImporting(false);
      }
    }
  };

  const openGeneratedContract = (index: number) => {
    const contract = generatedContracts[index];
    if (!contract) return;
    setEditorSection("basic");
    setGeneratedEditingIndex(index);
    setEditingItem(null);
    setReadOnly(false);
    const generatedDraft = draftFromContract(contract, false);
    setDraft(generatedDraft);
    setPreviewInput(previewInputJSON(generatedDraft.contract));
    setPreviewSubmitResponse("{}");
    setPreviewQueryResponse("{}");
    setPreviewResult(null);
    setGeneratedReviewOpen(false);
    setDialogOpen(true);
  };

  const closeContractDialog = () => {
    if (isSaving) return;
    setDialogOpen(false);
    editor?.onClose();
    if (generatedEditingIndex === null) return;
    setGeneratedEditingIndex(null);
    setGeneratedReviewOpen(generatedContracts.length > 0);
  };

  const abandonGeneratedContracts = () => {
    setGeneratedReviewOpen(false);
    setGeneratedEditingIndex(null);
    setGeneratedContracts([]);
    setGeneratedDryRun([]);
    setGeneratedWarnings([]);
    setGeneratedPublishError("");
  };

  const removeGeneratedContract = (index: number) => {
    const remaining = generatedContracts.filter((_, currentIndex) => currentIndex !== index);
    setGeneratedContracts(remaining);
    setGeneratedDryRun((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setGeneratedPublishError("");
    if (remaining.length === 0) setGeneratedReviewOpen(false);
  };

  const publishAllGeneratedContracts = async () => {
    if (generatedContracts.length === 0) return;
    const contracts = generatedContracts;
    const ticket = beginMutation(ALL_MUTATIONS_SCOPE);
    let current = true;
    setIsPublishingGeneratedContracts(true);
    setGeneratedPublishError("");
    try {
      const data = await createVideoModelContractBatch({
        contracts: contracts.map((contract) => ({ contract, enabled: true })),
      });
      current = applyMutationResult(ticket, data.items, () => data.items);
      if (!current) return;
      abandonGeneratedContracts();
      toast.success(`已新增并启用 ${contracts.length} 份契约`);
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) {
        const message = error instanceof Error ? error.message : "批量发布视频模型契约失败";
        setGeneratedPublishError(message);
      }
    } finally {
      if (current) setIsPublishingGeneratedContracts(false);
    }
  };

  const openView = (item: ManagedVideoModelContract) => {
    setEditorSection("basic");
    abandonGeneratedContracts();
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
    setEditorSection("basic");
    abandonGeneratedContracts();
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
    setEditorSection("basic");
    abandonGeneratedContracts();
    const copied = cloneContract(item.contract);
    copied.name = `${copied.name} 副本`.slice(0, 100);
    if (!copied.model_profiles?.length) copied.models = [];
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
    mutationTicket?: ScopedMutationToken,
  ) => {
    const targetSessionKey = currentSessionKeyRef.current;
    const payload = mutationFromDraft(draft, editingItem?.id || "");
    const data = await validateVideoModelContract(payload);
    if (!isCurrentSession(targetSessionKey) || currentDraftRef.current !== draft) return null;
    if (mutationTicket && !mutationTrackerRef.current!.canApply(mutationTicket)) return null;
    setDraft((current) => current === draft ? draftFromContract(data.contract, draft.enabled) : current);
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
      current = applyMutationResult(ticket, data.items, (items) => mergeScopedMutationItem(items, data.item, data.items));
      if (!current) return;
      setDialogOpen(false);
      toast.success("草稿已保存，当前已发布版本不受影响");
      editor?.onDraftSaved(data.items);
      editor?.onClose();
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
      current = applyMutationResult(ticket, data.items, (items) => mergeScopedMutationItem(items, data.item, data.items));
      if (!current) return;
      if (generatedEditingIndex !== null) {
        const remaining = generatedContracts.filter((_, index) => index !== generatedEditingIndex);
        setGeneratedContracts(remaining);
        setGeneratedDryRun((current) => current.filter((_, index) => index !== generatedEditingIndex));
        setGeneratedPublishError("");
        setGeneratedEditingIndex(null);
        setDialogOpen(false);
        setGeneratedReviewOpen(remaining.length > 0);
        toast.success(remaining.length > 0 ? `契约已发布，剩余 ${remaining.length} 份待审核` : "全部生成契约均已审核并发布");
        return;
      }
      setDialogOpen(false);
      toast.success(item ? `契约已发布为第 ${data.item.revision} 版` : "视频模型契约已添加并发布");
      editor?.onPublished(data.items);
      editor?.onClose();
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
      current = applyMutationResult(ticket, data.items, (items) => mergeScopedMutationItem(items, data.item, data.items));
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
    const enabled = !item.enabled;
    setPendingIds((current) => new Set(current).add(item.id));
    setOptimisticEnabledByID((current) => new Map(current).set(item.id, enabled));
    try {
      const data = await setVideoModelContractEnabled(item.id, enabled);
      current = applyMutationResult(ticket, data.items, (items) => mergeScopedMutationItem(items, data.item, data.items));
      if (!current) return;
      toast.success(item.enabled ? "契约已停用" : "契约已启用");
    } catch (error) {
      current = rejectMutation(ticket);
      if (current) {
        toast.error(error instanceof Error ? error.message : "更新契约状态失败");
      }
    } finally {
      if (current) {
        setPendingIds((pending) => {
          const next = new Set(pending);
          next.delete(item.id);
          return next;
        });
        setOptimisticEnabledByID((current) => {
          const next = new Map(current);
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
    const ticket = beginMutation(ALL_MUTATIONS_SCOPE);
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

  const activeProfile = draft.contract.model_profiles?.find((item) => item.model === draft.profileModel) || draft.contract;
  const capability = activeProfile.capability;
  const artifact = draft.contract.artifact;
  const polling = draft.contract.polling;
  const normalizedContract = useMemo(() => mutationFromDraft(draft).contract, [draft]);
  const previewContract = useMemo(() => {
    const contract = resolveVideoModelContract(normalizedContract, draft.profileModel);
    if (draft.profileModel) contract.models = [draft.profileModel];
    return contract;
  }, [normalizedContract, draft.profileModel]);
  const contractJSON = useMemo(() => JSON.stringify(normalizedContract, null, 2), [normalizedContract]);
  const parameterPreviewKey = useMemo(() => JSON.stringify({
    models: previewContract.models,
    capability: previewContract.capability,
    generation: previewContract.generation,
    rules: previewContract.rules,
  }), [previewContract]);
  const pendingImportSummary = useMemo(() => {
    if (!pendingJSONImport) return { created: 0, updated: 0 };
    const existingNames = new Set(items.map((item) => item.contract.name.trim().toLowerCase()));
    const updated = pendingJSONImport.bundle.contracts.filter((item) => existingNames.has(item.contract.name.trim().toLowerCase())).length;
    return { created: pendingJSONImport.bundle.contracts.length - updated, updated };
  }, [items, pendingJSONImport]);
  const listTotalPages = Math.max(1, Math.ceil(items.length / listPageSize));
  const safeListPage = Math.min(listPage, listTotalPages);
  const visibleItems = useMemo(
    () => items.slice((safeListPage - 1) * listPageSize, safeListPage * listPageSize),
    [items, listPageSize, safeListPage],
  );
  const selectedItems = useMemo(
    () => items.filter((item) => selectedContractIds.has(item.id)),
    [items, selectedContractIds],
  );
  const visibleItemIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);
  const allVisibleSelected = visibleItemIds.length > 0 && visibleItemIds.every((id) => selectedContractIds.has(id));
  const someVisibleSelected = visibleItemIds.some((id) => selectedContractIds.has(id));

  useEffect(() => setListPage((current) => Math.min(current, listTotalPages)), [listTotalPages]);

  useEffect(() => {
    const existingIds = new Set(items.map((item) => item.id));
    setSelectedContractIds((current) => {
      const next = new Set([...current].filter((id) => existingIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const toggleContractSelection = (id: string, checked: boolean) => {
    setSelectedContractIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleVisibleContractSelection = (checked: boolean) => {
    setSelectedContractIds((current) => {
      const next = new Set(current);
      for (const id of visibleItemIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const exportSelectedContracts = () => {
    if (selectedItems.length === 0) return;
    downloadVideoContractDocument(
      videoContractTransferDocument(selectedItems),
      `video-model-contracts-selected-${selectedItems.length}.json`,
    );
    toast.success(`已导出 ${selectedItems.length} 个契约`);
  };

  const updateSelectedContractsEnabled = async (enabled: boolean) => {
    if (isBulkActionBusy) return;
    const targets = selectedItems.filter((item) => (optimisticEnabledByID.get(item.id) ?? item.enabled) !== enabled);
    if (targets.length === 0) {
      toast.info(enabled ? "选中的契约均已启用" : "选中的契约均已停用");
      return;
    }
    const targetIds = new Set(targets.map((item) => item.id));
    const ticket = beginMutation(ALL_MUTATIONS_SCOPE);
    let latestItems: ManagedVideoModelContract[] | null = null;
    const failedIds = new Set<string>();
    let current = true;
    setIsBulkActionBusy(true);
    setPendingIds((pending) => new Set([...pending, ...targetIds]));
    setOptimisticEnabledByID((values) => {
      const next = new Map(values);
      for (const id of targetIds) next.set(id, enabled);
      return next;
    });
    try {
      for (const item of targets) {
        if (!mutationTrackerRef.current!.isCurrent(ticket)) {
          current = false;
          return;
        }
        try {
          const data = await setVideoModelContractEnabled(item.id, enabled);
          latestItems = data.items;
        } catch {
          failedIds.add(item.id);
        }
      }
      current = latestItems
        ? applyMutationResult(ticket, latestItems, () => latestItems!)
        : rejectMutation(ticket);
      if (!current) return;
      if (failedIds.size > 0) {
        void loadContracts(ticket.sessionKey, false);
        toast.warning(`${enabled ? "启用" : "停用"}完成：成功 ${targets.length - failedIds.size} 个，失败 ${failedIds.size} 个`);
      } else {
        toast.success(`已${enabled ? "启用" : "停用"} ${targets.length} 个契约`);
      }
    } finally {
      if (current) setPendingIds((pending) => {
        const next = new Set(pending);
        for (const id of targetIds) next.delete(id);
        return next;
      });
      if (current) setOptimisticEnabledByID((values) => {
        const next = new Map(values);
        for (const id of targetIds) next.delete(id);
        return next;
      });
      if (current) setIsBulkActionBusy(false);
    }
  };

  const deleteSelectedContracts = async () => {
    if (isBulkActionBusy || selectedItems.length === 0) return;
    const targets = [...selectedItems];
    const targetIds = new Set(targets.map((item) => item.id));
    const ticket = beginMutation(ALL_MUTATIONS_SCOPE);
    let latestItems: ManagedVideoModelContract[] | null = null;
    const failedIds = new Set<string>();
    let current = true;
    setIsBulkActionBusy(true);
    setPendingIds((pending) => new Set([...pending, ...targetIds]));
    try {
      for (const item of targets) {
        if (!mutationTrackerRef.current!.isCurrent(ticket)) {
          current = false;
          return;
        }
        try {
          const data = await deleteVideoModelContract(item.id);
          latestItems = data.items;
        } catch {
          failedIds.add(item.id);
        }
      }
      current = latestItems
        ? applyMutationResult(ticket, latestItems, () => latestItems!)
        : rejectMutation(ticket);
      if (!current) return;
      setSelectedContractIds(failedIds);
      setBulkDeleteOpen(false);
      if (failedIds.size > 0) {
        void loadContracts(ticket.sessionKey, false);
        toast.warning(`删除完成：成功 ${targets.length - failedIds.size} 个，失败 ${failedIds.size} 个`);
      } else {
        toast.success(`已删除 ${targets.length} 个契约`);
      }
    } finally {
      if (current) setPendingIds((pending) => {
        const next = new Set(pending);
        for (const id of targetIds) next.delete(id);
        return next;
      });
      if (current) setIsBulkActionBusy(false);
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

  const editorLoading = Boolean(editor) && isLoading;
  const contractDialog = (
      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeContractDialog())}>
        <DialogContent
          data-video-contract-dialog
          className="h-[min(94dvh,940px)] w-[min(96vw,1360px)] max-w-none sm:max-w-none"
        >
          <DialogHeader >
            <div className="flex items-start gap-3">
              <ItemMedia variant="icon" className="flex size-11 shrink-0 items-center justify-center"><Film className="size-5" /></ItemMedia>
              <div className="min-w-0 space-y-1.5">
                <DialogTitle>
                  {generatedEditingIndex !== null
                    ? `审核视频契约（${generatedEditingIndex + 1}/${generatedContracts.length}）`
                    : readOnly ? "查看视频契约" : editingItem ? "编辑视频契约" : "添加视频契约"}
                </DialogTitle>
                <DialogDescription>{readOnly ? "查看已配置的模型能力与上游接口。" : "配置模型能力与上游接口，实时预览创作参数。"}{editor ? "修改的是全局契约，发布后对新任务生效；已有任务保留原版本记录。" : ""}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="shrink-0 lg:hidden">
            <Select value={editorSection} onValueChange={setEditorSection}>
              <SelectTrigger aria-label="视频配置分区" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{VIDEO_CONTRACT_EDITOR_SECTIONS.map((section) => <SelectItem key={section.id} value={section.id}>{section.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <FieldSet disabled={isSaving || editorLoading} data-video-contract-layout className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden lg:grid-cols-[176px_minmax(0,1fr)] xl:grid-cols-[176px_minmax(0,1fr)_300px]">
            <ScrollArea className="hidden min-h-0 border-r lg:flex" contentClassName="grid gap-5 py-4 pr-4">
              <div className="space-y-1 px-3">
                <p className="text-xs font-medium text-muted-foreground">契约配置</p>
                <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{draft.contract.name || "新视频契约"}</p>
              </div>
              <nav aria-label="视频配置分区" className="grid gap-1">
                {VIDEO_CONTRACT_EDITOR_SECTIONS.map(({ id, label, description, icon: Icon }) => (
                  <Button key={id} type="button" variant={editorSection === id ? "secondary" : "ghost"} aria-current={editorSection === id ? "step" : undefined} aria-label={label} onClick={() => setEditorSection(id)} className={cn("h-auto min-h-16 w-full items-start justify-start gap-2 py-3 text-left", id === "preview" && "xl:hidden")}>
                    <Icon className="mt-0.5 shrink-0" />
                    <span className="min-w-0"><span className="block font-medium">{label}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{description}</span></span>
                  </Button>
                ))}
              </nav>
            </ScrollArea>
            <ScrollArea data-video-contract-details aria-label="契约表单" className={cn("min-h-0 min-w-0", editorSection === "preview" && "hidden xl:flex")} contentClassName="grid gap-5 p-1 pr-3 pb-4 lg:p-5" onWheel={(event) => event.stopPropagation()}>
              <Card className={cn("gap-5 p-4 sm:p-5", editorSection !== "basic" && editorSection !== "preview" && "hidden")}>
                <SectionTitle>基本信息</SectionTitle>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2"><TextField id="video-contract-name" label="契约名称" value={draft.contract.name} disabled={readOnly} placeholder="例如 MiniMax H3" onChange={(value) => updateContract((contract) => { contract.name = value; })} /></div>
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-driver" label="接口协议" help="选择当前模型采用的视频协议。协议决定请求结构和参数转换，不控制创作页面显示哪些模型。" />
                    <Select value={draft.contract.driver} disabled={readOnly} onValueChange={(value) => updateContract((contract) => { contract.driver = value as VideoModelContract["driver"]; })}>
                      <SelectTrigger id="video-contract-driver" ><SelectValue /></SelectTrigger>
                      <SelectContent>{VIDEO_CONTRACT_DRIVERS.map((driver) => <SelectItem key={driver.value} value={driver.value}>{driver.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <div className="sm:col-span-2"><TagListField id="video-contract-models" label="模型匹配规则" help="填写上游实际接收的模型 ID，支持 * 通配符。精确匹配优先，其次选择固定字符更多、通配符更少的规则。这里只负责匹配契约，不控制创作页面显示哪些模型。" value={draft.models} disabled={readOnly} placeholder="例如 minimax-h3-*" onValueChange={(value) => setDraft((current) => {
                    const contract = mutationFromDraft(current).contract;
                    contract.models = value;
                    contract.model_profiles = contract.model_profiles?.filter((profile) => value.some((model) => model.toLowerCase() === profile.model.toLowerCase()));
                    return draftFromContract(contract, current.enabled, value.includes(current.profileModel) ? current.profileModel : "");
                  })} /></div>
                  <div className="sm:col-span-2">
                    <Collapsible className="group" defaultOpen={draft.contract.priority !== 0}>
                      <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="justify-start px-0"><span>高级匹配设置</span><ChevronDown className="ml-1 transition-transform group-data-[state=open]:rotate-180" /></Button></CollapsibleTrigger>
                      <CollapsibleContent forceMount className="data-[state=closed]:hidden"><div className="max-w-sm pt-3"><NumericField id="video-contract-priority" label="同级优先级" help="仅在通配符具体度相同时生效，数值越大越优先；精确模型始终优先于通配符。" min={-1000} max={1000} value={draft.contract.priority} disabled={readOnly} onChange={(value) => updateContract((contract) => { contract.priority = value; })} /></div></CollapsibleContent>
                    </Collapsible>
                  </div>
                </div>
              </Card>

              <Card className={cn("gap-3 p-4 sm:p-5", !["capability", "preview"].includes(editorSection) && "hidden")}>
                <Field>
                  <ContractFieldLabel htmlFor="video-contract-profile" label="当前配置的模型能力" help="选择一个型号，分别配置它的参数、生成方式和输入能力；没有独立配置的型号沿用通用能力。" />
                  <ModelPicker id="video-contract-profile" label="模型能力配置" value={draft.profileModel || "__default__"}
                    options={[{ value: "__default__", label: "通用能力" }, ...normalizeTags(draft.models).filter((model) => !model.includes("*"))]}
                    onValueChange={(value) => selectProfile(value === "__default__" ? "" : value)} />
                  <FieldDescription>{draft.profileModel ? `正在配置 ${draft.profileModel}，其他模型的能力保持独立。` : "未单独配置的模型使用以下通用能力。"}</FieldDescription>
                </Field>
                {draft.profileModel && !readOnly ? <Button type="button" size="sm" variant="outline" onClick={() => {
                  const contract = mutationFromDraft(draft).contract;
                  contract.model_profiles = contract.model_profiles?.filter((item) => item.model !== draft.profileModel);
                  setDraft(draftFromContract(contract, draft.enabled, ""));
                }}>移除该模型的独立配置</Button> : null}
              </Card>
              <Card className={cn("gap-5 p-4 sm:p-5", editorSection !== "capability" && editorSection !== "preview" && "hidden")}>
                <SectionTitle description="先填写模型支持的选项，再单独指定默认值。默认值用于首次选择该模型或请求未指定参数时。">生成参数</SectionTitle>
                <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="grid min-w-0 gap-4">
                    <TagListField id="video-contract-sizes" label="画幅选项" value={draft.sizes} disabled={readOnly} placeholder="例如 16:9" onValueChange={(value) => setDraft((current) => ({ ...current, sizes: value }))} />
                    <TextField id="video-contract-default-size" label="默认画幅" value={capability.default_size} disabled={readOnly} onChange={(value) => updateProfile((contract) => { contract.capability.default_size = value; })} />
                  </div>
                  <div className="grid min-w-0 gap-4">
                    <TagListField id="video-contract-seconds" label="时长选项" value={draft.seconds} disabled={readOnly || Boolean(capability.seconds_range)} placeholder="例如 5" validateTag={(tag) => Number.isInteger(Number(tag)) && Number(tag) >= 1 && Number(tag) <= 3600} invalidMessage="时长必须是 1–3600 的整数" onValueChange={(value) => setDraft((current) => ({ ...current, seconds: value }))} />
                    <NumericField id="video-contract-default-seconds" label="默认时长" min={1} max={capability.seconds_range ? capability.seconds_range.max ?? Number.MAX_SAFE_INTEGER : 3600} value={capability.default_seconds} disabled={readOnly} suffix="秒" onChange={(value) => updateProfile((contract) => { contract.capability.default_seconds = value; })} />
                  </div>
                  <div className="grid min-w-0 gap-4">
                    <TagListField id="video-contract-resolutions" label="清晰度选项" value={draft.resolutions} disabled={readOnly} placeholder="例如 720p" onValueChange={(value) => setDraft((current) => ({ ...current, resolutions: value }))} />
                    <TextField id="video-contract-default-resolution" label="默认清晰度" value={capability.default_resolution} disabled={readOnly} onChange={(value) => updateProfile((contract) => { contract.capability.default_resolution = value; })} />
                  </div>
                </div>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Field><ContractFieldLabel htmlFor="video-contract-audio-control" label="音频生成" help="控制创作参数面板是否显示音频开关。不支持表示不生成音频，用户开关表示由用户选择，始终生成表示请求固定携带音频。" /><Select value={capability.audio_control} disabled={readOnly} onValueChange={(value) => updateProfile((contract) => { contract.capability.audio_control = value as VideoModelContract["capability"]["audio_control"]; })}><SelectTrigger id="video-contract-audio-control" ><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">不支持</SelectItem><SelectItem value="toggle">用户开关</SelectItem><SelectItem value="always">始终生成</SelectItem></SelectContent></Select></Field>
                  <ContractCheckboxField id="video-contract-watermark" label="支持水印开关" checked={capability.watermark} disabled={readOnly} className="min-h-11 self-end" onCheckedChange={(checked) => updateProfile((contract) => { contract.capability.watermark = checked; })} />
                </div>
              </Card>

              <Card className={cn("gap-5 p-4 sm:p-5", editorSection !== "capability" && editorSection !== "preview" && "hidden")}>
                <SectionTitle>附加参数与输入约束</SectionTitle>
                <ContractParametersEditor capability={capability} disabled={readOnly} onChange={value => updateProfile(profile => { profile.capability = value; })} />
              </Card>
              <Card className={cn("gap-5 p-4 sm:p-5", editorSection !== "capability" && editorSection !== "preview" && "hidden")}>
                <SectionTitle description="只勾选模型实际支持的输入方式，选中后再配置对应的上传要求。">支持哪些输入</SectionTitle>
                <ContractMaterialsEditor generation={activeProfile.generation} disabled={readOnly} onChange={(generation) => updateProfile((profile) => { profile.generation = generation; })} />
              </Card>

              <Card className={cn("gap-5 p-4 sm:p-5", editorSection !== "capability" && "hidden")}>
                <Collapsible key={draft.profileModel} className="group" defaultOpen={activeProfile.rules.length > 0}>
                  <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="h-auto min-h-8 w-full justify-start whitespace-normal px-0 text-left"><span className="min-w-0 flex-1"><span className="block font-medium">高级条件规则</span><span className="mt-1 block text-xs font-normal text-muted-foreground">仅在参数之间存在依赖时配置 · {activeProfile.rules.length} 条</span></span><ChevronDown className="shrink-0 transition-transform group-data-[state=open]:rotate-180" /></Button></CollapsibleTrigger>
                  <CollapsibleContent forceMount className="data-[state=closed]:hidden">
                <Item variant="muted" className="p-4">
                  <p className="mb-3 text-xs font-medium">从常见场景开始 <span className="font-normal text-muted-foreground">· 点击添加，再按接口要求调整</span></p>
                  <div className="grid gap-2">
                    {VIDEO_RULE_SCENARIOS.map((scenario) => <Button variant="outline" key={scenario.label} type="button" disabled={readOnly || activeProfile.rules.length >= 32} onClick={() => addContractRule(scenario.rule)} className="flex items-center text-left disabled:opacity-50 justify-start h-auto min-h-8 whitespace-normal py-2"><Plus className="shrink-0 text-muted-foreground" /><span><span className="block text-sm font-medium">{scenario.label}</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{scenario.description}</span></span></Button>)}
                  </div>
                </Item>
                <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">已配置 {activeProfile.rules.length} / 32 条规则</p>{!readOnly ? <Button type="button" variant="outline" size="sm" disabled={activeProfile.rules.length >= 32} onClick={() => addContractRule()}><Plus  />添加规则</Button> : null}</div>
                {activeProfile.rules.length > 0 ? <div className="space-y-3">{activeProfile.rules.map((rule, index) => <ContractRuleEditor key={index} disabled={readOnly} index={index} rule={rule} onChange={(next) => updateContractRule(index, next)} onRemove={() => updateProfile((profile) => { profile.rules.splice(index, 1); })} />)}</div> : <EmptyState compact title="还没有条件规则" description="仅按已配置的能力与上传数量校验。" className="min-h-0 p-5" />}
                  </CollapsibleContent>
                </Collapsible>
              </Card>

              <section className={cn("grid gap-5", editorSection !== "request" && "hidden")}>
                <SectionTitle description="按上游文档映射创建请求，并配置任务状态和视频获取方式。">请求设置</SectionTitle>
                <ContractRequestEditor key={`${editingItem?.id ?? `draft-${generatedEditingIndex ?? draft.contract.name}`}:${draft.profileModel}`} contract={previewContract} contractID={editingItem?.id} generation={activeProfile.generation} disabled={readOnly} onChange={(update) => updateProfile((profile) => { update(profile as VideoModelContract); })} onGenerationChange={(generation) => updateProfile((profile) => { profile.generation = generation; })} />
              </section>

              <Card className={cn("gap-5 p-4 sm:p-5", editorSection !== "request" && "hidden")}>
                <SectionTitle description="任务完成后，选择从响应中的下载地址还是独立下载接口获取视频。">获取生成的视频</SectionTitle>
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
                      <SelectTrigger id="video-contract-artifact-mode" ><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="response_url">响应中的视频地址</SelectItem><SelectItem value="task_content">任务内容端点</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-artifact-auth" label="下载鉴权" help="不鉴权不会发送中转 Key；中转鉴权仅允许向中转域名或允许域名发送 Bearer Key。" />
                    <Select value={artifact.auth} disabled={readOnly || artifact.mode === "task_content"} onValueChange={(value) => updateContract((contract) => { contract.artifact.auth = value as VideoModelContract["artifact"]["auth"]; })}>
                      <SelectTrigger id="video-contract-artifact-auth" ><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="none">不携带鉴权</SelectItem><SelectItem value="relay">携带中转鉴权</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <TextField id="video-contract-content-path" label="视频下载接口" help="必须包含 {task_id}，适用于 /v1/videos/{task_id}/content 这类内容代理。" value={artifact.content_path} disabled={readOnly || artifact.mode !== "task_content"} placeholder="/v1/videos/{task_id}/content" onChange={(value) => updateContract((contract) => { contract.artifact.content_path = value; })} />
                  <TagListField id="video-contract-artifact-hosts" label="允许域名" help="限制结果地址或允许携带中转鉴权的域名；支持 *.example.com。留空时，relay 鉴权只能发送到中转自身。" value={artifact.allowed_hosts} disabled={readOnly} placeholder="例如 cdn.example.com" onValueChange={(value) => updateContract((contract) => { contract.artifact.allowed_hosts = value; })} />
                </div>
              </Card>

              <Card className={cn("gap-5 p-4 sm:p-5", editorSection !== "request" && "hidden")}>
                <SectionTitle description="创建视频任务后，系统定时查询生成状态，并从上游返回的 JSON 中读取任务编号、进度和视频地址。">读取任务结果</SectionTitle>
                <Item variant="muted" className="space-y-2 p-3"><p>例如上游返回下列内容：任务编号填 data.id，生成状态填 data.status，完成进度填 data.progress，视频下载地址填 data.video_url。</p><ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden font-mono" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><CodeBlock><CodeBlockContent wrap>{JSON.stringify({ data: { id: "task_123", status: "completed", progress: 100, video_url: "https://example.com/video.mp4" } }, null, 2)}</CodeBlockContent></CodeBlock></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot><p>“data.progress”表示 data 对象中的 progress 字段。多项按填写顺序读取；选填字段没有对应数据时可留空。</p></Item>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <NumericField id="video-contract-poll-interval" label="查询频率" help="创建异步视频任务后，每隔多少秒向上游查询一次任务状态。间隔过短可能触发上游限流。" min={1} max={300} value={polling.interval_seconds} disabled={readOnly} suffix="秒" onChange={(value) => updateContract((contract) => { contract.polling.interval_seconds = value; })} />
                  <NumericField id="video-contract-poll-timeout" label="最长等待时间" help="上游任务提交成功后最多轮询多长时间；视频任务总时限会自动覆盖该时间和一次轮询间隔。" min={1} max={86400} value={polling.timeout_seconds} disabled={readOnly} suffix="秒" onChange={(value) => updateContract((contract) => { contract.polling.timeout_seconds = value; })} />
                  <TagListField id="video-contract-task-id-fields" label="任务编号取自" help="创建响应中任务 ID 的 JSON 路径，按顺序读取，例如 id 或 data.task_id。" value={draft.taskIDFields} disabled={readOnly} placeholder="例如 id" onValueChange={(value) => setDraft((current) => ({ ...current, taskIDFields: value }))} />
                  <TagListField id="video-contract-status-fields" label="生成状态取自" help="查询响应中任务状态的 JSON 路径，按顺序读取，例如 status 或 data.status。" value={draft.statusFields} disabled={readOnly} placeholder="例如 status" onValueChange={(value) => setDraft((current) => ({ ...current, statusFields: value }))} />
                  <TagListField id="video-contract-progress-fields" label="完成进度取自（选填）" help="查询响应中生成进度的 JSON 路径，按顺序读取，例如 progress 或 data.progress；无法提供进度时可以留空。" value={draft.progressFields} disabled={readOnly} placeholder="例如 progress" onValueChange={(value) => setDraft((current) => ({ ...current, progressFields: value }))} />
                  <TagListField id="video-contract-queued-statuses" label="哪些值表示排队中" help="上游返回这些状态时，任务保持排队中。" value={draft.queuedStatuses} disabled={readOnly} placeholder="例如 queued" onValueChange={(value) => setDraft((current) => ({ ...current, queuedStatuses: value }))} />
                  <TagListField id="video-contract-processing-statuses" label="哪些值表示生成中" help="上游返回这些状态时，任务显示为生成中。" value={draft.processingStatuses} disabled={readOnly} placeholder="例如 in_progress" onValueChange={(value) => setDraft((current) => ({ ...current, processingStatuses: value }))} />
                  <TagListField id="video-contract-success-statuses" label="哪些值表示已完成" help="上游任务查询接口返回这些状态值时，系统认为视频已生成完成，例如 completed 或 succeeded。" value={draft.successStatuses} disabled={readOnly} placeholder="例如 completed" onValueChange={(value) => setDraft((current) => ({ ...current, successStatuses: value }))} />
                  <TagListField id="video-contract-failure-statuses" label="哪些值表示失败" help="上游任务查询接口返回这些状态值时，系统停止轮询并标记生成失败，例如 failed 或 cancelled。" value={draft.failureStatuses} disabled={readOnly} placeholder="例如 failed" onValueChange={(value) => setDraft((current) => ({ ...current, failureStatuses: value }))} />
                  <Field>
                    <ContractFieldLabel htmlFor="video-contract-unknown-status" label="遇到其他状态时" help="没有匹配以上四组的状态统一归为 unknown。系统会保留原始状态并继续轮询，不会误判为成功或失败。" />
                    <Input id="video-contract-unknown-status" readOnly value="继续查询，直到成功、失败或超过最长等待时间" className="h-11 text-muted-foreground" />
                  </Field>
                  <TagListField id="video-contract-error-fields" label="失败原因取自（选填）" help="任务失败时错误信息的 JSON 路径，按顺序读取；可以留空。" value={draft.errorFields} disabled={readOnly} placeholder="例如 error.message" onValueChange={(value) => setDraft((current) => ({ ...current, errorFields: value }))} />
                  <TagListField id="video-contract-result-fields" label="视频下载地址取自" help="任务成功后视频地址的 JSON 路径，按顺序读取，例如 video_url 或 data.output.video_url。" value={draft.resultFields} disabled={readOnly} placeholder="例如 video_url" onValueChange={(value) => setDraft((current) => ({ ...current, resultFields: value }))} />
                </div>
              </Card>
            </ScrollArea>
            <ScrollArea data-video-contract-preview aria-label="契约预览" className={cn("min-h-0 min-w-0 xl:border-l", editorSection !== "preview" && "hidden xl:flex")} contentClassName="grid gap-4 p-1 pr-3 pb-4 xl:pl-4 xl:pt-5" onWheel={(event) => event.stopPropagation()}>
              <ContractParameterPreview key={parameterPreviewKey} contract={previewContract} />
              <Collapsible className="group overflow-hidden">
                <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden h-auto min-h-8">
                  <FlaskConical className="text-muted-foreground" />
                  <span className="min-w-0 flex-1">请求与响应模拟</span>
                  <span className="text-xs font-normal text-muted-foreground group-data-[state=open]:hidden">展开</span>
                  <span className="hidden text-xs font-normal text-muted-foreground group-data-[state=open]:inline">收起</span>
                </Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden">
                <div className="space-y-3 border-t border-border p-3">
                  <Field>
                    <FieldLabel htmlFor="video-contract-preview-input">示例请求</FieldLabel>
                    <Textarea id="video-contract-preview-input" className="min-h-32 font-mono" value={previewInput} onChange={(event) => setPreviewInput(event.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="video-contract-preview-submit">创建响应</FieldLabel>
                    <Textarea id="video-contract-preview-submit" className="min-h-24 font-mono" value={previewSubmitResponse} onChange={(event) => setPreviewSubmitResponse(event.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="video-contract-preview-query">查询响应</FieldLabel>
                    <Textarea id="video-contract-preview-query" className="min-h-24 font-mono" value={previewQueryResponse} onChange={(event) => setPreviewQueryResponse(event.target.value)} />
                  </Field>
                  <Button type="button" size="sm" className="w-full" disabled={isPreviewing} onClick={() => void runPreview()}>
                    {isPreviewing ? <Spinner /> : <FlaskConical  />}
                    运行模拟
                  </Button>
                  {previewResult ? <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-72 font-mono" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><CodeBlock><CodeBlockContent wrap>{JSON.stringify(previewResult, null, 2)}</CodeBlockContent></CodeBlock></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot> : null}
                </div>
              </CollapsibleContent></Collapsible>
              <Collapsible className="group overflow-hidden">
                <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden h-auto min-h-8">
                  <Braces className="text-muted-foreground" />
                  <span className="min-w-0 flex-1">原始 JSON</span>
                  <span className="text-xs font-normal text-muted-foreground group-data-[state=open]:hidden">展开</span>
                  <span className="hidden text-xs font-normal text-muted-foreground group-data-[state=open]:inline">收起</span>
                </Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden">
                <div className="border-t border-border p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-xs text-muted-foreground">{normalizedContract.name || "未填写契约名称"}</p>
                    <CodeBlockCopyButton size="sm" variant="outline" value={contractJSON}>复制 JSON</CodeBlockCopyButton>
                  </div>
                  <CodeBlock><CodeBlockContent wrap>{contractJSON}</CodeBlockContent></CodeBlock>
                </div>
              </CollapsibleContent></Collapsible>
            </ScrollArea>
          </FieldSet>
          <DialogFooter className="shrink-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={isSaving || editorLoading} onClick={() => setPluginTargets([{ id: editingItem?.id || "draft", contract: cloneVideoModelContract(normalizedContract), label: readOnly ? "当前查看版本" : "当前编辑快照", reviewPending: !readOnly, warnings: generatedEditingIndex !== null ? [...(generatedDryRun[generatedEditingIndex]?.review_issues || []), ...(generatedDryRun[generatedEditingIndex]?.missing_evidence || [])] : [] }])}><Code2 />生成插件</Button>
            {!readOnly ? <Button type="button" variant="outline" size="sm" onClick={() => void validate().catch((error) => toast.error(error instanceof Error ? error.message : "契约校验失败"))} disabled={isSaving || editorLoading}><ShieldCheck  />校验配置</Button> : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={closeContractDialog} disabled={isSaving}>{generatedEditingIndex !== null ? "返回审核列表" : readOnly ? "关闭" : "取消"}</Button>
            {!readOnly && editingItem ? <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={isSaving || editorLoading}><FileText  />保存草稿</Button> : null}
            {!readOnly ? <Button type="button" onClick={() => void publish()} disabled={isSaving || editorLoading}>{isSaving ? <Spinner /> : <CheckCircle2  />}{generatedEditingIndex !== null ? (generatedContracts.length > 1 ? "发布并审核下一份" : "发布契约") : editingItem ? "发布新版本" : "添加并发布"}</Button> : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
  const pluginDialog = pluginTargets.length > 0 ? <VideoContractPluginDialog targets={pluginTargets} sessionKey={sessionKey} onClose={() => {
    setPluginTargets([]);
    if (pluginReturnToReview) setGeneratedReviewOpen(generatedContracts.length > 0);
    setPluginReturnToReview(false);
  }} /> : null;
  if (editor) return <>{contractDialog}{pluginDialog}</>;

  const contractEntries = visibleItems.map((item) => {
    const pending = pendingIds.has(item.id);
    const displayedEnabled = optimisticEnabledByID.get(item.id) ?? item.enabled;
    const referenceTypes = referenceTypeCount(item.contract);
    const selection = (
      <Checkbox
        className="shrink-0"
        checked={selectedContractIds.has(item.id)}
        disabled={isBulkActionBusy}
        onCheckedChange={(checked) => toggleContractSelection(item.id, checked === true)}
        aria-label={`选择 ${item.contract.name}`}
      />
    );
    const moreActions = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={`更多操作：${item.contract.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => openView(item)}><Eye />查看契约</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void openVersions(item)}><History />版本历史</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => downloadVideoContractDocument(videoContractTransferDocument([item]), videoContractExportName(item.contract.name))}><Download />导出契约</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPluginTargets([{ id: item.id, contract: cloneVideoModelContract(item.contract), label: `已发布版本 v${item.revision}` }])}><Code2 />生成 New API 插件</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openCopy(item)}><Copy />复制契约</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={pending || isBulkActionBusy} onSelect={() => setDeletingItem(item)}><Trash2 />删除契约</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const modelBadges = (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="匹配模型">
        {item.contract.models.length > 0 ? item.contract.models.slice(0, 2).map((model) => (
          <Badge key={model} variant="outline" className="max-w-full break-all whitespace-normal font-mono">{model}</Badge>
        )) : <span className="text-xs text-muted-foreground">未设置模型匹配规则</span>}
        {item.contract.models.length > 2 ? <TooltipHint content={item.contract.models.slice(2).join("、")}><Badge variant="secondary">+{item.contract.models.length - 2}</Badge></TooltipHint> : null}
        <Badge variant="secondary">v{item.revision}</Badge>
        {item.draft ? <Badge variant="secondary">有草稿</Badge> : null}
      </div>
    );
    const statusToggle = (
      <Label className="flex items-center gap-2 text-xs">
        <Switch
          checked={displayedEnabled}
          disabled={pending || isBulkActionBusy}
          onCheckedChange={() => void toggleEnabled(item)}
          aria-label={displayedEnabled ? "停用契约" : "启用契约"}
        />
        {displayedEnabled ? "已启用" : "已停用"}
      </Label>
    );
    const editButton = (
      <Button type="button" variant="outline" size="sm" disabled={pending || isBulkActionBusy} onClick={() => openEdit(item)} aria-label="编辑契约"><Pencil />编辑契约</Button>
    );
    if (listView === "table") {
      return (
        <TableRow key={item.id} data-video-contract-row data-state={selectedContractIds.has(item.id) ? "selected" : undefined}>
          <TableCell className="px-4">{selection}</TableCell>
          <TableCell className="space-y-2 py-4 whitespace-normal">
            <h3 className="break-words font-medium [overflow-wrap:anywhere]">{item.contract.name}</h3>
            <p className="text-xs text-muted-foreground">{videoContractDriverLabel(item.contract.driver)}</p>
            {modelBadges}
          </TableCell>
          <TableCell className="py-4 whitespace-normal">
            <div className="flex flex-wrap gap-1.5" aria-label="能力范围">
              <Badge variant="secondary">{formatDurationRange(item.contract.capability.seconds)}</Badge>
              <Badge variant="secondary" className="whitespace-normal">{item.contract.model_profiles?.length ? `${item.contract.model_profiles.length} 个模型独立配置` : item.contract.capability.resolutions.join(" / ") || "上游默认清晰度"}</Badge>
              <Badge variant="secondary">{item.contract.capability.sizes.length > 0 ? `${item.contract.capability.sizes.length} 种画幅` : "上游默认画幅"}</Badge>
              {referenceTypes > 0 ? <Badge variant="secondary">{referenceTypes} 类参考素材</Badge> : null}
              {item.contract.rules.length > 0 ? <Badge variant="outline">{item.contract.rules.length} 条规则</Badge> : null}
            </div>
          </TableCell>
          <TableCell>{statusToggle}</TableCell>
          <TableCell className="text-xs text-muted-foreground">
            <time dateTime={item.updated_at} className="block leading-5 tabular-nums">{formatDateTime(item.updated_at)}</time>
            <span className="leading-5">轮询 {item.contract.polling.interval_seconds} 秒</span>
          </TableCell>
          <TableCell className="pr-4"><div className="flex items-center justify-end gap-1">{editButton}{moreActions}</div></TableCell>
        </TableRow>
      );
    }
    return (
      <Card key={item.id} data-video-contract-row data-selected={selectedContractIds.has(item.id) || undefined} className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-start gap-3">
            {selection}
            <h3 className="min-w-0 break-words leading-6 [overflow-wrap:anywhere]">{item.contract.name}</h3>
          </CardTitle>
          <CardDescription className="pl-7">{videoContractDriverLabel(item.contract.driver)}</CardDescription>
          <CardAction>
            {moreActions}
          </CardAction>
        </CardHeader>
        <CardContent className="grid flex-1 content-start gap-5">
          {modelBadges}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm" aria-label="能力范围">
            <div className="min-w-0 space-y-1"><dt className="text-xs text-muted-foreground">视频时长</dt><dd className="font-medium">{formatDurationRange(item.contract.capability.seconds)}</dd></div>
            <div className="min-w-0 space-y-1"><dt className="text-xs text-muted-foreground">清晰度</dt><dd className="break-words font-medium">{item.contract.model_profiles?.length ? `${item.contract.model_profiles.length} 个模型独立配置` : item.contract.capability.resolutions.join(" / ") || "上游默认"}</dd></div>
            <div className="min-w-0 space-y-1"><dt className="text-xs text-muted-foreground">画幅比例</dt><dd className="font-medium">{item.contract.capability.sizes.length > 0 ? `${item.contract.capability.sizes.length} 种画幅` : "上游默认"}</dd></div>
            <div className="min-w-0 space-y-1"><dt className="text-xs text-muted-foreground">参考素材</dt><dd className="font-medium">{referenceTypes > 0 ? `${referenceTypes} 类参考素材` : "纯文本输入"}</dd></div>
          </dl>
          <div className="flex flex-wrap items-center gap-1.5">
            {item.contract.generation.modes.map((mode) => <Badge key={mode.id} variant="secondary">{mode.label}</Badge>)}
            {item.contract.rules.length > 0 ? <Badge variant="outline">{item.contract.rules.length} 条规则</Badge> : null}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">更新于 <time dateTime={item.updated_at} className="tabular-nums">{formatDateTime(item.updated_at)}</time><span className="mx-2">·</span>轮询 {item.contract.polling.interval_seconds} 秒</p>
        </CardContent>
        <CardFooter className="flex-wrap justify-between gap-3">
          {statusToggle}
          {editButton}
        </CardFooter>
      </Card>
    );
  });

  return (
    <>
      {pluginDialog}
      <input
        ref={jsonImportInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => void prepareJSONImport(event.target.files?.[0] || null)}
      />
      <SettingsPanel className="max-w-none gap-5"
        contentClassName="p-0 sm:p-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
        contentScrollable={false}
        title="视频契约"
        description="配置视频生成能力、上游请求和任务轮询。"
        meta={<Badge variant="secondary" >{items.length} 个契约</Badge>}
        action={<Button type="button" size="sm" disabled={isBulkActionBusy || selectedItems.length > 0} onClick={openCreate}><Plus />添加契约</Button>}
      >
        <div className="grid shrink-0 pb-4">
          <div
            data-video-contract-toolbar
            aria-hidden={selectedItems.length > 0}
            className={cn("col-start-1 row-start-1 flex flex-wrap items-center gap-2", selectedItems.length > 0 && "invisible pointer-events-none")}
          >
            <Button type="button" size="sm" variant="ghost" disabled={isJSONImporting || isBulkActionBusy || selectedItems.length > 0} onClick={() => jsonImportInputRef.current?.click()}>
              <Upload  />
              导入 JSON
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={items.length === 0 || selectedItems.length > 0} onClick={() => downloadVideoContractDocument(videoContractTransferDocument(items), "video-model-contracts.json")}>
              <Download  />
              导出
            </Button>
            <Separator orientation="vertical" className="mx-1 hidden h-5 data-vertical:self-center sm:block" />
            <Button type="button" size="sm" variant="outline" disabled={isBulkActionBusy || selectedItems.length > 0} onClick={openImport}>
              <WandSparkles  />
              从文档生成
            </Button>
            <AutoDLContractImport key={sessionKey} disabled={isBulkActionBusy || selectedItems.length > 0} onDraft={(contract) => { setGeneratedContracts([contract]); setGeneratedDryRun([]); setGeneratedReviewOpen(true); }} />
          </div>
          <div
            data-video-contract-bulk-toolbar
            aria-hidden={selectedItems.length === 0}
            className={cn("col-start-1 row-start-1 flex flex-wrap items-center gap-2", selectedItems.length === 0 && "invisible pointer-events-none")}
          >
            <span className="mr-1 whitespace-nowrap text-sm font-medium text-foreground">已选择 {selectedItems.length} 个</span>
            <Button type="button" size="sm" variant="outline" disabled={isBulkActionBusy || selectedItems.length === 0} onClick={() => void updateSelectedContractsEnabled(true)}>
              <Power  />批量启用
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={isBulkActionBusy || selectedItems.length === 0} onClick={() => void updateSelectedContractsEnabled(false)}>
              <PowerOff  />批量停用
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={isBulkActionBusy || selectedItems.length === 0} onClick={exportSelectedContracts}>
              <Download  />导出选中
            </Button>
            <Button type="button" size="sm" variant="outline"  disabled={isBulkActionBusy || selectedItems.length === 0} onClick={() => setBulkDeleteOpen(true)}>
              <Trash2  />删除选中
            </Button>
            <TooltipHint content="清除选择">
              <Button type="button" size="icon" variant="ghost"  disabled={isBulkActionBusy || selectedItems.length === 0} onClick={() => setSelectedContractIds(new Set())} aria-label="清除契约选择">
                <X  />
              </Button>
            </TooltipHint>
          </div>
        </div>
        {isLoading ? (
          <LoadingState className="h-auto" label="正在加载视频契约" />
        ) : items.length === 0 ? (
          <div className="p-5 sm:p-6"><SettingsEmptyState icon={Film} title="暂无视频模型契约" description="添加后可为模型设置中的视频模型提供参数和请求转换规则。" /></div>
        ) : (
          <div data-video-contract-list className="@container/video-contract-list flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pb-4 text-xs text-muted-foreground">
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={allVisibleSelected || (someVisibleSelected ? "indeterminate" : false)}
                  disabled={isBulkActionBusy}
                  onCheckedChange={(checked) => toggleVisibleContractSelection(checked === true)}
                  aria-label="选择当前页契约"
                />
                选择本页
              </Label>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <span>{items.filter((item) => item.enabled).length} 个已启用 · {items.filter((item) => !item.enabled).length} 个已停用</span>
                <div role="group" aria-label="契约视图" className="flex items-center gap-1">
                  <Button type="button" variant={listView === "table" ? "secondary" : "ghost"} size="icon-sm" aria-label="表格视图" aria-pressed={listView === "table"} onClick={() => setListView("table")}><Table2 /></Button>
                  <Button type="button" variant={listView === "cards" ? "secondary" : "ghost"} size="icon-sm" aria-label="卡片视图" aria-pressed={listView === "cards"} onClick={() => setListView("cards")}><LayoutGrid /></Button>
                </div>
              </div>
            </div>
            <ScrollArea data-video-contract-rows className="-mx-1 min-h-0 flex-1" contentClassName={cn("px-1 pt-1 pb-4", listView === "cards" && "grid items-stretch gap-4 @3xl/video-contract-list:grid-cols-2")} onWheel={(event) => event.stopPropagation()}>
              {listView === "table" ? (
                <Card className="gap-0 py-0">
                  <Table aria-label="视频契约表格" className="min-w-[940px] table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12 px-4"><span className="sr-only">选择</span></TableHead>
                        <TableHead className="w-[28%]">契约与匹配模型</TableHead>
                        <TableHead>能力范围</TableHead>
                        <TableHead className="w-28">状态</TableHead>
                        <TableHead className="w-36">更新时间</TableHead>
                        <TableHead className="w-36 pr-4 text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{contractEntries}</TableBody>
                  </Table>
                </Card>
              ) : contractEntries}
            </ScrollArea>
            <ManagementPagination
              page={safeListPage}
              totalPages={listTotalPages}
              totalItems={items.length}
              pageSize={listPageSize}
              pageSizeOptions={[10, 20, 50]}
              itemLabel="个"
              onPageChange={setListPage}
              onPageSizeChange={(pageSize) => {
                setListPageSize(pageSize);
                setListPage(1);
              }}
            />
          </div>
        )}
      </SettingsPanel>

      <Dialog open={importOpen} onOpenChange={(open) => !isImporting && setImportOpen(open)}>
        <DialogContent className="w-[min(calc(100%-2rem),60rem)] sm:max-w-none" showCloseButton={!isImporting}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 leading-6"><WandSparkles className="size-5 shrink-0" />从文档生成契约</DialogTitle>
            <DialogDescription>{isImporting ? "按步骤读取文档、匹配协议并校验配置，执行记录实时更新。" : importStatus ? "本次执行已结束。查看执行记录，或调整文档与模型后重试。" : "提供 API 文档，由 Agent 提取视频能力与接口配置，生成可审核的契约草稿。"}</DialogDescription>
          </DialogHeader>
          <ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 px-1 py-1">
            <AgentExecutionRecovery domain="video_contract" busy={isImporting} onResult={(data: Awaited<ReturnType<typeof importVideoModelContract>>) => { acceptImportedContracts(data); setImportOpen(false); }} />
            <div className="grid gap-4">
              <div className={cn("grid min-w-0 items-stretch gap-4 md:grid-cols-[minmax(0,1fr)_18rem]", importStatus && "hidden")}>
                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>文档来源</CardTitle>
                    <CardDescription>上传本地文件，或提供多份在线文档。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Tabs value={importSourceType} onValueChange={(value) => { setImportSourceType(value as "file" | "url"); clearImportFeedback(); }} className="min-w-0 gap-4">
                      <TabsList className="w-full" aria-label="文档来源">
                        <TabsTrigger value="file" disabled={isImporting}><FileText />上传文档</TabsTrigger>
                        <TabsTrigger value="url" disabled={isImporting}><Link2 />文档链接</TabsTrigger>
                      </TabsList>
                      <TabsContent value="file">
                        <VideoContractDocumentUpload file={importFile} disabled={isImporting} onChange={file => { setImportFile(file); clearImportFeedback(); }} />
                      </TabsContent>
                      <TabsContent value="url" className="min-h-52 py-3">
                        <Field>
                          <FieldLabel htmlFor="video-contract-import-url">文档地址</FieldLabel>
                          <Textarea id="video-contract-import-url" value={importURL} disabled={isImporting} rows={5} className="min-h-32 resize-y" placeholder={"https://docs.example.com/video/create\nhttps://docs.example.com/video/query"} aria-describedby="video-contract-import-url-help" onChange={(event) => { setImportURL(event.target.value); clearImportFeedback(); }} />
                          <FieldDescription id="video-contract-import-url-help">每行一个公开的 HTTP 或 HTTPS 链接，最多 24 个。重复地址会去重，Agent 将合并分析所有文档及相关接口页面。</FieldDescription>
                          <span className="text-xs text-muted-foreground" aria-live="polite">已填写 {importURLs.length} 个地址</span>
                        </Field>
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>生成设置</CardTitle>
                    <CardDescription>选择分析模型和草稿生成后的操作。</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <Field>
                      <FieldLabel htmlFor="video-contract-analysis-model">分析模型</FieldLabel>
                      <ModelPicker id="video-contract-analysis-model" label="契约分析模型" value={importModel} options={textModels} disabled={isImporting || isLoadingImportOptions} onValueChange={setImportModel} placeholder={isLoadingImportOptions ? "读取模型中" : "暂无可用文本模型"} />
                      <FieldDescription>需支持工具调用，使用个人默认文本 Key。</FieldDescription>
                    </Field>
                    <Separator />
                    <Field orientation="horizontal" className="items-start">
                      <FieldContent>
                        <FieldLabel htmlFor="video-contract-import-plugin">生成 New API 插件</FieldLabel>
                        <FieldDescription id="video-contract-import-plugin-help">开启后，草稿生成完成时进入插件配置，可逐份生成和下载。</FieldDescription>
                      </FieldContent>
                      <Switch id="video-contract-import-plugin" aria-describedby="video-contract-import-plugin-help" checked={importGeneratePlugin} disabled={isImporting} onCheckedChange={setImportGeneratePlugin} />
                    </Field>
                  </CardContent>
                </Card>
              </div>
            {importStatus ? <VideoContractImportProgress activity={importStatus} running={isImporting} error={importError} elapsed={formatElapsedSeconds(importElapsedSeconds)} /> : null}
            <VideoContractAgentDetails entries={importDetails} running={isImporting} />
            {importError && !importStatus ? (
              <Alert variant="destructive" role="alert" className="flex flex-wrap items-center gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words leading-relaxed">{importError}</span>
              </Alert>
            ) : null}
          </div>
          </ScrollArea>
          <DialogFooter className="shrink-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0" />生成后先审核草稿，再发布生效。</p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!isImporting && importStatus ? <Button type="button" variant="ghost" onClick={clearImportFeedback}>调整文档或模型</Button> : null}
              <Button type="button" variant="outline" onClick={() => { if (isImporting) { importControllerRef.current?.abort(); void stopAgentExecution(importRunIDRef.current).catch((error: Error) => toast.error(error.message)); } else setImportOpen(false); }}>
                {isImporting ? <Square className="fill-current" /> : null}{isImporting ? "停止分析" : "取消"}
              </Button>
              <Button type="button" disabled={isImporting || isLoadingImportOptions || !importModel || (importSourceType === "file" ? !importFile : importURLs.length === 0)} onClick={() => void generateFromDocument()}>
                {isImporting ? <Spinner /> : <WandSparkles />}{isImporting ? "分析中" : importStatus ? "重新分析" : importGeneratePlugin ? "生成草稿并配置插件" : "生成契约草稿"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={generatedReviewOpen} onOpenChange={(open) => (open ? setGeneratedReviewOpen(true) : !isPublishingGeneratedContracts && abandonGeneratedContracts())}>
        <DialogContent className="w-[min(calc(100%-2rem),48rem)] sm:max-w-none" showCloseButton={!isPublishingGeneratedContracts}>
          <DialogHeader >
            <div className="flex items-start gap-3">
              <ItemMedia variant="icon" className="flex size-11 shrink-0 items-center justify-center"><CheckCircle2 className="size-5" /></ItemMedia>
              <div className="space-y-1.5"><DialogTitle>审核生成的契约</DialogTitle><DialogDescription>已生成 {generatedContracts.length} 份草稿，覆盖 {new Set(generatedContracts.flatMap((contract) => contract.models)).size} 个模型。确认参数和素材要求后发布。</DialogDescription></div>
            </div>
          </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          {generatedDryRun.some(item => item.limitations?.length || item.notes?.length) ? <Collapsible ><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal cursor-pointer h-auto min-h-8">功能限制与配置说明（不阻止初审）</Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden"><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{generatedDryRun.flatMap(item => [...(item.limitations || []), ...(item.notes || [])]).map((note,index) => <li key={index}>{note}</li>)}</ul></CollapsibleContent></Collapsible> : null}
          {generatedDryRun.length === generatedContracts.length && generatedDryRun.length > 0 && generatedDryRun.every((item, index) => item.passed && item.contract === generatedContracts[index].name) ? (
            <Alert role="status" className="flex flex-wrap items-center gap-2">
              {generatedDryRun.every(item => item.review_passed) ? <CheckCircle2 className="size-4 shrink-0" /> : <CircleAlert className="size-4 shrink-0" />}
              <span className="font-medium">{generatedDryRun.every(item => item.review_passed) ? "契约初审通过" : "本地干跑通过 · 契约待确认"}</span>
              <span className="text-xs opacity-80">已干跑 {generatedDryRun.reduce((sum, item) => sum + item.models_tested, 0)} 个模型规则与 {generatedDryRun.reduce((sum, item) => sum + item.modes_tested, 0)} 个生成模式的代表性样本；未覆盖全部参数组合，尚未实测上游。</span>
            </Alert>
          ) : null}
          {generatedWarnings.length > 0 ? (
            <Card aria-label="文档分析提示" className="space-y-2 p-4 gap-0">
              <p className="flex items-center gap-2 font-medium"><FileText className="size-4 shrink-0 text-muted-foreground" />文档分析说明</p>
              <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">{generatedWarnings.map((warning) => <li key={warning} className="break-words">{warning}</li>)}</ul>
            </Card>
          ) : null}
          {generatedPublishError ? <Alert variant="destructive" role="alert">{generatedPublishError}</Alert> : null}
          <VideoContractAgentDetails entries={importDetails} running={false} />
          <div className="space-y-3" aria-label="生成的契约草稿">
            {generatedContracts.map((contract, index) => (
              <Card key={`${contract.name}-${index}`} className="min-w-0 p-4 gap-0">
                <div className="flex min-w-0 items-start gap-3">
                  <ItemMedia variant="icon" className="flex size-8 shrink-0 items-center justify-center tabular-nums">{String(index + 1).padStart(2, "0")}</ItemMedia>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm font-semibold">{contract.name || "未命名契约"}</h3>{generatedDryRun[index]?.passed && generatedDryRun[index]?.contract === contract.name ? <Badge variant={generatedDryRun[index].review_passed ? "default" : "secondary"} >{generatedDryRun[index].review_passed ? "契约初审通过" : "契约待确认"}</Badge> : null}</div>
                    <div className="flex flex-wrap gap-1.5">{contract.models.map((model) => <Badge key={model} variant="secondary" className="max-w-full break-all whitespace-normal font-mono">{model}</Badge>)}</div>
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={isPublishingGeneratedContracts} onClick={() => removeGeneratedContract(index)} aria-label={`移除 ${contract.name || "未命名契约"}`}><Trash2  /></Button>
                </div>
                <ContractModelProfileSummary contract={contract} />
                {generatedDryRun[index]?.passed && generatedDryRun[index]?.contract === contract.name ? <div className="mt-3"><TestResults label={`${contract.name} 干跑检查结果`} checks={generatedDryRun[index].checks} /></div> : null}
                <p className="mt-3 text-xs leading-5 text-muted-foreground">接口协议：<span className="font-medium text-foreground">{videoContractDriverLabel(contract.driver)}</span>{contract.driver === "custom-video" ? " · 请确认自定义接口路径和字段映射" : contract.transport.create_path || contract.transport.query_path ? " · 使用自定义接口路径" : " · 使用内置接口路径"}</p>
                <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border/70 pt-3">
                  <dl className={cn("flex flex-wrap gap-x-6 gap-y-2 text-xs", Boolean(contract.model_profiles?.length) && "hidden")}>
                    <div><dt className="text-muted-foreground">时长</dt><dd className="mt-1 font-medium">{formatDurationRange(contract.capability.seconds)}</dd></div>
                    <div><dt className="text-muted-foreground">清晰度</dt><dd className="mt-1 font-medium">{contract.capability.resolutions.join(" / ") || "上游默认"}</dd></div>
                    <div><dt className="text-muted-foreground">画幅</dt><dd className="mt-1 font-medium" title={contract.capability.sizes.join(" / ")}>{contract.capability.sizes.length > 3 ? `${contract.capability.sizes.length} 种画幅` : contract.capability.sizes.join(" / ") || "上游默认"}</dd></div>
                    <div><dt className="text-muted-foreground">生成模式</dt><dd className="mt-1 font-medium">{contract.generation.modes.map((mode) => mode.label).join(" / ")}</dd></div>
                  </dl>
                  <Button type="button" variant="outline" size="sm" disabled={isPublishingGeneratedContracts} onClick={() => openGeneratedContract(index)}><Pencil  />审核参数</Button>
                </div>
              </Card>
            ))}
          </div>
          </ScrollArea><DialogFooter className="flex-col sm:flex-col sm:items-stretch">
            <p className="text-xs leading-relaxed text-muted-foreground">发布后启用新契约。同名或模型冲突时整批停止，已有契约和草稿会保留。</p>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button type="button" variant="ghost" disabled={isPublishingGeneratedContracts} onClick={abandonGeneratedContracts}>放弃草稿</Button>
            <Button type="button" variant="outline" disabled={isPublishingGeneratedContracts || generatedContracts.length === 0} onClick={() => openGeneratedContract(0)}>逐份审核</Button>
            <Button type="button" className="col-span-2" disabled={isPublishingGeneratedContracts || generatedContracts.length === 0} onClick={() => void publishAllGeneratedContracts()}>
              {isPublishingGeneratedContracts ? <Spinner /> : <CheckCheck  />}
              {isPublishingGeneratedContracts ? "正在发布" : `发布全部（${generatedContracts.length}）`}
            </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {contractDialog}

      <Dialog open={Boolean(pendingJSONImport)} onOpenChange={(open) => (!open && !isJSONImporting ? setPendingJSONImport(null) : undefined)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>导入视频模型契约</DialogTitle>
            <DialogDescription>{pendingJSONImport?.filename}</DialogDescription>
          </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <div className="space-y-4 py-1">
            <Card className="grid grid-cols-3 divide-x divide-border text-center gap-0 p-0">
              <div className="px-3 py-3"><p className="text-lg font-semibold text-foreground">{pendingJSONImport?.bundle.contracts.length || 0}</p><p className="text-xs text-muted-foreground">全部</p></div>
              <div className="px-3 py-3"><p className="text-lg font-semibold text-foreground">{pendingImportSummary.created}</p><p className="text-xs text-muted-foreground">新增</p></div>
              <div className="px-3 py-3"><p className="text-lg font-semibold text-foreground">{pendingImportSummary.updated}</p><p className="text-xs text-muted-foreground">更新</p></div>
            </Card>
            <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-52" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0 divide-y divide-border">
              {pendingJSONImport?.bundle.contracts.map((item, index) => (
                <div key={`${item.contract.name}-${index}`} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5">
                  <span className="truncate text-sm font-medium text-foreground">{item.contract.name || "未命名契约"}</span>
                  <Badge variant={item.enabled ? "default" : "secondary"} className="shrink-0">{item.enabled ? "启用" : "停用"}</Badge>
                </div>
              ))}
            </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
            {pendingImportSummary.updated > 0 ? <p className="text-sm text-muted-foreground">同名契约将更新，未出现在文件中的现有契约不会改变。</p> : null}
          </div>
          </ScrollArea><DialogFooter>
            <Button type="button" variant="outline" disabled={isJSONImporting} onClick={() => setPendingJSONImport(null)}>取消</Button>
            <Button type="button" disabled={isJSONImporting} onClick={() => void confirmJSONImport()}>
              {isJSONImporting ? <Spinner /> : <Upload  />}
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
          </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-[min(60dvh,520px)]" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0">
            {isLoadingVersions ? (
              <LoadingState className="h-auto min-h-32" label="正在加载版本记录" />
            ) : versions.length === 0 ? (
              <EmptyState compact title="暂无历史版本" className="min-h-0 p-6" />
            ) : (
              <div className="divide-y divide-border/70">
                {versions.map((version) => {
                  const current = version.revision === versionsItem?.revision;
                  return (
                    <div key={version.revision} className="flex min-w-0 items-center gap-3 px-4 py-3">
                      <ItemMedia variant="icon" className="flex size-9 shrink-0 items-center justify-center font-mono">v{version.revision}</ItemMedia>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{version.contract.name}</p>
                        <time dateTime={version.published_at} className="text-xs text-muted-foreground">{formatDateTime(version.published_at)}</time>
                      </div>
                      {current ? <Badge variant="default">当前版本</Badge> : (
                        <Button type="button" size="sm" variant="outline" disabled={isRollingBack} onClick={() => void rollback(version.revision)}>
                          {isRollingBack ? <Spinner /> : <History  />}回滚到此版本
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
          </ScrollArea><DialogFooter><Button type="button" variant="outline" disabled={isRollingBack} onClick={closeVersions}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deletingItem)}
        onOpenChange={(open) => (!open ? setDeletingItem(null) : undefined)}
        title="删除视频模型契约"
        description={<>删除“{deletingItem?.contract.name}”后，对应模型将立即停止使用这份契约。</>}
        confirmLabel="删除"
        busy={Boolean(deletingItem && pendingIds.has(deletingItem.id))}
        destructive
        onConfirm={() => void remove()}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !isBulkActionBusy && setBulkDeleteOpen(open)}
        title="批量删除视频模型契约？"
        description={<>将永久删除选中的 {selectedItems.length} 个契约，使用这些契约的模型会立即失去对应参数和请求映射。</>}
        confirmLabel={`删除 ${selectedItems.length} 个契约`}
        busy={isBulkActionBusy}
        confirmDisabled={selectedItems.length === 0}
        destructive
        onConfirm={() => void deleteSelectedContracts()}
      />
    </>
  );
}
