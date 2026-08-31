import { httpRequest } from "@/lib/request";
import {
  normalizeImageConversationAssetReference,
  planImageConversationAssetUploadBatches,
  type ImageConversationAssetUploadItem,
} from "@/lib/image-conversation-assets";
import type { LoginPageImageMode } from "@/lib/login-page-image-layout";
import {
  videoGenerationTaskRequestBody,
  type VideoGenerationTaskRequestInput,
} from "@/lib/video-request-normalizer";
import type {
  GenerationMediaType,
  GenerationTaskMode,
  GenerationTaskStatus,
  GenerationOutputStatus,
} from "@/lib/generation-task-contract";
import {
  composeImageGenerationPrompt,
  normalizedImagePartialImages,
} from "@/lib/image-api-contract";
import {
  installVideoModelContracts,
  type VideoModelContract,
} from "@/lib/video-model-contracts";
import { createExpiringRequestCache } from "@/lib/expiring-request-cache";

export type ImageModel = string;
export type ImageModelOption = { value: ImageModel; label: string };
export const DEFAULT_IMAGE_MODELS: ImageModel[] = [
  "gpt-image-2",
  "gemini-3.1-flash-image",
  "grok-imagine-image",
];
export const DEFAULT_IMAGE_MODEL: ImageModel = DEFAULT_IMAGE_MODELS[0];
export function normalizeModelNames(
  value: unknown,
  fallback: ReadonlyArray<ImageModel>,
): ImageModel[] {
  const rawItems = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const seen = new Set<string>();
  const models: ImageModel[] = [];
  for (const item of rawItems) {
    const model = String(item ?? "").trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    models.push(model);
  }
  return models.length > 0 ? models : [...fallback];
}

export function modelOptionsFromNames(
  names: ReadonlyArray<ImageModel>,
): ImageModelOption[] {
  return normalizeModelNames(names, []).map((model) => ({
    value: model,
    label: model,
  }));
}

export const IMAGE_CREATION_MODEL_OPTIONS =
  modelOptionsFromNames(DEFAULT_IMAGE_MODELS);
export function isImageModel(value: unknown): value is ImageModel {
  return typeof value === "string" && value.trim() !== "";
}

export function isImageCreationModel(value: unknown): value is ImageModel {
  return isImageModel(value);
}

export {
  imageOutputCountLimit,
  imageReferenceImageLimit,
  supportsImageEditing,
  supportsImageOutputControls,
  supportsImageQualityValue,
  supportsImageResolution,
  supportsImageStreaming,
  supportsStructuredImageParameters,
} from "@/lib/image-model-capabilities";

export type ImageQuality = "low" | "medium" | "high";
export type ImageRequestQuality = "auto" | ImageQuality;
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageModeration = "auto" | "low";
export type ImageVisibility = "private" | "public";

export type RelayModelListItem = {
  id?: string;
  object?: string;
  owned_by?: string;
};

export function relayModelOptionsFromList(
  items: RelayModelListItem[] | null | undefined,
): ImageModelOption[] {
  const seen = new Set<string>();
  const options: ImageModelOption[] = [];
  for (const item of items || []) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({ value: id, label: id });
  }
  return options;
}

const IMAGE_QUALITY_VALUES = new Set<string>(["low", "medium", "high"]);
const IMAGE_OUTPUT_FORMAT_VALUES = new Set<string>(["png", "jpeg", "webp"]);
const IMAGE_MODERATION_VALUES = new Set<string>(["auto", "low"]);

export function isImageQuality(value: unknown): value is ImageQuality {
  return typeof value === "string" && IMAGE_QUALITY_VALUES.has(value);
}

export function isImageOutputFormat(
  value: unknown,
): value is ImageOutputFormat {
  return typeof value === "string" && IMAGE_OUTPUT_FORMAT_VALUES.has(value);
}

export function isImageModeration(value: unknown): value is ImageModeration {
  return typeof value === "string" && IMAGE_MODERATION_VALUES.has(value);
}

export function supportsImageOutputCompression(format: ImageOutputFormat) {
  return format === "jpeg" || format === "webp";
}

type AuthRole = "admin" | "user";
export type LogView = "all" | "meaningful" | "business";
export type PermissionMenu = {
  id: string;
  label: string;
  path: string;
  icon?: string;
  order?: number;
  children?: PermissionMenu[];
};

export type ApiPermission = {
  key: string;
  method: string;
  path: string;
  label: string;
  group: string;
  subtree?: boolean;
};

