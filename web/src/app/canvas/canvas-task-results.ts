import type { CreationTask } from "@/lib/api";
import type { CanvasNode } from "@/services/api/canvas";
import { canvasGenerationNeedsRecovery } from "./canvas-generation-context.ts";
import { taskDataIsPreview } from "../../lib/image-task-state.ts";

export type CanvasTaskImage = {
  url: string;
  storageKey?: string;
  width?: number;
  height?: number;
  bytes?: number;
  mimeType?: string;
};

export type CanvasTaskAudio = {
  url: string;
  storageKey?: string;
  bytes?: number;
  mimeType?: string;
};

export type CanvasTaskImageSlot = {
  image?: CanvasTaskImage;
  status?: NonNullable<CreationTask["output_statuses"]>[number];
};

export type CanvasTaskInitialImage = {
  url: string;
  thumbnailURL: string;
};

function canvasTaskVideo(item: NonNullable<CreationTask["data"]>[number] | undefined): CanvasTaskImage | undefined {
  const url = String(item?.video_url || item?.url || "").trim();
  return url ? {
    url,
    ...((item?.storageKey || item?.storage_key) ? { storageKey: item.storageKey || item.storage_key } : {}),
    width: item?.width,
    height: item?.height,
    ...((item?.bytes || item?.size) ? { bytes: item.bytes || item.size } : {}),
    mimeType: item?.mime_type || "video/mp4",
  } : undefined;
}

function canvasTaskAudio(item: NonNullable<CreationTask["data"]>[number] | undefined): CanvasTaskAudio | undefined {
  const url = String(item?.audio_url || item?.url || "").trim();
  return url ? {
    url,
    ...((item?.storageKey || item?.storage_key) ? { storageKey: item.storageKey || item.storage_key } : {}),
    ...((item?.bytes || item?.size) ? { bytes: item.bytes || item.size } : {}),
    ...(item?.mime_type ? { mimeType: item.mime_type } : {}),
  } : undefined;
}

function canvasTaskText(item: NonNullable<CreationTask["data"]>[number] | undefined) {
  const content = String(item?.text_response || "").trim();
  return content || undefined;
}

function canvasTaskImage(item: NonNullable<CreationTask["data"]>[number] | undefined, includePreview = true): CanvasTaskImage | undefined {
  if (!includePreview && taskDataIsPreview(item)) return undefined;
  const url = String(item?.url || item?.video_url || "").trim();
  if (url) return {
    url,
    ...((item?.storageKey || item?.storage_key) ? { storageKey: item.storageKey || item.storage_key } : {}),
    width: item?.width,
    height: item?.height,
    ...((item?.bytes || item?.size) ? { bytes: item.bytes || item.size } : {}),
    ...(item?.mime_type ? { mimeType: item.mime_type } : {}),
  };
  const b64 = String(item?.b64_json || "").trim();
  return b64 ? { url: `data:image/png;base64,${b64}`, width: item?.width, height: item?.height } : undefined;
}

export function canvasTaskImageSlots(task: CreationTask, expectedCount = 0): CanvasTaskImageSlot[] {
  const count = Math.max(expectedCount, task.data?.length || 0, task.output_statuses?.length || 0);
  return Array.from({ length: count }, (_, index) => ({
    image: canvasTaskImage(task.data?.[index]),
    status: task.output_statuses?.[index],
  }));
}

export function canvasTaskImages(task: CreationTask) {
  return canvasTaskImageSlots(task).flatMap((slot) => slot.image ? [slot.image] : []);
}

function finalCanvasTaskImageSlots(task: CreationTask, expectedCount = 0): CanvasTaskImageSlot[] {
  const count = Math.max(expectedCount, task.data?.length || 0, task.output_statuses?.length || 0);
  return Array.from({ length: count }, (_, index) => {
    const status = task.output_statuses?.[index];
    return {
      image: status === "success" ? canvasTaskImage(task.data?.[index], false) : undefined,
      status,
    };
  });
}

export function successfulCanvasTaskImagesByNodeID(task: CreationTask, outputNodeIDs: readonly string[]) {
  const slots = finalCanvasTaskImageSlots(task, outputNodeIDs.length);
  return new Map(slots.flatMap((slot, index) => (
    slot.image && outputNodeIDs[index]
      ? [[outputNodeIDs[index], slot.image] as const]
      : []
  )));
}

