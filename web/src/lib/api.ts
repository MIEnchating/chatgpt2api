import { httpRequest } from "@/lib/request";
import type { LoginPageImageMode } from "@/lib/login-page-image-layout";
import webConfig from "@/constants/common-env";
import { getStoredSessionToken } from "@/store/auth";

export type AccountType = "Free" | "Plus" | "ProLite" | "Pro" | "Team";
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = string;
export type ImageModelOption = { value: ImageModel; label: string };
export const CODEX_IMAGE_MODEL: ImageModel = "codex-gpt-image-2";
export const DEFAULT_IMAGE_MODELS: ImageModel[] = ["gpt-image-2"];
export const DEFAULT_CHAT_MODELS: ImageModel[] = ["gpt-5.5", "gpt-5.4"];
export const DEFAULT_IMAGE_MODEL: ImageModel = DEFAULT_IMAGE_MODELS[0];
export const DEFAULT_CHAT_MODEL: ImageModel = DEFAULT_CHAT_MODELS[0];
export const IMAGE_MODEL_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "codex-gpt-image-2", label: "codex-gpt-image-2" },
  { value: "gpt-image-2", label: "gpt-image-2" },
  { value: "gpt-5-mini", label: "gpt-5-mini" },
  { value: "gpt-5-3-mini", label: "gpt-5-3-mini" },
  { value: "gpt-5", label: "gpt-5" },
  { value: "gpt-5-1", label: "gpt-5-1" },
  { value: "gpt-5-2", label: "gpt-5-2" },
  { value: "gpt-5-3", label: "gpt-5-3" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.5", label: "gpt-5.5" },
] as const satisfies ReadonlyArray<ImageModelOption>;
const IMAGE_TASK_MODEL_VALUES = new Set<ImageModel>(["gpt-image-2", "codex-gpt-image-2"]);
const KNOWN_CHAT_MODEL_VALUES = new Set<ImageModel>([
  "auto",
  "gpt-5-mini",
  "gpt-5-3-mini",
  "gpt-5",
  "gpt-5-1",
  "gpt-5-2",
  "gpt-5-3",
  "gpt-5.4",
  "gpt-5.5",
]);
export function normalizeModelNames(value: unknown, fallback: ReadonlyArray<ImageModel>): ImageModel[] {
  const rawItems = Array.isArray(value) ? value : String(value ?? "").split(",");
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

export function modelOptionsFromNames(names: ReadonlyArray<ImageModel>): ImageModelOption[] {
  return normalizeModelNames(names, []).map((model) => ({ value: model, label: model }));
}

export const IMAGE_TASK_MODEL_OPTIONS = IMAGE_MODEL_OPTIONS.filter((option) => IMAGE_TASK_MODEL_VALUES.has(option.value));
export const IMAGE_CREATION_MODEL_OPTIONS = modelOptionsFromNames(DEFAULT_IMAGE_MODELS);
export const CHAT_MODEL_OPTIONS = modelOptionsFromNames(DEFAULT_CHAT_MODELS);
export const IMAGE_MODEL_ROUTE_DETAILS: Partial<Record<
  ImageModel,
  {
    routeLabel: string;
    description: string;
    badge?: string;
  }
>> = {
  auto: {
    routeLabel: "RelayAI",
    description: "通过固定 RelayAI 上游提交请求，使用个人中心配置的 RelayAI Key。",
  },
  "gpt-image-2": {
    routeLabel: "RelayAI",
    description: "通过 RelayAI 图片接口生成图片。",
  },
  "codex-gpt-image-2": {
    routeLabel: "RelayAI",
    description: "通过 RelayAI 上游提交请求。",
  },
};

export function isImageModel(value: unknown): value is ImageModel {
  return typeof value === "string" && value.trim() !== "";
}

export function isImageTaskModel(value: unknown): value is ImageModel {
  return isImageModel(value) && (IMAGE_TASK_MODEL_VALUES.has(value) || !KNOWN_CHAT_MODEL_VALUES.has(value));
}

export function isImageCreationModel(value: unknown): value is ImageModel {
  return isImageModel(value);
}

export function isChatModel(value: unknown): value is ImageModel {
  return isImageModel(value) && !IMAGE_TASK_MODEL_VALUES.has(value);
}

export function usesOfficialImageRoute(model: ImageModel) {
  void model;
  return true;
}

export function usesCodexImageRoute(model: ImageModel) {
  void model;
  return false;
}

export function supportsStructuredImageParameters(model: ImageModel) {
  return model === "gpt-image-2";
}

export function supportsImageOutputControls(model: ImageModel) {
  return usesOfficialImageRoute(model) || usesCodexImageRoute(model);
}

export function supportsImageQuality(_model: ImageModel) {
  return true;
}

export type ImageQuality = "low" | "medium" | "high";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageBackground = "auto" | "opaque";
export type ImageModeration = "auto" | "low";
export type ImageVisibility = "private" | "public";

export type RelayModelListItem = {
  id?: string;
  object?: string;
  owned_by?: string;
};

export function relayModelOptionsFromList(items: RelayModelListItem[] | null | undefined): ImageModelOption[] {
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
const IMAGE_BACKGROUND_VALUES = new Set<string>(["auto", "opaque"]);
const IMAGE_MODERATION_VALUES = new Set<string>(["auto", "low"]);

export const IMAGE_OUTPUT_FORMAT_OPTIONS = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
] as const satisfies ReadonlyArray<{ value: ImageOutputFormat; label: string }>;

export const IMAGE_BACKGROUND_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "opaque", label: "不透明" },
] as const satisfies ReadonlyArray<{ value: ImageBackground; label: string }>;

