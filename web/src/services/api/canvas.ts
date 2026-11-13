import type { ImageOutputFormat, ImageQuality } from "@/lib/api";
import { httpRequest } from "@/lib/request";
import type { AgentRunStatus } from "@/lib/agent-run-state";

export type CanvasScriptDialogue = { id: string; kind: "dialogue" | "narration"; asset_id: string; text: string };
export type CanvasScriptReviewStatus = "unchecked" | "passed" | "needs_fix";
export type CanvasScriptQualityReview = { media_url: string; continuity: CanvasScriptReviewStatus; dialogue: CanvasScriptReviewStatus; speaker: CanvasScriptReviewStatus; lip_sync: CanvasScriptReviewStatus; text_on_screen?: CanvasScriptReviewStatus; notes: string };
export type CanvasScriptShot = { quality_review?: CanvasScriptQualityReview;
  id: string;
  seconds: number;
  description: string;
  framing: string;
  lighting: string;
  dialogue: CanvasScriptDialogue[];
  sound: string;
  camera: string;
  asset_ids: string[];
  image_prompt: string;
  video_prompt: string;
  color: string;
  source_node_id?: string;
  image_node_id?: string;
  video_node_id?: string;
  image_outdated?: boolean;
  video_outdated?: boolean;
  image_prompt_outdated?: boolean;
  video_prompt_outdated?: boolean;
};
export type CanvasScriptAsset = { id: string; kind: "character" | "scene" | "prop"; name: string; description: string; image_node_id: string };
export type CanvasScriptProject = { step: number; confirmed: boolean; shots: CanvasScriptShot[]; assets: CanvasScriptAsset[]; merged_video_node_id?: string; merged_video_fingerprint?: string; merged_video_outdated?: boolean };

type CanvasViewport = {
  zoom: number;
  x: number;
  y: number;
};

export type CanvasNode = {
  id: string;
  type: "image" | "video" | "audio" | "panorama" | "director" | "script" | "group" | "text" | "config";
  x: number;
  y: number;
  width: number;
  height: number;
  font_size?: number;
  natural_width?: number;
  natural_height?: number;
  bytes?: number;
  free_resize?: boolean;
  scale_x: number;
  scale_y: number;
  angle?: number;
  url?: string;
	storage_key?: string;
  thumbnail_url?: string;
  title?: string;
  prompt?: string;
  composer_content?: string;
  exclude_upstream_text?: boolean;
  group_id?: string;
  task_id?: string;
  generation_model?: string;
  generation_size?: string;
  generation_resolution?: string;
  generation_quality?: ImageQuality;
  generation_count?: number;
  generation_image_options?: import("@/lib/image-generation-options").ImageGenerationOptions;
  generation_output_format?: ImageOutputFormat;
  generation_output_compression?: number;
  generation_stream?: boolean;
  generation_partial_images?: number;
  generation_snap_to_multiple_16?: boolean;
  generation_response_format_b64_json?: boolean;
  generation_codex_cli_compatibility?: boolean;
  generation_status?: "idle" | "loading" | "success" | "error";
  generation_started_at?: number;
  generation_progress?: number;
  generation_error?: string;
  generation_type?: "generation" | "edit";
  generation_reference_urls?: string[];
  generation_video_model?: string;
  generation_video_size?: string;
  generation_video_seconds?: number;
  generation_video_parameters?: import("@/lib/video-model-contracts").VideoParameterValues;
  generation_video_resolution?: string;
  generation_video_audio?: boolean;
  generation_video_watermark?: boolean;
  generation_video_reference_mode?: "first-frame" | "reference";
  generation_video_reference_image_urls?: string[];
  generation_video_reference_urls?: string[];
  generation_video_reference_audio_urls?: string[];
  generation_video_first_frame_node_id?: string;
  generation_video_last_frame_node_id?: string;
  generation_video_last_frame_url?: string;
  generation_mode?: "image" | "text" | "video" | "audio";
  generation_text_model?: string;
  generation_workflow_inputs?: Record<string, string | number | boolean>;
  generation_audio_model?: string;
  generation_audio_voice?: string;
  generation_audio_format?: "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm";
  generation_audio_speed?: number;
  generation_audio_instructions?: string;
  generation_audio_grok_voice?: string;
  generation_audio_grok_language?: string;
  generation_audio_grok_format?: "mp3" | "wav";
  generation_audio_grok_speed?: number;
  generation_audio_glm_voice?: string;
  generation_audio_glm_format?: "wav" | "pcm";
  generation_audio_glm_speed?: number;
  generation_audio_mimo_voice?: string;
  generation_audio_mimo_format?: "wav" | "mp3";
  generation_audio_mimo_voice_design_prompt?: string;
  generation_audio_mimo_voice_clone_node_id?: string;
  generation_audio_gemini_voice?: string;
  audio_task_id?: string;
  audio_task_result_id?: string;
  duration_ms?: number;
  media_metadata?: { width: number; height: number; duration_ms: number; has_audio?: boolean };
  media_silent_clips?: number;
  media_probe_error?: string;
  mime_type?: string;
  panorama_source_prompt?: string;
  panorama_final_prompt?: string;
  panorama_projection?: "equirectangular";
  director_project?: Record<string, unknown>;
  script_project?: CanvasScriptProject;
  script_operation?: { kind: "script" | "prompts"; shot_ids: string[] };
  camera_control?: {
    enabled: boolean;
    camera?: string;
    lens?: string;
    focal_length?: number;
    aperture?: number;
  };
  batch_child_ids?: string[];
  batch_root_id?: string;
  batch_primary_id?: string;
  batch_expanded?: boolean;
  created_at?: string;
};