export function applyCanvasTaskProgressNodes(
  nodes: readonly CanvasNode[],
  task: CreationTask,
  options: {
    outputNodeIDs: readonly string[];
    batchRootID?: string;
    taskID: string;
  },
) {
  const previewSlots = canvasTaskImageSlots(task, options.outputNodeIDs.length);
  const previewImageByNodeID = new Map(previewSlots.flatMap((slot, index) => (
    slot.image && options.outputNodeIDs[index]
      ? [[options.outputNodeIDs[index], slot.image] as const]
      : []
  )));
  const completedImageByNodeID = successfulCanvasTaskImagesByNodeID(task, options.outputNodeIDs);
  const batchRoot = options.batchRootID ? nodes.find((node) => node.id === options.batchRootID) : null;
  const completedPrimaryID = batchRoot?.batch_primary_id && completedImageByNodeID.has(batchRoot.batch_primary_id)
    ? batchRoot.batch_primary_id
    : options.outputNodeIDs.find((nodeID) => completedImageByNodeID.has(nodeID));
  const firstPreview = options.outputNodeIDs.map((nodeID) => previewImageByNodeID.get(nodeID)).find(Boolean);
  const progress = options.outputNodeIDs.length
    ? Math.round((completedImageByNodeID.size / options.outputNodeIDs.length) * 100)
    : 0;

  const nextNodes = nodes.map((node): CanvasNode => {
    if (node.id === options.batchRootID) {
      const primaryImage = completedPrimaryID ? completedImageByNodeID.get(completedPrimaryID) : undefined;
      if (primaryImage) return {
        ...applyCanvasTaskImage(node, primaryImage, options.taskID),
        batch_primary_id: node.batch_child_ids?.includes(completedPrimaryID || "") ? completedPrimaryID : undefined,
      };
      if (node.generation_status !== "success" && firstPreview) return { ...node, url: firstPreview.url, thumbnail_url: "", generation_progress: progress };
      return node.generation_status === "loading" ? { ...node, generation_progress: progress } : node;
    }
    const completedImage = completedImageByNodeID.get(node.id);
    if (completedImage) return applyCanvasTaskImage(node, completedImage, options.taskID);
    const previewImage = previewImageByNodeID.get(node.id);
    if (previewImage && node.generation_status !== "success") return { ...node, url: previewImage.url, thumbnail_url: "", generation_progress: progress };
    return options.outputNodeIDs.includes(node.id) && node.generation_status === "loading" ? { ...node, generation_progress: progress } : node;
  });

  return { nodes: nextNodes, completedImageByNodeID };
}

export function applyCanvasTaskImage(node: CanvasNode, image: CanvasTaskImage, taskID: string): CanvasNode {
  const dimensions = node.type === "panorama"
    ? { width: 340, height: 170 }
    : image.width && image.height
    ? fitCanvasTaskImageSize(image.width, image.height, node.width, node.height)
    : { width: node.width, height: node.height };
  return {
    ...node,
    x: node.x + (node.width - dimensions.width) / 2,
    y: node.y + (node.height - dimensions.height) / 2,
    width: dimensions.width,
    height: dimensions.height,
    natural_width: image.width,
    natural_height: image.height,
    bytes: image.bytes,
    mime_type: image.mimeType || node.mime_type || (node.type === "video" ? "video/mp4" : "image/png"),
    free_resize: false,
    url: image.url,
    storage_key: image.storageKey,
    thumbnail_url: "",
    task_id: taskID,
    duration_ms: canvasTaskDurationMS(node),
    generation_status: "success",
    generation_progress: 100,
    generation_error: "",
    ...(node.type === "panorama" ? { panorama_projection: "equirectangular" as const } : {}),
  };
}

function applyCanvasTaskAudio(node: CanvasNode, audio: CanvasTaskAudio, taskID: string): CanvasNode {
  return {
    ...node,
    url: audio.url,
    storage_key: audio.storageKey,
    bytes: audio.bytes,
    mime_type: audio.mimeType || node.mime_type || "audio/mpeg",
    task_id: taskID,
    audio_task_id: taskID,
    audio_task_result_id: taskID,
    duration_ms: canvasTaskDurationMS(node),
    generation_status: "success",
    generation_progress: 100,
    generation_error: "",
  };
}

export function restoreCanvasTaskInitialImage(
  node: CanvasNode,
  initialImageByNodeID: ReadonlyMap<string, CanvasTaskInitialImage>,
) {
  const initialImage = initialImageByNodeID.get(node.id);
  return {
    ...node,
    url: initialImage?.url || "",
    thumbnail_url: initialImage?.thumbnailURL || "",
  };
}