export const IMAGE_MODERATION_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低限制" },
] as const satisfies ReadonlyArray<{ value: ImageModeration; label: string }>;

export function isImageQuality(value: unknown): value is ImageQuality {
  return typeof value === "string" && IMAGE_QUALITY_VALUES.has(value);
}

export function isImageOutputFormat(value: unknown): value is ImageOutputFormat {
  return typeof value === "string" && IMAGE_OUTPUT_FORMAT_VALUES.has(value);
}

export function isImageBackground(value: unknown): value is ImageBackground {
  return typeof value === "string" && IMAGE_BACKGROUND_VALUES.has(value);
}

export function isImageModeration(value: unknown): value is ImageModeration {
  return typeof value === "string" && IMAGE_MODERATION_VALUES.has(value);
}

export function supportsImageOutputCompression(format: ImageOutputFormat) {
  return format === "jpeg" || format === "webp";
}

export type AuthRole = "admin" | "user";
export type AnnouncementTarget = "login" | "image";

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

export type Account = {
  id: string;
  access_token?: string;
  token_preview?: string;
  type: AccountType;
  status: AccountStatus;
  quota: number;
  imageQuotaUnknown?: boolean;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restoreAt?: string | null;
  success: number;
  fail: number;
  lastUsedAt: string | null;
};

type AccountListResponse = {
  items: Account[];
};

type AccountTokensResponse = {
  tokens: string[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  errors?: Array<{ access_token?: string; account_id?: string; error: string }>;
  results?: AccountRefreshResult[];
  total?: number;
  failed?: number;
  duration_ms?: number;
};

export type AccountRefreshResult = {
  account_id: string;
  access_token?: string;
  token_preview?: string;
  success: boolean;
  status: "success" | "error" | string;
  message?: string;
  error?: string;
  duration_ms?: number;
  account_status?: AccountStatus;
  email?: string | null;
  type?: AccountType;
  quota?: number;
  image_quota_unknown?: boolean;
  restore_at?: string | null;
};

type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  errors: Array<{ access_token?: string; account_id?: string; error: string }>;
  results: AccountRefreshResult[];
  total?: number;
  failed?: number;
  duration_ms?: number;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  relay_base_url?: string;
  image_models?: string[] | string;
  chat_models?: string[] | string;
  default_image_model?: string;
  default_chat_model?: string;
  registration_enabled?: boolean;
  refresh_account_interval_minute?: number | string;
  image_task_timeout_seconds?: number | string;
  user_default_concurrent_limit?: number | string;
  user_default_rpm_limit?: number | string;
  default_billing_type?: BillingType;
  default_standard_balance?: number | string;
  default_subscription_quota?: number | string;
  default_subscription_period?: BillingPeriod;
  image_retention_days?: number | string;
  image_storage_limit_mb?: number | string;
  log_retention_days?: number | string;
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
  log_levels?: string[];
  linuxdo_enabled?: boolean;
  linuxdo_client_id?: string;
  linuxdo_client_secret?: string;
  linuxdo_client_secret_configured?: boolean;
  linuxdo_redirect_url?: string;
  linuxdo_frontend_redirect_url?: string;
  login_page_image_url?: string;
  login_page_image_mode?: LoginPageImageMode | string;
  login_page_image_zoom?: number | string;
  login_page_image_position_x?: number | string;
  login_page_image_position_y?: number | string;
  [key: string]: unknown;
};

export type ModelConfig = {
  image_models: ImageModel[];
  chat_models: ImageModel[];
  default_image_model: ImageModel;
  default_chat_model: ImageModel;
  relay_base_url: string;
};

export type LoginPageImageSettings = {
  login_page_image_url: string;
  login_page_image_mode: LoginPageImageMode;
  login_page_image_zoom: number;
  login_page_image_position_x: number;
  login_page_image_position_y: number;
};

export type ManagedImage = {
  name: string;
  path: string;
  owner_id?: string;
  owner_name?: string;
  visibility: ImageVisibility;
  prompt?: string;
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
  background?: string;
  moderation?: string;
  input_image_mask?: string;
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
  limit_bytes: number;
  over_limit_bytes: number;
  oldest_image_at?: string;
  latest_image_at?: string;
};

