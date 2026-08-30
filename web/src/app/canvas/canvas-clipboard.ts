import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";

export type CanvasClipboard = {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
};

const CANVAS_CLIPBOARD_NODE_FIELDS = new Set<keyof CanvasNode>([
  "id", "type", "x", "y", "width", "height", "font_size", "natural_width", "natural_height", "bytes",
  "free_resize", "scale_x", "scale_y", "angle", "url", "storage_key", "thumbnail_url", "title", "prompt",
  "composer_content", "exclude_upstream_text", "group_id", "task_id", "generation_model", "generation_size",
  "generation_resolution", "generation_quality", "generation_count", "generation_output_format",
  "generation_output_compression", "generation_stream", "generation_partial_images", "generation_snap_to_multiple_16",
  "generation_response_format_b64_json", "generation_codex_cli_compatibility", "generation_status",
	  "generation_started_at", "generation_progress", "generation_error", "generation_type", "generation_reference_urls",
	  "generation_video_model", "generation_video_size", "generation_video_seconds", "generation_video_resolution",
	  "generation_video_audio", "generation_video_watermark", "generation_video_reference_mode",
	  "generation_video_reference_image_urls", "generation_video_reference_urls", "generation_video_reference_audio_urls",
	  "generation_video_first_frame_node_id", "generation_video_last_frame_node_id", "generation_mode", "generation_text_model",
  "generation_audio_model", "generation_audio_voice", "generation_audio_format", "generation_audio_speed",
  "generation_audio_instructions", "generation_audio_grok_voice", "generation_audio_grok_language",
  "generation_audio_grok_format", "generation_audio_grok_speed", "generation_audio_glm_voice",
  "generation_audio_glm_format", "generation_audio_glm_speed", "generation_audio_mimo_voice",
  "generation_audio_mimo_format", "generation_audio_mimo_voice_design_prompt", "generation_audio_mimo_voice_clone_node_id",
  "generation_audio_gemini_voice", "audio_task_id", "audio_task_result_id", "duration_ms", "mime_type",
  "panorama_source_prompt", "panorama_final_prompt", "panorama_projection", "director_project", "camera_control",
  "batch_child_ids", "batch_root_id", "batch_primary_id", "batch_expanded", "created_at",
]);

const CANVAS_CLIPBOARD_CONNECTION_FIELDS = new Set<keyof CanvasConnection>([
  "id", "from_node_id", "to_node_id",
]);

export function remapCanvasNodeReferences(node: CanvasNode, idMap: ReadonlyMap<string, string>): CanvasNode {
  return {
    ...node,
    group_id: node.group_id ? idMap.get(node.group_id) : undefined,
  };
}

