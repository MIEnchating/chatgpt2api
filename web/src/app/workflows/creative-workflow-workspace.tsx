"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  ClipboardList,
  Copy,
  Download,
  Globe2,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  buildSeriesPromptDraftRequest,
  createBlankWorkflow,
  createDefaultInputValues,
  createStarterWorkflows,
  createWorkflowVariable,
  normalizeWorkflow,
  parseVariableOptions,
  parseWorkflowSeriesDrafts,
  workflowGenerationDefaultsFromPreferences,
  renderWorkflowPrompt,
  resolveWorkflowRuntime,
  type WorkflowGenerationDefaults,
  type WorkflowSeriesDraft,
} from "@/app/workflows/workflow-runtime";
import {
  buildImageSize,
  getImageSizeSelectionFromSize,
} from "@/lib/image-options";
import {
  creationTaskImages,
  restoreWorkflowTasks,
  type WorkflowTask,
} from "@/app/workflows/workflow-task-runtime";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox } from "@/components/ui/checkbox";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { ManagementPagination } from "@/components/management-page";
import { PromptTextareaFrame } from "@/components/generation/prompt-textarea-frame";
import {
  ImageSettingsPanel,
  type ImageSettingsValue,
} from "@/components/generation/image-settings-panel";
import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMyAssets } from "@/lib/use-my-assets";
import {
  createChatGenerationTask,
  createImageEditTask,
  createImageGenerationTask,
  deleteCreationTasks,
  deleteManagedImages,
  fetchCreationTasks,
  fetchModelConfig,
  isImageQuality,
  type CreationTask,
  type ImageGenerationPreferences,
  type ImageQuality,
  type ModelConfig,
} from "@/lib/api";
import { deleteStoredImages, imageToDataURL, uploadImage } from "@/services/image-storage";
import {
  deleteWorkflow,
  draftWorkflowWithAgent,
  fetchWorkflows,
  saveWorkflow,
  type CreativeWorkflow,
  type WorkflowGenerationConfig,
  type WorkflowSeriesConfig,
  type WorkflowVariable,
} from "@/services/api/workflows";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";
import type { MyAsset } from "@/lib/my-assets";
import { getManagedImagePathFromUrl } from "@/lib/image-path";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { useImageGenerationPreferences } from "@/lib/use-image-generation-preferences";
import { hasAPIPermission } from "@/store/auth";
import { cn } from "@/lib/utils";

type WorkflowReference = {
  id: string;
  name: string;
  url: string;
  storageKey?: string;
  temporary?: boolean;
};

type WorkflowSeriesRun = {
  id: string;
  total: number;
};

export type {
  WorkflowRunResult,
} from "@/app/workflows/workflow-task-runtime";

type CreativeWorkflowWorkspaceProps = {
  embedded?: boolean;
  hideTaskList?: boolean;
  generationDefaults?: WorkflowGenerationDefaults;
};

function workflowImageSettings(config: WorkflowGenerationConfig): ImageSettingsValue {
  return {
    ...getImageSizeSelectionFromSize(config.size || "auto"),
    quality: isImageQuality(config.quality) ? config.quality : "",
    count: Math.max(1, Math.min(10, Math.round(Number(config.count) || 1))),
    snapToMultiple16: true,
  };
}

function workflowGenerationDefaults(
  preferences: ImageGenerationPreferences | undefined,
  overrides: WorkflowGenerationDefaults | undefined,
  textChannelID: string,
) {
  return {
    ...workflowGenerationDefaultsFromPreferences(preferences),
    ...(textChannelID ? { text_channel_id: textChannelID } : {}),
    ...overrides,
  };
}

const workflowScopeOptions: Array<{
  value: "all" | CreativeWorkflow["scope"];
  label: string;
  icon?: typeof LockKeyhole;
}> = [
  { value: "all", label: "全部" },
  { value: "private", label: "个人", icon: LockKeyhole },
  { value: "public", label: "公开", icon: Globe2 },
];