export type ImageStorageCleanupResult = {
  retention_days?: number;
  max_bytes?: number;
  include_public?: boolean;
  deleted_images: number;
  deleted_thumbnails: number;
  deleted_metadata_files: number;
  deleted_reference_files: number;
  deleted_bytes: number;
  remaining_bytes: number;
  over_limit_bytes: number;
  preserved_public_images?: number;
  action?: string;
};

export type ImageResponse = {
  created: number;
  data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
};

export type CreationTaskData = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  text_response?: string;
  width?: number;
  height?: number;
  resolution?: string;
  output_format?: ImageOutputFormat;
};

export type CreationTask = {
  id: string;
  status: "queued" | "running" | "success" | "error" | "cancelled";
  mode: "generate" | "edit" | "chat";
  model?: ImageModel;
  size?: string;
  quality?: ImageQuality;
  output_format?: ImageOutputFormat;
  output_compression?: number;
  background?: string;
  moderation?: string;
  created_at: string;
  updated_at: string;
  data?: CreationTaskData[];
  output_statuses?: ("queued" | "running" | "success" | "error" | "cancelled")[];
  error?: string;
  output_type?: "text";
  visibility?: ImageVisibility;
};

export type CreationTaskMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

type CreationTaskListResponse = {
  items?: CreationTask[] | null;
  missing_ids?: string[] | null;
};

export type LoginResponse = {
  ok: boolean;
  token?: string;
  role: AuthRole;
  role_id?: string;
  role_name?: string;
  subject_id: string;
  name: string;
  provider?: string;
  credential_id?: string;
  credential_name?: string;
  creation_concurrent_limit: number;
  creation_rpm_limit: number;
  billing?: BillingState | null;
  menu_paths?: string[];
  api_permissions?: string[];
  menus?: PermissionMenu[];
};

export type ProfileRelayKeyStatus = {
  has_key: boolean;
  key_preview: string;
  updated_at?: string;
};

export type AuthProviders = {
  registration?: {
    enabled: boolean;
  };
};

export type Announcement = {
  id: string;
  title: string;
  content: string;
  enabled?: boolean;
  show_login: boolean;
  show_image: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

export type UserKey = {
  id: string;
  name: string;
  role: AuthRole;
  role_id?: string;
  role_name?: string;
  kind?: "api_key";
  provider?: "local" | "linuxdo" | string;
  owner_id?: string;
  owner_name?: string;
  enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
  menu_paths?: string[];
  api_permissions?: string[];
};

export type BillingType = "standard" | "subscription";
export type BillingPeriod = "daily" | "weekly" | "monthly";

export type BillingStandardState = {
  balance: number;
  lifetime_consumed: number;
  available_balance?: number;
};

export type BillingSubscriptionState = {
  quota_limit: number;
  quota_used: number;
  manual_delta: number;
  quota_period: BillingPeriod;
  quota_period_started_at?: string;
  quota_period_ends_at?: string;
  remaining_quota?: number;
};

export type BillingState = {
  type: BillingType;
  unit: "image";
  unlimited: boolean;
  available: number;
  standard?: BillingStandardState | null;
  subscription?: BillingSubscriptionState | null;
  limit_state?: "ok" | "insufficient" | "unlimited" | string;
  updated_at?: string;
};

export type BillingAdjustment = {
  id: string;
  user_id: string;
  operator_id?: string;
  operator_name?: string;
  billing_type: BillingType;
  type: string;
  amount?: number;
  reason?: string;
  before?: BillingState | Record<string, unknown>;
  after?: BillingState | Record<string, unknown>;
  created_at: string;
};

export type BillingAdjustmentPayload = {
  type: string;
  reason?: string;
  amount?: number;
  balance?: number;
  quota_limit?: number;
  quota_period?: BillingPeriod;
  unlimited?: boolean;
};

export type BulkBillingAdjustmentPayload = {
  scope: "users" | "role";
  user_ids?: string[];
  role_id?: string;
  billing: BillingAdjustmentPayload;
};

export type BulkBillingAdjustmentResult = {
  user_id: string;
  billing?: BillingState | null;
  adjustment?: BillingAdjustment;
  error?: string;
};

export type BulkBillingAdjustmentSummary = {
  total: number;
  succeeded: number;
  failed: number;
};

export type ManagedUser = {
  id: string;
  username?: string;
  name: string;
  role: "user";
  role_id?: string;
  role_name?: string;
  provider: "local" | "linuxdo" | string;
  owner_id?: string;
  owner_name?: string;
  linuxdo_level?: string;
  enabled: boolean;
  has_api_key: boolean;
  has_session: boolean;
  api_key_id?: string;
  api_key_name?: string;
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
  billing?: BillingState | null;
  usage_curve?: Array<{
    date: string;
    calls: number;
    success: number;
    failure: number;
    quota_used: number;
  }>;
  menu_paths?: string[];
  api_permissions?: string[];
  billing_adjustments?: BillingAdjustment[];
};

export type ManagedUsersQuery = {
  page?: number | string;
  page_size?: number | string;
  search?: string;
  provider?: "all" | "local" | "linuxdo" | string;
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

export type RegisterConfig = {
  enabled: boolean;
  mail: {
    request_timeout: number;
    wait_timeout: number;
    wait_interval: number;
    providers: Array<Record<string, unknown>>;
  };
  proxy: string;
  total: number;
  threads: number;
  mode: "total" | "quota" | "available";
  target_quota: number;
  target_available: number;
  check_interval: number;
  stats: {
    job_id?: string;
    success: number;
    fail: number;
    done: number;
    running: number;
    threads: number;
    elapsed_seconds?: number;
    avg_seconds?: number;
    success_rate?: number;
    current_quota?: number;
    current_available?: number;
    started_at?: string;
    updated_at?: string;
    finished_at?: string;
  };
  logs?: Array<{
    time: string;
    text: string;
    level: string;
  }>;
};

export async function login(username: string, password: string) {
  return httpRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: { username, password },
    redirectOnUnauthorized: false,
  });
}