export type Announcement = {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type AnnouncementInput = {
  title: string;
  content: string;
  enabled: boolean;
};

export type AnnouncementPreferences = {
  seen_versions: string[];
  permanent_versions: string[];
  snoozed_dates: Record<string, string>;
};

export type SettingsConfig = {
	storage?: StorageSettingConfig;
  proxy: string;
  base_url?: string;
  app_title?: string;
  project_name?: string;
  site_icon_url?: string;
  relay_base_url?: string;
  relay_database_url?: string;
  relay_database_type?: "newapi" | "sub2api" | string;
  relay_database_driver?: "sqlite" | "postgres" | "mysql" | string;
  relay_database_host?: string;
  relay_database_port?: string;
  relay_database_name?: string;
  relay_database_user?: string;
  relay_database_password?: string;
  relay_database_configured?: boolean;
  relay_database_password_configured?: boolean;
  image_models?: string[] | string;
  default_image_model?: string;
  video_models?: string[] | string;
  default_video_model?: string;
  text_models?: string[] | string;
  default_text_model?: string;
  audio_models?: string[] | string;
  default_audio_model?: string;
  image_task_timeout_seconds?: number | string;
  user_default_concurrent_limit?: number | string;
  user_default_rpm_limit?: number | string;
  allow_user_custom_relay_config?: boolean;
  image_retention_days?: number | string;
  image_storage_limit_mb?: number | string;
  log_retention_days?: number | string;
  log_cleanup_schedule_enabled?: boolean;
  log_cleanup_hour?: number | string;
  default_log_view?: LogView | string;
  log_levels?: string[];
  login_page_image_url?: string;
  login_page_image_mode?: LoginPageImageMode | string;
  login_page_image_zoom?: number | string;
  login_page_image_position_x?: number | string;
  login_page_image_position_y?: number | string;
  prompt_sources?: Array<{
    id: string;
    label: string;
    url: string;
    homepage?: string;
    format:
      | "reference-project"
      | "banana-json"
      | "awesome-gpt-image-2-markdown"
      | "generic-json"
      | string;
    enabled?: boolean;
    builtin?: boolean;
  }>;
  [key: string]: unknown;
};

export type StorageProviderConfig = {
	id: string;
	name: string;
	type: "s3" | "webdav";
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	publicBaseUrl: string;
	pathPrefix: string;
	username: string;
	password: string;
	weight: number;
	enabled: boolean;
	ownerUserId: string;
	capacityBytes: number;
	capacityCheckedAt: string;
	capacityExceeded: boolean;
};

export type StorageSettingConfig = {
	mode: string;
	allowUserProvider: boolean;
	allowUserGlobalProvider: boolean;
	providers: StorageProviderConfig[];
	roundRobinCursor: number;
	capacityCheck: { enabled: boolean; cron: string };
	capacityLimitBytes: number;
	localCapacityLimitBytes: number;
};

export type ModelConfig = {
  image_models: ImageModel[];
  default_image_model: ImageModel;
  video_models: string[];
  default_video_model: string;
  text_models: string[];
  default_text_model: string;
  audio_models: string[];
  default_audio_model: string;
  relay_base_url: string;
  custom_relay_configurable?: boolean;
  video_model_contracts?: VideoModelContract[];
};

export type ManagedVideoModelContract = {
  id: string;
  contract: VideoModelContract;
  draft?: VideoModelContract;
  draft_enabled?: boolean;
  enabled: boolean;
  revision: number;
  versions?: VideoModelContractVersion[];
  created_at: string;
  updated_at: string;
  draft_updated_at?: string;
};

export type VideoModelContractVersion = {
  revision: number;
  contract: VideoModelContract;
  published_at: string;
};

export type VideoModelContractMutation = {
  contract: VideoModelContract;
  enabled: boolean;
  existing_id?: string;
};

export type VideoModelContractImportResult = {
  contract: VideoModelContract;
  source: { type: "file" | "url"; name: string };
  warnings: string[];
  model: string;
};

export type VideoModelContractTransferDocument = {
  version: 4;
  contracts: Array<{ contract: VideoModelContract; enabled: boolean }>;
};

export type CustomRelayConfigStatus = {
  id: string;
  kind: "text" | "image" | "video" | "audio";
  name: string;
  token_name: string;
  base_url: string;
  has_key: boolean;
  configured: boolean;
};

export type CustomRelayConfigsResponse = {
  configurable: boolean;
  configs: CustomRelayConfigStatus[];
};

export type LoginPageImageSettings = {
  login_page_image_url: string;
  login_page_image_mode: LoginPageImageMode;
  login_page_image_zoom: number;
  login_page_image_position_x: number;
  login_page_image_position_y: number;
};

export type CreationWorkbenchPreferences = {
  image_model: string;
  image_size: string;
  image_size_mode: "auto" | "ratio" | "custom";
  image_aspect_ratio: string;
  image_resolution: string;
  image_custom_ratio: string;
  image_custom_width: string;
  image_custom_height: string;
  image_snap_to_multiple_16: boolean;
  image_quality: "" | ImageQuality;
  image_count: number;
  image_output_format: ImageOutputFormat;
  image_output_compression: string;
  video_model: string;
  video_size: string;
  video_seconds: string;
  video_resolution: string;
  video_generate_audio: boolean;
  video_watermark: boolean;
};

export type ImageGenerationPreferences = {
  api_mode: ImageAPIMode;
  stream: boolean;
  partial_images: number;
  response_format_b64_json: boolean;
  codex_cli_compatibility: boolean;
  system_prompt: string;
  video_system_prompt: string;
  audio_instructions: string;
  default_text_model: string;
  default_image_model: string;
  default_video_model: string;
  default_audio_model: string;
  canvas_default_image_count: number;
  default_audio_voice: string;
  default_audio_format: "" | "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm";
  default_audio_speed: number;
  default_text_relay_token_names: string[];
  default_image_relay_token_names: string[];
  default_video_relay_token_names: string[];
  default_audio_relay_token_names: string[];
  workbench: CreationWorkbenchPreferences;
};

export type ImageAPIMode = "images" | "responses" | "chat";

export type ImageTaskToolOptions = {
  apiMode?: ImageAPIMode;
  moderation?: string;
  inputImageMask?: string;
  responseFormatB64JSON?: boolean;
  codexCLICompatibility?: boolean;
  systemPrompt?: string;
  workflowContext?: unknown;
  generationSource?: "image-workbench" | "workflow" | "canvas";
};

export type ManagedImage = {
  name: string;
  path: string;
  owner_id?: string;
  owner_name?: string;
  visibility: ImageVisibility;
  prompt?: string;
  generation_source?: "image-workbench" | "workflow" | "canvas";
  model?: ImageModel;
  quality?: ImageQuality;
  date: string;
  size: number;
  url: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  resolution?: string;
  resolution_preset?: string;
  requested_size?: string;
  output_format?: ImageOutputFormat;
  output_compression?: number;
  partial_images?: number;
  moderation?: string;
  reference_image_urls?: string[];
  reference_images?: Array<{
    path: string;
    url?: string;
    filename?: string;
    content_type?: string;
    size?: number;
  }>;
  share_prompt_parameters?: boolean;
  share_reference_images?: boolean;
  aspect_ratio?: string;
  orientation?: string;
  megapixels?: number;
  created_at: string;
  published_at?: string;
};

export type SystemLog = {
  time: string;
  summary?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SystemLogFilters = {
  username?: string;
  module?: string;
  summary?: string;
  method?: string;
  status?: string;
  ip_address?: string;
  operation_type?: string;
  log_level?: string;
  view?: LogView | string;
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  page_size?: number | string;
};

export type LogGovernanceSummary = {
  total: number;
  oldest_time?: string;
  latest_time?: string;
};

export type LogCleanupResult = {
  retention_days: number;
  cutoff_date: string;
  deleted: number;
  remaining: number;
};

export type ImageStorageGovernanceSummary = {
  total_bytes: number;
  images_bytes: number;
  thumbnails_bytes: number;
  metadata_bytes: number;
  reference_bytes: number;
  images_count: number;
  public_images_count: number;
  private_images_count: number;
  thumbnail_files: number;
  metadata_files: number;
  reference_files: number;
  conversation_asset_bytes: number;
  conversation_asset_count: number;
  limit_bytes: number;
  over_limit_bytes: number;
  oldest_image_at?: string;
  latest_image_at?: string;
  text_assets?: {
    count: number;
    bytes: number;
  };
  local_media?: {
    total_bytes: number;
    indexed_bytes: number;
    untracked_bytes: number;
    total_count: number;
    text_bytes: number;
    text_count: number;
    image_bytes: number;
    image_count: number;
    video_bytes: number;
    video_count: number;
    audio_bytes: number;
    audio_count: number;
    other_bytes: number;
    other_count: number;
    limit_bytes: number;
    over_limit_bytes: number;
  };
};

export type ImageStorageCleanupResult = {
  retention_days?: number;
  max_bytes?: number;
  include_public?: boolean;
  deleted_images: number;
  deleted_thumbnails: number;
  deleted_metadata_files: number;
  deleted_reference_files: number;
  deleted_conversation_assets: number;
  deleted_bytes: number;
  remaining_bytes: number;
  over_limit_bytes: number;
  preserved_public_images?: number;
  action?: string;
};

export type ImageQualityCheck = {
  requested_size?: string;
  actual_size?: string;
  size_matched?: boolean;
  requested_output_format?: ImageOutputFormat | string;
  actual_output_format?: ImageOutputFormat | string;
  output_format_matched?: boolean;
  warnings?: string[];
};

export type CreationTaskData = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  text_response?: string;
  reasoning_content?: string;
  tool_calls?: CreationTaskToolCall[];
  width?: number;
  height?: number;
  resolution?: string;
  output_format?: ImageOutputFormat;
  actual_size?: string;
  actual_output_format?: ImageOutputFormat | string;
  quality_check?: ImageQualityCheck;
  video_url?: string;
  audio_url?: string;
  type?: GenerationMediaType | "text" | string;
  mime_type?: string;
  bytes?: number;
  size?: number;
  storageKey?: string;
  storage_key?: string;
  duration_ms?: number;
};

export type CreationTask = {
  id: string;
  /** Monotonic server-side task revision when available. */
  revision?: number | string;
  status: GenerationTaskStatus;
  /** Normalized status returned by the configured upstream video contract. */
  upstream_status?: "unknown" | "queued" | "in_progress" | "completed" | "failed" | string;
  /** Upstream video generation progress, clamped to 0-100. */
  progress?: number;
  mode: GenerationTaskMode;
  model?: ImageModel;
  size?: string;
  quality?: ImageQuality;
  output_format?: ImageOutputFormat;
  output_compression?: number;
  partial_images?: number;
  moderation?: string;
  created_at: string;
  updated_at: string;
  data?: CreationTaskData[];
  output_statuses?: GenerationOutputStatus[];
  error?: string;
  output_type?: "text" | "image" | "video" | "audio";
  visibility?: ImageVisibility;
  workflow_context?: unknown;
};

export type CreationTaskRequestOptions = {
  redirectOnUnauthorized?: boolean;
  signal?: AbortSignal;
};

function creationTaskRequestAuth(options?: CreationTaskRequestOptions) {
  return {
    ...(options?.redirectOnUnauthorized === undefined
      ? {}
      : { redirectOnUnauthorized: options.redirectOnUnauthorized }),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

export type CreationTaskMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
  reasoning_content?: string;
  tool_calls?: CreationTaskToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type CreationTaskToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type CreationTaskToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type FallbackReferenceImage = {
  path?: string;
  url?: string;
  b64_json?: string;
  outputFormat?: ImageOutputFormat;
};

type CreationTaskListResponse = {
  items?: CreationTask[] | null;
  missing_ids?: string[] | null;
};

export type LoginResponse = {
  ok: boolean;
  role: AuthRole;
  role_id?: string;
  role_name?: string;
  subject_id: string;
  username?: string;
  name: string;
  provider?: string;
  credential_id?: string;
  credential_name?: string;
  creation_concurrent_limit: number;
  creation_rpm_limit: number;
  menu_paths?: string[];
  api_permissions?: string[];
  menus?: PermissionMenu[];
};

export type ProfileRelayKeyStatus = {
  has_key: boolean;
  key_preview: string;
  group?: string;
  token_name?: string;
  groups?: string[];
  token_names?: string[];
  source?: "newapi" | "sub2api" | string;
  database_configured?: boolean;
  message?: string;
};

export type ProfileBalanceStatus = {
  has_balance: boolean;
  source?: "newapi" | "sub2api" | string;
  database_configured?: boolean;
  token_group?: string;
  token_name?: string;
  token_groups?: string[];
  token_names?: string[];
  token_message?: string;
  user_id?: number;
  username?: string;
  email?: string;
  display_name?: string;
  user_group?: string;
  quota?: number;
  used_quota?: number;
  request_count?: number;
  message?: string;
};

export type ManagedUser = {
  id: string;
  username?: string;
  name: string;
  role: "user";
  role_id?: string;
  role_name?: string;
  provider: "local" | "newapi" | "sub2api" | string;
  owner_id?: string;
  owner_name?: string;
  enabled: boolean;
  has_session: boolean;
  session_id?: string;
  session_name?: string;
  credential_count: number;
  created_at: string | null;
  last_used_at: string | null;
  updated_at?: string | null;
  call_count?: number;
  success_count?: number;
  failure_count?: number;
  quota_used?: number;
  usage_curve?: Array<{
    date: string;
    calls: number;
    success: number;
    failure: number;
    quota_used: number;
  }>;
  menu_paths?: string[];
  api_permissions?: string[];
};

export type ManagedUsersQuery = {
  page?: number | string;
  page_size?: number | string;
  search?: string;
  provider?: "all" | "local" | "newapi" | "sub2api" | string;
  status?: "all" | "enabled" | "disabled" | string;
  sort_by?: string;
  sort_order?: "asc" | "desc" | string;
  signal?: AbortSignal;
};

export type ManagedUsersResponse = {
  items: ManagedUser[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
};

export type ManagedRole = {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  user_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
  menu_paths?: string[];
  api_permissions?: string[];
};

export type CreateManagedUserPayload = {
  username: string;
  name?: string;
  password: string;
  role_id?: string;
  enabled?: boolean;
};

export async function login(username: string, password: string) {
	clearAccountScopedAPICaches();
  return httpRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: { username, password },
    redirectOnUnauthorized: false,
  });
}

export async function verifySession() {
  return httpRequest<LoginResponse>("/auth/session", {
    method: "GET",
    redirectOnUnauthorized: false,
  });
}

type ImageGenerationPreferencesResponse = { preferences: ImageGenerationPreferences };

const imageGenerationPreferencesCache = createExpiringRequestCache<ImageGenerationPreferencesResponse>(30_000);
const modelConfigCache = createExpiringRequestCache<{ config: ModelConfig }>(30_000);

function clearAccountScopedAPICaches() {
	imageGenerationPreferencesCache.clear();
	modelConfigCache.clear();
	grokTTSVoiceRequests.clear();
}

export async function fetchProfileRelayKey(group?: string, tokenName?: string) {
  const params = new URLSearchParams();
  if (group?.trim()) {
    params.set("group", group.trim());
  }
  if (tokenName?.trim()) {
    params.set("token_name", tokenName.trim());
  }
  return httpRequest<ProfileRelayKeyStatus>(
    `/api/profile/relay-key${params.toString() ? `?${params.toString()}` : ""}`,
  );
}

export async function fetchCustomRelayConfigs() {
  return httpRequest<CustomRelayConfigsResponse>("/api/profile/custom-relay-configs");
}

export async function createCustomRelayConfig(
  input: { kind: CustomRelayConfigStatus["kind"]; name: string; base_url: string; api_key: string },
) {
  return httpRequest<{ item: CustomRelayConfigStatus }>(
    "/api/profile/custom-relay-configs",
    { method: "POST", body: input },
  );
}

export async function updateCustomRelayConfig(
  id: string,
  input: { name: string; base_url: string; api_key: string },
) {
  return httpRequest<{ item: CustomRelayConfigStatus }>(
    `/api/profile/custom-relay-configs/${encodeURIComponent(id)}`,
    { method: "PUT", body: input },
  );
}

export async function deleteCustomRelayConfig(id: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/profile/custom-relay-configs/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function fetchProfileBalance() {
  return httpRequest<ProfileBalanceStatus>("/api/profile/balance");
}

export async function fetchImageGenerationPreferences() {
  return imageGenerationPreferencesCache.get(() => (
    httpRequest<ImageGenerationPreferencesResponse>(
      "/api/profile/image-generation-preferences",
    )
  ));
}

export async function updateImageGenerationPreferences(
  preferences: ImageGenerationPreferences,
) {
  const storeResponse = imageGenerationPreferencesCache.beginStore();
  return httpRequest<ImageGenerationPreferencesResponse>(
    "/api/profile/image-generation-preferences",
    {
      method: "PUT",
      body: preferences,
    },
  ).then(storeResponse);
}

export type RelayTokenPreferenceUpdate = Partial<Pick<
  ImageGenerationPreferences,
  | "default_text_relay_token_names"
  | "default_image_relay_token_names"
  | "default_video_relay_token_names"
  | "default_audio_relay_token_names"
>>;

export async function updateRelayTokenPreferences(preferences: RelayTokenPreferenceUpdate) {
  const storeResponse = imageGenerationPreferencesCache.beginStore();
  return httpRequest<ImageGenerationPreferencesResponse>(
    "/api/profile/image-generation-preferences",
    {
      method: "PATCH",
      body: preferences,
    },
  ).then(storeResponse);
}

export async function updateCreationWorkbenchPreferences(
  workbench: CreationWorkbenchPreferences,
  options: Pick<ImageGenerationPreferences, "stream" | "partial_images" | "response_format_b64_json" | "codex_cli_compatibility">,
) {
  const storeResponse = imageGenerationPreferencesCache.beginStore();
  return httpRequest<ImageGenerationPreferencesResponse>(
    "/api/profile/image-generation-preferences",
    {
      method: "PATCH",
      body: { workbench, ...options },
    },
  ).then(storeResponse);
}

export async function logout() {
	clearAccountScopedAPICaches();
  return httpRequest<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    redirectOnUnauthorized: false,
  });
}

export async function createImageGenerationTask(
  clientTaskId: string,
  prompt: string,
  model?: ImageModel,
  size?: string,
  requestedSize?: string,
  quality?: ImageRequestQuality,
  count = 1,
  visibility: ImageVisibility = "private",
  imageResolution?: string,
  outputFormat?: ImageOutputFormat,
  outputCompression?: number,
  stream?: boolean,
  partialImages?: number,
  toolOptions?: ImageTaskToolOptions,
  relayTokenGroup?: string,
  relayTokenName?: string,
  frontendConversationId?: string,
  fallbackReferenceImage?: FallbackReferenceImage,
  requestOptions?: CreationTaskRequestOptions,
) {
  const normalizedPartialImages = stream
    ? normalizedImagePartialImages(partialImages)
    : undefined;
  const requestPrompt = composeImageGenerationPrompt(
    prompt,
    toolOptions?.systemPrompt,
    toolOptions?.codexCLICompatibility,
  );
  return httpRequest<CreationTask>("/api/creation-tasks/image-generations", {
    ...creationTaskRequestAuth(requestOptions),
    method: "POST",
    timeout: 30_000,
    body: {
      client_task_id: clientTaskId,
      prompt: requestPrompt,
      api_mode: toolOptions?.apiMode || "images",
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(requestedSize ? { requested_size: requestedSize } : {}),
      ...(imageResolution ? { image_resolution: imageResolution } : {}),
      ...(quality && !toolOptions?.codexCLICompatibility ? { quality } : {}),
      ...(outputFormat ? { output_format: outputFormat } : {}),
      ...(typeof outputCompression === "number"
        ? { output_compression: outputCompression }
        : {}),
      ...(stream ? { stream: true } : {}),
      ...(normalizedPartialImages !== undefined
        ? { partial_images: normalizedPartialImages }
        : {}),
      ...(toolOptions?.responseFormatB64JSON
        ? { response_format: "b64_json" }
        : {}),
      ...(toolOptions?.moderation
        ? { moderation: toolOptions.moderation }
        : {}),
      ...(toolOptions?.workflowContext
        ? { workflow_context: toolOptions.workflowContext }
        : {}),
      ...(toolOptions?.generationSource
        ? { generation_source: toolOptions.generationSource }
        : {}),
      ...(relayTokenGroup ? { token_group: relayTokenGroup } : {}),
      ...(relayTokenName ? { token_name: relayTokenName } : {}),
      ...(frontendConversationId
        ? { frontend_conversation_id: frontendConversationId }
        : {}),
      ...(fallbackReferenceImage
        ? { fallback_reference_image: fallbackReferenceImage }
        : {}),
      visibility,
      n: count,
    },
  });
}

export type CreateVideoGenerationTaskInput = VideoGenerationTaskRequestInput & {
  requestOptions?: CreationTaskRequestOptions;
};

export async function createVideoGenerationTask(
  input: CreateVideoGenerationTaskInput,
) {
  return httpRequest<CreationTask>("/api/creation-tasks/video-generations", {
    ...creationTaskRequestAuth(input.requestOptions),
    method: "POST",
    timeout: 30_000,
    body: videoGenerationTaskRequestBody(input),
  });
}

export type CreateAudioGenerationTaskInput = {
  clientTaskId: string;
  request: Record<string, unknown>;
  relayTokenName?: string;
  requestOptions?: CreationTaskRequestOptions;
};

export type GrokTTSVoice = {
  voice_id: string;
  name?: string;
  language?: string;
};

const grokTTSVoiceRequests = new Map<string, Promise<GrokTTSVoice[]>>();

export function fetchGrokTTSVoices(model: string, relayTokenName: string) {
  const query = new URLSearchParams({ model });
  if (relayTokenName.trim()) query.set("token_name", relayTokenName.trim());
  const requestKey = query.toString();
	const existing = grokTTSVoiceRequests.get(requestKey);
	if (existing) return existing;
	const request = httpRequest<{ voices?: GrokTTSVoice[] }>(`/api/creation-tasks/audio-voices?${query.toString()}`, { timeout: 30_000 })
		.then((response) => Array.isArray(response.voices) ? response.voices.filter((voice) => Boolean(voice.voice_id?.trim())) : [])
		.finally(() => {
			if (grokTTSVoiceRequests.get(requestKey) === request) {
				grokTTSVoiceRequests.delete(requestKey);
			}
		});
  grokTTSVoiceRequests.set(requestKey, request);
  return request;
}

export async function createAudioGenerationTask(
  input: CreateAudioGenerationTaskInput,
) {
  return httpRequest<CreationTask>("/api/creation-tasks/audio-generations", {
    ...creationTaskRequestAuth(input.requestOptions),
    method: "POST",
    timeout: 30_000,
    body: {
      ...input.request,
      client_task_id: input.clientTaskId,
      ...(input.relayTokenName ? { token_name: input.relayTokenName } : {}),
    },
  });
}

export type CreateChatGenerationTaskInput = {
  clientTaskId: string;
  prompt: string;
  model?: string;
  messages?: CreationTaskMessage[];
  tools?: CreationTaskToolDefinition[];
  toolChoice?: "none" | "auto" | "required" | Record<string, unknown>;
  relayTokenName?: string;
  requestOptions?: CreationTaskRequestOptions;
};

export async function createChatGenerationTask(
  input: CreateChatGenerationTaskInput,
) {
  const messages = input.messages?.length
    ? input.messages
    : [{ role: "user" as const, content: input.prompt }];
  return httpRequest<CreationTask>("/api/creation-tasks/chat-completions", {
    ...creationTaskRequestAuth(input.requestOptions),
    method: "POST",
    timeout: 30_000,
    body: {
      client_task_id: input.clientTaskId,
      prompt: input.prompt,
      messages,
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(input.toolChoice !== undefined ? { tool_choice: input.toolChoice } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.relayTokenName ? { token_name: input.relayTokenName } : {}),
    },
  });
}

export async function uploadVideoReference(file: File) {
  const formData = new FormData();
  formData.append("video", file);
  return httpRequest<{
    url: string;
    name?: string;
    content_type?: string;
    size?: number;
  }>("/api/creation-tasks/video-reference-uploads", {
    method: "POST",
    body: formData,
    timeout: 120_000,
  });
}

export async function uploadVideoImageReference(file: File) {
  const formData = new FormData();
  formData.append("image", file);
  return httpRequest<{
    url: string;
    name?: string;
    content_type?: string;
    size?: number;
  }>("/api/creation-tasks/video-image-reference-uploads", {
    method: "POST",
    body: formData,
    timeout: 120_000,
  });
}

export async function uploadAudioReference(file: File) {
  const formData = new FormData();
  formData.append("audio", file);
  return httpRequest<{
    url: string;
    name?: string;
    content_type?: string;
    size?: number;
  }>("/api/creation-tasks/audio-reference-uploads", {
    method: "POST",
    body: formData,
    timeout: 120_000,
  });
}

export async function createImageEditTask(
  clientTaskId: string,
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  requestedSize?: string,
  quality?: ImageRequestQuality,
  count = 1,
  visibility: ImageVisibility = "private",
  imageResolution?: string,
  outputFormat?: ImageOutputFormat,
  outputCompression?: number,
  stream?: boolean,
  partialImages?: number,
  toolOptions?: ImageTaskToolOptions,
  relayTokenGroup?: string,
  relayTokenName?: string,
  frontendConversationId?: string,
  fallbackReferenceImage?: FallbackReferenceImage,
  requestOptions?: CreationTaskRequestOptions,
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];
  let maskFile: File | undefined;
  if (toolOptions?.inputImageMask) {
    const response = await fetch(toolOptions.inputImageMask);
    if (!response.ok) {
      throw new Error("无法读取局部编辑遮罩");
    }
    const blob = await response.blob();
    if (blob.type && blob.type.toLowerCase() !== "image/png") {
      throw new Error("局部编辑遮罩必须是 PNG 图片");
    }
    maskFile = new File([blob], "mask.png", { type: "image/png" });
  }

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  if (maskFile) {
    formData.append("mask", maskFile);
  }
  formData.append("client_task_id", clientTaskId);
  formData.append(
    "prompt",
    composeImageGenerationPrompt(
      prompt,
      toolOptions?.systemPrompt,
      toolOptions?.codexCLICompatibility,
    ),
  );
  formData.append("api_mode", toolOptions?.apiMode || "images");
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  if (requestedSize) {
    formData.append("requested_size", requestedSize);
  }
  if (imageResolution) {
    formData.append("image_resolution", imageResolution);
  }
  if (quality && !toolOptions?.codexCLICompatibility) {
    formData.append("quality", quality);
  }
  if (outputFormat) {
    formData.append("output_format", outputFormat);
  }
  if (typeof outputCompression === "number") {
    formData.append("output_compression", String(outputCompression));
  }
  if (stream) {
    formData.append("stream", "true");
    const normalizedPartialImages = normalizedImagePartialImages(partialImages);
    if (normalizedPartialImages !== undefined) {
      formData.append("partial_images", String(normalizedPartialImages));
    }
  }
  if (toolOptions?.responseFormatB64JSON) {
    formData.append("response_format", "b64_json");
  }
  if (toolOptions?.moderation) {
    formData.append("moderation", toolOptions.moderation);
  }
  if (toolOptions?.workflowContext) {
    formData.append("workflow_context", JSON.stringify(toolOptions.workflowContext));
  }
  if (toolOptions?.generationSource) {
    formData.append("generation_source", toolOptions.generationSource);
  }
  if (relayTokenGroup) {
    formData.append("token_group", relayTokenGroup);
  }
  if (relayTokenName) {
    formData.append("token_name", relayTokenName);
  }
  if (frontendConversationId) {
    formData.append("frontend_conversation_id", frontendConversationId);
  }
  if (fallbackReferenceImage) {
    formData.append(
      "fallback_reference_image",
      JSON.stringify(fallbackReferenceImage),
    );
  }
  formData.append("visibility", visibility);
  formData.append("n", String(count));

  return httpRequest<CreationTask>("/api/creation-tasks/image-edits", {
    ...creationTaskRequestAuth(requestOptions),
    method: "POST",
    body: formData,
    timeout: 60_000,
  });
}

