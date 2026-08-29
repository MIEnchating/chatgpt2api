import type { CreationTask } from "@/lib/api";
import type {
  WorkflowExecutionSnapshot,
  WorkflowGenerationConfig,
  WorkflowTaskContext,
} from "@/services/api/workflows";

type WorkflowReferenceSnapshot = WorkflowTaskContext["references"][number] & {
  temporary?: boolean;
};

export type WorkflowTaskImage = {
  url: string;
  index?: number;
  title?: string;
  prompt?: string;
  width?: number;
  height?: number;
  bytes?: number;
};

export type WorkflowTask = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  prompt: string;
  status: "running" | "success" | "failed";
  started_at: number;
  ended_at?: number;
  error?: string;
  image_urls: string[];
  images: WorkflowTaskImage[];
  series_title?: string;
  series_index?: number;
  inputs: Record<string, string>;
  references: WorkflowReferenceSnapshot[];
  model: string;
  api_mode: WorkflowGenerationConfig["api_mode"];
  config: WorkflowGenerationConfig;
  execution: WorkflowExecutionSnapshot;
  count: number;
  backend_task_ids: string[];
  completed_units?: number[];
  unit_errors?: Record<string, string>;
};

export type WorkflowRunResult = {
  id: string;
  index: number;
  workflowId: string;
  workflowName: string;
  prompt: string;
  imageUrl: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  durationMs: number;
  createdAt: number;
};

export type WorkflowExternalTaskStart = {
  taskId: string;
  workflowId: string;
  workflowName: string;
  prompt: string;
  inputs: Record<string, string>;
  references: WorkflowReferenceSnapshot[];
  model: string;
  apiMode: WorkflowGenerationConfig["api_mode"];
  config: WorkflowGenerationConfig;
  execution: WorkflowExecutionSnapshot;
  count: number;
  startedAt: number;
};

export type WorkflowExternalTaskSuccess = {
  taskId: string;
  images: WorkflowRunResult[];
  durationMs: number;
  endedAt: number;
};

export type WorkflowExternalTaskFailure = {
  taskId: string;
  error: string;
  images: WorkflowRunResult[];
  durationMs: number;
  endedAt: number;
};