export async function registerAccount(username: string, password: string, name?: string) {
  return httpRequest<LoginResponse>("/auth/register", {
    method: "POST",
    body: { username, password, name: name ?? "" },
    redirectOnUnauthorized: false,
  });
}

export async function verifySession(token: string) {
  return httpRequest<LoginResponse>("/auth/session", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${String(token || "").trim()}`,
    },
    redirectOnUnauthorized: false,
  });
}

export async function fetchProfile() {
  return httpRequest<LoginResponse>("/api/profile");
}

export async function fetchProfileRelayKey() {
  return httpRequest<ProfileRelayKeyStatus>("/api/profile/relay-key");
}

export async function updateProfileRelayKey(apiKey: string) {
  return httpRequest<ProfileRelayKeyStatus>("/api/profile/relay-key", {
    method: "POST",
    body: { api_key: apiKey },
  });
}

export async function clearProfileRelayKey() {
  return httpRequest<ProfileRelayKeyStatus>("/api/profile/relay-key", {
    method: "DELETE",
  });
}

export async function logout() {
  return httpRequest<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    redirectOnUnauthorized: false,
  });
}

export async function fetchAuthProviders() {
  return httpRequest<AuthProviders>("/auth/providers", {
    redirectOnUnauthorized: false,
  });
}

export async function fetchVisibleAnnouncements(target: AnnouncementTarget) {
  const params = new URLSearchParams({ target });
  return httpRequest<{ items: Announcement[] }>(`/api/announcements?${params.toString()}`, {
    redirectOnUnauthorized: false,
  });
}

export async function fetchAdminAnnouncements() {
  return httpRequest<{ items: Announcement[] }>("/api/admin/announcements");
}

export async function createAnnouncement(announcement: {
  title: string;
  content: string;
  enabled: boolean;
  show_login: boolean;
  show_image: boolean;
}) {
  return httpRequest<{ item: Announcement; items: Announcement[] }>("/api/admin/announcements", {
    method: "POST",
    body: announcement,
  });
}

export async function updateAnnouncement(
  announcementId: string,
  updates: Partial<Pick<Announcement, "title" | "content" | "enabled" | "show_login" | "show_image">>,
) {
  return httpRequest<{ item: Announcement; items: Announcement[] }>(`/api/admin/announcements/${announcementId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteAnnouncement(announcementId: string) {
  return httpRequest<{ items: Announcement[] }>(`/api/admin/announcements/${announcementId}`, {
    method: "DELETE",
  });
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function fetchAccountTokens() {
  return httpRequest<AccountTokensResponse>("/api/accounts/tokens");
}

export async function createAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens },
  });
}

export async function deleteAccounts(accountIds: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { account_ids: accountIds },
  });
}

export async function refreshAccounts(accountIds: string[]) {
  return httpRequest<AccountRefreshResponse>("/api/accounts/refresh", {
    method: "POST",
    body: { account_ids: accountIds },
  });
}

export async function updateAccount(
  accountId: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      account_id: accountId,
      ...updates,
    },
  });
}

export async function generateImage(prompt: string, model?: ImageModel, size?: string, quality?: ImageQuality) {
  return httpRequest<ImageResponse>(
    "/v1/images/generations",
    {
      method: "POST",
      body: {
        prompt,
        ...(model ? { model } : {}),
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
        n: 1,
        response_format: "b64_json",
      },
    },
  );
}

