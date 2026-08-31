type VideoModelMaterialRange = { min: number; max: number };
type VideoModelModeMaterials = {
  first_frame: VideoModelMaterialRange;
  last_frame: VideoModelMaterialRange;
  image: VideoModelMaterialRange;
  video: VideoModelMaterialRange;
  audio: VideoModelMaterialRange;
  total: VideoModelMaterialRange;
};
export type VideoModelGenerationMode = {
  id: string;
  label: string;
  kind: "text" | "image" | "reference";
  request_value: string;
  materials: VideoModelModeMaterials;
};
export type VideoModelContractRuleField = "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio" | "generate_audio" | "size" | "resolution" | "duration" | "watermark";
export type VideoModelContractRule = {
  when: { field: VideoModelContractRuleField; operator: "present" | "equals"; value?: string };
  require?: VideoModelContractRuleField[];
  require_any?: VideoModelContractRuleField[];
  forbid?: VideoModelContractRuleField[];
  limits?: Partial<Record<VideoModelContractRuleField, number>>;
  force_values?: Partial<Record<VideoModelContractRuleField, string>>;
  ui?: {
    show?: VideoModelContractRuleField[];
    hide?: VideoModelContractRuleField[];
    disable?: VideoModelContractRuleField[];
  };
  message: string;
};

export type VideoModelContractRuleValues = Partial<Record<VideoModelContractRuleField, unknown>>;
export type VideoModelContractUIState = {
  hidden: ReadonlySet<VideoModelContractRuleField>;
  disabled: ReadonlySet<VideoModelContractRuleField>;
};

export type VideoModelContract = {
  name: string;
  models: string[];
  priority: number;
  driver:
    | "openai-videos"
    | "xai-videos"
    | "gemini-veo"
    | "vertex-veo"
    | "dashscope-video"
    | "volcengine-video"
    | "kling-video"
    | "minimax-video"
    | "vidu-video"
    | "kie-video"
    | "apimart-video"
    | "custom-video";
  transport: {
    local_material: "url" | "multipart";
    multipart_file_field: string;
    multipart_repeatable: boolean;
    multipart_mixed_urls: boolean;
    create_path: string;
    query_path: string;
  };
  artifact: {
    mode: "response_url" | "task_content";
    content_path: string;
    auth: "none" | "relay";
    allowed_hosts: string[];
  };
  capability: {
    sizes: string[];
    seconds: number[];
    resolutions: string[];
    default_size: string;
    default_seconds: number;
    default_resolution: string;
    references: { image: number; video: number; audio: number; total: number };
    first_frame_image_limit: number;
    reference_mode: boolean;
    audio_control: "none" | "toggle" | "always";
    watermark: boolean;
  };
  validation: {
    max_prompt_characters: number;
    allow_audio_only_reference: boolean;
  };
  generation: {
    selection: "infer";
    default_mode: string;
    modes: VideoModelGenerationMode[];
  };
  rules: VideoModelContractRule[];
  request: {
    duration_field: string;
    aspect_ratio_field: string;
    resolution_field: string;
    generate_audio_field: string;
    watermark_field: string;
    generation_mode_field: string;
    first_frame_field: string;
    last_frame_field: string;
    reference_images_field: string;
    reference_videos_field: string;
    reference_audios_field: string;
  };
  polling: {
    interval_seconds: number;
    timeout_seconds: number;
    task_id_fields: string[];
    status_fields: string[];
    progress_fields: string[];
    error_fields: string[];
    queued_statuses: string[];
    processing_statuses: string[];
    success_statuses: string[];
    failure_statuses: string[];
    result_fields: string[];
  };
};

export function cloneVideoModelContract(contract: VideoModelContract): VideoModelContract {
  return structuredClone(contract);
}

let activeContracts: VideoModelContract[] = [];
let contractIndex = indexContracts(activeContracts);

type IndexedWildcardContract = {
  pattern: string;
  literalCount: number;
  wildcardCount: number;
  contract: VideoModelContract;
};