export function reconcileCancelledCanvasTaskNodes(
  nodes: readonly CanvasNode[],
  task: CreationTask | null,
  options: {
    resultNodeIDs: readonly string[];
    outputNodeIDs: readonly string[];
    batchRootID?: string;
    taskID: string;
    initialImageByNodeID: ReadonlyMap<string, CanvasTaskInitialImage>;
  },
) {
  const resultNodeIDs = new Set(options.resultNodeIDs);
  const completedImageByNodeID = task ? successfulCanvasTaskImagesByNodeID(task, options.outputNodeIDs) : new Map<string, CanvasTaskImage>();
  const completedPrimaryID = options.outputNodeIDs.find((nodeID) => completedImageByNodeID.has(nodeID));
  const nextNodes = nodes.map((node): CanvasNode => {
    if (!resultNodeIDs.has(node.id)) return node;
    if (node.id === options.batchRootID && completedPrimaryID) {
      const primaryImage = completedImageByNodeID.get(completedPrimaryID);
      if (primaryImage) return {
        ...applyCanvasTaskImage(node, primaryImage, options.taskID),
        batch_primary_id: node.batch_child_ids?.includes(completedPrimaryID) ? completedPrimaryID : undefined,
      };
    }
    const completedImage = completedImageByNodeID.get(node.id);
    if (completedImage) return applyCanvasTaskImage(node, completedImage, options.taskID);
    return {
      ...restoreCanvasTaskInitialImage(node, options.initialImageByNodeID),
      task_id: options.taskID,
      generation_status: "idle",
      generation_error: "",
    };
  });
  return { nodes: nextNodes, completedImageByNodeID };
}