export async function editImage(files: File | File[], prompt: string, model?: ImageModel, size?: string, quality?: ImageQuality) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  if (quality) {
    formData.append("quality", quality);
  }
  formData.append("n", "1");

  return httpRequest<ImageResponse>(
    "/v1/images/edits",
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function createImageGenerationTask(
  clientTaskId: string,
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: ImageQuality,
  count = 1,
  messages?: CreationTaskMessage[],
  visibility: ImageVisibility = "private",
  imageResolution?: string,
  outputFormat?: ImageOutputFormat,
  outputCompression?: number,
  toolOptions?: {
    background?: string;
    moderation?: string;
  },
) {
  return httpRequest<CreationTask>("/api/creation-tasks/image-generations", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      prompt,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(imageResolution ? { image_resolution: imageResolution } : {}),
      ...(quality ? { quality } : {}),
      ...(outputFormat ? { output_format: outputFormat } : {}),
      ...(typeof outputCompression === "number" ? { output_compression: outputCompression } : {}),
      ...(toolOptions?.background ? { background: toolOptions.background } : {}),
      ...(toolOptions?.moderation ? { moderation: toolOptions.moderation } : {}),
      ...(messages?.length ? { messages } : {}),
      visibility,
      n: count,
    },
  });
}

export async function createImageEditTask(
  clientTaskId: string,
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: ImageQuality,
  count = 1,
  messages?: CreationTaskMessage[],
  visibility: ImageVisibility = "private",
  imageResolution?: string,
  outputFormat?: ImageOutputFormat,
  outputCompression?: number,
  toolOptions?: {
    background?: string;
    moderation?: string;
    inputImageMask?: string;
  },
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("client_task_id", clientTaskId);
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  if (imageResolution) {
    formData.append("image_resolution", imageResolution);
  }
  if (quality) {
    formData.append("quality", quality);
  }
  if (outputFormat) {
    formData.append("output_format", outputFormat);
  }
  if (typeof outputCompression === "number") {
    formData.append("output_compression", String(outputCompression));
  }
  if (toolOptions?.background) {
    formData.append("background", toolOptions.background);
  }
  if (toolOptions?.moderation) {
    formData.append("moderation", toolOptions.moderation);
  }
  if (toolOptions?.inputImageMask) {
    formData.append("input_image_mask", toolOptions.inputImageMask);
  }
  if (messages?.length) {
    formData.append("messages", JSON.stringify(messages));
  }
  formData.append("visibility", visibility);
  formData.append("n", String(count));

  return httpRequest<CreationTask>("/api/creation-tasks/image-edits", {
    method: "POST",
    body: formData,
  });
}

export async function createChatCompletionTask(
  clientTaskId: string,
  prompt: string,
  model: ImageModel,
  messages: CreationTaskMessage[],
  referenceImages?: { name: string; dataUrl: string }[],
) {
  const body: Record<string, unknown> = {
    client_task_id: clientTaskId,
    prompt,
    model,
    messages,
  };

  if (referenceImages && referenceImages.length > 0) {
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: prompt },
      ...referenceImages.map((img) => ({
        type: "image_url" as const,
        image_url: { url: img.dataUrl },
      })),
    ];
    body.messages = [
      ...messages,
      { role: "user" as const, content },
    ];
  }

  return httpRequest<CreationTask>("/api/creation-tasks/chat-completions", {
    method: "POST",
    body,
  });
}

export async function streamChatCompletion(
  model: ImageModel,
  messages: CreationTaskMessage[],
  prompt: string,
  referenceImages: { name: string; dataUrl: string }[] | undefined,
  onText: (text: string) => void,
  signal?: AbortSignal,
) {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  if (referenceImages && referenceImages.length > 0) {
    const content = [
      { type: "text", text: prompt },
      ...referenceImages.map((img) => ({
        type: "image_url",
        image_url: { url: img.dataUrl },
      })),
    ];
    body.messages = [
      ...messages,
      { role: "user" as const, content },
    ];
  }

  const token = await getStoredSessionToken();
  const response = await fetch(`${webConfig.apiUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `请求失败 (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        const parsed = JSON.parse(data) as {
          error?: unknown;
          detail?: unknown;
          message?: unknown;
          type?: string;
          choices?: Array<{
            delta?: { content?: string | Array<{ text?: string }>; text?: string };
            message?: { content?: string | Array<{ text?: string }> };
            text?: string;
          }>;
        };
        const errorMessage = streamChunkErrorMessage(parsed);
        if (errorMessage) {
          throw new Error(errorMessage);
        }
        const delta = chatCompletionChunkText(parsed);
        if (delta) {
          fullText += delta;
          onText(fullText);
        }
      }
    }
  }
  return fullText;
}

function streamChunkErrorMessage(chunk: { error?: unknown; detail?: unknown; message?: unknown; type?: string }) {
  const error = errorText(chunk.error);
  if (error) {
    return error;
  }
  if (chunk.type === "error") {
    return errorText(chunk.message) || errorText(chunk.detail);
  }
  return "";
}

function errorText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const item = value as { error?: unknown; detail?: unknown; message?: unknown };
  return errorText(item.message) || errorText(item.error) || errorText(item.detail);
}

