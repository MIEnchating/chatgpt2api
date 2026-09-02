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

type RestorableWorkflowTask = CreationTask & {
  workflow_context: WorkflowTaskContext;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExecutionSnapshot(value: unknown): value is WorkflowExecutionSnapshot {
  if (!isObject(value)) return false;
  return typeof value.stream === "boolean"
    && typeof value.partial_images === "number"
    && Number.isFinite(value.partial_images)
    && Number.isInteger(value.partial_images)
    && value.partial_images >= 0
    && typeof value.response_format_b64_json === "boolean"
    && typeof value.codex_cli_compatibility === "boolean"
    && (value.token_name === undefined || typeof value.token_name === "string");
}

function isGenerationConfig(value: unknown): value is WorkflowGenerationConfig {
  if (!isObject(value)) return false;
  const stringFields = [
    "model",
    "image_model",
    "quality",
    "size",
    "count",
    "timeout",
    "system_prompt",
    "prompt_template",
    "negative_prompt",
  ];
  return stringFields.every((field) => typeof value[field] === "string")
    && (value.api_mode === "images" || value.api_mode === "responses" || value.api_mode === "chat");
}

function isRestorableWorkflowTask(task: CreationTask): task is RestorableWorkflowTask {
  const context = task.workflow_context;
  return isObject(context)
    && typeof context.workflow_id === "string"
    && Boolean(context.workflow_id)
    && typeof context.workflow_name === "string"
    && Boolean(context.workflow_name)
    && typeof context.prompt === "string"
    && isObject(context.inputs)
    && Array.isArray(context.references)
    && isGenerationConfig(context.config)
    && isExecutionSnapshot(context.execution)
    && typeof context.count === "number"
    && Number.isFinite(context.count)
    && context.count > 0;
}

export function prependWorkflowTask(
  tasks: readonly WorkflowTask[],
  task: WorkflowTask,
): WorkflowTask[] {
  return tasks.some((item) => item.id === task.id) ? [...tasks] : [task, ...tasks];
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
  const groups = new Map<string, RestorableWorkflowTask[]>();
  for (const task of tasks) {
    if (!isRestorableWorkflowTask(task)) continue;
    const context = task.workflow_context;
    const groupID = context.batch_task_id || task.id;
    groups.set(groupID, [...(groups.get(groupID) || []), task]);
  }

  return Array.from(groups.entries())
    .map(([groupID, group]) => {
      const ordered = [...group].sort(
        (left, right) =>
          (left.workflow_context.batch_index || 1) -
          (right.workflow_context.batch_index || 1),
      );
      const first = ordered[0];
      const context = first.workflow_context;
      const statuses = ordered.map(creationTaskStatus);
      const expectedCount = Math.max(
        ordered.length,
        ...ordered.map((task) => Number(task.workflow_context.batch_count) || 0),
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
        const context = task.workflow_context;
        const index = Math.max(0, Number(context.batch_index || fallbackIndex + 1) - 1);
        return creationTaskImages(task).map((image) => ({
          ...image,
          index,
          ...(context.series_title ? { title: context.series_title } : {}),
          ...(context.prompt ? { prompt: context.prompt } : {}),
        }));
      });
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
        api_mode: context.config.api_mode,
        config: context.config,
        execution: context.execution,
        count: expectedCount,
        backend_task_ids: ordered.map((task) => task.id),
        completed_units: ordered.flatMap((task, fallbackIndex) => {
          if (creationTaskStatus(task) === "running") return [];
          return [Math.max(1, Number(task.workflow_context.batch_index || fallbackIndex + 1))];
        }),
        unit_errors: Object.fromEntries(ordered.flatMap((task, fallbackIndex) => {
          if (creationTaskStatus(task) !== "failed") return [];
          const index = Math.max(1, Number(task.workflow_context.batch_index || fallbackIndex + 1));
          return [[String(index), task.error?.trim() || "任务执行失败"]];
        })),
      } satisfies WorkflowTask;
    })
    .sort((left, right) => right.started_at - left.started_at);
}