function workflowTaskImageMimeType(url: string) {
  const dataMime = /^data:(image\/[a-z0-9.+-]+);/i.exec(url)?.[1];
  if (dataMime) return dataMime.toLowerCase();
  const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

export function workflowTaskStartEvent(task: WorkflowTask): WorkflowExternalTaskStart {
  return {
    taskId: task.id,
    workflowId: task.workflow_id,
    workflowName: task.workflow_name,
    prompt: task.prompt,
    inputs: { ...task.inputs },
    references: task.references.map((reference) => ({ ...reference })),
    model: task.model,
    apiMode: task.api_mode,
    config: { ...task.config },
    execution: { ...task.execution },
    count: task.count,
    startedAt: task.started_at,
  };
}

function workflowTaskResults(task: WorkflowTask, endedAt: number): WorkflowRunResult[] {
  const durationMs = Math.max(0, endedAt - task.started_at);
  return task.images.map((image, fallbackIndex) => {
    const index = image.index ?? fallbackIndex;
    return {
      id: `${task.id}-${index + 1}`,
      index,
      workflowId: task.workflow_id,
      workflowName: task.workflow_name,
      prompt: image.prompt || task.prompt,
      imageUrl: image.url,
      storageKey: "",
      width: image.width || 0,
      height: image.height || 0,
      bytes: image.bytes || 0,
      mimeType: workflowTaskImageMimeType(image.url),
      durationMs,
      createdAt: endedAt,
    };
  });
}

export function workflowTaskSuccessEvent(task: WorkflowTask): WorkflowExternalTaskSuccess {
  const endedAt = task.ended_at || task.started_at;
  return {
    taskId: task.id,
    images: workflowTaskResults(task, endedAt),
    durationMs: Math.max(0, endedAt - task.started_at),
    endedAt,
  };
}

export function workflowTaskFailureEvent(task: WorkflowTask): WorkflowExternalTaskFailure {
  const endedAt = task.ended_at || task.started_at;
  return {
    taskId: task.id,
    error: task.error || "工作流运行失败",
    images: workflowTaskResults(task, endedAt),
    durationMs: Math.max(0, endedAt - task.started_at),
    endedAt,
  };
}

export function creationTaskImages(task: CreationTask): WorkflowTaskImage[] {
  return (task.data || []).flatMap((item) => {
    const url = String(item.url || item.video_url || "").trim();
    const encoded = String(item.b64_json || "").trim();
    const format = String(item.output_format || task.output_format || "png")
      .toLowerCase()
      .replace("jpg", "jpeg");
    const resolvedURL = url || (encoded ? `data:image/${format};base64,${encoded}` : "");
    if (!resolvedURL) return [];
    const width = Number(item.width) || undefined;
    const height = Number(item.height) || undefined;
    const bytes = Number(item.bytes || item.size) || undefined;
    return [{ url: resolvedURL, width, height, bytes }];
  });
}

function creationTaskStatus(task: CreationTask): WorkflowTask["status"] {
  if (task.status === "success") return "success";
  if (task.status === "error" || task.status === "cancelled") return "failed";
  return "running";
}

function taskTimestamp(value: string, fallback: number) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

export function restoreWorkflowTasks(tasks: CreationTask[]): WorkflowTask[] {
  const groups = new Map<string, CreationTask[]>();
  for (const task of tasks) {
    const context = task.workflow_context as Partial<WorkflowTaskContext> | undefined;
    if (!context?.workflow_id || !context.workflow_name) continue;
    const groupID = context.batch_task_id || task.id;
    groups.set(groupID, [...(groups.get(groupID) || []), task]);
  }

  return Array.from(groups.entries())
    .map(([groupID, group]) => {
      const ordered = [...group].sort(
        (left, right) =>
          ((left.workflow_context as Partial<WorkflowTaskContext> | undefined)?.batch_index || 1) -
          ((right.workflow_context as Partial<WorkflowTaskContext> | undefined)?.batch_index || 1),
      );
      const first = ordered[0];
      const context = first.workflow_context as WorkflowTaskContext;
      const statuses = ordered.map(creationTaskStatus);
      const expectedCount = Math.max(
        ordered.length,
        ...ordered.map((task) => Number((task.workflow_context as Partial<WorkflowTaskContext> | undefined)?.batch_count) || 0),
      );
      const status: WorkflowTask["status"] = statuses.includes("running") || ordered.length < expectedCount
        ? "running"
        : statuses.includes("failed")
          ? "failed"
          : "success";
      const startedAt = Math.min(
        ...ordered.map((task) => taskTimestamp(task.created_at, Date.now())),
      );
      const endedAt = status === "running"
        ? undefined
        : Math.max(
            ...ordered.map((task) => taskTimestamp(task.updated_at, startedAt)),
          );
      const images = ordered.flatMap((task, fallbackIndex) => {
        const context = task.workflow_context as Partial<WorkflowTaskContext> | undefined;
        const index = Math.max(0, Number(context?.batch_index || fallbackIndex + 1) - 1);
        return creationTaskImages(task).map((image) => ({
          ...image,
          index,
          ...(context?.series_title ? { title: context.series_title } : {}),
          ...(context?.prompt ? { prompt: context.prompt } : {}),
        }));
      });
      const legacyConfig = context.config as WorkflowGenerationConfig & Record<string, unknown>;
      const execution: WorkflowExecutionSnapshot = context.execution || {
        stream: legacyConfig.stream_images === "1" || legacyConfig.stream_images === "true",
        partial_images: Number(legacyConfig.stream_partial_images) || 0,
        response_format_b64_json: legacyConfig.response_format_b64_json === "1" || legacyConfig.response_format_b64_json === "true",
        codex_cli_compatibility: legacyConfig.codex_cli === "1" || legacyConfig.codex_cli === "true",
        token_name: String(legacyConfig.image_channel_id || "") || undefined,
      };
      return {
        id: groupID,
        workflow_id: context.workflow_id,
        workflow_name: context.workflow_name,
        prompt: context.prompt,
        status,
        started_at: startedAt,
        ended_at: endedAt,
        error:
          ordered
            .filter((task) => creationTaskStatus(task) === "failed")
            .map((task) => task.error?.trim())
            .filter((value): value is string => Boolean(value))
            .join("\n") || undefined,
        image_urls: images.map((image) => image.url),
        images,
        series_title: context.series_title,
        series_index: context.series_index,
        inputs: context.inputs || {},
        references: context.references || [],
        model: String(first.model || context.config.image_model || context.config.model || ""),
        api_mode: context.config.api_mode || "images",
        config: context.config,
        execution,
        count: expectedCount || context.count || ordered.length,
        backend_task_ids: ordered.map((task) => task.id),
        completed_units: ordered.flatMap((task, fallbackIndex) => {
          if (creationTaskStatus(task) === "running") return [];
          const taskContext = task.workflow_context as Partial<WorkflowTaskContext> | undefined;
          return [Math.max(1, Number(taskContext?.batch_index || fallbackIndex + 1))];
        }),
        unit_errors: Object.fromEntries(ordered.flatMap((task, fallbackIndex) => {
          if (creationTaskStatus(task) !== "failed") return [];
          const taskContext = task.workflow_context as Partial<WorkflowTaskContext> | undefined;
          const index = Math.max(1, Number(taskContext?.batch_index || fallbackIndex + 1));
          return [[String(index), task.error?.trim() || "任务执行失败"]];
        })),
      } satisfies WorkflowTask;
    })
    .sort((left, right) => right.started_at - left.started_at);
}