function chatCompletionChunkText(chunk: {
  choices?: Array<{
    delta?: { content?: string | Array<{ text?: string }>; text?: string };
    message?: { content?: string | Array<{ text?: string }> };
    text?: string;
  }>;
}) {
  return (chunk.choices || [])
    .map((choice) =>
      contentText(choice.delta?.content) ||
      choice.delta?.text ||
      contentText(choice.message?.content) ||
      choice.text ||
      "",
    )
    .join("");
}

function contentText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("");
}

export async function fetchCreationTasks(ids: string[]) {
  const params = new URLSearchParams();
  if (ids.length > 0) {
    params.set("ids", ids.join(","));
  }
  const data = await httpRequest<CreationTaskListResponse>(`/api/creation-tasks${params.toString() ? `?${params.toString()}` : ""}`, {
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  return {
    items: Array.isArray(data.items) ? data.items : [],
    missing_ids: Array.isArray(data.missing_ids) ? data.missing_ids : [],
  };
}

export async function cancelCreationTask(clientTaskId: string) {
  return httpRequest<CreationTask>(`/api/creation-tasks/${encodeURIComponent(clientTaskId)}/cancel`, {
    method: "POST",
    body: {},
  });
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

export async function fetchModelConfig() {
  return httpRequest<{ config: ModelConfig }>("/api/model-config");
}

export async function updateLoginPageImageSettings(
  settings: LoginPageImageSettings,
  options: { action: "keep" | "replace" | "remove"; file?: File | null },
) {
  const formData = new FormData();
  formData.append("login_page_image_url", settings.login_page_image_url);
  formData.append("login_page_image_mode", settings.login_page_image_mode);
  formData.append("login_page_image_zoom", String(settings.login_page_image_zoom));
  formData.append("login_page_image_position_x", String(settings.login_page_image_position_x));
  formData.append("login_page_image_position_y", String(settings.login_page_image_position_y));
  formData.append("login_page_image_action", options.action);
  if (options.file) {
    formData.append("login_page_image_file", options.file);
  }
  return httpRequest<{ config: SettingsConfig }>("/api/settings/login-page-image", {
    method: "POST",
    body: formData,
  });
}

export async function fetchManagedImages(
  filters: { start_date?: string; end_date?: string; scope?: "mine" | "public" | "all" },
  options: { signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams();
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  const data = await httpRequest<{ items?: ManagedImage[] | null; groups?: Array<{ date: string; items: ManagedImage[] }> | null }>(
    `/api/images${params.toString() ? `?${params.toString()}` : ""}`,
    { signal: options.signal },
  );
  return {
    items: Array.isArray(data.items) ? data.items : [],
    groups: Array.isArray(data.groups) ? data.groups : [],
  };
}

export async function updateManagedImageVisibility(
  path: string,
  visibility: ImageVisibility,
  options: { sharePromptParameters?: boolean; shareReferenceImages?: boolean } = {},
) {
  return httpRequest<{ item: Partial<ManagedImage> & { path: string; visibility: ImageVisibility } }>(
    "/api/images/visibility",
    {
      method: "PATCH",
      body: {
        path,
        visibility,
        ...(visibility === "public" && options.sharePromptParameters ? { share_prompt_parameters: true } : {}),
        ...(visibility === "public" && options.sharePromptParameters && options.shareReferenceImages ? { share_reference_images: true } : {}),
      },
    },
  );
}

export async function deleteManagedImages(paths: string[]) {
  return httpRequest<{ deleted: number; missing: number; paths: string[] }>("/api/images", {
    method: "DELETE",
    body: { paths },
  });
}

export async function fetchSystemLogs(filters: SystemLogFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "" || value === "all") {
      continue;
    }
    params.set(key, String(value));
  }
  return httpRequest<{ items: SystemLog[] }>(`/api/logs${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function fetchLogGovernance() {
  return httpRequest<{ governance: LogGovernanceSummary }>("/api/logs/governance");
}

export async function cleanupLogs(retentionDays: number) {
  return httpRequest<{ cleanup: LogCleanupResult; governance: LogGovernanceSummary }>("/api/logs/governance", {
    method: "POST",
    body: { retention_days: retentionDays },
  });
}

export async function fetchImageStorageGovernance() {
  return httpRequest<{ governance: ImageStorageGovernanceSummary }>("/api/images/storage-governance");
}

export async function cleanupImageStorage(body: {
  action: "retention" | "quota" | "thumbnails" | "all";
  retention_days?: number;
  max_mb?: number;
  include_public?: boolean;
  clear_thumbnails?: boolean;
}) {
  return httpRequest<{ cleanup: ImageStorageCleanupResult; governance: ImageStorageGovernanceSummary }>(
    "/api/images/storage-governance",
    {
      method: "POST",
      body,
    },
  );
}

export async function fetchUserKeys() {
  return httpRequest<{ items: UserKey[] }>("/api/auth/users");
}

export async function createUserKey(name: string) {
  return httpRequest<{ item: UserKey; key: string; items: UserKey[] }>("/api/auth/users", {
    method: "POST",
    body: { name },
  });
}

export async function revealUserKey(keyId: string) {
  return httpRequest<{ key: string }>(`/api/auth/users/${keyId}/key`);
}

export async function updateUserKey(keyId: string, updates: { enabled?: boolean; name?: string }) {
  return httpRequest<{ item: UserKey; items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteUserKey(keyId: string) {
  return httpRequest<{ items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "DELETE",
  });
}

function profileAPIKeyPath(keyId: string) {
  return `/api/profile/api-key/${encodeURIComponent(keyId)}`;
}

export async function fetchProfileAPIKey() {
  return httpRequest<{ items: UserKey[] }>("/api/profile/api-key");
}

export async function upsertProfileAPIKey(name: string) {
  return httpRequest<{ item: UserKey; key: string; items: UserKey[] }>("/api/profile/api-key", {
    method: "POST",
    body: { name },
  });
}

export async function revealProfileAPIKey(keyId: string) {
  return httpRequest<{ key: string }>(`${profileAPIKeyPath(keyId)}/key`);
}

export async function updateProfileAPIKey(keyId: string, updates: { enabled?: boolean; name?: string }) {
  return httpRequest<{ item: UserKey; items: UserKey[] }>(profileAPIKeyPath(keyId), {
    method: "POST",
    body: updates,
  });
}

export async function deleteProfileAPIKey(keyId: string) {
  return httpRequest<{ items: UserKey[] }>(profileAPIKeyPath(keyId), {
    method: "DELETE",
  });
}

export async function updateProfileName(name: string) {
  return httpRequest<LoginResponse>("/api/profile", {
    method: "POST",
    body: { name },
  });
}

export async function changeProfilePassword(currentPassword: string, newPassword: string) {
  return httpRequest<{ ok: boolean }>("/api/profile/password", {
    method: "POST",
    body: {
      current_password: currentPassword,
      new_password: newPassword,
    },
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
  if (query.provider && query.provider !== "all") params.set("provider", query.provider);
  if (query.status && query.status !== "all") params.set("status", query.status);
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

export async function fetchManagedUser(userId: string) {
  return httpRequest<{ item: ManagedUser }>(managedUserPath(userId));
}

export async function fetchPermissionCatalog() {
  return httpRequest<{ menus: PermissionMenu[]; apis: ApiPermission[] }>("/api/admin/permissions");
}

function managedRolePath(roleId: string) {
  return `/api/admin/roles/${encodeURIComponent(roleId)}`;
}

export async function fetchManagedRoles() {
  return httpRequest<{ items: ManagedRole[] }>("/api/admin/roles");
}

export async function createManagedRole(updates: {
  name: string;
  description?: string;
  menu_paths?: string[];
  api_permissions?: string[];
}) {
  return httpRequest<{ item: ManagedRole; items: ManagedRole[] }>("/api/admin/roles", {
    method: "POST",
    body: updates,
  });
}

export async function updateManagedRole(
  roleId: string,
  updates: { name?: string; description?: string; menu_paths?: string[]; api_permissions?: string[] },
) {
  return httpRequest<{ item: ManagedRole; items: ManagedRole[] }>(managedRolePath(roleId), {
    method: "POST",
    body: updates,
  });
}

export async function deleteManagedRole(roleId: string) {
  return httpRequest<{ items: ManagedRole[] }>(managedRolePath(roleId), {
    method: "DELETE",
  });
}

export async function createManagedUser(payload: CreateManagedUserPayload) {
  return httpRequest<{ item: ManagedUser; items?: ManagedUser[] } & Partial<ManagedUsersResponse>>("/api/admin/users", {
    method: "POST",
    body: payload,
  });
}

export async function updateManagedUser(
  userId: string,
  updates: { enabled?: boolean; name?: string; role_id?: string; billing?: BillingAdjustmentPayload },
) {
  return httpRequest<{ item: ManagedUser; items?: ManagedUser[] } & Partial<ManagedUsersResponse>>(managedUserPath(userId), {
    method: "POST",
    body: updates,
  });
}

export async function fetchBillingAdjustments(userId: string, limit = 20) {
  const params = new URLSearchParams({ limit: String(limit) });
  return httpRequest<{ items: BillingAdjustment[] }>(`${managedUserPath(userId)}/billing-adjustments?${params.toString()}`);
}

export async function createBillingAdjustment(userId: string, payload: BillingAdjustmentPayload) {
  return httpRequest<
    { item?: ManagedUser; billing?: BillingState; adjustment?: BillingAdjustment; items?: ManagedUser[] } & Partial<ManagedUsersResponse>
  >(`${managedUserPath(userId)}/billing-adjustments`, {
    method: "POST",
    body: payload,
  });
}

export async function createBulkBillingAdjustment(payload: BulkBillingAdjustmentPayload) {
  return httpRequest<
    {
      results?: BulkBillingAdjustmentResult[];
      summary?: BulkBillingAdjustmentSummary;
      items?: ManagedUser[];
    } & Partial<ManagedUsersResponse>
  >("/api/admin/users/billing-adjustments/bulk", {
    method: "POST",
    body: payload,
  });
}

export async function revealManagedUserKey(userId: string) {
  return httpRequest<{ key: string }>(`${managedUserPath(userId)}/key`);
}

export async function resetManagedUserKey(userId: string, name?: string) {
  return httpRequest<{ item: ManagedUser; api_key: UserKey; key: string; items?: ManagedUser[] } & Partial<ManagedUsersResponse>>(
    `${managedUserPath(userId)}/reset-key`,
    {
      method: "POST",
      body: { name: name ?? "" },
    },
  );
}

export async function deleteManagedUser(userId: string) {
  return httpRequest<{ items?: ManagedUser[] } & Partial<ManagedUsersResponse>>(managedUserPath(userId), {
    method: "DELETE",
  });
}

export async function fetchRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register");
}

export async function updateRegisterConfig(updates: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register", {
    method: "POST",
    body: updates,
  });
}

export async function startRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/start", { method: "POST" });
}

export async function stopRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/stop", { method: "POST" });
}

export async function resetRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/reset", { method: "POST" });
}

// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  import_job?: CPAImportJob | null;
};

export type CPARemoteFile = {
  name: string;
  email: string;
};

export type CPAImportJob = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  added: number;
  skipped: number;
  refreshed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
};

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools");
}

export async function createCPAPool(pool: { name: string; base_url: string; secret_key: string }) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function fetchCPAPoolFiles(poolId: string) {
  return httpRequest<{ pool_id: string; files: CPARemoteFile[] }>(`/api/cpa/pools/${poolId}/files`);
}

export async function startCPAImport(poolId: string, names: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`, {
    method: "POST",
    body: { names },
  });
}

export async function fetchCPAPoolImportJob(poolId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`);
}

// ── Sub2API ────────────────────────────────────────────────────────

export type Sub2APIServer = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  has_api_key: boolean;
  group_id: string;
  import_job?: CPAImportJob | null;
};

export type Sub2APIRemoteAccount = {
  id: string;
  name: string;
  email: string;
  plan_type: string;
  status: string;
  expires_at: string;
  has_refresh_token: boolean;
};

export type Sub2APIRemoteGroup = {
  id: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  account_count: number;
  active_account_count: number;
};

export async function fetchSub2APIServers() {
  const data = await httpRequest<{ servers?: Sub2APIServer[] | null }>("/api/sub2api/servers");
  return {
    servers: Array.isArray(data.servers) ? data.servers : [],
  };
}

export async function createSub2APIServer(server: {
  name: string;
  base_url: string;
  email: string;
  password: string;
  api_key: string;
  group_id: string;
}) {
  const data = await httpRequest<{ server: Sub2APIServer; servers?: Sub2APIServer[] | null }>("/api/sub2api/servers", {
    method: "POST",
    body: server,
  });
  return {
    server: data.server,
    servers: Array.isArray(data.servers) ? data.servers : [],
  };
}

export async function updateSub2APIServer(
  serverId: string,
  updates: {
    name?: string;
    base_url?: string;
    email?: string;
    password?: string;
    api_key?: string;
    group_id?: string;
  },
) {
  const data = await httpRequest<{ server: Sub2APIServer; servers?: Sub2APIServer[] | null }>(`/api/sub2api/servers/${serverId}`, {
    method: "POST",
    body: updates,
  });
  return {
    server: data.server,
    servers: Array.isArray(data.servers) ? data.servers : [],
  };
}

export async function fetchSub2APIServerGroups(serverId: string) {
  const data = await httpRequest<{ server_id: string; groups?: Sub2APIRemoteGroup[] | null }>(
    `/api/sub2api/servers/${serverId}/groups`,
  );
  return {
    server_id: data.server_id,
    groups: Array.isArray(data.groups) ? data.groups : [],
  };
}

export async function deleteSub2APIServer(serverId: string) {
  const data = await httpRequest<{ servers?: Sub2APIServer[] | null }>(`/api/sub2api/servers/${serverId}`, {
    method: "DELETE",
  });
  return {
    servers: Array.isArray(data.servers) ? data.servers : [],
  };
}

export async function fetchSub2APIServerAccounts(serverId: string) {
  const data = await httpRequest<{ server_id: string; accounts?: Sub2APIRemoteAccount[] | null }>(
    `/api/sub2api/servers/${serverId}/accounts`,
  );
  return {
    server_id: data.server_id,
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
  };
}

export async function startSub2APIImport(serverId: string, accountIds: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`, {
    method: "POST",
    body: { account_ids: accountIds },
  });
}

export async function fetchSub2APIImportJob(serverId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`);
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchRelayModels(signal?: AbortSignal) {
  return httpRequest<{ object?: string; data?: RelayModelListItem[] | null }>("/v1/models", {
    signal,
  });
}

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}