function taskID(prefix: string) {
  return `${prefix}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
}

function workflowPollDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason || new DOMException("Workspace closed", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isWorkflowPollAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function waitForTask(id: string, timeoutSeconds: number, signal?: AbortSignal) {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const response = await fetchCreationTasks([id], { signal });
    const task = response.items?.[0];
    if (task?.status === "success") return task;
    if (task?.status === "error" || task?.status === "cancelled") {
      throw new Error(task.error || "任务执行失败");
    }
    await workflowPollDelay(1200, signal);
  }
  throw new Error("任务执行超时");
}

async function workflowImageFiles(references: WorkflowReference[], signal?: AbortSignal) {
  return Promise.all(
    references.map(async (reference, index) => {
      const response = await fetch(reference.url, { credentials: "include", signal });
      if (!response.ok) throw new Error(`无法读取参考图（${response.status}）`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("参考文件不是图片");
      const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      return new File([blob], `workflow-reference-${index + 1}.${extension}`, {
        type: blob.type,
      });
    }),
  );
}

async function workflowImageDataURLs(references: WorkflowReference[]) {
  return Promise.all(references.map((reference) => imageToDataURL(reference)));
}

async function downloadWorkflowImage(url: string, fileName: string) {
  let href = url;
  let objectURL = "";
  if (!url.startsWith("data:")) {
    try {
      const response = await fetch(url, { credentials: "include" });
      if (response.ok) {
        objectURL = URL.createObjectURL(await response.blob());
        href = objectURL;
      }
    } catch {
      href = url;
    }
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (objectURL) window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}

function taskText(task: CreationTask) {
  return (task.data || [])
    .map((item) => String(item.text_response || item.revised_prompt || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function CreativeWorkflowWorkspace({
  embedded = false,
  hideTaskList = false,
  generationDefaults,
}: CreativeWorkflowWorkspaceProps = {}) {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/workflows");
  const sessionKey = session?.key || "";
  const { preferences, isReady: preferencesReady } = useImageGenerationPreferences(sessionKey);
  const { isReady: relayPreferencesReady, tokenNameForModel } = useRelayTokenPreferences();
  const sessionTextChannelID = tokenNameForModel("text", preferences.default_text_model || "");
  const { assets: myAssets, loading: assetLoading } = useMyAssets(
    session?.key || "",
    Boolean(session),
  );
  const [items, setItems] = useState<CreativeWorkflow[]>([]);
  const [models, setModels] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [scopeFilter, setScopeFilter] = useState<"all" | CreativeWorkflow["scope"]>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [editing, setEditing] = useState<CreativeWorkflow | null>(null);
  const [running, setRunning] = useState<CreativeWorkflow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<WorkflowReference[]>([]);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [seriesDrafts, setSeriesDrafts] = useState<WorkflowSeriesDraft[]>([]);
  const [seriesDraftLoading, setSeriesDraftLoading] = useState(false);
  const [seriesBatchAppend, setSeriesBatchAppend] = useState("");
  const [tasks, setTasks] = useState<WorkflowTask[]>([]);
  const [directTaskPollIDs, setDirectTaskPollIDs] = useState<string[]>([]);
  const taskWaitAbortControllerRef = useRef<AbortController | null>(null);
  const [taskHistoryOpen, setTaskHistoryOpen] = useState(false);
  const [selectedTaskID, setSelectedTaskID] = useState("");
  const [clearingTaskHistory, setClearingTaskHistory] = useState(false);
  const [now, setNow] = useState(Date.now());
  const selectedTask = tasks.find((task) => task.id === selectedTaskID) || null;
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentScope, setAgentScope] = useState<"private" | "public">("private");
  const [agentModel, setAgentModel] = useState("");
  const [agentReferences, setAgentReferences] = useState<WorkflowReference[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDraft, setAgentDraft] = useState<CreativeWorkflow | null>(null);
  const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
  const [assetPickerTarget, setAssetPickerTarget] = useState<"workflow" | "agent" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    taskWaitAbortControllerRef.current = controller;
    return () => {
      controller.abort();
      if (taskWaitAbortControllerRef.current === controller) {
        taskWaitAbortControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionKey || !preferencesReady || !relayPreferencesReady) return;
    let ignore = false;
    void Promise.all([fetchWorkflows(), fetchModelConfig(), fetchCreationTasks([])])
      .then(async ([workflows, modelResponse, creationTasks]) => {
        if (ignore) return;
        const modelConfig = modelResponse.config;
        setModels(modelConfig);
        const restoredTasks = restoreWorkflowTasks(creationTasks.items);
        setTasks(restoredTasks);
        if (workflows.length) {
          const normalized = workflows.map((workflow) =>
            normalizeWorkflow(workflow, modelConfig, preferences),
          );
          const recovered = normalized.map((workflow) => {
            if (workflow.editable === false) return workflow;
            const latest = restoredTasks
              .filter((task) => task.workflow_id === workflow.id && task.status === "success")
              .reduce((value, task) => Math.max(value, task.ended_at || 0), 0);
            if (!latest || latest <= Date.parse(workflow.last_run_at || "")) return workflow;
            const timestamp = new Date(latest).toISOString();
            const updated = { ...workflow, last_run_at: timestamp, updated_at: timestamp };
            void saveWorkflow(updated).catch(() => undefined);
            return updated;
          });
          setItems(recovered);
          return;
        }
        const starters = createStarterWorkflows(modelConfig, preferences, workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID));
        const saved = await Promise.all(starters.map((workflow) => saveWorkflow(workflow)));
        if (!ignore) setItems(saved.map((workflow) => normalizeWorkflow(workflow, modelConfig, preferences)));
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "工作流加载失败"),
      )
      .finally(() => !ignore && setLoading(false));
    return () => {
      ignore = true;
    };
  }, [generationDefaults, preferences, preferencesReady, relayPreferencesReady, sessionKey, sessionTextChannelID]);

  useEffect(() => {
    if (!agentModel && models?.default_text_model) {
      setAgentModel(preferences.default_text_model || models.default_text_model);
    }
  }, [agentModel, models, preferences.default_text_model]);

  const directTaskPollIDSet = new Set(directTaskPollIDs);
  const runningWorkflowTaskIDs = Array.from(new Set(tasks
    .filter((task) => task.status === "running")
    .flatMap((task) => task.backend_task_ids)
    .filter((id) => !directTaskPollIDSet.has(id))))
    .join(",");
  const runningTaskCount = tasks.filter((task) => task.status === "running").length;

  useEffect(() => {
    if (!runningTaskCount) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningTaskCount]);

  useEffect(() => {
    if (!runningWorkflowTaskIDs) return;
    const controller = new AbortController();
    const poll = async () => {
      const ids = runningWorkflowTaskIDs.split(",");
      while (!controller.signal.aborted) {
        try {
          const response = await fetchCreationTasks(ids, { signal: controller.signal });
          const updates = new Map(
            restoreWorkflowTasks(response.items).map((task) => [task.id, task]),
          );
          setTasks((current) => current.map((task) => {
            const update = updates.get(task.id);
            if (!update) return task;
            const completedUnits = Array.from(new Set([
              ...(task.completed_units || []),
              ...(update.completed_units || []),
            ])).sort((left, right) => left - right);
            const unitErrors = { ...task.unit_errors, ...update.unit_errors };
            const count = Math.max(task.count, update.count);
            const incomplete = completedUnits.length < count;
            return {
              ...task,
              ...update,
              count,
              backend_task_ids: Array.from(new Set([...task.backend_task_ids, ...update.backend_task_ids])),
              completed_units: completedUnits,
              unit_errors: unitErrors,
              status: incomplete ? "running" : Object.keys(unitErrors).length ? "failed" : "success",
              ended_at: incomplete ? undefined : update.ended_at,
            };
          }));
        } catch {
          if (controller.signal.aborted) return;
          // Keep the durable task visible and retry on the next interval.
        }
        try {
          await workflowPollDelay(1200, controller.signal);
        } catch {
          return;
        }
      }
    };
    void poll();
    return () => controller.abort();
  }, [runningWorkflowTaskIDs]);

  const categories = useMemo(
    () =>
      Array.from(
        new Set(items.map((item) => item.category || "未分类")),
      ).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [items],
  );
  const filteredItems = useMemo(() => {
    const text = query.trim().toLowerCase();
    return items.filter((workflow) => {
      if (category !== "all" && (workflow.category || "未分类") !== category)
        return false;
      if (scopeFilter !== "all" && workflow.scope !== scopeFilter) return false;
      if (!text) return true;
      return [workflow.name, workflow.category, workflow.description].some((value) =>
        value.toLowerCase().includes(text),
      );
    });
  }, [category, items, query, scopeFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleWorkflows = filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => setPage(1), [category, pageSize, query, scopeFilter]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const renderedPrompt = useMemo(
    () => (running ? renderWorkflowPrompt(running, values) : ""),
    [running, values],
  );
  async function persist(workflow: CreativeWorkflow) {
    if (!workflow.name.trim()) {
      toast.error("请输入工作流名称");
      return;
    }
    if (!workflow.config.prompt_template.trim()) {
      toast.error("请输入提示词模板");
      return;
    }
    try {
      const generatedByAgent = agentDraft?.id === workflow.id;
      const saved = normalizeWorkflow(
        await saveWorkflow(normalizeWorkflow(workflow, models, preferences)),
        models,
        preferences,
      );
      setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setEditing(null);
      if (generatedByAgent) {
        await cleanupAgentReferences();
        setAgentDraft(null);
        setAgentWarnings([]);
      }
      toast.success("工作流已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "工作流保存失败");
    }
  }

  async function duplicateWorkflow(workflow: CreativeWorkflow) {
    const copy = normalizeWorkflow(
      {
        ...structuredClone(workflow),
        id: "",
        owner_id: undefined,
        editable: true,
        scope: "private",
        name: `${workflow.name} 副本`,
        created_at: undefined,
        updated_at: undefined,
        last_run_at: undefined,
      },
      models,
      preferences,
    );
    try {
      const saved = normalizeWorkflow(await saveWorkflow(copy), models, preferences);
      setItems((current) => [saved, ...current]);
      toast.success("工作流副本已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "工作流复制失败");
    }
  }

  function markWorkflowRunCompleted(workflow: CreativeWorkflow, endedAt: number) {
    if (workflow.editable === false) return;
    const timestamp = new Date(endedAt).toISOString();
    const completed = { ...workflow, last_run_at: timestamp, updated_at: timestamp };
    setItems((current) =>
      current
        .map((item) => (item.id === workflow.id ? completed : item))
        .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || ""))),
    );
    setRunning((current) => (current?.id === workflow.id ? completed : current));
    void saveWorkflow(completed)
      .then((saved) => {
        const normalized = normalizeWorkflow(saved, models, preferences);
        setItems((current) => current.map((item) => (item.id === normalized.id ? normalized : item)));
        setRunning((current) => (current?.id === normalized.id ? normalized : current));
      })
      .catch(() => undefined);
  }

  function openRunner(workflow: CreativeWorkflow) {
    setRunning(workflow);
    setValues(createDefaultInputValues(workflow));
    setReferences([]);
    setSeriesBatchAppend("");
    setSeriesDrafts([]);
  }

  function closeRunner() {
    setRunning(null);
    setSeriesDrafts([]);
    setSeriesBatchAppend("");
  }

  async function addReferences(files: FileList | null, agent = false) {
    const selected = Array.from(files || []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!selected.length) return;
    setReferenceBusy(true);
    try {
      const uploaded = await Promise.all(
        selected.map(async (file) => {
          const image = await uploadImage(file);
          return {
            id: taskID("reference"),
            name: file.name,
            url: image.url,
            storageKey: image.storageKey,
            temporary: true,
          };
        }),
      );
      if (agent) setAgentReferences((value) => [...value, ...uploaded]);
      else setReferences((value) => [...value, ...uploaded]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考图上传失败");
    } finally {
      setReferenceBusy(false);
    }
  }

  function insertWorkflowAsset(asset: MyAsset) {
    if (!assetPickerTarget) return;
    if (asset.kind === "text") {
      const content = String(asset.content || "").trim();
      if (content) {
        if (assetPickerTarget === "agent") {
          setAgentPrompt((current) => current.trim() ? `${current.trim()}\n\n${content}` : content);
        } else {
          const key = running?.variables[0]?.key || "asset_text";
          setValues((current) => ({ ...current, [key]: content }));
        }
      }
      setAssetPickerTarget(null);
      return;
    }
    if (asset.kind !== "image" || !asset.url) {
      toast.error("视频或音频素材不能作为工作流参考图");
      return;
    }
    const reference = { id: taskID("asset-reference"), name: asset.title, url: asset.url, temporary: false };
    if (assetPickerTarget === "agent") {
      setAgentReferences((current) => [...current, reference]);
    } else {
      setReferences((current) => [...current, reference]);
    }
    setAssetPickerTarget(null);
  }

  function removeWorkflowReference(id: string) {
    const reference = references.find((item) => item.id === id);
    setReferences((current) => current.filter((item) => item.id !== id));
    if (!reference?.temporary || !reference.storageKey) return;
    const used = tasks.some((task) => task.references?.some((item) =>
      item.storageKey === reference.storageKey || item.url === reference.url,
    ));
    if (!used) void deleteStoredImages([reference.storageKey]).catch(() => undefined);
  }

  function removeAgentReference(id: string) {
    const reference = agentReferences.find((item) => item.id === id);
    setAgentReferences((current) => current.filter((item) => item.id !== id));
    if (reference?.temporary && reference.storageKey) {
      void deleteStoredImages([reference.storageKey]).catch(() => undefined);
    }
  }

  async function cleanupAgentReferences() {
    const keys = agentReferences
      .filter((reference) => reference.temporary && reference.storageKey)
      .map((reference) => reference.storageKey as string);
    setAgentReferences([]);
    if (keys.length) {
      await deleteStoredImages(keys).catch((error) =>
        toast.error(error instanceof Error ? error.message : "参考图文件删除失败"),
      );
    }
  }

  async function executeImageTask(
    workflow: CreativeWorkflow,
    prompt: string,
    countOverride?: number,
    draft?: WorkflowSeriesDraft,
    seriesDraftIndex?: number,
    seriesRun?: WorkflowSeriesRun,
  ) {
    if (!session) throw new Error("登录状态已失效");
    const taskController = taskWaitAbortControllerRef.current;
    if (!taskController || taskController.signal.aborted) {
      throw taskController?.signal.reason || new DOMException("Workspace closed", "AbortError");
    }
    const runtime = resolveWorkflowRuntime(workflow, models, preferences);
    const model = runtime.model;
    const count = Math.max(1, Math.min(10, countOverride || runtime.count));
    const quality = ["low", "medium", "high"].includes(runtime.quality)
      ? (runtime.quality as ImageQuality)
      : undefined;
    const stream = preferences.stream;
    const partialImages = preferences.partial_images || undefined;
    const relayTokenName = tokenNameForModel("image", model);
    const execution = {
      stream,
      partial_images: preferences.partial_images,
      response_format_b64_json: preferences.response_format_b64_json,
      codex_cli_compatibility: preferences.codex_cli_compatibility,
      token_name: relayTokenName || undefined,
    };
    const localTaskID = seriesRun?.id || taskID("workflow-image");
    const startedAt = Date.now();
    const taskConfig = {
      ...workflow.config,
      model,
      image_model: model,
      api_mode: runtime.api_mode,
      system_prompt: runtime.system_prompt,
      quality: runtime.quality,
      size: runtime.size,
      count: String(count),
      timeout: String(runtime.timeout),
    };
    const seriesIndex = draft ? Math.max(0, seriesDraftIndex || 0) + 1 : undefined;
    const taskCount = seriesRun?.total || count;
    const taskSnapshot: WorkflowTask = {
      id: localTaskID,
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      prompt,
      status: "running",
      started_at: startedAt,
      image_urls: [],
      images: [],
      series_title: draft?.title,
      series_index: seriesIndex,
      inputs: { ...values },
      references: references.map((reference) => ({ ...reference })),
      model,
      api_mode: runtime.api_mode,
      config: taskConfig,
      execution,
      count: taskCount,
      backend_task_ids: [],
      completed_units: [],
      unit_errors: {},
    };
    setTasks((current) => current.some((task) => task.id === localTaskID)
      ? current
      : [taskSnapshot, ...current]);
    if (draft) patchSeriesDraft(draft.id, { status: "running", error: undefined });
    const settleLocalTask = (nextImages: WorkflowTask["images"], taskError?: string) => {
      const unitIndexes = seriesRun && seriesIndex
        ? [seriesIndex]
        : Array.from({ length: count }, (_, index) => index + 1);
      setTasks((current) => current.map((task) => {
        if (task.id !== localTaskID) return task;
        const completedUnits = Array.from(new Set([
          ...(task.completed_units || []),
          ...unitIndexes,
        ])).sort((left, right) => left - right);
        const unitErrors = { ...task.unit_errors };
        for (const unitIndex of unitIndexes) {
          if (taskError) unitErrors[String(unitIndex)] = taskError;
          else delete unitErrors[String(unitIndex)];
        }
        const replacedIndexes = new Set(nextImages.map((image) => image.index));
        const images = [
          ...task.images.filter((image) => !replacedIndexes.has(image.index)),
          ...nextImages,
        ].sort((left, right) => (left.index || 0) - (right.index || 0));
        const finished = completedUnits.length >= task.count;
        const error = Object.values(unitErrors).filter(Boolean).join("\n") || undefined;
        return {
          ...task,
          completed_units: completedUnits,
          unit_errors: unitErrors,
          images,
          image_urls: images.map((image) => image.url),
          status: finished ? (error ? "failed" : "success") : "running",
          ended_at: finished ? Date.now() : undefined,
          error,
        };
      }));
    };
    try {
      const imageFiles = references.length ? await workflowImageFiles(references, taskController.signal) : [];
      const settled = await Promise.allSettled(
        Array.from({ length: count }, async (_, index) => {
          const batchIndex = seriesRun && seriesIndex ? seriesIndex : index + 1;
          const batchCount = seriesRun?.total || count;
          const clientTaskID = seriesRun
            ? `${localTaskID}-${batchIndex}`
            : count === 1 ? localTaskID : `${localTaskID}-${index + 1}`;
          const workflowContext = {
            workflow_id: workflow.id,
            workflow_name: workflow.name,
            prompt,
            inputs: { ...values },
            references: references.map((reference) => ({ ...reference })),
            config: { ...taskConfig, count: "1" },
            execution,
            count: batchCount,
            batch_task_id: localTaskID,
            batch_index: batchIndex,
            batch_count: batchCount,
            ...(draft?.title ? { series_title: draft.title } : {}),
            ...(seriesIndex ? { series_index: seriesIndex } : {}),
          };
          const toolOptions = {
            apiMode: runtime.api_mode,
            responseFormatB64JSON: preferences.response_format_b64_json,
            codexCLICompatibility: preferences.codex_cli_compatibility,
            systemPrompt: runtime.system_prompt,
            workflowContext,
            generationSource: "workflow" as const,
          };
          const submitted = imageFiles.length
            ? await createImageEditTask(clientTaskID, imageFiles, prompt, model, runtime.size || undefined, undefined, quality, 1, "private", undefined, undefined, undefined, stream, partialImages, toolOptions, undefined, relayTokenName || undefined, undefined, undefined, { signal: taskController.signal })
            : await createImageGenerationTask(clientTaskID, prompt, model, runtime.size || undefined, undefined, quality, 1, "private", undefined, undefined, undefined, stream, partialImages, toolOptions, undefined, relayTokenName || undefined, undefined, undefined, { signal: taskController.signal });
          setTasks((current) => current.map((task) =>
            task.id === localTaskID
              ? {
                  ...task,
                  backend_task_ids: Array.from(new Set([...task.backend_task_ids, submitted.id])),
                }
              : task,
          ));
          return waitForOwnedTask(submitted.id, runtime.timeout);
        }),
      );
      const aborted = settled.find(
        (item): item is PromiseRejectedResult => item.status === "rejected" && isWorkflowPollAbort(item.reason),
      );
      if (aborted) throw aborted.reason;
      const completed = settled.flatMap((item, index) =>
        item.status === "fulfilled" ? [{ task: item.value, index }] : [],
      );
      const failures = settled
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason || "任务执行失败"));
      const images = completed.flatMap(({ task, index }) =>
        creationTaskImages(task).map((image) => ({
          ...image,
          index: seriesRun && seriesIndex ? seriesIndex - 1 : index,
          ...(draft?.title ? { title: draft.title } : {}),
          ...(draft ? { prompt } : {}),
        })),
      );
      const imageURLs = images.map((image) => image.url);
      if (!imageURLs.length) throw new Error(failures[0] || "接口没有返回图片");
      const partialError = failures.join("\n") || undefined;
      settleLocalTask(images, partialError);
      if (partialError) {
        if (draft) patchSeriesDraft(draft.id, { status: "failed", result_ids: imageURLs, error: partialError });
        throw new Error(partialError);
      }
      if (draft) {
        patchSeriesDraft(draft.id, {
          status: "success",
          result_ids: imageURLs,
          error: undefined,
        });
      }
      markWorkflowRunCompleted(workflow, Date.now());
      return imageURLs;
    } catch (error) {
      if (taskController.signal.aborted || isWorkflowPollAbort(error)) {
        throw taskController.signal.reason || error;
      }
      const message = error instanceof Error ? error.message : "工作流运行失败";
      settleLocalTask([], message);
      if (draft) patchSeriesDraft(draft.id, { status: "failed", error: message });
      throw error;
    }
  }

  async function runWorkflow() {
    if (!running) return;
    const missing = running.variables.find(
      (variable) => variable.required && !String(values[variable.key] || "").trim(),
    );
    if (missing) {
      toast.error(`请填写 ${missing.label}`);
      return;
    }
    if (running.mode === "multi_image_series") {
      await generateSeriesDrafts();
      return;
    }
    const workflow = running;
    const prompt = renderedPrompt;
    closeRunner();
    try {
      await executeImageTask(workflow, prompt);
      toast.success("工作流运行完成");
    } catch (error) {
      if (isWorkflowPollAbort(error)) return;
      toast.error(error instanceof Error ? error.message : "工作流运行失败");
    }
  }

  async function generateSeriesDrafts() {
    if (!running || seriesDraftLoading) return;
    const missing = running.variables.find(
      (variable) => variable.required && !String(values[variable.key] || "").trim(),
    );
    if (missing) {
      toast.error(`请填写 ${missing.label}`);
      return;
    }
    const taskController = taskWaitAbortControllerRef.current;
    if (!taskController || taskController.signal.aborted) return;
    setSeriesDraftLoading(true);
    try {
      const count = Math.max(
        1,
        Math.min(20, Number(running.series_config.target_count) || Number(running.config.count) || 4),
      );
      const prompt = buildSeriesPromptDraftRequest(
        running,
        renderedPrompt,
        count,
        values,
      );
      const model =
        preferences.default_text_model ||
        models?.default_text_model ||
        "";
      const submitted = await createChatGenerationTask({
        clientTaskId: taskID("workflow-series"),
        prompt,
        model,
        relayTokenName: tokenNameForModel("text", model),
        messages: [{ role: "user", content: prompt }],
        requestOptions: { signal: taskController.signal },
      });
      const completed = await waitForOwnedTask(
        submitted.id,
        600,
      );
      const drafts = parseWorkflowSeriesDrafts(taskText(completed), count, renderedPrompt);
      setSeriesDrafts(drafts);
      toast.success("多图提示词已生成，请审核后生成图片");
      if (running.series_config.review_required === false) {
        window.setTimeout(() => {
          void runAllSeriesDrafts(drafts);
        }, 0);
      }
    } catch (error) {
      if (!taskController.signal.aborted && !isWorkflowPollAbort(error)) {
        toast.error(error instanceof Error ? error.message : "系列提示词生成失败");
      }
    } finally {
      if (!taskController.signal.aborted) {
        setSeriesDraftLoading(false);
      }
    }
  }

  async function waitForOwnedTask(id: string, timeoutSeconds: number) {
    const controller = taskWaitAbortControllerRef.current;
    if (!controller || controller.signal.aborted) {
      throw controller?.signal.reason || new DOMException("Workspace closed", "AbortError");
    }
    setDirectTaskPollIDs((current) => current.includes(id) ? current : [...current, id]);
    try {
      return await waitForTask(id, timeoutSeconds, controller.signal);
    } finally {
      if (!controller.signal.aborted) {
        setDirectTaskPollIDs((current) => current.filter((item) => item !== id));
      }
    }
  }

  function patchSeriesDraft(id: string, patch: Partial<WorkflowSeriesDraft>) {
    setSeriesDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    );
  }

  function moveSeriesDraft(id: string, direction: -1 | 1) {
    setSeriesDrafts((current) => {
      const index = current.findIndex((draft) => draft.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function appendToSeriesDrafts() {
    const text = seriesBatchAppend.trim();
    if (!text) {
      toast.error("请输入要追加的批量要求");
      return;
    }
    setSeriesDrafts((current) =>
      current.map((draft) => ({
        ...draft,
        prompt: `${draft.prompt.trim()}\n${text}`.trim(),
        status: draft.status === "success" ? "draft" : draft.status,
      })),
    );
    setSeriesBatchAppend("");
  }

  async function runOneSeriesDraft(
    draft: WorkflowSeriesDraft,
    index: number,
    seriesRun?: WorkflowSeriesRun,
    notifyError = true,
  ) {
    if (!running || !draft.prompt.trim() || draft.status === "running") return false;
    try {
      await executeImageTask(running, draft.prompt.trim(), 1, draft, index, seriesRun);
      return true;
    } catch (error) {
      if (isWorkflowPollAbort(error)) return false;
      if (notifyError) {
        toast.error(error instanceof Error ? error.message : "系列图片生成失败");
      }
      return false;
    }
  }

  async function runAllSeriesDrafts(source = seriesDrafts) {
    if (!running) return;
    const controller = taskWaitAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    const drafts = source.filter(
      (draft) => draft.prompt.trim() && draft.status !== "running" && draft.status !== "success",
    );
    if (!drafts.length) {
      toast.error("没有可生成的提示词");
      return;
    }
    const concurrency = Math.max(
      1,
      Math.min(6, Number(running.series_config.concurrency) || 3),
    );
    const seriesRun: WorkflowSeriesRun = {
      id: taskID("workflow-series-images"),
      total: drafts.length,
    };
    let successCount = 0;
    for (let index = 0; index < drafts.length; index += concurrency) {
      if (controller.signal.aborted) return;
      const results = await Promise.all(
        drafts.slice(index, index + concurrency).map((draft, chunkIndex) =>
          runOneSeriesDraft(
            draft,
            index + chunkIndex,
            seriesRun,
            false,
          ),
        ),
      );
      successCount += results.filter(Boolean).length;
    }
    if (controller.signal.aborted) return;
    if (successCount === drafts.length) toast.success(`多图任务已完成，共生成 ${successCount} 张`);
    else toast.error(`多图任务完成 ${successCount}/${drafts.length} 张，请查看任务记录`);
  }

  async function clearCompletedTaskHistory(includeAssets: boolean) {
    if (clearingTaskHistory) return false;
    const completedTasks = tasks.filter((task) => task.status !== "running");
    if (!completedTasks.length) return false;
    const backendTaskIDs = Array.from(new Set(completedTasks.flatMap((task) => task.backend_task_ids)));
    setClearingTaskHistory(true);
    try {
      const result = backendTaskIDs.length
        ? await deleteCreationTasks(backendTaskIDs)
        : { active_ids: [] as string[] };
      const activeIDs = new Set(result.active_ids || []);
      const removableTaskIDs = new Set(completedTasks
        .filter((task) => !task.backend_task_ids.some((id) => activeIDs.has(id)))
        .map((task) => task.id));
      const removableTasks = completedTasks.filter((task) => removableTaskIDs.has(task.id));
      setTasks((current) => current.filter((task) => !removableTaskIDs.has(task.id)));
      if (removableTaskIDs.has(selectedTaskID)) setSelectedTaskID("");
      let deletedAssetCount = 0;
      if (includeAssets && hasAPIPermission(session, "DELETE", "/api/images")) {
        const assetPaths = Array.from(new Set(removableTasks.flatMap((task) =>
          task.images
            .map((image) => getManagedImagePathFromUrl(image.url))
            .filter(Boolean),
        )));
        if (assetPaths.length) {
          try {
            const assetResult = await deleteManagedImages(assetPaths);
            deletedAssetCount = assetResult.deleted;
          } catch (error) {
            toast.error(error instanceof Error ? `任务记录已清理，但关联素材删除失败：${error.message}` : "任务记录已清理，但关联素材删除失败");
            return true;
          }
        }
      }
      if (activeIDs.size) toast.error(`${activeIDs.size} 个仍在运行的后端任务未清理`);
      else if (includeAssets) toast.success(`已清理 ${removableTasks.length} 条任务记录，并删除 ${deletedAssetCount} 个关联素材`);
      else toast.success(`已清理 ${removableTasks.length} 条任务记录，关联素材已保留`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "任务记录清理失败");
      return false;
    } finally {
      setClearingTaskHistory(false);
    }
  }

  async function draftWithAgent() {
    if (!session || !agentPrompt.trim() || agentBusy) return;
    setAgentBusy(true);
    try {
      const model = agentModel || preferences.default_text_model || models?.default_text_model || "";
      const response = await draftWorkflowWithAgent({
        prompt: agentPrompt.trim(),
        scope: agentScope,
        model,
        channelID: tokenNameForModel("text", model),
        references: agentReferences.length
          ? await workflowImageDataURLs(agentReferences)
          : [],
      });
      const draft = response.draft;
      const base = createBlankWorkflow(
        models,
        preferences,
        draft.mode === "multi_image_series"
          ? "multi_image_series"
          : "single_image",
        workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID),
      );
      setAgentDraft(
        normalizeWorkflow(
          {
            ...base,
            ...draft,
            id: taskID("workflow-draft"),
            scope: agentScope,
            variables: Array.isArray(draft.variables) ? draft.variables : base.variables,
            config: { ...base.config, ...draft.config },
            series_config: {
              ...base.series_config,
              ...draft.series_config,
            },
          },
          models,
          preferences,
        ),
      );
      setAgentWarnings(Array.isArray(response.warnings) ? response.warnings : []);
      toast.success("Agent 草稿已生成，请预览后应用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Agent 创建失败");
    } finally {
      setAgentBusy(false);
    }
  }

  function applyAgentDraft() {
    if (!agentDraft) return;
    setEditing(structuredClone(agentDraft));
    setAgentOpen(false);
  }

  if (isCheckingAuth || !session || loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        正在加载工作流
      </div>
    );
  }

  const workflowActions = (
    <>
      <Button variant="outline" onClick={() => setAgentOpen(true)}><Bot />Agent</Button>
      {!hideTaskList ? <Button variant="outline" className="relative" onClick={() => setTaskHistoryOpen(true)}>
        {runningTaskCount ? <LoaderCircle className="animate-spin" /> : <ClipboardList />}
        任务记录
        {runningTaskCount ? <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[#1456f0] px-1.5 text-[10px] font-semibold leading-5 text-white">{runningTaskCount}</span> : null}
      </Button> : null}
      <Button onClick={() => setEditing(createBlankWorkflow(models, preferences, "single_image", workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID)))}><Plus />新建工作流</Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", embedded ? "bg-transparent" : "card-surface rounded-xl border border-border/80 shadow-[0_4px_16px_rgba(24,40,72,0.05)]")}>
        <header className={cn("shrink-0 border-b border-border px-5 py-3 sm:px-8", embedded && "pr-14 sm:pr-14")}>
          <div data-workflow-toolbar className="flex w-full flex-wrap items-center gap-3">
            <div className="relative min-w-[240px] flex-[1_1_320px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、分类或描述" />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="min-w-0 flex-1 sm:w-36 sm:flex-none"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部分类</SelectItem>
                  {categories.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="hide-scrollbar flex max-w-full shrink-0 items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1">
                {workflowScopeOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setScopeFilter(option.value)}
                      className={cn(
                        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition",
                        scopeFilter === option.value && "bg-card text-foreground shadow-sm",
                      )}
                    >
                      {Icon ? <Icon className="size-3.5" /> : null}
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div data-workflow-actions className="ml-auto flex shrink-0 items-center gap-2">
              {workflowActions}
            </div>
          </div>
        </header>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-5 py-5 sm:px-8 lg:py-6">
          <div className="flex w-full flex-col gap-8">
            {visibleWorkflows.length ? (
              <section aria-label="工作流列表">
                <div data-workflow-grid className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {visibleWorkflows.map((workflow) => (
                  <WorkflowCard
                    key={workflow.id}
                    workflow={workflow}
                    onRun={() => openRunner(workflow)}
                    onEdit={() => setEditing(structuredClone(workflow))}
                    onCopy={() => void duplicateWorkflow(workflow)}
                    onDelete={async () => {
                      if (!window.confirm(`确定删除「${workflow.name}」吗？已生成的图片不受影响。`)) return;
                      try {
                        await deleteWorkflow(workflow.id);
                        setItems((current) => current.filter((item) => item.id !== workflow.id));
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "删除失败");
                      }
                    }}
                  />
                ))}
                </div>
              </section>
            ) : (
              <EmptyState icon={WorkflowIcon} title="暂无工作流" description="新建工作流后可在这里配置并运行创作任务" className="min-h-72" />
            )}
          </div>
        </ScrollArea>
        <ManagementPagination
          page={safePage}
          totalPages={totalPages}
          totalItems={filteredItems.length}
          pageSize={pageSize}
          pageSizeOptions={[12, 24, 48]}
          itemLabel="个"
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
      <WorkflowTaskHistoryDialog
        open={taskHistoryOpen}
        tasks={tasks}
        now={now}
        clearing={clearingTaskHistory}
        canDeleteAssets={hasAPIPermission(session, "DELETE", "/api/images")}
        onClearCompleted={clearCompletedTaskHistory}
        onOpenTask={(taskID) => {
          setTaskHistoryOpen(false);
          setSelectedTaskID(taskID);
        }}
        onClose={() => setTaskHistoryOpen(false)}
      />
      <WorkflowEditor
        workflow={editing}
        models={models}
        preferences={preferences}
        onChange={setEditing}
        onSave={persist}
        onClose={() => setEditing(null)}
      />
      <WorkflowRunner
        key={running?.id || "closed-workflow-runner"}
        workflow={running}
        values={values}
        prompt={renderedPrompt}
        references={references}
        referenceBusy={referenceBusy}
        drafts={seriesDrafts}
        draftLoading={seriesDraftLoading}
        models={models}
        batchAppend={seriesBatchAppend}
        onValuesChange={setValues}
        onAssetsOpen={() => setAssetPickerTarget("workflow")}
        onReferencesAdd={(files) => void addReferences(files)}
        onReferenceRemove={removeWorkflowReference}
        onRun={() => void runWorkflow()}
        onGenerateDrafts={() => void generateSeriesDrafts()}
        onRunAll={() => void runAllSeriesDrafts()}
        onRunDraft={(draft, index) => void runOneSeriesDraft(draft, index)}
        onDraftChange={patchSeriesDraft}
        onDraftMove={moveSeriesDraft}
        onDraftDelete={(id) => setSeriesDrafts((current) => current.filter((draft) => draft.id !== id))}
        onBatchAppendChange={setSeriesBatchAppend}
        onBatchAppend={appendToSeriesDrafts}
        onClose={closeRunner}
      />
      <AgentDialog
        open={agentOpen}
        prompt={agentPrompt}
        scope={agentScope}
        model={agentModel}
        models={models}
        references={agentReferences}
        draft={agentDraft}
        warnings={agentWarnings}
        busy={agentBusy || referenceBusy}
        onPromptChange={setAgentPrompt}
        onScopeChange={setAgentScope}
        onModelChange={setAgentModel}
        onAssetsOpen={() => setAssetPickerTarget("agent")}
        onReferencesAdd={(files) => void addReferences(files, true)}
        onReferenceRemove={removeAgentReference}
        onRun={() => void draftWithAgent()}
        onApply={applyAgentDraft}
        onClose={() => setAgentOpen(false)}
      />
      <WorkflowAssetPicker
        open={assetPickerTarget !== null}
        assets={myAssets}
        loading={assetLoading}
        onInsert={insertWorkflowAsset}
        onClose={() => setAssetPickerTarget(null)}
      />
      <WorkflowTaskDialog task={selectedTask} now={now} onClose={() => setSelectedTaskID("")} />
    </div>
  );
}

function WorkflowCard({ workflow, onRun, onEdit, onCopy, onDelete }: { workflow: CreativeWorkflow; onRun: () => void; onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
  const isSeries = workflow.mode === "multi_image_series";
  return (
    <article data-interaction="controls" className="interactive-card group flex min-h-44 flex-col rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#edf4ff] text-[#1456f0] dark:bg-blue-950/40 dark:text-blue-300"><WorkflowIcon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2"><h3 className="truncate text-sm font-semibold">{workflow.name}</h3><span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">{workflow.scope === "public" ? <Globe2 className="size-3" /> : <LockKeyhole className="size-3" />}{workflow.scope === "public" ? "公开" : "个人"}</span></div>
          <p className="mt-0.5 text-xs text-muted-foreground">{workflow.category || "未分类"}</p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 flex-1 text-xs leading-5 text-muted-foreground">{workflow.description || workflow.config.prompt_template}</p>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant={isSeries ? "violet" : "info"} className="shrink-0 px-2.5 py-1 font-semibold">
          {isSeries ? <Layers3 className="size-3.5" /> : <ImageIcon className="size-3.5" />}
          {isSeries ? "多图生成" : "单图生成"}
        </Badge>
        <span className="shrink-0">{workflow.variables.length} 个变量</span>
        {workflow.last_run_at ? <span className="min-w-0 truncate">最近运行 {new Date(workflow.last_run_at).toLocaleString("zh-CN")}</span> : null}
      </div>
      <div className="mt-3 flex items-center gap-1 border-t border-border/70 pt-3">
        <Button size="sm" onClick={onRun}><Play />运行</Button>
        {workflow.editable !== false ? <Button size="icon" variant="ghost" title="编辑" onClick={onEdit}><Pencil /></Button> : null}
        <Button size="icon" variant="ghost" title="复制" onClick={onCopy}><Copy /></Button>
        {workflow.editable !== false ? <Button size="icon" variant="ghost" className="ml-auto text-rose-600" title="删除" onClick={onDelete}><Trash2 /></Button> : null}
      </div>
    </article>
  );
}

function workflowTaskDuration(task: WorkflowTask, now: number) {
  const elapsed = Math.max(0, (task.ended_at || now) - task.started_at);
  return elapsed < 60_000
    ? `${Math.max(1, Math.round(elapsed / 1000))} 秒`
    : `${Math.floor(elapsed / 60_000)} 分 ${Math.round((elapsed % 60_000) / 1000)} 秒`;
}

function WorkflowTaskStatus({ task }: { task: WorkflowTask }) {
  if (task.status === "running") return <Badge variant="info"><LoaderCircle className="size-3 animate-spin" />运行中</Badge>;
  if (task.status === "failed") return <Badge variant="danger">失败</Badge>;
  return <Badge variant="success">完成</Badge>;
}

type WorkflowTaskFilter = "all" | WorkflowTask["status"];

function WorkflowTaskHistoryDialog({ open, tasks, now, clearing, canDeleteAssets, onClearCompleted, onOpenTask, onClose }: { open: boolean; tasks: WorkflowTask[]; now: number; clearing: boolean; canDeleteAssets: boolean; onClearCompleted: (includeAssets: boolean) => Promise<boolean>; onOpenTask: (taskID: string) => void; onClose: () => void }) {
  const [filter, setFilter] = useState<WorkflowTaskFilter>("all");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearAssets, setClearAssets] = useState(false);
  const counts = {
    all: tasks.length,
    running: tasks.filter((task) => task.status === "running").length,
    success: tasks.filter((task) => task.status === "success").length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
  const clearableTasks = tasks.filter((task) => task.status !== "running");
  const clearableAssetCount = new Set(clearableTasks.flatMap((task) =>
    task.images.map((image) => getManagedImagePathFromUrl(image.url)).filter(Boolean),
  )).size;
  const filteredTasks = filter === "all" ? tasks : tasks.filter((task) => task.status === filter);
  const filters: Array<{ value: WorkflowTaskFilter; label: string }> = [
    { value: "all", label: "全部" },
    { value: "running", label: "运行中" },
    { value: "success", label: "已完成" },
    { value: "failed", label: "失败" },
  ];
  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent scrollable={false} className="max-h-[min(88dvh,780px)] w-[min(96vw,920px)] max-w-none gap-0 p-0">
          <DialogHeader className="border-b border-border px-5 py-4 sm:px-6">
            <DialogTitle className="flex items-center gap-2 text-lg"><ClipboardList className="size-5" />任务记录</DialogTitle>
            <DialogDescription>{counts.running ? `${counts.running} 个工作流任务正在执行` : tasks.length ? `共 ${tasks.length} 条工作流运行记录` : "运行工作流后，任务记录会显示在这里"}</DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-5 py-3 sm:px-6">
            <div className="hide-scrollbar flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label="任务状态">
              {filters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors",
                    filter === option.value && "bg-card text-foreground shadow-sm",
                  )}
                >
                  {option.label}
                  <span className="tabular-nums text-[10px] opacity-70">{counts[option.value]}</span>
                </button>
              ))}
            </div>
            {counts.success + counts.failed > 0 ? <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={clearing} onClick={() => setClearConfirmOpen(true)}>{clearing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}{clearing ? "清理中" : "清理历史"}</Button> : null}
          </div>
          <ScrollArea className="max-h-[min(62dvh,560px)]" viewportClassName="overscroll-contain">
            {filteredTasks.length ? (
              <div data-workflow-task-list>
                {filteredTasks.map((task) => <WorkflowTaskRow key={task.id} task={task} now={now} onOpen={() => onOpenTask(task.id)} />)}
              </div>
            ) : (
              <EmptyState
                icon={ClipboardList}
                title={`当前没有${filter === "all" ? "任务记录" : filters.find((option) => option.value === filter)?.label + "任务"}`}
                description={filter === "all" ? "从工作流启动任务后可在这里查看进度和结果" : "切换其他状态查看工作流运行记录"}
                className="min-h-72"
              />
            )}
          </ScrollArea>
          <DialogFooter flush><Button variant="outline" onClick={onClose}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={clearConfirmOpen}
        onOpenChange={(nextOpen) => {
          if (clearing) return;
          setClearConfirmOpen(nextOpen);
          if (!nextOpen) setClearAssets(false);
        }}
      >
        <DialogContent className="w-[min(92vw,460px)]">
          <DialogHeader>
            <DialogTitle>清理任务历史？</DialogTitle>
            <DialogDescription>将清除 {clearableTasks.length} 条已完成或失败的任务记录，运行中的任务不会受到影响。</DialogDescription>
          </DialogHeader>
          <label className={cn("flex items-start gap-3 rounded-lg border border-border p-3.5", (!canDeleteAssets || !clearableAssetCount) && "cursor-not-allowed bg-muted/40")}>
            <Checkbox
              className="mt-0.5"
              checked={clearAssets}
              disabled={clearing || !canDeleteAssets || !clearableAssetCount}
              onCheckedChange={(checked) => setClearAssets(checked === true)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">一并删除关联素材</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {!canDeleteAssets
                  ? "当前角色没有删除素材的权限，任务图片将继续保留。"
                  : clearableAssetCount
                    ? `将永久删除这些任务生成的 ${clearableAssetCount} 个服务器素材，外部图片不受影响。`
                    : "这些任务记录没有可删除的服务器素材。"}
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={clearing} onClick={() => setClearConfirmOpen(false)}>取消</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={clearing}
              onClick={() => void onClearCompleted(clearAssets).then((cleared) => {
                if (!cleared) return;
                setClearConfirmOpen(false);
                setClearAssets(false);
              })}
            >
              {clearing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {clearing ? "清理中" : clearAssets ? "清理记录和素材" : "仅清理记录"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function WorkflowTaskRow({ task, now, onOpen }: { task: WorkflowTask; now: number; onOpen: () => void }) {
  const duration = workflowTaskDuration(task, now);
  const title = task.series_title ? `${task.workflow_name} · ${task.series_title}` : task.workflow_name;
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`查看任务：${title}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group grid cursor-pointer grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-3 outline-none transition-colors last:border-b-0 hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring/30 sm:grid-cols-[64px_minmax(0,1fr)_auto] sm:px-4"
    >
      <div className="grid aspect-square size-14 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted sm:size-16">
        {task.images[0]?.url ? <AuthenticatedImage src={task.images[0].url} alt="" className="size-full object-cover" placeholderClassName="min-h-0" /> : task.status === "running" ? <LoaderCircle className="size-5 animate-spin text-muted-foreground" /> : <ImageIcon className="size-5 text-muted-foreground" />}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          <WorkflowTaskStatus task={task} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{task.prompt || "未记录提示词"}</p>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>{new Date(task.started_at).toLocaleString("zh-CN")}</span>
          <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{duration}</span>
          <span className="truncate">{task.model || "默认模型"}</span>
          <span>{task.count} 张</span>
          {task.images.length ? <span>{task.images.length} 个结果</span> : null}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" title="复制提示词" onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(task.prompt); }}><Copy /></Button>
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
    </article>
  );
}

function formatWorkflowBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function generationQualityLabel(value: string) {
  if (value === "low") return "低";
  if (value === "medium") return "中";
  if (value === "high") return "高";
  return "自动";
}

function WorkflowImageSettings({
  models,
  model,
  value,
  className,
  readOnly = false,
  showHeading = true,
  onModelChange,
  onChange,
}: {
  models: ModelConfig | null;
  model: string;
  value: ImageSettingsValue;
  className?: string;
  readOnly?: boolean;
  showHeading?: boolean;
  onModelChange?: (model: string) => void;
  onChange?: (patch: Partial<ImageSettingsValue>) => void;
}) {
  const modelOptions = models?.image_models.includes(model)
    ? models.image_models
    : [model, ...(models?.image_models || [])].filter(Boolean);
  return (
    <section data-workbench-generation-settings data-read-only={readOnly || undefined} className={cn("space-y-3", className)}>
      {showHeading ? (
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Settings2 className="size-4" />
          创作参数
        </h3>
      ) : null}
      <div className="space-y-1.5">
        <ImageParameterLabel>图片模型</ImageParameterLabel>
        <Select value={model} disabled={readOnly} onValueChange={(next) => onModelChange?.(next)}>
          <SelectTrigger aria-label="图片模型"><SelectValue placeholder="选择图片模型" /></SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <fieldset disabled={readOnly} className={cn(readOnly && "[&_button]:cursor-default [&_input]:cursor-default")}>
        <ImageSettingsPanel disabled={readOnly} model={model} value={value} showSnapToMultiple16={false} onChange={(patch) => onChange?.(patch)} />
      </fieldset>
    </section>
  );
}