export type CanvasConnection = {
  id: string;
  from_node_id: string;
  to_node_id: string;
};

export type CanvasAssistantReference = {
  id: string;
  source?: "attachment";
  type: CanvasNode["type"];
  title: string;
  label?: string;
  dataUrl?: string;
  url?: string;
  storageKey?: string;
  mimeType?: string;
  text?: string;
};

export type CanvasInsertAssetPayload =
  | { kind: "text"; content: string; title: string; assetId?: string; source?: "asset" | "library" }
  | { kind: "image"; dataUrl: string; title: string; storageKey?: string; assetId?: string; width?: number; height?: number; bytes?: number; mimeType?: string; source?: "asset" | "library" }
  | { kind: "video"; url: string; title: string; storageKey?: string; assetId?: string; width?: number; height?: number; bytes?: number; mimeType?: string; durationMs?: number; source?: "asset" | "library" }
  | { kind: "audio"; url: string; title: string; storageKey?: string; assetId?: string; bytes?: number; mimeType?: string; durationMs?: number; source?: "asset" | "library" };

export type CanvasPendingAgentAsset = {
  nodeId: string;
  payload: CanvasInsertAssetPayload;
  reference: CanvasAssistantReference;
};

export type CanvasPendingAgentRequest = {
  prompt: string;
  assets: CanvasPendingAgentAsset[];
};

type CanvasAgentMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type CanvasDocument = {
  agent_run?: { id: string; sessionId: string; assistantId: string; engine?: string; toolResult?: { ok: boolean; [key: string]: unknown }; status: AgentRunStatus; error?: string; updatedAt: string };
  retained_storage_object_ids?: string[];
  retained_storage_object_urls?: string[];
  retained_storage_objects_until?: string;
  version: number;
  id: string;
  revision: number;
  title: string;
  background: "dots" | "grid" | "plain";
  show_image_info?: boolean;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  agent_messages?: CanvasAgentMessage[];
  agent_sessions?: unknown[];
  agent_history_partial?: boolean;
  agent_session_summaries?: CanvasAgentSessionSummary[];
  agent_session_updates?: CanvasAgentSessionUpdate[];
  deleted_agent_session_ids?: string[];
  active_agent_session_id?: string;
  agent_config?: Record<string, unknown>;
  agent_panel?: {
    mode?: "floating" | "docked";
    open: boolean;
    width: number;
  };
  agent_auto_title_pending?: boolean;
  pending_agent_request?: CanvasPendingAgentRequest;
  viewport: CanvasViewport;
  created_at?: string;
  updated_at?: string;
};

