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
  recovery_error?: string;
  recovery_deadline?: number;
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
    && Number.isSafeInteger(value.partial_images)
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

function isWorkflowReference(value: unknown) {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.url === "string"
    && (value.role === "template" || value.role === "product");
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
    && context.references.every(isWorkflowReference)
    && isGenerationConfig(context.config)
    && isExecutionSnapshot(context.execution)
    && typeof context.count === "number"
    && Number.isSafeInteger(context.count)
    && context.count > 0;
}

function workflowBatchIndex(context: WorkflowTaskContext) {
  const value = context.batch_index;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function compareTaskIDs(left: { id: string }, right: { id: string }) {
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function prependWorkflowTask(
  tasks: readonly WorkflowTask[],
  task: WorkflowTask,
): WorkflowTask[] {
  return tasks.some((item) => item.id === task.id) ? [...tasks] : [task, ...tasks];
}

export type WorkflowTaskUnitResult = {
  unit: number;
  images: WorkflowTaskImage[];
  error?: string;
};

function mergeWorkflowTaskImages(current: WorkflowTaskImage[], incoming: WorkflowTaskImage[]) {
  const indexes = new Set(incoming.map((image) => image.index));
  return [...current.filter((image) => !indexes.has(image.index)), ...incoming]
    .sort((left, right) => (left.index || 0) - (right.index || 0));
}

export function settleWorkflowTaskUnits(task: WorkflowTask, results: WorkflowTaskUnitResult[], now = Date.now()): WorkflowTask {
  const completed = new Set(task.completed_units);
  const unitErrors = { ...task.unit_errors };
  const updatedImages = results.flatMap((result) => {
    completed.add(result.unit);
    if (result.error) unitErrors[result.unit] = result.error;
    else delete unitErrors[result.unit];
    return result.images;
  });
  const images = mergeWorkflowTaskImages(task.images, updatedImages);
  const finished = completed.size >= task.count;
  const error = [...new Set(Object.values(unitErrors).filter(Boolean))].join("\n") || undefined;
  return {
    ...task,
    completed_units: [...completed].sort((left, right) => left - right),
    unit_errors: unitErrors,
    images,
    image_urls: images.map((image) => image.url),
    status: finished ? (error ? "failed" : "success") : "running",
    ended_at: finished ? now : undefined,
    error,
  };
}

export function mergeWorkflowTaskProgress(current: WorkflowTask, update: WorkflowTask, submitting: boolean): WorkflowTask {
  const completedUnits = [...new Set([...(current.completed_units || []), ...(update.completed_units || [])])]
    .sort((left, right) => left - right);
  const unitErrors = { ...current.unit_errors, ...update.unit_errors };
  const images = mergeWorkflowTaskImages(current.images, update.images);
  const count = Math.max(current.count, update.count);
  const incomplete = completedUnits.length < count;
  const recoveryError = incomplete && !submitting ? update.recovery_error : undefined;
  const errors = [...new Set(Object.values(unitErrors))];
  if (recoveryError) errors.push(recoveryError);
  return {
    ...current,
    ...update,
    count,
    images,
    image_urls: images.map((image) => image.url),
    backend_task_ids: [...new Set([...current.backend_task_ids, ...update.backend_task_ids])],
    completed_units: completedUnits,
    unit_errors: unitErrors,
    status: incomplete && !recoveryError ? "running" : errors.length ? "failed" : "success",
    ended_at: incomplete && !recoveryError ? undefined : update.ended_at ?? current.ended_at,
    error: errors.join("\n") || undefined,
    recovery_error: recoveryError,
  };
}

export function creationTaskImages(task: CreationTask): WorkflowTaskImage[] {
  return (task.data || []).flatMap((item) => {
    const url = String(item.url || "").trim() || String(item.video_url || "").trim();
    const encoded = String(item.b64_json || "").trim();
    const format = String(item.output_format || task.output_format || "png")
      .toLowerCase()
      .replace("jpg", "jpeg");
    const resolvedURL = url || (encoded ? `data:${format === "svg" ? "image/svg+xml" : `image/${format}`};base64,${encoded}` : "");
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

export function restoreWorkflowTasks(tasks: CreationTask[], now = Date.now()): WorkflowTask[] {
  const groups = new Map<string, RestorableWorkflowTask[]>();
  for (const task of tasks) {
    if (!isRestorableWorkflowTask(task)) continue;
    const batchID = task.workflow_context.batch_task_id;
    const groupID = (typeof batchID === "string" && batchID.trim()) || task.id;
    const group = groups.get(groupID);
    if (group) group.push(task);
    else groups.set(groupID, [task]);
  }

  return Array.from(groups.entries())
    .map(([groupID, group]) => {
      const ordered = group.sort((left, right) =>
        workflowBatchIndex(left.workflow_context) - workflowBatchIndex(right.workflow_context)
        || compareTaskIDs(left, right),
      );
      const first = ordered[0];
      const context = first.workflow_context;
      const expectedCount = ordered.reduce((count, task) => {
        const storedCount = task.workflow_context.batch_count;
        return typeof storedCount === "number" && Number.isSafeInteger(storedCount) ? Math.max(count, storedCount) : count;
      }, ordered.length);
      const presentUnits = new Set(ordered.flatMap(({ workflow_context: child }) => {
        const unit = child.batch_index;
        return typeof unit === "number" && Number.isSafeInteger(unit) && unit > 0 && unit <= expectedCount ? [unit] : [];
      }));
      const completedUnits = new Set<number>();
      const unitErrors: Record<string, string> = {};
      const images: WorkflowTaskImage[] = [];
      let running = false;
      let nextUnit = 1;
      ordered.forEach((task, fallbackIndex) => {
        const child = task.workflow_context;
        let unit = child.batch_index ?? 0;
        if (unit === 0) {
          while (presentUnits.has(nextUnit)) nextUnit++;
          unit = nextUnit++;
          presentUnits.add(unit);
        }
        const validUnit = Number.isSafeInteger(unit) && unit > 0 && unit <= expectedCount;
        const index = Math.max(0, Number(child.series_index || (validUnit ? unit : fallbackIndex + 1)) - 1);
        const childImages = creationTaskImages(task);
        for (const image of childImages) {
          images.push({
            ...image,
            index,
            ...(child.series_title ? { title: child.series_title } : {}),
            ...(child.prompt ? { prompt: child.prompt } : {}),
          });
        }
        const status = creationTaskStatus(task);
        if (status === "running") {
          running = true;
          return;
        }
        if (validUnit) completedUnits.add(unit);
        const errorKey = validUnit ? unit : `child:${task.id}`;
        if (status === "failed") unitErrors[errorKey] = task.error?.trim() || "任务执行失败";
        else if (!childImages.length) unitErrors[errorKey] = "接口没有返回图片";
      });
      const latestActivity = Math.max(...ordered.map((task) => taskTimestamp(task.updated_at, now)));
      // Allow the full serial execution and submission budget before expiring absent children.
      const timeout = /^[+-]?\d+$/.test(context.config.timeout.trim()) ? Number(context.config.timeout) : 0;
      const timeoutSeconds = Number.isSafeInteger(timeout) && timeout !== 0 ? Math.max(1, timeout) : 600;
      const recoveryBudget = expectedCount * (timeoutSeconds + 60) * 1000;
      const missingCount = Math.max(0, expectedCount - presentUnits.size);
      const recoveryDeadline = missingCount > 0 && !running ? latestActivity + recoveryBudget : undefined;
      const missingExpired = recoveryDeadline !== undefined && now > recoveryDeadline;
      const errors = [...new Set(Object.values(unitErrors))];
      const status: WorkflowTask["status"] = running || (missingCount > 0 && !missingExpired)
        ? "running"
        : errors.length || missingExpired
          ? "failed"
          : "success";
      const startedAt = Math.min(
        ...ordered.map((task) => taskTimestamp(task.created_at, now)),
      );
      const endedAt = status === "running"
        ? undefined
        : Math.max(
            ...ordered.map((task) => taskTimestamp(task.updated_at, now)),
          );
      const recoveryError = missingExpired ? `批次恢复等待超时：缺少 ${missingCount} 个子任务，请重新运行未完成的生成。` : undefined;
      if (recoveryError) errors.push(recoveryError);
      return {
        id: groupID,
        workflow_id: context.workflow_id,
        workflow_name: context.workflow_name,
        prompt: context.prompt,
        status,
        started_at: startedAt,
        ended_at: endedAt,
        error: errors.join("\n") || undefined,
        recovery_error: recoveryError,
        recovery_deadline: missingExpired ? undefined : recoveryDeadline,
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
        completed_units: [...completedUnits].sort((left, right) => left - right),
        unit_errors: unitErrors,
      } satisfies WorkflowTask;
    })
    .sort((left, right) => right.started_at - left.started_at || compareTaskIDs(left, right));
}