function WorkflowTaskDialog({ task, now, onClose }: { task: WorkflowTask | null; now: number; onClose: () => void }) {
  const [selectedImage, setSelectedImage] = useState(0);
  useEffect(() => setSelectedImage(0), [task?.id]);
  if (!task) return null;
  const duration = workflowTaskDuration(task, now);
  const activeImage = task.images[selectedImage] || task.images[0];
  const activeImagePrompt = activeImage?.prompt || task.prompt;
  const activeImageTitle = activeImage?.title?.trim() || `第 ${selectedImage + 1} 张`;
  const inputEntries = Object.entries(task.inputs).filter(([, value]) => String(value).trim());
  const title = task.series_title ? `${task.workflow_name} · ${task.series_title}` : task.workflow_name;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent scrollable={false} className="h-[min(92dvh,920px)] w-[min(96vw,1180px)] max-w-none gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <DialogTitle className="text-lg">{title}</DialogTitle>
            <WorkflowTaskStatus task={task} />
          </div>
          <DialogDescription>{new Date(task.started_at).toLocaleString("zh-CN")} · 耗时 {duration} · {task.count} 张</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="overscroll-contain">
          <div className="grid min-h-full lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
            <section className="min-w-0 border-b border-border p-4 sm:p-6 lg:border-r lg:border-b-0">
              {activeImage ? (
                <>
                  <div className="flex min-h-72 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/50 lg:min-h-[520px]">
                    <AuthenticatedImage src={activeImage.url} alt={`${title} 结果 ${selectedImage + 1}`} className="max-h-[62dvh] w-full object-contain" />
                  </div>
                  <div className="mt-2 flex min-h-16 gap-2 overflow-x-auto pb-1">
                    {task.images.map((image, index) => (
                      <button key={`${image.url}-${index}`} type="button" aria-label={`查看第 ${index + 1} 张结果`} onClick={() => setSelectedImage(index)} className={cn("relative aspect-square size-16 shrink-0 overflow-hidden rounded-md border bg-muted", selectedImage === index ? "border-primary ring-2 ring-primary/20" : "border-border")}>
                        <AuthenticatedImage src={image.url} alt="" className="size-full object-cover" placeholderClassName="min-h-0" />
                        <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white">{index + 1}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{activeImage.width && activeImage.height ? `${activeImage.width} × ${activeImage.height}` : "尺寸未记录"}{activeImage.bytes ? ` · ${formatWorkflowBytes(activeImage.bytes)}` : ""}</p>
                </>
              ) : (
                <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-border text-center text-sm text-muted-foreground lg:min-h-[520px]">
                  <div>{task.status === "running" ? <LoaderCircle className="mx-auto mb-3 size-6 animate-spin" /> : <ImageIcon className="mx-auto mb-3 size-6" />}<p>{task.status === "running" ? `任务生成中，已运行 ${duration}` : "任务没有返回图片"}</p></div>
                </div>
              )}
            </section>
            <aside className="min-w-0 p-4 sm:p-6">
              {task.error ? <section className="mb-5 border-l-2 border-rose-500 bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"><h3 className="font-semibold">失败原因</h3><p className="mt-1 whitespace-pre-wrap text-xs leading-5">{task.error}</p></section> : null}
              <section className="border-b border-border pb-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">当前图片提示词</h3>
                    {activeImage ? <p className="mt-1 truncate text-xs text-muted-foreground">{activeImageTitle} · 第 {selectedImage + 1}/{task.images.length} 张</p> : null}
                  </div>
                  <Button size="icon" variant="ghost" title="复制当前图片提示词" disabled={!activeImagePrompt} onClick={() => void navigator.clipboard.writeText(activeImagePrompt)}><Copy /></Button>
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">{activeImagePrompt || "未记录"}</p>
              </section>
              <section className="border-b border-border py-5">
                <h3 className="text-sm font-semibold">输入变量</h3>
                {inputEntries.length ? <dl className="mt-3 divide-y divide-border/70">{inputEntries.map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(90px,0.35fr)_minmax(0,1fr)] gap-3 py-2 text-xs"><dt className="break-words text-muted-foreground">{key}</dt><dd className="whitespace-pre-wrap break-words text-foreground">{value}</dd></div>)}</dl> : <p className="mt-2 text-xs text-muted-foreground">没有输入变量</p>}
              </section>
              {task.references.length ? <section className="border-b border-border py-5"><h3 className="text-sm font-semibold">参考图</h3><div className="mt-3 grid grid-cols-4 gap-2">{task.references.map((reference) => <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer" className="group min-w-0"><div className="aspect-square overflow-hidden rounded-md border border-border bg-muted"><AuthenticatedImage src={reference.url} alt={reference.name} className="size-full object-cover" placeholderClassName="min-h-0" /></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{reference.name}</p></a>)}</div></section> : null}
              <section className="border-b border-border py-5">
                <h3 className="text-sm font-semibold">创作参数快照</h3>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                  {[["图片模型", task.model || "默认"], ["尺寸", task.config.size || "auto"], ["质量", generationQualityLabel(task.config.quality)], ["数量", `${task.count} 张`], ["接口", task.api_mode], ["超时", `${task.config.timeout || "600"} 秒`]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-0.5 break-words font-medium">{value}</dd></div>)}
                </dl>
              </section>
              <section className="pt-5">
                <h3 className="text-sm font-semibold">执行信息</h3>
                <dl className="mt-3 space-y-2 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-4"><dt>流式返回</dt><dd className="text-foreground">{task.execution.stream ? "开启" : "关闭"}</dd></div>
                  <div className="flex justify-between gap-4"><dt>部分图片</dt><dd className="text-foreground">{task.execution.partial_images}</dd></div>
                  <div className="flex justify-between gap-4"><dt>Base64 返回</dt><dd className="text-foreground">{task.execution.response_format_b64_json ? "开启" : "关闭"}</dd></div>
                  <div className="flex justify-between gap-4"><dt>后端任务</dt><dd className="max-w-[65%] break-all text-right text-foreground">{task.backend_task_ids.join(", ") || "提交中"}</dd></div>
                </dl>
              </section>
            </aside>
          </div>
        </ScrollArea>
        <DialogFooter flush className="flex-row justify-end sm:justify-end">
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {activeImage ? <Button onClick={() => void downloadWorkflowImage(activeImage.url, `workflow-task-${selectedImage + 1}.png`).catch((error) => toast.error(error instanceof Error ? error.message : "图片下载失败"))}><Download />下载当前图片</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowEditor({ workflow, models, preferences, onChange, onSave, onClose }: { workflow: CreativeWorkflow | null; models: ModelConfig | null; preferences: ImageGenerationPreferences; onChange: (workflow: CreativeWorkflow | null) => void; onSave: (workflow: CreativeWorkflow) => void; onClose: () => void }) {
  if (!workflow) return null;
  const patch = (value: Partial<CreativeWorkflow>) => onChange({ ...workflow, ...value });
  const patchConfig = (value: Partial<WorkflowGenerationConfig>) => patch({ config: { ...workflow.config, ...value } });
  const patchSeries = (value: Partial<WorkflowSeriesConfig>) => patch({ series_config: { ...workflow.series_config, ...value } });
  const patchVariable = (id: string, value: Partial<WorkflowVariable>) => patch({ variables: workflow.variables.map((item) => item.id === id ? { ...item, ...value } : item) });
  const imageModel = workflow.config.image_model || workflow.config.model || models?.default_image_model || models?.image_models[0] || "";
  const imageSettings = workflowImageSettings(workflow.config);
  const patchImageSettings = (value: Partial<ImageSettingsValue>) => {
    const next = { ...imageSettings, ...value };
    const size = buildImageSize(next, { preserveAspectRatio: true, snapToMultiple16: true });
    patchConfig({
      quality: next.quality || "auto",
      size: size || "auto",
      count: String(Math.max(1, Math.min(10, Math.round(Number(next.count) || 1)))),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent scrollable={false} className="h-[min(92dvh,920px)] w-[min(96vw,1180px)] max-w-none gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle>{workflow.id ? "编辑工作流" : "新建工作流"}</DialogTitle>
            <Badge variant="secondary">{workflow.mode === "multi_image_series" ? "多图生成" : "单图生成"}</Badge>
            <Badge variant="outline">{workflow.variables.length} 个变量</Badge>
          </div>
          <DialogDescription>工作流信息、输入变量、提示词与创作参数</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="overscroll-contain p-5 sm:p-6" viewClass="space-y-6">
          <section className="border-b border-border pb-6">
            <div className="mb-4 flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">1</span>
              <h3 className="text-sm font-semibold">基本信息</h3>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="工作流名称"><Input value={workflow.name} onChange={(event) => patch({ name: event.target.value })} placeholder="输入工作流名称" /></Field>
              <Field label="分类"><Input value={workflow.category} onChange={(event) => patch({ category: event.target.value })} placeholder="输入分类" /></Field>
              <Field label="生成方式">
                <Select value={workflow.mode} onValueChange={(mode: CreativeWorkflow["mode"]) => patch({ mode })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="single_image">单图生成</SelectItem><SelectItem value="multi_image_series">多图生成</SelectItem></SelectContent>
                </Select>
              </Field>
              <Field label="可见范围">
                <Select value={workflow.scope} onValueChange={(scope: CreativeWorkflow["scope"]) => patch({ scope })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="private">个人工作流</SelectItem><SelectItem value="public">公开工作流</SelectItem></SelectContent>
                </Select>
              </Field>
              <div className="sm:col-span-2 lg:col-span-4"><Field label="适用场景"><Textarea rows={2} value={workflow.description} onChange={(event) => patch({ description: event.target.value })} placeholder="输入适用场景说明" /></Field></div>
            </div>
          </section>

          <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-6">
              <section className="border-b border-border pb-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="grid size-6 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">2</span>
                    <h3 className="text-sm font-semibold">输入变量</h3>
                    <Badge variant="outline">{workflow.variables.length}</Badge>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => patch({ variables: [...workflow.variables, createWorkflowVariable()] })}><Plus />添加变量</Button>
                </div>
                {workflow.variables.length ? (
                  <div className="space-y-3">
                    {workflow.variables.map((variable, index) => (
                      <VariableEditor
                        key={variable.id}
                        index={index}
                        variable={variable}
                        onChange={(value) => patchVariable(variable.id, value)}
                        onDelete={() => patch({ variables: workflow.variables.filter((item) => item.id !== variable.id) })}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">暂无输入变量</div>
                )}
              </section>

              <section className={cn(workflow.mode === "multi_image_series" && "border-b border-border pb-6")}>
                <div className="mb-4 flex items-center gap-2">
                  <span className="grid size-6 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">3</span>
                  <h3 className="text-sm font-semibold">提示词模板</h3>
                </div>
                <div className="space-y-4">
                  <Field label="用户提示词模板"><Textarea rows={7} value={workflow.config.prompt_template} onChange={(event) => patchConfig({ prompt_template: event.target.value })} placeholder="使用 {{变量名}} 插入变量" /></Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="系统提示词"><Textarea rows={3} value={workflow.config.system_prompt} onChange={(event) => patchConfig({ system_prompt: event.target.value })} placeholder="可选" /></Field>
                    <Field label="负面约束"><Textarea rows={3} value={workflow.config.negative_prompt} onChange={(event) => patchConfig({ negative_prompt: event.target.value })} placeholder="可选" /></Field>
                  </div>
                </div>
              </section>

              {workflow.mode === "multi_image_series" ? (
                <section>
                  <div className="mb-4 flex items-start gap-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">4</span>
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="size-4" />多图提示词规划</h3>
                      <p className="mt-1 text-xs text-muted-foreground">设置系列拆分数量、并发和每张图片的规划要求。</p>
                    </div>
                  </div>
                  <div className="grid gap-4 rounded-lg border border-border bg-card p-4 xl:grid-cols-[240px_minmax(0,1fr)]">
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="草稿张数"><Input type="number" min={1} max={20} value={workflow.series_config.target_count} onChange={(event) => patchSeries({ target_count: event.target.value })} /></Field>
                        <Field label="图片并发"><Input type="number" min={1} max={6} value={workflow.series_config.concurrency} onChange={(event) => patchSeries({ concurrency: event.target.value })} /></Field>
                      </div>
                      <div className="flex min-h-9 items-center rounded-lg border border-border px-3"><Toggle label="生成前审核提示词" checked={workflow.series_config.review_required} onChange={(checked) => patchSeries({ review_required: checked })} /></div>
                    </div>
                    <Field label="系列拆分说明"><Textarea rows={4} value={workflow.series_config.prompt_instruction} onChange={(event) => patchSeries({ prompt_instruction: event.target.value })} placeholder="说明封面、步骤、要点和总结图之间的结构关系" /></Field>
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:sticky lg:top-0">
              <div className="p-4">
                <WorkflowImageSettings models={models} model={imageModel} value={imageSettings} onModelChange={(model) => patchConfig({ model, image_model: model })} onChange={patchImageSettings} />
              </div>
              {!workflow.config.system_prompt && preferences.system_prompt ? (
                <div className="border-t border-border p-4"><Button className="w-full" size="sm" variant="outline" onClick={() => patchConfig({ system_prompt: preferences.system_prompt })}>使用当前系统提示词</Button></div>
              ) : null}
            </aside>
          </div>
        </ScrollArea>
        <DialogFooter flush className="flex-row">
          <p className="mr-auto hidden text-xs text-muted-foreground sm:block">{!workflow.name.trim() ? "请填写工作流名称" : !workflow.config.prompt_template.trim() ? "请填写用户提示词模板" : "工作流配置已就绪"}</p>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={!workflow.name.trim() || !workflow.config.prompt_template.trim()} onClick={() => onSave(workflow)}><Save />保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VariableEditor({ index, variable, onChange, onDelete }: { index: number; variable: WorkflowVariable; onChange: (value: Partial<WorkflowVariable>) => void; onDelete: () => void }) {
  return (
    <article className="rounded-lg border border-border bg-card p-3.5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold text-muted-foreground">变量 {index + 1}</h4>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={variable.required} onCheckedChange={(checked) => onChange({ required: checked === true })} />必填</label>
          <Button size="icon" variant="ghost" title="删除变量" onClick={onDelete}><Trash2 /></Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="变量名"><Input value={variable.key} onChange={(event) => onChange({ key: event.target.value.replace(/[^\w.-]/g, "_") })} placeholder="例如 product_name" /></Field>
        <Field label="显示名称"><Input value={variable.label} onChange={(event) => onChange({ label: event.target.value })} placeholder="例如 产品名称" /></Field>
        <Field label="输入类型">
          <Select value={variable.type} onValueChange={(type: WorkflowVariable["type"]) => onChange({ type })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="text">短文本</SelectItem><SelectItem value="textarea">长文本</SelectItem><SelectItem value="number">数字</SelectItem><SelectItem value="select">选项</SelectItem><SelectItem value="boolean">开关</SelectItem></SelectContent>
          </Select>
        </Field>
        {variable.type === "select" ? (
          <Field label="默认选项">
            <Select value={variable.default_value || "__none"} onValueChange={(value) => onChange({ default_value: value === "__none" ? "" : value })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="__none">无默认值</SelectItem>{variable.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        ) : variable.type === "boolean" ? (
          <Field label="默认状态"><div className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs"><Checkbox checked={variable.default_value === "true"} onCheckedChange={(checked) => onChange({ default_value: checked === true ? "true" : "false" })} />{variable.default_value === "true" ? "开启" : "关闭"}</div></Field>
        ) : (
          <Field label="默认值"><Input type={variable.type === "number" ? "number" : "text"} value={variable.default_value} onChange={(event) => onChange({ default_value: event.target.value })} placeholder="可选" /></Field>
        )}
        {variable.type === "select" ? (
          <div className="sm:col-span-2 xl:col-span-2"><Field label="选项"><Input value={variable.options.join(" / ")} onChange={(event) => { const options = parseVariableOptions(event.target.value); onChange({ options, default_value: options.includes(variable.default_value) ? variable.default_value : options[0] || "" }); }} placeholder="例如 自动 / 极简 / 商业" /></Field></div>
        ) : null}
        <div className="sm:col-span-2 xl:col-span-2"><Field label="输入提示"><Input value={variable.placeholder || ""} onChange={(event) => onChange({ placeholder: event.target.value })} placeholder="可选" /></Field></div>
      </div>
    </article>
  );
}

function WorkflowRunner({ workflow, values, prompt, references, referenceBusy, drafts, draftLoading, batchAppend, models, onValuesChange, onAssetsOpen, onReferencesAdd, onReferenceRemove, onRun, onGenerateDrafts, onRunAll, onRunDraft, onDraftChange, onDraftMove, onDraftDelete, onBatchAppendChange, onBatchAppend, onClose }: { workflow: CreativeWorkflow | null; values: Record<string, string>; prompt: string; references: WorkflowReference[]; referenceBusy: boolean; drafts: WorkflowSeriesDraft[]; draftLoading: boolean; batchAppend: string; models: ModelConfig | null; onValuesChange: (values: Record<string, string>) => void; onAssetsOpen: () => void; onReferencesAdd: (files: FileList | null) => void; onReferenceRemove: (id: string) => void; onRun: () => void; onGenerateDrafts: () => void; onRunAll: () => void; onRunDraft: (draft: WorkflowSeriesDraft, index: number) => void; onDraftChange: (id: string, patch: Partial<WorkflowSeriesDraft>) => void; onDraftMove: (id: string, direction: -1 | 1) => void; onDraftDelete: (id: string) => void; onBatchAppendChange: (value: string) => void; onBatchAppend: () => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!workflow) return null;
  const imageModel = workflow.config.image_model || workflow.config.model || models?.default_image_model || models?.image_models[0] || "";
  const imageSettings = workflowImageSettings(workflow.config);
  const requiredVariables = workflow.variables.filter((variable) => variable.required);
  const completedRequiredVariables = requiredVariables.filter((variable) => String(values[variable.key] || "").trim()).length;
  const missingRequiredVariables = requiredVariables.length - completedRequiredVariables;
  const runningDraftCount = drafts.filter((draft) => draft.status === "running").length;
  const completedDraftCount = drafts.filter((draft) => draft.status === "success").length;
  const runnableDraftCount = drafts.filter((draft) => draft.status !== "running" && draft.status !== "success" && draft.prompt.trim()).length;
  const allDraftsComplete = drafts.length > 0 && completedDraftCount === drafts.length;
  const seriesStep = missingRequiredVariables > 0
    ? 1
    : draftLoading || drafts.length === 0
      ? 2
      : runningDraftCount > 0 || allDraftsComplete
        ? 4
        : 3;
  const seriesNextStep = missingRequiredVariables > 0
    ? `下一步：完成左侧 ${missingRequiredVariables} 个必填项。`
    : draftLoading
      ? "正在拆分多图提示词，生成完成后请逐条审核。"
      : drafts.length === 0
        ? `下一步：生成 ${workflow.series_config.target_count || workflow.config.count || 4} 条提示词草稿。`
        : runningDraftCount > 0
          ? `正在生成 ${runningDraftCount} 张图片，可在任务记录查看进度。`
          : allDraftsComplete
            ? "全部图片已生成，可关闭窗口并在任务记录中查看结果。"
            : `下一步：审核提示词，然后生成${runnableDraftCount ? `剩余 ${runnableDraftCount} 张` : "图片"}。`;
  const imageSize = buildImageSize(imageSettings, { snapToMultiple16: imageSettings.snapToMultiple16 }) || "自动";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent scrollable={false} className="h-[min(92dvh,900px)] w-[min(96vw,1120px)] max-w-none gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2 pr-8">
            <DialogTitle>{workflow.name}</DialogTitle>
            <Badge variant="secondary">{workflow.mode === "multi_image_series" ? "多图生成" : "单图生成"}</Badge>
            <Badge variant="outline">{workflow.variables.length} 个输入</Badge>
          </div>
          <DialogDescription>{workflow.description || "填写内容，确认提示词后启动生成任务。"}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="overscroll-contain p-5 sm:p-6" viewClass="grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
          <section className="rounded-lg border border-border bg-card shadow-sm">
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5">
              <div>
                <h3 className="text-sm font-semibold">填写生成内容</h3>
                <p className="mt-1 text-xs text-muted-foreground">这些内容会自动填入工作流提示词。</p>
              </div>
              {requiredVariables.length ? (
                <Badge variant={completedRequiredVariables === requiredVariables.length ? "success" : "warning"} className="shrink-0 tabular-nums">
                  必填 {completedRequiredVariables}/{requiredVariables.length}
                </Badge>
              ) : null}
            </div>
            <div className="space-y-4 p-4">
              {workflow.variables.length ? workflow.variables.map((variable) => (
                <WorkflowVariableInput
                  key={variable.id}
                  variable={variable}
                  value={values[variable.key] || ""}
                  onChange={(value) => onValuesChange({ ...values, [variable.key]: value })}
                />
              )) : <p className="rounded-lg bg-muted/40 px-3 py-5 text-center text-xs text-muted-foreground">此工作流没有需要填写的变量</p>}
            </div>
            <div className="border-t border-border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">参考图</h3>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={onAssetsOpen}>我的素材</Button>
                  <Button size="sm" variant="outline" disabled={referenceBusy} onClick={() => inputRef.current?.click()}>
                    {referenceBusy ? <LoaderCircle className="animate-spin" /> : <Upload />}
                    上传
                  </Button>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    onReferencesAdd(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              {references.length ? (
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {references.map((reference) => (
                    <div key={reference.id} className="group relative aspect-square overflow-hidden rounded-lg border">
                      <AuthenticatedImage src={reference.url} alt={reference.name} className="size-full object-cover" placeholderClassName="min-h-0" />
                      <button
                        type="button"
                        className="absolute top-1 right-1 grid size-6 place-items-center rounded-md bg-black/70 text-white"
                        onClick={() => onReferenceRemove(reference.id)}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-dashed py-5 text-center text-xs text-muted-foreground">未添加参考图</div>
              )}
            </div>
          </section>
          <div className="space-y-4">
            <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">生成提示词预览</h3>
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(prompt)}><Copy />复制</Button>
              </div>
              <ScrollArea maxHeight="18rem" className="rounded-lg bg-muted/40" viewportClassName="p-3" viewClass="text-xs leading-5 whitespace-pre-wrap">
                {prompt || "填写变量后会在这里预览最终提示词"}
              </ScrollArea>
            </section>
            <section className="overflow-hidden rounded-lg border border-border bg-card">
              <button
                type="button"
                aria-expanded={settingsOpen}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <Settings2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">创作参数</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {imageModel || "默认模型"} · {generationQualityLabel(imageSettings.quality)} · {imageSize} · {imageSettings.count} 张
                  </span>
                </span>
                <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", settingsOpen && "rotate-180")} />
              </button>
              {settingsOpen ? (
                <div className="border-t border-border p-4">
                  <WorkflowImageSettings models={models} model={imageModel} value={imageSettings} readOnly showHeading={false} />
                </div>
              ) : null}
            </section>
          </div>
          {workflow.mode === "multi_image_series" ? (
            <section data-workflow-series-workspace className="overflow-hidden rounded-lg border border-border bg-card lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="size-4" />多图提示词</h3>
                  <Badge variant="outline">{drafts.length} 条</Badge>
                  {completedDraftCount > 0 ? <Badge variant="success">已完成 {completedDraftCount}</Badge> : null}
                  {runningDraftCount > 0 ? <Badge variant="info"><LoaderCircle className="size-3 animate-spin" />生成中 {runningDraftCount}</Badge> : null}
                </div>
                {drafts.length ? (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={draftLoading || runningDraftCount > 0} onClick={onGenerateDrafts}>
                      {draftLoading ? <LoaderCircle className="animate-spin" /> : null}
                      重新生成提示词
                    </Button>
                    <Button size="sm" disabled={!runnableDraftCount || runningDraftCount > 0} onClick={onRunAll}>
                      <Play />生成{runnableDraftCount ? `剩余 ${runnableDraftCount} 张` : "图片"}
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="p-4 sm:p-5">
                <div data-workflow-series-steps className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {["填写内容", "生成提示词", "审核提示词", "生成图片"].map((label, index) => {
                    const step = index + 1;
                    const complete = step < seriesStep || allDraftsComplete && step === 4;
                    const current = step === seriesStep && !allDraftsComplete;
                    return (
                      <div
                        key={label}
                        aria-current={current ? "step" : undefined}
                        className={cn(
                          "flex min-h-10 items-center gap-2 rounded-lg border px-3 text-xs font-medium",
                          complete && "border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/25 dark:text-emerald-300",
                          current && "border-primary/35 bg-primary/[0.05] text-primary",
                          !complete && !current && "border-border text-muted-foreground",
                        )}
                      >
                        <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border text-[10px]", current && "border-primary bg-primary text-primary-foreground")}>
                          {complete ? <CircleCheck className="size-4" /> : step}
                        </span>
                        {label}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex min-h-10 items-center rounded-lg bg-muted/55 px-3 text-xs font-medium text-foreground">
                  {seriesNextStep}
                </div>

                {drafts.length ? (
                  <>
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <Input className="min-w-0 flex-1" value={batchAppend} onChange={(event) => onBatchAppendChange(event.target.value)} placeholder="为所有提示词追加统一要求" />
                      <Button variant="outline" disabled={!batchAppend.trim() || runningDraftCount > 0} onClick={onBatchAppend}>批量追加</Button>
                    </div>
                    <ScrollArea maxHeight="520px" className="mt-4" viewportClassName="pr-2" viewClass="grid gap-3 2xl:grid-cols-2">
                      {drafts.map((draft, index) => (
                        <SeriesDraftCard
                          key={draft.id}
                          draft={draft}
                          index={index}
                          first={index === 0}
                          last={index === drafts.length - 1}
                          onChange={(patch) => onDraftChange(draft.id, patch)}
                          onMove={(direction) => onDraftMove(draft.id, direction)}
                          onDelete={() => onDraftDelete(draft.id)}
                          onRun={() => onRunDraft(draft, index)}
                        />
                      ))}
                    </ScrollArea>
                  </>
                ) : (
                  <div className="mt-4 flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed border-border px-5 text-center">
                    {draftLoading ? <LoaderCircle className="size-6 animate-spin text-primary" /> : <Sparkles className="size-6 text-muted-foreground" />}
                    <p className="mt-3 text-sm font-medium">{draftLoading ? "正在生成多图提示词" : "还没有提示词草稿"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{draftLoading ? "生成后可逐条修改、排序或单独生成。" : "系统会根据工作流规划拆分每张图片的标题和提示词。"}</p>
                    {!draftLoading ? <Button className="mt-4" size="sm" disabled={missingRequiredVariables > 0} onClick={onGenerateDrafts}><Layers3 />生成提示词</Button> : null}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </ScrollArea>
        <DialogFooter flush className="flex-row">
          <p className="mr-auto hidden text-xs text-muted-foreground sm:block">
            {workflow.mode === "multi_image_series"
              ? seriesNextStep
              : requiredVariables.length && completedRequiredVariables < requiredVariables.length
              ? `还有 ${requiredVariables.length - completedRequiredVariables} 个必填项未完成`
              : "内容就绪后即可开始生成"}
          </p>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={completedRequiredVariables < requiredVariables.length || draftLoading || workflow.mode === "multi_image_series" && drafts.length > 0 && (!runnableDraftCount || runningDraftCount > 0)}
            onClick={workflow.mode === "multi_image_series" && drafts.length > 0 ? onRunAll : onRun}
          >
            {draftLoading || runningDraftCount > 0 ? <LoaderCircle className="animate-spin" /> : workflow.mode === "multi_image_series" ? drafts.length ? <Play /> : <Layers3 /> : <Play />}
            {workflow.mode === "multi_image_series"
              ? drafts.length
                ? allDraftsComplete
                  ? "已全部生成"
                  : runningDraftCount > 0
                    ? "正在生成图片"
                    : `生成${runnableDraftCount ? ` ${runnableDraftCount} 张图片` : "图片"}`
                : "生成提示词"
              : "启动任务"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SeriesDraftCard({ draft, index, first, last, onChange, onMove, onDelete, onRun }: { draft: WorkflowSeriesDraft; index: number; first: boolean; last: boolean; onChange: (patch: Partial<WorkflowSeriesDraft>) => void; onMove: (direction: -1 | 1) => void; onDelete: () => void; onRun: () => void }) {
  const statusLabel = draft.status === "success" ? "已完成" : draft.status === "failed" ? "生成失败" : draft.status === "running" ? "生成中" : "待审核";
  const statusVariant: "success" | "danger" | "info" | "warning" = draft.status === "success" ? "success" : draft.status === "failed" ? "danger" : draft.status === "running" ? "info" : "warning";
  const running = draft.status === "running";
  const resultURL = draft.result_ids?.[0] || "";
  return (
    <article data-series-draft-card data-status={draft.status} className={cn("overflow-hidden rounded-lg border bg-background", running ? "border-sky-500/40" : draft.status === "success" ? "border-emerald-500/35" : "border-border")}>
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-3 py-2.5">
        <Badge variant="secondary" className="shrink-0 tabular-nums">{String(index + 1).padStart(2, "0")}</Badge>
        <Input className="h-8 min-w-[150px] flex-1 bg-background font-medium" value={draft.title} aria-label={`第 ${index + 1} 张标题`} onChange={(event) => onChange({ title: event.target.value })} />
        <Badge variant={statusVariant} className="shrink-0">{running ? <LoaderCircle className="size-3 animate-spin" /> : null}{statusLabel}</Badge>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button className="size-8" size="icon" variant="ghost" title="上移" disabled={first || running} onClick={() => onMove(-1)}><ArrowUp /></Button>
          <Button className="size-8" size="icon" variant="ghost" title="下移" disabled={last || running} onClick={() => onMove(1)}><ArrowDown /></Button>
          <Button className="size-8" size="icon" variant="ghost" title="复制提示词" onClick={() => void navigator.clipboard.writeText(draft.prompt)}><Copy /></Button>
          <Button className="size-8" size="icon" variant="ghost" title="删除草稿" disabled={running} onClick={onDelete}><Trash2 /></Button>
        </div>
      </header>
      <div className={cn("grid gap-3 p-3", resultURL && "sm:grid-cols-[132px_minmax(0,1fr)]")}>
        {resultURL ? (
          <div className="relative min-h-32 overflow-hidden rounded-lg border border-border bg-muted/40">
            <AuthenticatedImage src={resultURL} alt={`${draft.title || `第 ${index + 1} 张`}生成结果`} loading="lazy" decoding="async" className="size-full min-h-32 object-cover" placeholderClassName="min-h-32" />
            <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-2 py-1 text-[10px] font-medium text-white">生成结果</span>
          </div>
        ) : running ? (
          <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-sky-500/30 bg-sky-500/[0.04] text-center">
            <LoaderCircle className="size-5 animate-spin text-sky-500" />
            <span className="mt-2 text-xs font-medium text-sky-600 dark:text-sky-300">正在生成图片</span>
          </div>
        ) : null}
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground"><span>图片提示词</span><span className="font-normal tabular-nums">{draft.prompt.length} 字</span></div>
          <div className="overflow-hidden rounded-lg border border-input bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
            <PromptTextareaFrame className="h-32 min-h-32">
              <Textarea className="min-h-full resize-none overflow-hidden rounded-none border-0 bg-transparent px-3 py-2.5 text-sm font-normal leading-6 text-foreground shadow-none focus-visible:ring-0" value={draft.prompt} disabled={running} onChange={(event) => onChange({ prompt: event.target.value, status: draft.status === "success" ? "draft" : draft.status })} />
            </PromptTextareaFrame>
          </div>
        </div>
      </div>
      <div className="flex min-h-12 items-center justify-between gap-3 border-t border-border bg-muted/15 px-3 py-2.5">
        <p className={cn("min-w-0 text-xs leading-5", draft.status === "failed" ? "text-rose-600" : draft.status === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>{draft.error || (draft.status === "success" ? "生成完成，结果已显示在卡片中" : running ? "任务已提交，完成后会在这里显示结果" : "确认标题和提示词无误后生成此图")}</p>
        <Button size="sm" variant={draft.status === "draft" || draft.status === "failed" ? "default" : "outline"} className="shrink-0" disabled={!draft.prompt.trim() || running || draft.status === "success"} onClick={onRun}>
          {running ? <LoaderCircle className="animate-spin" /> : draft.status === "success" ? <CircleCheck /> : <Play />}
          {running ? "生成中" : draft.status === "success" ? "已生成" : "生成此图"}
        </Button>
      </div>
    </article>
  );
}

function WorkflowVariableInput({ variable, value, onChange }: { variable: WorkflowVariable; value: string; onChange: (value: string) => void }) {
  return <label className="grid gap-1.5 text-xs"><span className="font-medium">{variable.label || variable.key}{variable.required ? " *" : ""}</span>{variable.type === "textarea" ? <Textarea rows={3} value={value} placeholder={variable.placeholder || variable.default_value} onChange={(event) => onChange(event.target.value)} /> : variable.type === "select" ? <Select value={value || "__none"} onValueChange={(next) => onChange(next === "__none" ? "" : next)}><SelectTrigger><SelectValue placeholder={variable.placeholder || "请选择"} /></SelectTrigger><SelectContent><SelectItem value="__none">请选择</SelectItem>{variable.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select> : variable.type === "boolean" ? <label className="flex h-9 items-center gap-2 rounded-lg border px-3"><Checkbox checked={value === "true"} onCheckedChange={(checked) => onChange(checked === true ? "true" : "false")} />{value === "true" ? "开启" : "关闭"}</label> : <Input type={variable.type === "number" ? "number" : "text"} value={value} placeholder={variable.placeholder || variable.default_value} onChange={(event) => onChange(event.target.value)} />}</label>;
}

type AgentDialogProps = {
  open: boolean;
  prompt: string;
  scope: "private" | "public";
  model: string;
  models: ModelConfig | null;
  references: WorkflowReference[];
  draft: CreativeWorkflow | null;
  warnings: string[];
  busy: boolean;
  onPromptChange: (value: string) => void;
  onScopeChange: (value: "private" | "public") => void;
  onModelChange: (value: string) => void;
  onAssetsOpen: () => void;
  onReferencesAdd: (files: FileList | null) => void;
  onReferenceRemove: (id: string) => void;
  onRun: () => void;
  onApply: () => void;
  onClose: () => void;
};

function AgentDialog({
  open,
  prompt,
  scope,
  model,
  models,
  references,
  draft,
  warnings,
  busy,
  onPromptChange,
  onScopeChange,
  onModelChange,
  onAssetsOpen,
  onReferencesAdd,
  onReferenceRemove,
  onRun,
  onApply,
  onClose,
}: AgentDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="w-[min(96vw,980px)]">
        <DialogHeader>
          <DialogTitle>Agent</DialogTitle>
          <DialogDescription>描述目标、变量和图片结果。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select value={scope} onValueChange={onScopeChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">个人工作流</SelectItem>
                  <SelectItem value="public">公开工作流</SelectItem>
                </SelectContent>
              </Select>
              <Select value={model || "__default"} onValueChange={(value) => onModelChange(value === "__default" ? "" : value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">默认文本模型</SelectItem>
                  {(models?.text_models || []).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Textarea rows={12} value={prompt} onChange={(event) => onPromptChange(event.target.value)} placeholder="例如：创建一个电商海报工作流，只需要输入产品名称、核心卖点、活动信息，固定商业摄影质感和营销文案结构。" />
            <section className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">参考图</h3>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={onAssetsOpen}>我的素材</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}><Upload />上传</Button>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    onReferencesAdd(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              {references.length ? (
                <div className="mt-3 grid grid-cols-5 gap-2">
                  {references.map((reference) => (
                    <div key={reference.id} className="group relative aspect-square overflow-hidden rounded-lg border">
                      <AuthenticatedImage src={reference.url} alt={reference.name} className="size-full object-cover" placeholderClassName="min-h-0" />
                      <button type="button" className="absolute top-1 right-1 grid size-6 place-items-center rounded-md bg-black/70 text-white" onClick={() => onReferenceRemove(reference.id)}>
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
            <Button className="w-full" disabled={busy || !prompt.trim()} onClick={onRun}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              生成工作流草稿
            </Button>
          </div>
          <aside className="space-y-3 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold">草稿预览</h3>
            {draft ? (
              <>
                <div>
                  <p className="font-semibold">{draft.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{draft.category || "未分类"} · {draft.variables.length} 个变量 · {draft.scope === "public" ? "公开" : "个人"}</p>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{draft.description || "暂无描述"}</p>
                <ScrollArea maxHeight="16rem" className="rounded-lg bg-muted/50" viewportClassName="p-3" viewClass="whitespace-pre-wrap text-xs leading-5">{draft.config.prompt_template}</ScrollArea>
                {warnings.length ? (
                  <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                    {warnings.map((warning) => <p key={warning}>{warning}</p>)}
                  </div>
                ) : null}
                <Button className="w-full" onClick={onApply}><Pencil />应用到编辑器</Button>
              </>
            ) : (
              <div className="grid min-h-56 place-items-center rounded-lg border border-dashed text-xs text-muted-foreground">暂无草稿</div>
            )}
          </aside>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowAssetPicker({ open, assets, loading, onInsert, onClose }: { open: boolean; assets: MyAsset[]; loading: boolean; onInsert: (asset: MyAsset) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = assets.filter((asset) => {
    const text = query.trim().toLowerCase();
    return !text || [asset.title, asset.content, asset.source, ...(asset.tags || [])].some((value) => String(value || "").toLowerCase().includes(text));
  });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(94vw,900px)]">
        <DialogHeader><DialogTitle>我的素材</DialogTitle><DialogDescription>选择文本填入变量或提示词，选择图片作为参考图。</DialogDescription></DialogHeader>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索素材" />
        </div>
        <ScrollArea className="h-[min(58vh,560px)]" viewportClassName="pr-3">
          {loading ? (
            <div className="grid h-48 place-items-center text-sm text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>
          ) : filtered.length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((asset) => (
                <button key={asset.id} type="button" data-interaction="primary" className="interactive-card min-w-0 overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm" onClick={() => onInsert(asset)}>
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/50">
                    {asset.kind === "image" && asset.url ? <AuthenticatedImage src={asset.url} alt={asset.title} className="size-full object-cover" placeholderClassName="min-h-0" /> : asset.kind === "video" && asset.url ? <video src={`${asset.url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" /> : <p className="line-clamp-6 p-4 text-xs leading-5 text-muted-foreground">{asset.content || (asset.kind === "audio" ? "音频素材" : "媒体素材")}</p>}
                  </div>
                  <div className="p-3"><p className="truncate text-sm font-semibold">{asset.title}</p><p className="mt-1 text-xs text-muted-foreground">{asset.kind === "text" ? "文本" : asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "音频"}</p></div>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid h-48 place-items-center text-sm text-muted-foreground">暂无素材</div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-xs"><span className="font-medium text-muted-foreground">{label}</span>{children}</label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex w-full items-center justify-between gap-2 text-xs"><span>{label}</span><Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} /></label>;
}