export type CanvasAgentSessionUpdate = {
  id: string;
  changes: { title?: string; engine?: "native" | "codex"; updatedAt?: string };
};

export type CanvasAgentSessionSummary = { id: string; title: string; created_at?: string; updated_at?: string; message_count: number; content_hash: string };

export type CanvasProjectSummary = {
  id: string;
  title: string;
  node_count: number;
  revision: number;
  created_at?: string;
  updated_at?: string;
};

export type CanvasProjectList = {
  projects: CanvasProjectSummary[];
  active_project_id: string;
};

export type CanvasWorkspaceResponse = CanvasProjectList & { document: CanvasDocument };

export function fetchCanvasProjectList(signal?: AbortSignal) {
  return httpRequest<CanvasProjectList>("/api/canvas?view=projects", { signal });
}

type CanvasHistoryScope = "full" | "active" | "editor";

export async function fetchCanvasDocument(projectID?: string, history: CanvasHistoryScope = "full", sessionIDs: string[] = [], signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (projectID) query.set("project_id", projectID);
  if (history !== "full") query.set("history", history);
  for (const id of sessionIDs) query.append("session_id", id);
  return httpRequest<CanvasWorkspaceResponse>(`/api/canvas?${query}`, { signal });
}

export function fetchCanvasAgentHistorySession(projectID: string, sessionID: string, revision: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ project_id: projectID, session_id: sessionID, revision: String(revision) });
  return httpRequest<{ session: unknown; revision: number }>(`/api/canvas/agent-history?${query}`, { signal });
}

export async function saveCanvasDocument(document: CanvasDocument) {
  return httpRequest<{ document: CanvasDocument }>("/api/canvas", {
    method: "PUT",
    body: document,
  });
}

export async function clearCanvasDocument(projectID: string, revision: number) {
  return httpRequest<{ document: CanvasDocument }>(
    `/api/canvas?history=active&project_id=${encodeURIComponent(projectID)}&revision=${encodeURIComponent(String(revision))}`,
    { method: "DELETE" },
  );
}

type CanvasProjectMutation = {
  action: "create" | "activate" | "rename" | "delete";
  project_id?: string;
  title?: string;
  revision?: number;
};

export function mutateCanvasProjectList(input: CanvasProjectMutation | { action: "import"; document: CanvasDocument }) {
  return httpRequest<CanvasProjectList>("/api/canvas?view=projects", { method: "POST", body: input });
}

export async function updateCanvasProject(input: CanvasProjectMutation, history: CanvasHistoryScope = "full", signal?: AbortSignal) {
  return httpRequest<CanvasWorkspaceResponse>(`/api/canvas?history=${history}`, {
    method: "POST",
    body: input,
    signal,
  });
}

export async function importCanvasProject(document: CanvasDocument, history: "full" | "active" = "full") {
  return httpRequest<CanvasWorkspaceResponse>(`/api/canvas?history=${history}`, {
    method: "POST",
    body: { action: "import", document },
  });
}

export type CanvasShare = { token: string };

export function fetchCanvasShare(projectID: string) {
  return httpRequest<CanvasShare>(`/api/canvas/shares?project_id=${encodeURIComponent(projectID)}`);
}

export function createCanvasShare(projectID: string) {
  return httpRequest<CanvasShare>(`/api/canvas/shares?project_id=${encodeURIComponent(projectID)}`, { method: "POST" });
}

export function revokeCanvasShare(projectID: string) {
  return httpRequest<CanvasShare>(`/api/canvas/shares?project_id=${encodeURIComponent(projectID)}`, { method: "DELETE" });
}

export function fetchSharedCanvas(token: string, signal?: AbortSignal) {
  return httpRequest<{ document: CanvasDocument }>(`/api/canvas-shares/${encodeURIComponent(token)}`, { redirectOnUnauthorized: false, signal });
}