function globMatches(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function indexContracts(contracts: VideoModelContract[]) {
  const exact = new Map<string, VideoModelContract>();
  const wildcards: IndexedWildcardContract[] = [];
  for (const contract of contracts) {
    for (const model of contract.models) {
      const key = model.trim().toLowerCase();
      if (exact.has(key) || wildcards.some((candidate) => candidate.pattern === key)) throw new Error(`Duplicate video model contract for ${model}`);
      if (key.includes("*")) {
        wildcards.push({
          pattern: key,
          literalCount: [...key.replaceAll("*", "")].length,
          wildcardCount: key.split("*").length - 1,
          contract,
        });
      } else {
        exact.set(key, contract);
      }
    }
  }
  wildcards.sort((left, right) =>
    right.literalCount - left.literalCount
    || left.wildcardCount - right.wildcardCount
    || right.contract.priority - left.contract.priority
    || left.pattern.localeCompare(right.pattern)
    || left.contract.name.localeCompare(right.contract.name));
  return { exact, wildcards };
}

export function installVideoModelContracts(contracts: VideoModelContract[] | null | undefined) {
  activeContracts = Array.isArray(contracts) ? contracts.map(cloneVideoModelContract) : [];
  contractIndex = indexContracts(activeContracts);
}

export function activeVideoModelContracts() {
  return activeContracts.map((contract) => structuredClone(contract));
}

export function videoModelContract(model: string) {
  const key = String(model || "").trim().toLowerCase();
  const exact = contractIndex.exact.get(key);
  if (exact) return exact;
  return contractIndex.wildcards.find((candidate) => globMatches(candidate.pattern, key))?.contract;
}

export function videoContractGenerationMode(contract: VideoModelContract, kind: VideoModelGenerationMode["kind"]) {
  return contract.generation.modes.find((mode) => mode.kind === kind);
}

export type VideoModelMaterialCounts = {
  first_frame: number;
  last_frame: number;
  image: number;
  video: number;
  audio: number;
};

export function videoContractMaterialError(contract: VideoModelContract, kind: VideoModelGenerationMode["kind"], counts: VideoModelMaterialCounts) {
  const mode = videoContractGenerationMode(contract, kind);
  if (!mode) return `当前模型不支持${kind === "text" ? "文生视频" : kind === "image" ? "图生视频" : "参考素材生视频"}`;
  const values: Array<[string, number, VideoModelMaterialRange]> = [
    ["首帧", counts.first_frame, mode.materials.first_frame],
    ["尾帧", counts.last_frame, mode.materials.last_frame],
    ["参考图片", counts.image, mode.materials.image],
    ["参考视频", counts.video, mode.materials.video],
    ["参考音频", counts.audio, mode.materials.audio],
  ];
  for (const [label, count, range] of values) {
    if (count < range.min) return `${mode.label}至少需要 ${range.min} 个${label}`;
    if (count > range.max) return range.max === 0 ? `${mode.label}不能使用${label}` : `${mode.label}最多支持 ${range.max} 个${label}`;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total < mode.materials.total.min) return `${mode.label}至少需要 ${mode.materials.total.min} 个素材`;
  if (total > mode.materials.total.max) return `${mode.label}素材合计最多支持 ${mode.materials.total.max} 个`;
  return "";
}

function contractRuleValueCount(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value === 0 ? 0 : value;
  return String(value || "").trim() ? 1 : 0;
}

function contractRuleMatches(rule: VideoModelContractRule, values: VideoModelContractRuleValues) {
  const value = values[rule.when.field];
  return rule.when.operator === "present"
    ? contractRuleValueCount(value) > 0
    : String(value ?? "").trim().toLowerCase() === String(rule.when.value || "").trim().toLowerCase();
}

export function videoContractRuleError(contract: VideoModelContract, values: VideoModelContractRuleValues) {
  for (const rule of contract.rules || []) {
    if (!contractRuleMatches(rule, values)) continue;
    if ((rule.require || []).some((field) => contractRuleValueCount(values[field]) === 0)) return rule.message;
    if ((rule.require_any || []).length > 0 && !(rule.require_any || []).some((field) => contractRuleValueCount(values[field]) > 0)) return rule.message;
    if ((rule.forbid || []).some((field) => contractRuleValueCount(values[field]) > 0)) return rule.message;
    if (Object.entries(rule.limits || {}).some(([field, limit]) => contractRuleValueCount(values[field as VideoModelContractRuleField]) > Number(limit))) return rule.message;
  }
  return "";
}

export function applyVideoContractForcedValues(contract: VideoModelContract, values: VideoModelContractRuleValues) {
  const next = { ...values };
  for (const rule of contract.rules || []) {
    if (!contractRuleMatches(rule, next)) continue;
    for (const [field, value] of Object.entries(rule.force_values || {})) {
      const key = field as VideoModelContractRuleField;
      next[key] = videoContractForcedValue(key, value);
    }
  }
  return next;
}

function videoContractForcedValue(field: VideoModelContractRuleField, value: string) {
  return field === "duration" ? Number(value) : field === "generate_audio" || field === "watermark" ? value === "true" : value;
}

export function videoContractUIState(contract: VideoModelContract | null | undefined, values: VideoModelContractRuleValues): VideoModelContractUIState {
  const hidden = new Set<VideoModelContractRuleField>();
  const disabled = new Set<VideoModelContractRuleField>();
  const effectiveValues = { ...values };
  for (const rule of contract?.rules || []) {
    if (!contractRuleMatches(rule, effectiveValues)) continue;
    for (const field of rule.ui?.show || []) hidden.delete(field);
    for (const field of rule.ui?.hide || []) hidden.add(field);
    for (const field of rule.ui?.disable || []) disabled.add(field);
    for (const [field, value] of Object.entries(rule.force_values || {})) {
      const key = field as VideoModelContractRuleField;
      effectiveValues[key] = videoContractForcedValue(key, value);
    }
  }
  return { hidden, disabled };
}
