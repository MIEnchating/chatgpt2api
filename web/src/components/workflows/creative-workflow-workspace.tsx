"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
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
  renderWorkflowPrompt,
  resolveWorkflowRuntime,
  readStoredWorkflowGenerationDefaults,
  type WorkflowGenerationDefaults,
  type WorkflowSeriesDraft,
} from "@/app/workflows/workflow-runtime";
import {
  creationTaskImages,
  restoreWorkflowTasks,
  workflowTaskFailureEvent,
  workflowTaskStartEvent,
  workflowTaskSuccessEvent,
  type WorkflowExternalTaskFailure,
  type WorkflowExternalTaskStart,
  type WorkflowExternalTaskSuccess,
  type WorkflowTask,
} from "@/app/workflows/workflow-task-runtime";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TooltipButton } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/page-header";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useMyAssets } from "@/app/assets/use-my-assets";
import {
  createChatGenerationTask,
  createImageEditTask,
  createImageGenerationTask,
  fetchCreationTasks,
  fetchModelConfig,
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
import { getStoredRelayTokenName } from "@/lib/relay-token-selection";
import type { MyAsset } from "@/lib/my-assets";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { useImageGenerationPreferences } from "@/lib/use-image-generation-preferences";
import { cn } from "@/lib/utils";

type WorkflowReference = {
  id: string;
  name: string;
  url: string;
  storageKey?: string;
  temporary?: boolean;
};

export type {
  WorkflowExternalTaskFailure,
  WorkflowExternalTaskStart,
  WorkflowExternalTaskSuccess,
  WorkflowRunResult,
} from "@/app/workflows/workflow-task-runtime";

type CreativeWorkflowWorkspaceProps = {
  embedded?: boolean;
  hideTaskList?: boolean;
  generationDefaults?: WorkflowGenerationDefaults;
  onGenerationLogSaved?: () => void;
  onWorkflowTaskStarted?: (task: WorkflowExternalTaskStart) => void;
  onWorkflowTaskSuccess?: (task: WorkflowExternalTaskSuccess) => void;
  onWorkflowTaskFailure?: (task: WorkflowExternalTaskFailure) => void;
};

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

async function waitForTask(id: string, timeoutSeconds: number) {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const response = await fetchCreationTasks([id]);
    const task = response.items?.[0];
    if (task?.status === "success") return task;
    if (task?.status === "error" || task?.status === "cancelled") {
      throw new Error(task.error || "任务执行失败");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }
  throw new Error("任务执行超时");
}

async function workflowImageFiles(references: WorkflowReference[]) {
  return Promise.all(
    references.map(async (reference, index) => {
      const response = await fetch(reference.url, { credentials: "include" });
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
  onGenerationLogSaved,
  onWorkflowTaskStarted,
  onWorkflowTaskSuccess,
  onWorkflowTaskFailure,
}: CreativeWorkflowWorkspaceProps = {}) {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/workflows");
  const { preferences } = useImageGenerationPreferences(session?.key || "");
  const storedGenerationDefaults = useMemo(readStoredWorkflowGenerationDefaults, []);
  const sessionTextChannelID = session ? getStoredRelayTokenName(session, "text") : "";
  const generationImageModel = generationDefaults?.image_model;
  const generationModel = generationDefaults?.model;
  const generationTextModel = generationDefaults?.text_model;
  const generationTextChannelID = generationDefaults?.text_channel_id;
  const generationQuality = generationDefaults?.quality;
  const generationSize = generationDefaults?.size;
  const generationCount = generationDefaults?.count;
  const effectiveGenerationDefaults = useMemo(
    () => ({
      ...storedGenerationDefaults,
      ...(session ? { text_channel_id: sessionTextChannelID } : {}),
      ...(generationImageModel !== undefined ? { image_model: generationImageModel } : {}),
      ...(generationModel !== undefined ? { model: generationModel } : {}),
      ...(generationTextModel !== undefined ? { text_model: generationTextModel } : {}),
      ...(generationTextChannelID !== undefined ? { text_channel_id: generationTextChannelID } : {}),
      ...(generationQuality !== undefined ? { quality: generationQuality } : {}),
      ...(generationSize !== undefined ? { size: generationSize } : {}),
      ...(generationCount !== undefined ? { count: generationCount } : {}),
    }),
    [
      generationCount,
      generationImageModel,
      generationModel,
      generationQuality,
      generationSize,
      generationTextChannelID,
      generationTextModel,
      session,
      sessionTextChannelID,
      storedGenerationDefaults,
    ],
  );
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
  const [editing, setEditing] = useState<CreativeWorkflow | null>(null);
  const [running, setRunning] = useState<CreativeWorkflow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<WorkflowReference[]>([]);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [seriesDrafts, setSeriesDrafts] = useState<WorkflowSeriesDraft[]>([]);
  const [seriesDraftLoading, setSeriesDraftLoading] = useState(false);
  const [seriesBatchAppend, setSeriesBatchAppend] = useState("");
  const [tasks, setTasks] = useState<WorkflowTask[]>([]);
  const [now, setNow] = useState(Date.now());
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentScope, setAgentScope] = useState<"private" | "public">("private");
  const [agentModel, setAgentModel] = useState("");
  const [agentChannelID, setAgentChannelID] = useState("");
  const [agentReferences, setAgentReferences] = useState<WorkflowReference[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDraft, setAgentDraft] = useState<CreativeWorkflow | null>(null);
  const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
  const [assetPickerTarget, setAssetPickerTarget] = useState<"workflow" | "agent" | null>(null);
  const reportedTaskStartsRef = useRef(new Set<string>());
  const reportedTerminalTasksRef = useRef(new Set<string>());

  useEffect(() => {
    if (!session) return;
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
            normalizeWorkflow(workflow, modelConfig, preferences, effectiveGenerationDefaults),
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
        const starters = createStarterWorkflows(modelConfig, preferences, effectiveGenerationDefaults);
        const saved = await Promise.all(starters.map((workflow) => saveWorkflow(workflow)));
        if (!ignore) setItems(saved);
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "工作流加载失败"),
      )
      .finally(() => !ignore && setLoading(false));
    return () => {
      ignore = true;
    };
  }, [effectiveGenerationDefaults, preferences, session]);

  useEffect(() => {
    if (!agentModel && models?.default_text_model) {
      setAgentModel(preferences.default_text_model || models.default_text_model);
    }
  }, [agentModel, models, preferences.default_text_model]);

  const runningWorkflowTaskIDs = tasks
    .filter((task) => task.status === "running")
    .flatMap((task) => task.backend_task_ids)
    .join(",");
  const runningTaskCount = tasks.filter((task) => task.status === "running").length;

  useEffect(() => {
    if (!runningTaskCount) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningTaskCount]);

  useEffect(() => {
    for (const task of tasks) {
      if (!reportedTaskStartsRef.current.has(task.id)) {
        reportedTaskStartsRef.current.add(task.id);
        onWorkflowTaskStarted?.(workflowTaskStartEvent(task));
      }
      if (task.status === "running" || reportedTerminalTasksRef.current.has(task.id)) continue;
      reportedTerminalTasksRef.current.add(task.id);
      if (task.status === "success") {
        onWorkflowTaskSuccess?.(workflowTaskSuccessEvent(task));
      } else {
        onWorkflowTaskFailure?.(workflowTaskFailureEvent(task));
      }
      onGenerationLogSaved?.();
    }
  }, [onGenerationLogSaved, onWorkflowTaskFailure, onWorkflowTaskStarted, onWorkflowTaskSuccess, tasks]);

  useEffect(() => {
    if (!runningWorkflowTaskIDs) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetchCreationTasks(runningWorkflowTaskIDs.split(","));
        if (stopped) return;
        const updates = new Map(
          restoreWorkflowTasks(response.items).map((task) => [task.id, task]),
        );
        setTasks((current) => current.map((task) => updates.get(task.id) || task));
      } catch {
        // Keep the durable task visible and retry on the next interval.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
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
      const saved = await saveWorkflow(normalizeWorkflow(workflow, models, preferences, effectiveGenerationDefaults));
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
      effectiveGenerationDefaults,
    );
    try {
      const saved = await saveWorkflow(copy);
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
        setItems((current) => current.map((item) => (item.id === saved.id ? saved : item)));
        setRunning((current) => (current?.id === saved.id ? saved : current));
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
  ) {
    if (!session) throw new Error("登录状态已失效");
    const config = workflow.config;
    const runtime = resolveWorkflowRuntime(workflow, models, preferences);
    const model = runtime.model;
    const count = Math.max(1, Math.min(10, countOverride || Number(config.count) || 1));
    const quality = ["low", "medium", "high"].includes(config.quality)
      ? (config.quality as ImageQuality)
      : undefined;
    const stream = preferences.stream;
    const partialImages = preferences.partial_images || undefined;
    const relayTokenName = getStoredRelayTokenName(session, "image");
    const execution = {
      stream,
      partial_images: preferences.partial_images,
      response_format_b64_json: preferences.response_format_b64_json,
      codex_cli_compatibility: preferences.codex_cli_compatibility,
      token_name: relayTokenName || undefined,
    };
    const localTaskID = taskID("workflow-image");
    const startedAt = Date.now();
    const taskConfig = {
      ...config,
      model,
      image_model: model,
      api_mode: runtime.api_mode,
      system_prompt: runtime.system_prompt,
      count: String(count),
    };
    const seriesIndex = draft ? Math.max(0, seriesDraftIndex || 0) + 1 : undefined;
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
        count,
        backend_task_ids: [],
    };
    setTasks((current) => [taskSnapshot, ...current]);
    reportedTaskStartsRef.current.add(localTaskID);
    onWorkflowTaskStarted?.(workflowTaskStartEvent(taskSnapshot));
    if (draft) patchSeriesDraft(draft.id, { status: "running", error: undefined });
    let completedImages: WorkflowTask["images"] = [];
    try {
      const imageFiles = references.length ? await workflowImageFiles(references) : [];
      const settled = await Promise.allSettled(
        Array.from({ length: count }, async (_, index) => {
          const clientTaskID = count === 1 ? localTaskID : `${localTaskID}-${index + 1}`;
          const workflowContext = {
            workflow_id: workflow.id,
            workflow_name: workflow.name,
            prompt,
            inputs: { ...values },
            references: references.map((reference) => ({ ...reference })),
            config: { ...taskConfig, count: "1" },
            execution,
            count: 1,
            batch_task_id: localTaskID,
            batch_index: index + 1,
            batch_count: count,
            ...(draft?.title ? { series_title: draft.title } : {}),
            ...(seriesIndex ? { series_index: seriesIndex } : {}),
          };
          const toolOptions = {
            apiMode: runtime.api_mode,
            responseFormatB64JSON: preferences.response_format_b64_json,
            codexCLICompatibility: preferences.codex_cli_compatibility,
            systemPrompt: runtime.system_prompt,
            workflowContext,
          };
          const submitted = imageFiles.length
            ? await createImageEditTask(clientTaskID, imageFiles, prompt, model, config.size || undefined, undefined, quality, 1, "private", undefined, undefined, undefined, stream, partialImages, toolOptions, undefined, relayTokenName || undefined)
            : await createImageGenerationTask(clientTaskID, prompt, model, config.size || undefined, undefined, quality, 1, "private", undefined, undefined, undefined, stream, partialImages, toolOptions, undefined, relayTokenName || undefined);
          setTasks((current) => current.map((task) =>
            task.id === localTaskID
              ? {
                  ...task,
                  backend_task_ids: Array.from(new Set([...task.backend_task_ids, submitted.id])),
                }
              : task,
          ));
          return waitForTask(submitted.id, Number(config.timeout) || 600);
        }),
      );
      const completed = settled.flatMap((item, index) =>
        item.status === "fulfilled" ? [{ task: item.value, index }] : [],
      );
      const failures = settled
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason || "任务执行失败"));
      const images = completed.flatMap(({ task, index }) =>
        creationTaskImages(task).map((image) => ({ ...image, index })),
      );
      const imageURLs = images.map((image) => image.url);
      completedImages = images;
      if (!imageURLs.length) throw new Error(failures[0] || "接口没有返回图片");
      const endedAt = Date.now();
      const partialError = failures.join("\n") || undefined;
      setTasks((current) =>
        current.map((task) =>
          task.id === localTaskID
            ? { ...task, status: partialError ? "failed" : "success", ended_at: endedAt, image_urls: imageURLs, images, error: partialError }
            : task,
        ),
      );
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
      markWorkflowRunCompleted(workflow, endedAt);
      const completedTask = { ...taskSnapshot, status: "success" as const, ended_at: endedAt, image_urls: imageURLs, images };
      reportedTerminalTasksRef.current.add(localTaskID);
      onWorkflowTaskSuccess?.(workflowTaskSuccessEvent(completedTask));
      onGenerationLogSaved?.();
      return imageURLs;
    } catch (error) {
      const message = error instanceof Error ? error.message : "工作流运行失败";
      const endedAt = Date.now();
      setTasks((current) =>
        current.map((task) =>
          task.id === localTaskID
            ? { ...task, status: "failed", ended_at: endedAt, error: message }
            : task,
        ),
      );
      if (draft) patchSeriesDraft(draft.id, { status: "failed", error: message });
      const failedTask = { ...taskSnapshot, status: "failed" as const, ended_at: endedAt, error: message, images: completedImages, image_urls: completedImages.map((image) => image.url) };
      reportedTerminalTasksRef.current.add(localTaskID);
      onWorkflowTaskFailure?.(workflowTaskFailureEvent(failedTask));
      onGenerationLogSaved?.();
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
    try {
      await executeImageTask(running, renderedPrompt);
      toast.success("工作流运行完成");
    } catch (error) {
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
        running.series_config.prompt_model ||
        preferences.default_text_model ||
        models?.default_text_model ||
        "";
      const submitted = await createChatGenerationTask({
        clientTaskId: taskID("workflow-series"),
        prompt,
        model,
        relayTokenName:
          running.series_config.prompt_channel_id ||
          (session ? getStoredRelayTokenName(session, "text") : ""),
        messages: [{ role: "user", content: prompt }],
      });
      const completed = await waitForTask(
        submitted.id,
        Number(running.config.timeout) || 600,
      );
      const drafts = parseWorkflowSeriesDrafts(taskText(completed), count, renderedPrompt);
      setSeriesDrafts(drafts);
      toast.success("多图提示词已生成，请审核后生成图片");
      if (running.series_config.review_required === false) {
        window.setTimeout(() => {
          drafts.forEach((draft, index) => void runOneSeriesDraft(draft, index));
        }, 0);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "系列提示词生成失败");
    } finally {
      setSeriesDraftLoading(false);
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

  async function runOneSeriesDraft(draft: WorkflowSeriesDraft, index: number) {
    if (!running || !draft.prompt.trim() || draft.status === "running") return;
    try {
      await executeImageTask(running, draft.prompt.trim(), 1, draft, index);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "系列图片生成失败");
    }
  }

  async function runAllSeriesDrafts(source = seriesDrafts) {
    if (!running) return;
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
    for (let index = 0; index < drafts.length; index += concurrency) {
      await Promise.all(
        drafts.slice(index, index + concurrency).map((draft) =>
          runOneSeriesDraft(
            draft,
            Math.max(0, seriesDrafts.findIndex((item) => item.id === draft.id)),
          ),
        ),
      );
    }
  }

  async function draftWithAgent() {
    if (!session || !agentPrompt.trim() || agentBusy) return;
    setAgentBusy(true);
    try {
      const response = await draftWorkflowWithAgent({
        prompt: agentPrompt.trim(),
        scope: agentScope,
        model:
          agentModel || preferences.default_text_model || models?.default_text_model || "",
        channelID: agentChannelID || getStoredRelayTokenName(session, "text"),
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
        effectiveGenerationDefaults,
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
          effectiveGenerationDefaults,
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
      <Button variant="outline" onClick={() => setEditing(createBlankWorkflow(models, preferences, "multi_image_series", effectiveGenerationDefaults))}><Layers3 />新建多图</Button>
      <Button onClick={() => setEditing(createBlankWorkflow(models, preferences, "single_image", effectiveGenerationDefaults))}><Plus />新建工作流</Button>
    </>
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", embedded ? "bg-background" : "gap-5")}>
      {!embedded ? <PageHeader actions={workflowActions} /> : null}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-background", !embedded && "rounded-xl border border-border")}>
        <header className={cn("shrink-0 border-b border-border px-5 py-3 sm:px-8", embedded && "pr-14 sm:pr-14")}>
          <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="shrink-0">
              <h1 className="text-base font-semibold">创意工作流</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {items.length} 个模板 · {tasks.filter((task) => task.status === "running").length} 个任务运行中
              </p>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
              <div className="relative w-full min-w-[220px] flex-1">
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
              {embedded ? workflowActions : null}
            </div>
          </div>
        </header>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-5 py-5 sm:px-8">
          <div className="flex w-full flex-col gap-5">
            {filteredItems.length ? (
              <div data-workflow-grid className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {filteredItems.map((workflow) => (
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
            ) : (
              <div className="grid min-h-72 place-items-center text-center text-sm text-muted-foreground">暂无工作流</div>
            )}
            {!hideTaskList && tasks.length ? (
              <section className="border-t border-border pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">工作流任务</h2>
                  <Button size="sm" variant="outline" onClick={() => setTasks((current) => current.filter((task) => task.status === "running"))}>清理已完成</Button>
                </div>
                <div data-workflow-task-grid className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {tasks.map((task) => <WorkflowTaskCard key={task.id} task={task} now={now} />)}
                </div>
              </section>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      <WorkflowEditor workflow={editing} models={models} preferences={preferences} onChange={setEditing} onSave={persist} onClose={() => setEditing(null)} />
      <WorkflowRunner
        workflow={running}
        values={values}
        prompt={renderedPrompt}
        references={references}
        referenceBusy={referenceBusy}
        drafts={seriesDrafts}
        draftLoading={seriesDraftLoading}
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
        channelID={agentChannelID}
        models={models}
        references={agentReferences}
        draft={agentDraft}
        warnings={agentWarnings}
        busy={agentBusy || referenceBusy}
        onPromptChange={setAgentPrompt}
        onScopeChange={setAgentScope}
        onModelChange={setAgentModel}
        onChannelIDChange={setAgentChannelID}
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
    </div>
  );
}

function WorkflowCard({ workflow, onRun, onEdit, onCopy, onDelete }: { workflow: CreativeWorkflow; onRun: () => void; onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
  return (
    <article data-interaction="controls" className="interactive-card group flex min-h-48 flex-col rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#edf4ff] text-[#1456f0] dark:bg-blue-950/40 dark:text-blue-300"><WorkflowIcon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-sm font-semibold">{workflow.name}</h2><span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">{workflow.scope === "public" ? <Globe2 className="size-3" /> : <LockKeyhole className="size-3" />}{workflow.scope === "public" ? "公开" : "个人"}</span></div>
          <p className="mt-1 text-xs text-muted-foreground">{workflow.category || "未分类"}</p>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 flex-1 text-xs leading-5 text-muted-foreground">{workflow.description || workflow.config.prompt_template}</p>
      <p className="mt-3 text-[11px] text-muted-foreground">{workflow.variables.length} 个变量 · {workflow.mode === "multi_image_series" ? "多图生成" : "单图生成"}{workflow.last_run_at ? ` · ${new Date(workflow.last_run_at).toLocaleString("zh-CN")}` : ""}</p>
      <div className="mt-3 flex items-center gap-1 border-t border-border/70 pt-3">
        <Button size="sm" onClick={onRun}><Play />运行</Button>
        {workflow.editable !== false ? <Button size="icon" variant="ghost" title="编辑" onClick={onEdit}><Pencil /></Button> : null}
        <Button size="icon" variant="ghost" title="复制" onClick={onCopy}><Copy /></Button>
        {workflow.editable !== false ? <Button size="icon" variant="ghost" className="ml-auto text-rose-600" title="删除" onClick={onDelete}><Trash2 /></Button> : null}
      </div>
    </article>
  );
}

function WorkflowTaskCard({ task, now }: { task: WorkflowTask; now: number }) {
  const elapsed = Math.max(0, (task.ended_at || now) - task.started_at);
  const duration = elapsed < 60_000
    ? `${Math.max(1, Math.round(elapsed / 1000))} 秒`
    : `${Math.floor(elapsed / 60_000)} 分 ${Math.round((elapsed % 60_000) / 1000)} 秒`;
  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <ImageIcon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">{task.series_title ? `${task.workflow_name} · ${task.series_title}` : task.workflow_name}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{new Date(task.started_at).toLocaleString("zh-CN")} · {duration}</p>
        </div>
        {task.status === "running" ? <LoaderCircle className="size-4 animate-spin" /> : <span className={cn("text-[11px]", task.status === "failed" ? "text-rose-600" : "text-emerald-600")}>{task.status === "failed" ? "失败" : "完成"}</span>}
        <Button size="icon" variant="ghost" title="复制提示词" onClick={() => void navigator.clipboard.writeText(task.prompt)}><Copy /></Button>
      </div>
      <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{task.prompt}</p>
      <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
        {[task.model, task.config.size || "auto", task.config.quality || "auto", `${task.count} 张`].map((value, index) => <span key={`${index}-${value}`} className="rounded-md border bg-muted/50 px-1.5 py-0.5">{value}</span>)}
      </div>
      {Object.entries(task.inputs).some(([, value]) => String(value).trim()) ? <div className="mt-2 flex flex-wrap gap-1">{Object.entries(task.inputs).filter(([, value]) => String(value).trim()).slice(0, 6).map(([key, value]) => <span key={key} className="max-w-full truncate rounded-md border px-1.5 py-0.5 text-[10px]"><strong>{key}</strong>: {value}</span>)}</div> : null}
      {task.error ? <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{task.error}</p> : null}
      {task.images.length ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{task.images.map((image, index) => <div key={`${image.url}-${index}`} className="group overflow-hidden rounded-lg border bg-muted"><div className="relative aspect-square"><img src={image.url} alt={`${task.workflow_name} ${index + 1}`} className="size-full object-cover" /><TooltipButton type="button" tooltip="下载" className="absolute right-1 bottom-1 grid size-7 place-items-center rounded-md bg-black/70 text-white opacity-0 group-hover:opacity-100" onClick={() => void downloadWorkflowImage(image.url, `workflow-task-${index + 1}.png`).catch((error) => toast.error(error instanceof Error ? error.message : "图片下载失败"))}><Download className="size-3.5" /></TooltipButton></div>{image.width || image.height || image.bytes ? <p className="truncate px-1.5 py-1 text-[10px] text-muted-foreground">{image.width && image.height ? `${image.width}x${image.height}` : ""}{image.bytes ? `${image.width && image.height ? " · " : ""}${formatWorkflowBytes(image.bytes)}` : ""}</p> : null}</div>)}</div> : task.status === "running" ? <div className="mt-3 flex h-24 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">生成中 {duration}</div> : null}
    </article>
  );
}

function formatWorkflowBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function WorkflowEditor({ workflow, models, preferences, onChange, onSave, onClose }: { workflow: CreativeWorkflow | null; models: ModelConfig | null; preferences: ImageGenerationPreferences; onChange: (workflow: CreativeWorkflow | null) => void; onSave: (workflow: CreativeWorkflow) => void; onClose: () => void }) {
  if (!workflow) return null;
  const patch = (value: Partial<CreativeWorkflow>) => onChange({ ...workflow, ...value });
  const patchConfig = (value: Partial<WorkflowGenerationConfig>) => patch({ config: { ...workflow.config, ...value } });
  const patchSeries = (value: Partial<WorkflowSeriesConfig>) => patch({ series_config: { ...workflow.series_config, ...value } });
  const patchVariable = (id: string, value: Partial<WorkflowVariable>) => patch({ variables: workflow.variables.map((item) => item.id === id ? { ...item, ...value } : item) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(96vw,1100px)]">
        <DialogHeader><DialogTitle>{workflow.id ? "编辑工作流" : "新建工作流"}</DialogTitle><DialogDescription>把固定提示词和生成参数沉淀为模板，运行时只填写变量。</DialogDescription></DialogHeader>
        <div className="grid gap-4 pr-1 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <section className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              <Input value={workflow.name} onChange={(event) => patch({ name: event.target.value })} placeholder="工作流名称" />
              <Input value={workflow.category} onChange={(event) => patch({ category: event.target.value })} placeholder="分类" />
              <Select value={workflow.mode} onValueChange={(mode: CreativeWorkflow["mode"]) => patch({ mode })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="single_image">单图生成</SelectItem><SelectItem value="multi_image_series">多图生成</SelectItem></SelectContent></Select>
              <Select value={workflow.scope} onValueChange={(scope: CreativeWorkflow["scope"]) => patch({ scope })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="private">个人工作流</SelectItem><SelectItem value="public">公开工作流</SelectItem></SelectContent></Select>
              <Textarea className="sm:col-span-2" rows={2} value={workflow.description} onChange={(event) => patch({ description: event.target.value })} placeholder="适用场景说明" />
            </section>
            <section className="rounded-lg border border-border p-3">
              <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">输入变量</h3><Button size="sm" variant="outline" onClick={() => patch({ variables: [...workflow.variables, createWorkflowVariable()] })}><Plus />添加变量</Button></div>
              <div className="space-y-2">{workflow.variables.map((variable) => <VariableEditor key={variable.id} variable={variable} onChange={(value) => patchVariable(variable.id, value)} onDelete={() => patch({ variables: workflow.variables.filter((item) => item.id !== variable.id) })} />)}</div>
            </section>
            <section className="space-y-3 rounded-lg border border-border p-3">
              <h3 className="text-sm font-semibold">提示词模板</h3>
              <Textarea rows={2} value={workflow.config.system_prompt} onChange={(event) => patchConfig({ system_prompt: event.target.value })} placeholder="系统提示词，可选" />
              <Textarea rows={7} value={workflow.config.prompt_template} onChange={(event) => patchConfig({ prompt_template: event.target.value })} placeholder="用户提示词模板，使用 {{变量名}} 插入变量" />
              <Textarea rows={2} value={workflow.config.negative_prompt} onChange={(event) => patchConfig({ negative_prompt: event.target.value })} placeholder="负面约束，可选" />
            </section>
          </div>
          <aside className="space-y-3 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold">生成配置</h3>
            <Field label="图片模型"><Select value={workflow.config.image_model || "__default"} onValueChange={(value) => patchConfig({ image_model: value === "__default" ? "" : value, model: value === "__default" ? "" : value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default">默认图片模型</SelectItem>{(models?.image_models || []).map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent></Select></Field>
            {workflow.mode === "multi_image_series" ? <section className="space-y-3 rounded-lg bg-muted/50 p-3"><h4 className="flex items-center gap-2 text-xs font-semibold"><Layers3 className="size-4" />多图提示词规划</h4><Field label="文本模型"><Select value={workflow.series_config.prompt_model || "__default"} onValueChange={(value) => patchSeries({ prompt_model: value === "__default" ? "" : value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default">默认文本模型</SelectItem>{(models?.text_models || []).map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent></Select></Field><Field label="文本渠道 / Token 名"><Input value={workflow.series_config.prompt_channel_id} onChange={(event) => patchSeries({ prompt_channel_id: event.target.value })} placeholder="留空使用个人默认" /></Field><div className="grid grid-cols-2 gap-2"><Field label="张数"><Input type="number" min={1} max={20} value={workflow.series_config.target_count} onChange={(event) => patchSeries({ target_count: event.target.value })} /></Field><Field label="并发"><Input type="number" min={1} max={6} value={workflow.series_config.concurrency} onChange={(event) => patchSeries({ concurrency: event.target.value })} /></Field></div><Textarea rows={4} value={workflow.series_config.prompt_instruction} onChange={(event) => patchSeries({ prompt_instruction: event.target.value })} placeholder="系列拆分说明" /><Toggle label="先审核提示词" checked={workflow.series_config.review_required} onChange={(checked) => patchSeries({ review_required: checked })} /></section> : null}
            <div className="grid grid-cols-2 gap-2"><Field label="尺寸"><Input value={workflow.config.size} onChange={(event) => patchConfig({ size: event.target.value })} placeholder="auto / 1024x1024" /></Field><Field label="质量"><Select value={workflow.config.quality} onValueChange={(quality) => patchConfig({ quality })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">自动</SelectItem><SelectItem value="low">低</SelectItem><SelectItem value="medium">中</SelectItem><SelectItem value="high">高</SelectItem></SelectContent></Select></Field><Field label="数量"><Input type="number" min={1} max={10} value={workflow.config.count} onChange={(event) => patchConfig({ count: event.target.value })} /></Field><Field label="超时（秒）"><Input type="number" min={1} max={3600} value={workflow.config.timeout} onChange={(event) => patchConfig({ timeout: event.target.value })} /></Field></div>
            {!workflow.config.system_prompt && preferences.system_prompt ? <Button size="sm" variant="outline" onClick={() => patchConfig({ system_prompt: preferences.system_prompt })}>使用当前系统提示词</Button> : null}
          </aside>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button disabled={!workflow.name.trim() || !workflow.config.prompt_template.trim()} onClick={() => onSave(workflow)}><Save />保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VariableEditor({ variable, onChange, onDelete }: { variable: WorkflowVariable; onChange: (value: Partial<WorkflowVariable>) => void; onDelete: () => void }) {
  return <div className="grid gap-2 rounded-lg bg-muted/50 p-2 sm:grid-cols-[1fr_1fr_130px_auto]">
    <Input value={variable.key} onChange={(event) => onChange({ key: event.target.value.replace(/[^\w.-]/g, "_") })} placeholder="变量名" />
    <Input value={variable.label} onChange={(event) => onChange({ label: event.target.value })} placeholder="显示名称" />
    <Select value={variable.type} onValueChange={(type: WorkflowVariable["type"]) => onChange({ type })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="text">短文本</SelectItem><SelectItem value="textarea">长文本</SelectItem><SelectItem value="number">数字</SelectItem><SelectItem value="select">选项</SelectItem><SelectItem value="boolean">开关</SelectItem></SelectContent></Select>
    <div className="flex items-center gap-2"><label className="flex items-center gap-1.5 text-xs"><Checkbox checked={variable.required} onCheckedChange={(checked) => onChange({ required: checked === true })} />必填</label><Button size="icon" variant="ghost" title="删除变量" onClick={onDelete}><Trash2 /></Button></div>
    {variable.type === "select" ? <><Input className="sm:col-span-2" value={variable.options.join(" / ")} onChange={(event) => { const options = parseVariableOptions(event.target.value); onChange({ options, default_value: options.includes(variable.default_value) ? variable.default_value : options[0] || "" }); }} placeholder="选项，例如 自动 / 极简 / 商业" /><Select value={variable.default_value || "__none"} onValueChange={(value) => onChange({ default_value: value === "__none" ? "" : value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none">无默认值</SelectItem>{variable.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></> : variable.type === "boolean" ? <label className="flex items-center gap-2 text-xs sm:col-span-4"><Checkbox checked={variable.default_value === "true"} onCheckedChange={(checked) => onChange({ default_value: checked === true ? "true" : "false" })} />默认开启</label> : <Input className="sm:col-span-4" type={variable.type === "number" ? "number" : "text"} value={variable.default_value} onChange={(event) => onChange({ default_value: event.target.value })} placeholder="默认值" />}
    <Input className="sm:col-span-4" value={variable.placeholder || ""} onChange={(event) => onChange({ placeholder: event.target.value })} placeholder="输入提示，可选" />
  </div>;
}

function WorkflowRunner({ workflow, values, prompt, references, referenceBusy, drafts, draftLoading, batchAppend, onValuesChange, onAssetsOpen, onReferencesAdd, onReferenceRemove, onRun, onGenerateDrafts, onRunAll, onRunDraft, onDraftChange, onDraftMove, onDraftDelete, onBatchAppendChange, onBatchAppend, onClose }: { workflow: CreativeWorkflow | null; values: Record<string, string>; prompt: string; references: WorkflowReference[]; referenceBusy: boolean; drafts: WorkflowSeriesDraft[]; draftLoading: boolean; batchAppend: string; onValuesChange: (values: Record<string, string>) => void; onAssetsOpen: () => void; onReferencesAdd: (files: FileList | null) => void; onReferenceRemove: (id: string) => void; onRun: () => void; onGenerateDrafts: () => void; onRunAll: () => void; onRunDraft: (draft: WorkflowSeriesDraft, index: number) => void; onDraftChange: (id: string, patch: Partial<WorkflowSeriesDraft>) => void; onDraftMove: (id: string, direction: -1 | 1) => void; onDraftDelete: (id: string) => void; onBatchAppendChange: (value: string) => void; onBatchAppend: () => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (!workflow) return null;
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="w-[min(96vw,1000px)]"><DialogHeader><DialogTitle>{workflow.name}</DialogTitle><DialogDescription>{workflow.description || "填写变量后生成图片。"}</DialogDescription></DialogHeader><div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]"><div className="space-y-3"><section className="space-y-3 rounded-lg border border-border p-3"><h3 className="text-sm font-semibold">变量输入</h3>{workflow.variables.map((variable) => <WorkflowVariableInput key={variable.id} variable={variable} value={values[variable.key] || ""} onChange={(value) => onValuesChange({ ...values, [variable.key]: value })} />)}</section><section className="rounded-lg border border-border p-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">参考图</h3><div className="flex gap-2"><Button size="sm" variant="outline" onClick={onAssetsOpen}>我的素材</Button><Button size="sm" variant="outline" disabled={referenceBusy} onClick={() => inputRef.current?.click()}>{referenceBusy ? <LoaderCircle className="animate-spin" /> : <Upload />}上传</Button></div><input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { onReferencesAdd(event.currentTarget.files); event.currentTarget.value = ""; }} /></div>{references.length ? <div className="mt-3 grid grid-cols-4 gap-2">{references.map((reference) => <div key={reference.id} className="group relative aspect-square overflow-hidden rounded-lg border"><img src={reference.url} alt={reference.name} className="size-full object-cover" /><button type="button" className="absolute top-1 right-1 grid size-6 place-items-center rounded-md bg-black/70 text-white" onClick={() => onReferenceRemove(reference.id)}><X className="size-3" /></button></div>)}</div> : <div className="mt-3 rounded-lg border border-dashed py-5 text-center text-xs text-muted-foreground">未添加参考图</div>}</section><Button className="w-full" onClick={onRun}>{workflow.mode === "multi_image_series" ? <Layers3 /> : <Play />}{workflow.mode === "multi_image_series" ? "生成提示词" : "启动任务"}</Button></div><div className="space-y-3"><section className="rounded-lg border border-border p-3"><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">生成提示词预览</h3><Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(prompt)}><Copy />复制</Button></div><ScrollArea maxHeight="14rem" className="rounded-lg bg-muted/50" viewportClassName="p-3" viewClass="text-xs leading-5 whitespace-pre-wrap">{prompt || "填写变量后会在这里预览最终提示词"}</ScrollArea></section><div className="grid grid-cols-2 gap-2 text-xs"><Info label="模型" value={workflow.config.image_model || workflow.config.model || "默认"} /><Info label="尺寸" value={workflow.config.size} /><Info label={workflow.mode === "multi_image_series" ? "草稿数量" : "数量"} value={workflow.mode === "multi_image_series" ? workflow.series_config.target_count : workflow.config.count} /></div>{workflow.mode === "multi_image_series" ? <section className="rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="size-4" />多图提示词 · {drafts.length} 条</h3><div className="flex gap-2"><Button size="sm" variant="outline" disabled={draftLoading} onClick={onGenerateDrafts}>{draftLoading ? <LoaderCircle className="animate-spin" /> : null}重新生成</Button><Button size="sm" disabled={!drafts.some((draft) => draft.status !== "success" && draft.prompt.trim())} onClick={onRunAll}>全部生成</Button></div></div>{drafts.length ? <><div className="mt-3 flex gap-2"><Input value={batchAppend} onChange={(event) => onBatchAppendChange(event.target.value)} placeholder="批量追加统一要求" /><Button variant="outline" onClick={onBatchAppend}>批量追加</Button></div><ScrollArea maxHeight="420px" className="mt-3" viewportClassName="pr-2" viewClass="space-y-2">{drafts.map((draft, index) => <SeriesDraftCard key={draft.id} draft={draft} index={index} first={index === 0} last={index === drafts.length - 1} onChange={(patch) => onDraftChange(draft.id, patch)} onMove={(direction) => onDraftMove(draft.id, direction)} onDelete={() => onDraftDelete(draft.id)} onRun={() => onRunDraft(draft, index)} />)}</ScrollArea></> : <div className="mt-3 rounded-lg border border-dashed py-10 text-center text-xs text-muted-foreground">点击“生成提示词”后在这里审核每张图的提示词</div>}</section> : null}</div></div></DialogContent></Dialog>;
}

function SeriesDraftCard({ draft, index, first, last, onChange, onMove, onDelete, onRun }: { draft: WorkflowSeriesDraft; index: number; first: boolean; last: boolean; onChange: (patch: Partial<WorkflowSeriesDraft>) => void; onMove: (direction: -1 | 1) => void; onDelete: () => void; onRun: () => void }) {
  return <article className="rounded-lg border border-border p-2"><div className="mb-2 flex items-center gap-2"><Input className="h-8 flex-1" value={draft.title} aria-label={`第 ${index + 1} 张标题`} onChange={(event) => onChange({ title: event.target.value })} /><Button size="icon" variant="ghost" title="上移" disabled={first} onClick={() => onMove(-1)}><ArrowUp /></Button><Button size="icon" variant="ghost" title="下移" disabled={last} onClick={() => onMove(1)}><ArrowDown /></Button><Button size="icon" variant="ghost" title="复制" onClick={() => void navigator.clipboard.writeText(draft.prompt)}><Copy /></Button><Button size="icon" variant="ghost" title="删除" onClick={onDelete}><Trash2 /></Button><Button size="icon" variant="outline" title="生成这一张" disabled={!draft.prompt.trim() || draft.status === "running" || draft.status === "success"} onClick={onRun}>{draft.status === "running" ? <LoaderCircle className="animate-spin" /> : <Play />}</Button></div><Textarea rows={3} value={draft.prompt} onChange={(event) => onChange({ prompt: event.target.value, status: draft.status === "success" ? "draft" : draft.status })} /><div className={cn("mt-1 text-[11px]", draft.status === "failed" ? "text-rose-600" : draft.status === "success" ? "text-emerald-600" : "text-muted-foreground")}>{draft.error || (draft.status === "success" ? "完成" : draft.status === "failed" ? "失败" : draft.status === "running" ? "生成中" : "待审核")}</div></article>;
}

function WorkflowVariableInput({ variable, value, onChange }: { variable: WorkflowVariable; value: string; onChange: (value: string) => void }) {
  return <label className="grid gap-1.5 text-xs"><span className="font-medium">{variable.label || variable.key}{variable.required ? " *" : ""}</span>{variable.type === "textarea" ? <Textarea rows={3} value={value} placeholder={variable.placeholder || variable.default_value} onChange={(event) => onChange(event.target.value)} /> : variable.type === "select" ? <Select value={value || "__none"} onValueChange={(next) => onChange(next === "__none" ? "" : next)}><SelectTrigger><SelectValue placeholder={variable.placeholder || "请选择"} /></SelectTrigger><SelectContent><SelectItem value="__none">请选择</SelectItem>{variable.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select> : variable.type === "boolean" ? <label className="flex h-9 items-center gap-2 rounded-lg border px-3"><Checkbox checked={value === "true"} onCheckedChange={(checked) => onChange(checked === true ? "true" : "false")} />{value === "true" ? "开启" : "关闭"}</label> : <Input type={variable.type === "number" ? "number" : "text"} value={value} placeholder={variable.placeholder || variable.default_value} onChange={(event) => onChange(event.target.value)} />}</label>;
}

type AgentDialogProps = {
  open: boolean;
  prompt: string;
  scope: "private" | "public";
  model: string;
  channelID: string;
  models: ModelConfig | null;
  references: WorkflowReference[];
  draft: CreativeWorkflow | null;
  warnings: string[];
  busy: boolean;
  onPromptChange: (value: string) => void;
  onScopeChange: (value: "private" | "public") => void;
  onModelChange: (value: string) => void;
  onChannelIDChange: (value: string) => void;
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
  channelID,
  models,
  references,
  draft,
  warnings,
  busy,
  onPromptChange,
  onScopeChange,
  onModelChange,
  onChannelIDChange,
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
            <Input value={channelID} onChange={(event) => onChannelIDChange(event.target.value)} placeholder="文本渠道 / Token 名，留空使用个人默认" />
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
                      <img src={reference.url} alt={reference.name} className="size-full object-cover" />
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
                    {asset.kind === "image" && asset.url ? <img src={asset.url} alt={asset.title} className="size-full object-cover" /> : asset.kind === "video" && asset.url ? <video src={`${asset.url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" /> : <p className="line-clamp-6 p-4 text-xs leading-5 text-muted-foreground">{asset.content || (asset.kind === "audio" ? "音频素材" : "媒体素材")}</p>}
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
  return <label className="flex items-center justify-between gap-2 text-xs"><span>{label}</span><Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} /></label>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-muted/50 px-3 py-2"><span className="text-muted-foreground">{label}</span><p className="mt-1 truncate font-medium">{value}</p></div>;
}
