import type { CanvasNode, CreationTask } from "@/lib/api";
import { taskDataIsPreview } from "../image/image-task-state.ts";

export type CanvasTaskImage = {
  url: string;
  width?: number;
  height?: number;
};

export type CanvasTaskImageSlot = {
  image?: CanvasTaskImage;
  status?: NonNullable<CreationTask["output_statuses"]>[number];
};

export type CanvasTaskInitialImage = {
  url: string;
  thumbnailURL: string;
};

function canvasTaskImage(item: NonNullable<CreationTask["data"]>[number] | undefined, includePreview = true): CanvasTaskImage | undefined {
  if (!includePreview && taskDataIsPreview(item)) return undefined;
  const url = String(item?.url || "").trim();
  if (url) return { url, width: item?.width, height: item?.height };
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

  const nextNodes = nodes.map((node): CanvasNode => {
    if (node.id === options.batchRootID) {
      const primaryImage = completedPrimaryID ? completedImageByNodeID.get(completedPrimaryID) : undefined;
      if (primaryImage) return {
        ...applyCanvasTaskImage(node, primaryImage, options.taskID),
        batch_primary_id: node.batch_child_ids?.includes(completedPrimaryID || "") ? completedPrimaryID : undefined,
      };
      if (node.generation_status !== "success" && firstPreview) return { ...node, url: firstPreview.url, thumbnail_url: "" };
      return node;
    }
    const completedImage = completedImageByNodeID.get(node.id);
    if (completedImage) return applyCanvasTaskImage(node, completedImage, options.taskID);
    const previewImage = previewImageByNodeID.get(node.id);
    if (previewImage && node.generation_status !== "success") return { ...node, url: previewImage.url, thumbnail_url: "" };
    return node;
  });

  return { nodes: nextNodes, completedImageByNodeID };
}

export function applyCanvasTaskImage(node: CanvasNode, image: CanvasTaskImage, taskID: string): CanvasNode {
  const dimensions = image.width && image.height
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
    free_resize: false,
    url: image.url,
    thumbnail_url: "",
    task_id: taskID,
    generation_status: "success",
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
