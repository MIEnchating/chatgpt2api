import { getImageSizeSelectionFromSize } from "@/app/image/image-options";
import type {
  WorkflowExternalTaskFailure,
  WorkflowExternalTaskStart,
  WorkflowExternalTaskSuccess,
} from "@/app/workflows/workflow-task-runtime";
import { getManagedImagePathFromUrl } from "@/lib/image-path";
import { isImageOutputFormat, isImageQuality } from "@/lib/api";
import type { ImageConversation, StoredImage } from "@/store/image-conversations";

function workflowConversationId(taskId: string) {
  return `workflow-${taskId}`;
}

function workflowTurnId(taskId: string) {
  return `workflow-turn-${taskId}`;
}

export function createWorkflowImageConversation(task: WorkflowExternalTaskStart): ImageConversation {
  const createdAt = new Date(task.startedAt).toISOString();
  const size = task.config.size || "auto";
  return {
    id: workflowConversationId(task.taskId),
    title: task.workflowName,
    createdAt,
    updatedAt: createdAt,
    turns: [{
      id: workflowTurnId(task.taskId),
      source: "workflow",
      workflowId: task.workflowId,
      workflowName: task.workflowName,
      workflowInputs: { ...task.inputs },
      workflowTaskId: task.taskId,
      prompt: task.prompt,
      model: task.model,
      mode: task.references.length ? "image" : "generate",
      referenceImages: task.references.map((reference) => ({
        name: reference.name,
        type: "image/*",
        dataUrl: reference.url,
      })),
      count: task.count,
      size,
      sizeSelection: getImageSizeSelectionFromSize(size),
      quality: isImageQuality(task.config.quality) ? task.config.quality : undefined,
      apiMode: task.apiMode,
      imageSystemPrompt: task.config.system_prompt || undefined,
      stream: task.execution.stream,
      partialImages: task.execution.partial_images,
      responseFormatB64JSON: task.execution.response_format_b64_json,
      codexCLICompatibility: task.execution.codex_cli_compatibility,
      tokenName: task.execution.token_name,
      visibility: "private",
      images: Array.from({ length: task.count }, (_, index) => ({
        id: `${workflowTurnId(task.taskId)}-${index}`,
        taskId: task.count === 1 ? task.taskId : `${task.taskId}-${index + 1}`,
        taskStatus: "queued" as const,
        status: "loading" as const,
        mediaType: "image" as const,
        visibility: "private" as const,
      })),
      processingStartedAt: createdAt,
      createdAt,
      status: "generating",
    }],
  };
}

export function workflowImageConversationSuccess(
  conversation: ImageConversation,
  task: WorkflowExternalTaskSuccess,
): ImageConversation {
  if (workflowTaskIsTerminal(conversation, task.taskId)) return conversation;
  return {
    ...conversation,
    updatedAt: new Date(task.endedAt).toISOString(),
    turns: conversation.turns.map((turn) => {
      if (turn.workflowTaskId !== task.taskId) return turn;
      const images = task.images.map((image): StoredImage => {
        const format = image.mimeType.split("/")[1]?.replace("jpg", "jpeg");
        return {
          ...(turn.images[image.index] || { id: `${turn.id}-${image.index}` }),
          taskStatus: "success",
          status: "success",
          mediaType: "image",
          url: image.imageUrl,
          path: getManagedImagePathFromUrl(image.imageUrl) || undefined,
          mimeType: image.mimeType || undefined,
          width: image.width || undefined,
          height: image.height || undefined,
          outputFormat: isImageOutputFormat(format) ? format : undefined,
          generationDurationMs: image.durationMs || task.durationMs,
          visibility: "private",
          error: undefined,
        };
      });
      return { ...turn, images, status: "success", error: undefined };
    }),
  };
}

export function workflowImageConversationFailure(
  conversation: ImageConversation,
  task: WorkflowExternalTaskFailure,
): ImageConversation {
  if (workflowTaskIsTerminal(conversation, task.taskId)) return conversation;
  return {
    ...conversation,
    updatedAt: new Date(task.endedAt).toISOString(),
    turns: conversation.turns.map((turn) =>
      turn.workflowTaskId === task.taskId
        ? {
            ...turn,
            status: "error" as const,
            error: task.error,
            images: turn.images.map((image, index) => {
              const completed = task.images.find((item) => item.index === index);
              if (completed) {
                const format = completed.mimeType.split("/")[1]?.replace("jpg", "jpeg");
                return {
                  ...image,
                  taskStatus: "success" as const,
                  status: "success" as const,
                  mediaType: "image" as const,
                  url: completed.imageUrl,
                  path: getManagedImagePathFromUrl(completed.imageUrl) || undefined,
                  mimeType: completed.mimeType || undefined,
                  width: completed.width || undefined,
                  height: completed.height || undefined,
                  outputFormat: isImageOutputFormat(format) ? format : undefined,
                  generationDurationMs: completed.durationMs || task.durationMs,
                  visibility: "private" as const,
                  error: undefined,
                };
              }
              return image.status === "loading"
                ? {
                    ...image,
                    taskStatus: "error" as const,
                    status: "error" as const,
                    generationDurationMs: task.durationMs,
                    error: task.error,
                  }
                : image;
            }),
          }
        : turn,
    ),
  };
}

export function workflowTaskIsTerminal(conversation: ImageConversation, taskId: string) {
  const turn = conversation.turns.find((item) => item.workflowTaskId === taskId);
  return turn?.status === "success" || turn?.status === "error" || turn?.status === "cancelled";
}