export function normalizeCanvasClipboard(value: unknown): CanvasClipboard | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { type?: unknown; nodes?: unknown; connections?: unknown };
  if (Object.keys(candidate).some((key) => key !== "type" && key !== "nodes" && key !== "connections")) return null;
  if (candidate.type !== undefined && candidate.type !== "yunmian-canvas-nodes") return null;
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0 || candidate.nodes.length > 500) return null;

  const ids = new Set<string>();
  const nodes: CanvasNode[] = [];
  for (const raw of candidate.nodes) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Partial<CanvasNode>;
    if (Object.keys(source).some((key) => !CANVAS_CLIPBOARD_NODE_FIELDS.has(key as keyof CanvasNode))) return null;
    const id = String(source.id || "").trim();
    const type = source.type;
    if (!id || id.length > 128 || ids.has(id) || !["image", "video", "audio", "panorama", "director", "group", "text", "config"].includes(type || "")) return null;
    if (!isFiniteNumber(source.x) || !isFiniteNumber(source.y) || Math.abs(source.x) > 1e7 || Math.abs(source.y) > 1e7) return null;
    if (!isFiniteNumber(source.width) || !isFiniteNumber(source.height) || source.width <= 0 || source.height <= 0 || source.width > 20000 || source.height > 20000) return null;
    if (source.font_size !== undefined && (!isFiniteNumber(source.font_size) || source.font_size < 10 || source.font_size > 32)) return null;
    if (!isFiniteNumber(source.scale_x) || !isFiniteNumber(source.scale_y) || source.scale_x <= 0 || source.scale_y <= 0) return null;
    if (source.composer_content !== undefined && (typeof source.composer_content !== "string" || source.composer_content.length > 12000)) return null;
    if (source.group_id !== undefined && (typeof source.group_id !== "string" || source.group_id.length > 128 || source.group_id === id || type === "group")) return null;
    if (source.generation_model !== undefined && (typeof source.generation_model !== "string" || source.generation_model.trim().length > 256)) return null;
    if (source.generation_video_model !== undefined && (typeof source.generation_video_model !== "string" || source.generation_video_model.trim().length > 256)) return null;
    if (source.generation_video_size !== undefined && (typeof source.generation_video_size !== "string" || source.generation_video_size.length > 64)) return null;
    if (source.generation_video_seconds !== undefined && (!isFiniteNumber(source.generation_video_seconds) || source.generation_video_seconds < 1 || source.generation_video_seconds > 3600 || !Number.isInteger(source.generation_video_seconds))) return null;
    if (source.generation_video_resolution !== undefined && (typeof source.generation_video_resolution !== "string" || source.generation_video_resolution.length > 64)) return null;
    if (source.batch_child_ids !== undefined && (!Array.isArray(source.batch_child_ids) || source.batch_child_ids.some((childID) => typeof childID !== "string"))) return null;
    if (source.generation_reference_urls !== undefined && (!Array.isArray(source.generation_reference_urls) || source.generation_reference_urls.some((url) => typeof url !== "string"))) return null;
    if (source.generation_video_reference_urls !== undefined && (!Array.isArray(source.generation_video_reference_urls) || source.generation_video_reference_urls.some((url) => typeof url !== "string"))) return null;
    if (source.generation_video_reference_mode !== undefined && source.generation_video_reference_mode !== "first-frame" && source.generation_video_reference_mode !== "reference") return null;
    if (source.generation_video_reference_image_urls !== undefined && (!Array.isArray(source.generation_video_reference_image_urls) || source.generation_video_reference_image_urls.some((url) => typeof url !== "string"))) return null;
    if (source.generation_video_reference_audio_urls !== undefined && (!Array.isArray(source.generation_video_reference_audio_urls) || source.generation_video_reference_audio_urls.some((url) => typeof url !== "string"))) return null;
    if (source.generation_video_first_frame_node_id !== undefined && typeof source.generation_video_first_frame_node_id !== "string") return null;
    if (source.generation_video_last_frame_node_id !== undefined && typeof source.generation_video_last_frame_node_id !== "string") return null;
	    ids.add(id);
    nodes.push({ ...source, id, type, x: source.x, y: source.y, width: source.width, height: source.height, scale_x: source.scale_x, scale_y: source.scale_y } as CanvasNode);
  }
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  if (nodes.some((node) => node.group_id && nodeByID.get(node.group_id)?.type !== "group")) return null;

  if (candidate.connections !== undefined && !Array.isArray(candidate.connections)) return null;
  const connections = (candidate.connections || []) as unknown[];
  if (connections.length > 2000) return null;
  const connectionIDs = new Set<string>();
  const connectionPairs = new Set<string>();
  const normalizedConnections: CanvasConnection[] = [];
  for (const raw of connections) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Partial<CanvasConnection>;
    if (Object.keys(source).some((key) => !CANVAS_CLIPBOARD_CONNECTION_FIELDS.has(key as keyof CanvasConnection))) return null;
    const id = String(source.id || "").trim();
    const fromNodeID = String(source.from_node_id || "").trim();
    const toNodeID = String(source.to_node_id || "").trim();
    const pair = `${fromNodeID}\u0000${toNodeID}`;
    if (!id || id.length > 128 || connectionIDs.has(id) || !ids.has(fromNodeID) || !ids.has(toNodeID) || fromNodeID === toNodeID || connectionPairs.has(pair)) return null;
    connectionIDs.add(id);
    connectionPairs.add(pair);
    normalizedConnections.push({ ...source, id, from_node_id: fromNodeID, to_node_id: toNodeID } as CanvasConnection);
  }

  return { nodes, connections: normalizedConnections };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
