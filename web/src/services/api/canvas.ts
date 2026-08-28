import type { ImageOutputFormat, ImageQuality } from "@/lib/api";
import { httpRequest } from "@/lib/request";

type CanvasViewport = {
  zoom: number;
  x: number;
  y: number;
};

export type CanvasNode = {
  id: string;
  type: "image" | "video" | "audio" | "panorama" | "director" | "group" | "text" | "config";
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
  generation_video_resolution?: string;
  generation_video_audio?: boolean;
  generation_video_watermark?: boolean;
  generation_video_mode?: string;
  generation_video_negative_prompt?: string;
  generation_video_multi_shot?: boolean;
  generation_video_shot_type?: "intelligence" | "customize";
  generation_video_multi_prompt?: Array<Record<string, unknown>>;
  generation_video_element_list?: Array<Record<string, unknown>>;
  generation_video_character_orientation?: "image" | "video";
  generation_video_reference_mode?: "first-frame" | "reference";
  generation_video_reference_image_urls?: string[];
  generation_video_reference_urls?: string[];
  generation_video_reference_audio_urls?: string[];
  generation_video_first_frame_node_id?: string;
  generation_video_last_frame_node_id?: string;
  generation_video_kling_image_node_ids?: string[];
  generation_video_kling_multi_prompt?: Array<{ text_node_id?: string; duration?: string }>;
  generation_video_kling_element_list?: Array<{
    name?: string;
    description?: string;
    node_ids?: string[];
  }>;
  generation_mode?: "image" | "text" | "video" | "audio";
  generation_text_model?: string;
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
  mime_type?: string;
  panorama_source_prompt?: string;
  panorama_final_prompt?: string;
  panorama_projection?: "equirectangular";
  director_project?: Record<string, unknown>;
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
  active_agent_session_id?: string;
  agent_config?: Record<string, unknown>;
  agent_panel?: {
    open: boolean;
    width: number;
  };
  agent_auto_title_pending?: boolean;
  pending_agent_request?: CanvasPendingAgentRequest;
  viewport: CanvasViewport;
  created_at?: string;
  updated_at?: string;
};

export type CanvasProjectSummary = {
  id: string;
  title: string;
  node_count: number;
  revision: number;
  created_at?: string;
  updated_at?: string;
};

export type CanvasWorkspaceResponse = {
  document: CanvasDocument;
  projects: CanvasProjectSummary[];
  active_project_id: string;
};

export async function fetchCanvasDocument(projectID?: string) {
  const query = projectID ? `?project_id=${encodeURIComponent(projectID)}` : "";
  return httpRequest<CanvasWorkspaceResponse>(`/api/canvas${query}`);
}

export async function saveCanvasDocument(document: CanvasDocument) {
  return httpRequest<{ document: CanvasDocument }>("/api/canvas", {
    method: "PUT",
    body: document,
  });
}

export async function clearCanvasDocument(projectID: string, revision: number) {
  return httpRequest<{ document: CanvasDocument }>(
    `/api/canvas?project_id=${encodeURIComponent(projectID)}&revision=${encodeURIComponent(String(revision))}`,
    { method: "DELETE" },
  );
}

export async function updateCanvasProject(input: {
  action: "create" | "activate" | "rename" | "delete";
  project_id?: string;
  title?: string;
  revision?: number;
}) {
  return httpRequest<CanvasWorkspaceResponse>("/api/canvas", {
    method: "POST",
    body: input,
  });
}

export async function importCanvasProject(document: CanvasDocument) {
  return httpRequest<CanvasWorkspaceResponse>("/api/canvas", {
    method: "POST",
    body: { action: "import", document },
  });
}