export function reconcilePersistedCanvasTaskNodes(nodes: readonly CanvasNode[], task: CreationTask) {
  const taskNodeIDs = new Set(nodes.flatMap((node) => (
    (node.task_id === task.id || node.audio_task_id === task.id)
      && canvasGenerationNeedsRecovery(node)
      ? [node.id]
      : []
  )));
  if (!taskNodeIDs.size) {
    return { nodes: [...nodes], changed: false, terminal: isTerminalCanvasTask(task), completedImageCount: 0 };
  }

  const batchRoot = nodes.find((node) => (
    taskNodeIDs.has(node.id)
    && (node.type === "image" || node.type === "panorama")
    && node.batch_child_ids?.some((childID) => taskNodeIDs.has(childID))
  ));
  const outputNodeIDs = batchRoot
    ? (batchRoot.batch_child_ids || []).filter((nodeID) => taskNodeIDs.has(nodeID))
    : nodes.flatMap((node) => taskNodeIDs.has(node.id) && (node.type === "image" || node.type === "panorama" || node.type === "video") ? [node.id] : []);
  const videoNodeIDs = nodes.flatMap((node) => taskNodeIDs.has(node.id) && node.type === "video" ? [node.id] : []);
  const videoByNodeID = new Map(videoNodeIDs.flatMap((nodeID, index) => {
    const video = canvasTaskVideo(task.data?.[index]);
    return video ? [[nodeID, video] as const] : [];
  }));
  const audioNodeIDs = nodes.flatMap((node) => taskNodeIDs.has(node.id) && node.type === "audio" ? [node.id] : []);
  const audioByNodeID = new Map(audioNodeIDs.flatMap((nodeID, index) => {
    const audio = canvasTaskAudio(task.data?.[index]);
    return audio ? [[nodeID, audio] as const] : [];
  }));
  const textNodeIDs = nodes.flatMap((node) => taskNodeIDs.has(node.id) && node.type === "text" ? [node.id] : []);
  const textByNodeID = new Map(textNodeIDs.flatMap((nodeID, index) => {
    const content = canvasTaskText(task.data?.[index]);
    return content ? [[nodeID, content] as const] : [];
  }));
  const progress = applyCanvasTaskProgressNodes(nodes, task, {
    outputNodeIDs,
    batchRootID: batchRoot?.id,
    taskID: task.id,
  });
  const terminal = isTerminalCanvasTask(task);
  if (!terminal) {
    const progressNodes = progress.nodes.map((node): CanvasNode => {
      const content = textByNodeID.get(node.id);
      return content ? { ...node, prompt: content } : node;
    });
    return {
      nodes: progressNodes,
      changed: progressNodes.some((node, index) => node !== nodes[index]),
      terminal: false,
      completedImageCount: progress.completedImageByNodeID.size + videoByNodeID.size + audioByNodeID.size + textByNodeID.size,
    };
  }

  const completedImageByNodeID = successfulCanvasTaskImagesByNodeID(task, outputNodeIDs);
  const completedOutputCount = completedImageByNodeID.size + videoByNodeID.size + audioByNodeID.size + textByNodeID.size;
  const completedPrimaryID = batchRoot?.batch_primary_id && completedImageByNodeID.has(batchRoot.batch_primary_id)
    ? batchRoot.batch_primary_id
    : outputNodeIDs.find((nodeID) => completedImageByNodeID.has(nodeID));
  const cancelled = task.status === "cancelled";
  const terminalError = String(task.error || "").trim() || "生成失败";
  const nextNodes = progress.nodes.map((node): CanvasNode => {
    if (!taskNodeIDs.has(node.id)) return node;
    if (node.type === "video") {
      const video = videoByNodeID.get(node.id);
      return video
        ? applyCanvasTaskImage(node, video, task.id)
        : { ...node, duration_ms: canvasTaskDurationMS(node), generation_status: cancelled ? "idle" : "error", generation_error: cancelled ? "" : terminalError };
    }
    if (node.type === "audio") {
      const audio = audioByNodeID.get(node.id);
      return audio
        ? applyCanvasTaskAudio(node, audio, task.id)
        : {
          ...node,
          task_id: task.id,
          audio_task_id: task.id,
          duration_ms: canvasTaskDurationMS(node),
          generation_status: cancelled ? "idle" : "error",
          generation_error: cancelled ? "" : terminalError,
        };
    }
    if (node.type === "text") {
      const content = textByNodeID.get(node.id);
      return content
        ? { ...node, prompt: content, task_id: task.id, duration_ms: canvasTaskDurationMS(node), generation_status: "success", generation_error: "" }
        : { ...node, task_id: task.id, duration_ms: canvasTaskDurationMS(node), generation_status: cancelled ? "idle" : "error", generation_error: cancelled ? "" : terminalError };
    }
    if (node.type === "config") {
      return {
        ...node,
        duration_ms: canvasTaskDurationMS(node),
        generation_status: completedOutputCount ? "success" : cancelled ? "idle" : "error",
        generation_error: completedOutputCount || cancelled ? "" : terminalError,
      };
    }
    if (node.id === batchRoot?.id) {
      const primaryImage = completedPrimaryID ? completedImageByNodeID.get(completedPrimaryID) : undefined;
      if (primaryImage) {
        return {
          ...applyCanvasTaskImage(node, primaryImage, task.id),
          batch_primary_id: node.batch_child_ids?.includes(completedPrimaryID || "") ? completedPrimaryID : undefined,
        };
      }
      return {
        ...node,
        duration_ms: canvasTaskDurationMS(node),
        generation_status: cancelled ? "idle" : "error",
        generation_error: cancelled ? "" : terminalError,
        batch_primary_id: undefined,
      };
    }
    const completedImage = completedImageByNodeID.get(node.id);
    if (completedImage) return applyCanvasTaskImage(node, completedImage, task.id);
    return {
      ...node,
      duration_ms: canvasTaskDurationMS(node),
      generation_status: cancelled ? "idle" : "error",
      generation_error: cancelled ? "" : terminalError,
    };
  });
  return {
    nodes: nextNodes,
    changed: true,
    terminal: true,
    completedImageCount: completedOutputCount,
  };
}

function canvasTaskDurationMS(node: CanvasNode) {
  const startedAt = Number(node.generation_started_at);
  return Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, Date.now() - startedAt) : node.duration_ms;
}

function isTerminalCanvasTask(task: CreationTask) {
  return task.status === "success" || task.status === "error" || task.status === "cancelled";
}

function fitCanvasTaskImageSize(width: number, height: number, maxWidth: number, maxHeight: number) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  return { width: safeWidth * scale, height: safeHeight * scale };
}

export function summarizeCanvasTaskResult(task: CreationTask, expectedCount: number) {
  const slots = finalCanvasTaskImageSlots(task, expectedCount);
  const images = slots.flatMap((slot) => slot.image ? [slot.image] : []);
  return {
    slots,
    images,
    cancelled: task.status === "cancelled",
    missingCount: Math.max(0, expectedCount - images.length),
    error: String(task.error || "").trim(),
  };
}