export async function fetchCreationTasks(
  ids: string[],
  requestOptions?: CreationTaskRequestOptions,
) {
  const params = new URLSearchParams();
  if (ids.length > 0) {
    params.set("ids", ids.join(","));
  }
  const data = await httpRequest<CreationTaskListResponse>(
    `/api/creation-tasks${params.toString() ? `?${params.toString()}` : ""}`,
    {
      ...creationTaskRequestAuth(requestOptions),
      timeout: 15_000,
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    },
  );
  return {
    items: Array.isArray(data.items) ? data.items : [],
    missing_ids: Array.isArray(data.missing_ids) ? data.missing_ids : [],
  };
}

export async function cancelCreationTask(
  clientTaskId: string,
  requestOptions?: CreationTaskRequestOptions,
) {
  return httpRequest<CreationTask>(
    `/api/creation-tasks/${encodeURIComponent(clientTaskId)}/cancel`,
    {
      ...creationTaskRequestAuth(requestOptions),
      method: "POST",
      body: {},
      timeout: 20_000,
    },
  );
}

export async function deleteCreationTasks(
  ids: string[],
  requestOptions?: CreationTaskRequestOptions,
) {
  return httpRequest<{
    deleted_ids: string[];
    active_ids: string[];
    missing_ids: string[];
  }>("/api/creation-tasks", {
    ...creationTaskRequestAuth(requestOptions),
    method: "DELETE",
    body: { ids },
    timeout: 20_000,
  });
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function fetchPromptSourcesConfig() {
  return httpRequest<{ sources?: SettingsConfig["prompt_sources"] }>("/api/prompt-sources");
}

export async function fetchAnnouncements() {
  return httpRequest<{ items: Announcement[] }>("/api/announcements");
}

export async function fetchAnnouncementPreferences() {
  return httpRequest<{ preferences: AnnouncementPreferences }>(
    "/api/profile/announcement-preferences",
  );
}

export async function updateAnnouncementPreferences(
  version: string,
  action: "seen" | "today" | "forever",
  localDate = "",
) {
  return httpRequest<{ preferences: AnnouncementPreferences }>(
    "/api/profile/announcement-preferences",
    {
      method: "POST",
      body: { version, action, local_date: localDate },
    },
  );
}

export async function fetchAdminAnnouncements() {
  return httpRequest<{ items: Announcement[] }>("/api/admin/announcements");
}

export async function createAnnouncement(input: AnnouncementInput) {
  return httpRequest<{ item: Announcement; items: Announcement[] }>(
    "/api/admin/announcements",
    {
      method: "POST",
      body: input,
    },
  );
}

export async function updateAnnouncement(
  id: string,
  updates: Partial<AnnouncementInput>,
) {
  return httpRequest<{ item: Announcement; items: Announcement[] }>(
    `/api/admin/announcements/${encodeURIComponent(id)}`,
    {
      method: "POST",
      body: updates,
    },
  );
}

export async function deleteAnnouncement(id: string) {
  return httpRequest<{ items: Announcement[] }>(
    `/api/admin/announcements/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  const response = await httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
  modelConfigCache.clear();
  return response;
}

export function measureAdminStorageProvider(index: number, provider?: StorageProviderConfig) {
	return httpRequest<{ result: { bytes: number; limitBytes: number; overLimit: boolean; checkedAt: string; providerName: string } }>(
		"/api/settings/storage/measure",
		{ method: "POST", body: { index, provider } },
	);
}

export async function fetchModelConfig() {
  const data = await modelConfigCache.get(() => (
    httpRequest<{ config: ModelConfig }>("/api/model-config")
  ));
  installVideoModelContracts(data.config.video_model_contracts);
  return data;
}

export async function fetchAdminVideoModelContracts(options: { signal?: AbortSignal } = {}) {
  return httpRequest<{ items: ManagedVideoModelContract[] }>("/api/admin/video-model-contracts", {
    signal: options.signal,
  });
}

export async function importVideoModelContract(input: {
  sourceType: "file" | "url";
  file?: File | null;
  url?: string;
  model?: string;
  tokenName?: string;
}) {
  const formData = new FormData();
  formData.append("source_type", input.sourceType);
  if (input.file) formData.append("file", input.file);
  if (input.url?.trim()) formData.append("url", input.url.trim());
  if (input.model?.trim()) formData.append("model", input.model.trim());
  if (input.tokenName?.trim()) formData.append("token_name", input.tokenName.trim());
  return httpRequest<VideoModelContractImportResult>("/api/admin/video-model-contracts/import", {
    method: "POST",
    body: formData,
    timeout: 180_000,
  });
}

export async function importVideoModelContractJSON(document: VideoModelContractTransferDocument) {
  const response = await httpRequest<{
    items: ManagedVideoModelContract[];
    imported: number;
    created: number;
    updated: number;
  }>("/api/admin/video-model-contracts/import-json", {
    method: "POST",
    body: document,
  });
  modelConfigCache.clear();
  return response;
}

export async function validateVideoModelContract(input: VideoModelContractMutation) {
  return httpRequest<{ valid: true; contract: VideoModelContract }>("/api/admin/video-model-contracts/validate", {
    method: "POST",
    body: input,
  });
}

export async function createVideoModelContract(input: VideoModelContractMutation) {
  const response = await httpRequest<{ item: ManagedVideoModelContract; items: ManagedVideoModelContract[] }>("/api/admin/video-model-contracts", {
    method: "POST",
    body: input,
  });
  modelConfigCache.clear();
  return response;
}

export async function saveVideoModelContractDraft(id: string, input: VideoModelContractMutation) {
  return httpRequest<{ item: ManagedVideoModelContract; items: ManagedVideoModelContract[] }>(
    `/api/admin/video-model-contracts/${encodeURIComponent(id)}/draft`,
    { method: "PUT", body: input },
  );
}

export async function publishVideoModelContract(id: string, input: VideoModelContractMutation) {
  const response = await httpRequest<{ item: ManagedVideoModelContract; items: ManagedVideoModelContract[] }>(
    `/api/admin/video-model-contracts/${encodeURIComponent(id)}/publish`,
    { method: "POST", body: input },
  );
  modelConfigCache.clear();
  return response;
}

export async function fetchVideoModelContractVersions(id: string, options: { signal?: AbortSignal } = {}) {
  return httpRequest<{ versions: VideoModelContractVersion[] }>(
    `/api/admin/video-model-contracts/${encodeURIComponent(id)}/versions`,
    { signal: options.signal },
  );
}

export async function rollbackVideoModelContract(id: string, revision: number) {
  const response = await httpRequest<{ item: ManagedVideoModelContract; items: ManagedVideoModelContract[] }>(
    `/api/admin/video-model-contracts/${encodeURIComponent(id)}/rollback`,
    { method: "POST", body: { revision } },
  );
  modelConfigCache.clear();
  return response;
}

export type VideoModelContractPreviewResult = {
  request: {
    method: "POST";
    create_path: string;
    query_path: string;
    body: Record<string, unknown>;
    transport: VideoModelContract["transport"];
  };
  submit?: { task_id: string; error: string };
  query?: { status: "unknown" | "queued" | "in_progress" | "completed" | "failed"; progress?: number; error: string; result_url?: string };
};

export async function previewVideoModelContract(input: {
  contract: VideoModelContract;
  existing_id?: string;
  input: Record<string, unknown>;
  submit_response?: Record<string, unknown>;
  query_response?: Record<string, unknown>;
}) {
  return httpRequest<VideoModelContractPreviewResult>("/api/admin/video-model-contracts/preview", {
    method: "POST",
    body: input,
  });
}

export async function setVideoModelContractEnabled(id: string, enabled: boolean) {
  const response = await httpRequest<{ item: ManagedVideoModelContract; items: ManagedVideoModelContract[] }>(
    `/api/admin/video-model-contracts/${encodeURIComponent(id)}`,
    { method: "PATCH", body: { enabled, contract: {} } },
  );
  modelConfigCache.clear();
  return response;
}

export async function deleteVideoModelContract(id: string) {
  const response = await httpRequest<{ items: ManagedVideoModelContract[] }>(
    `/api/admin/video-model-contracts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  modelConfigCache.clear();
  return response;
}

export async function updateLoginPageImageSettings(
  settings: LoginPageImageSettings,
  options: { action: "keep" | "replace" | "remove"; file?: File | null },
) {
  const formData = new FormData();
  formData.append("login_page_image_url", settings.login_page_image_url);
  formData.append("login_page_image_mode", settings.login_page_image_mode);
  formData.append(
    "login_page_image_zoom",
    String(settings.login_page_image_zoom),
  );
  formData.append(
    "login_page_image_position_x",
    String(settings.login_page_image_position_x),
  );
  formData.append(
    "login_page_image_position_y",
    String(settings.login_page_image_position_y),
  );
  formData.append("login_page_image_action", options.action);
  if (options.file) {
    formData.append("login_page_image_file", options.file);
  }
  return httpRequest<{ config: SettingsConfig }>(
    "/api/settings/login-page-image",
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function updateSiteIconSettings(options: {
  action: "keep" | "replace" | "remove";
  file?: File | null;
}) {
  const formData = new FormData();
  formData.append("site_icon_action", options.action);
  if (options.file) {
    formData.append("site_icon_file", options.file);
  }
  return httpRequest<{ config: SettingsConfig }>("/api/settings/site-icon", {
    method: "POST",
    body: formData,
  });
}

export async function fetchManagedImages(
  filters: {
    start_date?: string;
    end_date?: string;
    scope?: "mine" | "public" | "visible" | "all";
  },
  options: { signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams();
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  const data = await httpRequest<{
    items?: ManagedImage[] | null;
    groups?: Array<{ date: string; items: ManagedImage[] }> | null;
  }>(`/api/images${params.toString() ? `?${params.toString()}` : ""}`, {
    signal: options.signal,
  });
  return {
    items: Array.isArray(data.items) ? data.items : [],
    groups: Array.isArray(data.groups) ? data.groups : [],
  };
}

export async function uploadImageConversationAssets(files: readonly File[]) {
  const items: ImageConversationAssetUploadItem[] = [];
  for (const batch of planImageConversationAssetUploadBatches(files)) {
    const formData = new FormData();
    batch.forEach((file) => formData.append("images", file));
    const response = await httpRequest<{ items?: unknown[] }>(
      "/api/profile/image-conversation-assets",
      {
        method: "POST",
        body: formData,
        timeout: 120_000,
      },
    );
    const normalized = Array.isArray(response.items)
      ? response.items
          .map(normalizeImageConversationAssetReference)
          .filter(
            (item): item is ImageConversationAssetUploadItem => item !== null,
          )
      : [];
    if (normalized.length !== batch.length) {
      throw new Error("参考图上传响应不完整，请重试");
    }
    items.push(...normalized);
  }
  return items;
}

export async function updateManagedImageVisibility(
  path: string,
  visibility: ImageVisibility,
  options: {
    sharePromptParameters?: boolean;
    shareReferenceImages?: boolean;
  } = {},
) {
  return httpRequest<{
    item: Partial<ManagedImage> & { path: string; visibility: ImageVisibility };
  }>("/api/images/visibility", {
    method: "PATCH",
    body: {
      path,
      visibility,
      ...(visibility === "public" && options.sharePromptParameters
        ? { share_prompt_parameters: true }
        : {}),
      ...(visibility === "public" &&
      options.sharePromptParameters &&
      options.shareReferenceImages
        ? { share_reference_images: true }
        : {}),
    },
  });
}

export async function deleteManagedImages(paths: string[]) {
  return httpRequest<{ deleted: number; missing: number; paths: string[] }>(
    "/api/images",
    {
      method: "DELETE",
      body: { paths },
    },
  );
}

export async function fetchSystemLogs(filters: SystemLogFilters, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (key !== "view" && value === "all")
    ) {
      continue;
    }
    params.set(key, String(value));
  }
  return httpRequest<{ items: SystemLog[]; view?: LogView | string }>(
    `/api/logs${params.toString() ? `?${params.toString()}` : ""}`,
    { signal: options.signal },
  );
}

export async function fetchLogGovernance() {
  return httpRequest<{ governance: LogGovernanceSummary }>(
    "/api/logs/governance",
  );
}

export async function cleanupLogs(retentionDays: number) {
  return httpRequest<{
    cleanup: LogCleanupResult;
    governance: LogGovernanceSummary;
  }>("/api/logs/governance", {
    method: "POST",
    body: { retention_days: retentionDays },
  });
}

export async function fetchImageStorageGovernance() {
  return httpRequest<{ governance: ImageStorageGovernanceSummary }>(
    "/api/images/storage-governance",
  );
}

export async function cleanupImageStorage(body: {
  action: "retention" | "quota" | "thumbnails" | "all";
  retention_days?: number;
  max_mb?: number;
  include_public?: boolean;
  clear_thumbnails?: boolean;
}) {
  return httpRequest<{
    cleanup: ImageStorageCleanupResult;
    governance: ImageStorageGovernanceSummary;
  }>("/api/images/storage-governance", {
    method: "POST",
    body,
  });
}

function managedUserPath(userId: string) {
  return `/api/admin/users/${encodeURIComponent(userId)}`;
}

export async function fetchManagedUsers(query: ManagedUsersQuery = {}) {
  const params = new URLSearchParams();
  if (query.page) params.set("page", String(query.page));
  if (query.page_size) params.set("page_size", String(query.page_size));
  if (query.search?.trim()) params.set("search", query.search.trim());
  if (query.provider && query.provider !== "all")
    params.set("provider", query.provider);
  if (query.status && query.status !== "all")
    params.set("status", query.status);
  if (query.sort_by) params.set("sort_by", query.sort_by);
  if (query.sort_order) params.set("sort_order", query.sort_order);
  const data = await httpRequest<Partial<ManagedUsersResponse>>(
    `/api/admin/users${params.toString() ? `?${params.toString()}` : ""}`,
    { signal: query.signal },
  );
  return {
    items: Array.isArray(data.items) ? data.items : [],
    total: Number(data.total ?? data.items?.length ?? 0),
    page: Number(data.page ?? query.page ?? 1),
    page_size: Number(data.page_size ?? query.page_size ?? 20),
    total_pages: Number(data.total_pages ?? 1),
  };
}

export async function fetchPermissionCatalog(options: { signal?: AbortSignal } = {}) {
  return httpRequest<{ menus: PermissionMenu[]; apis: ApiPermission[] }>(
    "/api/admin/permissions",
    { signal: options.signal },
  );
}

function managedRolePath(roleId: string) {
  return `/api/admin/roles/${encodeURIComponent(roleId)}`;
}

export async function fetchManagedRoles(options: { signal?: AbortSignal } = {}) {
  return httpRequest<{ items: ManagedRole[] }>("/api/admin/roles", { signal: options.signal });
}

export async function createManagedRole(updates: {
  name: string;
  description?: string;
  menu_paths?: string[];
  api_permissions?: string[];
}) {
  return httpRequest<{ item: ManagedRole; items: ManagedRole[] }>(
    "/api/admin/roles",
    {
      method: "POST",
      body: updates,
    },
  );
}

export async function updateManagedRole(
  roleId: string,
  updates: {
    name?: string;
    description?: string;
    menu_paths?: string[];
    api_permissions?: string[];
  },
) {
  return httpRequest<{ item: ManagedRole; items: ManagedRole[] }>(
    managedRolePath(roleId),
    {
      method: "POST",
      body: updates,
    },
  );
}

export async function deleteManagedRole(roleId: string) {
  return httpRequest<{ items: ManagedRole[] }>(managedRolePath(roleId), {
    method: "DELETE",
  });
}

export async function createManagedUser(payload: CreateManagedUserPayload) {
  return httpRequest<
    { item: ManagedUser; items?: ManagedUser[] } & Partial<ManagedUsersResponse>
  >("/api/admin/users", {
    method: "POST",
    body: payload,
  });
}

export async function updateManagedUser(
  userId: string,
  updates: { enabled?: boolean; name?: string; role_id?: string },
) {
  return httpRequest<
    { item: ManagedUser; items?: ManagedUser[] } & Partial<ManagedUsersResponse>
  >(managedUserPath(userId), {
    method: "POST",
    body: updates,
  });
}

export async function deleteManagedUser(userId: string) {
  return httpRequest<{ items?: ManagedUser[] } & Partial<ManagedUsersResponse>>(
    managedUserPath(userId),
    {
      method: "DELETE",
    },
  );
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchRelayModels(
  options: { group?: string; tokenName?: string; signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams();
  if (options.group?.trim()) params.set("group", options.group.trim());
  if (options.tokenName?.trim())
    params.set("token_name", options.tokenName.trim());
  return httpRequest<{ object?: string; data?: RelayModelListItem[] | null }>(
    `/api/profile/upstream-models${params.toString() ? `?${params.toString()}` : ""}`,
    { signal: options.signal },
  );
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}
