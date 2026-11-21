"use client";

import { Spinner } from "@/components/ui/spinner";
import { useSearchParams } from "react-router-dom";
import { LibraryWorkspace } from "@/components/library-workspace";
import { WorkflowList } from "./workflow-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ItemMedia } from "@/components/ui/item";
import { Card } from "@/components/ui/card";
import { Toggle as ToggleButton } from "@/components/ui/toggle";
import { TooltipHint } from "@/components/ui/tooltip";
import { watchCreationTasks, waitForCreationTask } from "@/lib/creation-task-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ClipboardList, Copy, Globe2, Image as ImageIcon, Layers3, LayoutGrid, List, Folder, LockKeyhole, Pencil, Play, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { toast } from "sonner";
import { buildSeriesPromptDraftRequest, createBlankWorkflow, createDefaultInputValues, createProductDetailWorkflow, createStarterWorkflows, composeWorkflowReferencePrompt, isWorkflowModelConfigured, mergeWorkflowRunMetadata, normalizeWorkflow, parseWorkflowSeriesDrafts, workflowGenerationDefaultsFromPreferences, renderWorkflowPrompt, resolveWorkflowRuntime, resolveWorkflowTextModel, type WorkflowGenerationDefaults, type WorkflowSeriesDraft } from "@/app/workflows/workflow-runtime";
import {
  creationTaskImages,
  mergeWorkflowTaskProgress,
  prependWorkflowTask,
  restoreWorkflowTasks,
  settleWorkflowTaskUnits,
  type WorkflowTask,
  type WorkflowTaskUnitResult,
} from "@/app/workflows/workflow-task-runtime";
import { freezeWorkflowReferences, ownedWorkflowTaskReferences, settleWorkflowReferenceUploads, workflowReferenceCleanupKeys } from "@/app/workflows/workflow-reference-lifecycle";
import { runCurrentWorkflowAgentDraft } from "@/app/workflows/workflow-agent-draft-lifecycle";
import { assetListKey, managedImageAsset, mergeAssetLibrary } from "@/app/assets/asset-library";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { ManagementPage, ManagementPagination, ManagementToolbar } from "@/components/management-page";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMyAssets } from "@/lib/use-my-assets";
import { createChatGenerationTask, createImageEditTask, createImageGenerationTask, deleteManagedImages, fetchManagedImages, fetchModelConfig, imageReferenceImageLimit, type CreationTask, type ImageGenerationPreferences, type ImageQuality, type ModelConfig } from "@/lib/api";
import { deleteStoredImages, imageToDataURL, uploadImage } from "@/services/image-storage";
import { clearWorkflowTaskHistory, deleteWorkflow, draftWorkflowWithAgent, fetchWorkflowTaskHistory, fetchWorkflows, initializeWorkflows, saveWorkflow, touchWorkflowLastRun, type CreativeWorkflow, type WorkflowTaskHistoryPage, type WorkflowTaskHistoryQuery } from "@/services/api/workflows";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";
import { createMyAsset, fetchVisibleMyAssets, type MyAsset } from "@/lib/my-assets";
import { getManagedImagePathFromUrl } from "@/lib/image-path";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { useImageGenerationPreferences } from "@/lib/use-image-generation-preferences";
import { AUTH_SESSION_CHANGE_EVENT, hasAPIPermission, type StoredAuthSession } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { cn } from "@/lib/utils";
import { resolveConfiguredModel } from "@/lib/model-config-selection";
import { WorkflowAgentDialog } from "./workflow-agent-dialog";
import { WorkflowEditor } from "./workflow-editor";
import type { WorkflowReference } from "./workflow-reference-grid";
import { WorkflowRunner } from "./workflow-runner";
import { WorkflowTaskDialog, WorkflowTaskHistoryDialog } from "./workflow-task-dialogs";

type WorkflowSeriesRun = {
  id: string;
  total: number;
  references: WorkflowReference[];
};

type CreativeWorkflowWorkspaceProps = {
  embedded?: boolean;
  hideTaskList?: boolean;
  generationDefaults?: WorkflowGenerationDefaults;
};

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

function isWorkflowPollAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function waitForTask(id: string, timeoutSeconds: number, signal?: AbortSignal) {
  const task = await waitForCreationTask(id, { signal, timeoutMs: Math.max(1, timeoutSeconds) * 1000 });
  if (task.status !== "success") throw new Error(task.error || "任务执行失败");
  return task;
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

async function workflowImageDataURLs(references: WorkflowReference[], signal: AbortSignal) {
  return Promise.all(references.map((reference) => imageToDataURL(reference, signal)));
}

function taskText(task: CreationTask) {
  return (task.data || [])
    .map((item) => String(item.text_response || item.revised_prompt || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function CreativeWorkflowWorkspace(props: CreativeWorkflowWorkspaceProps = {}) {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/workflows");
  const sessionRevision = useAuthSessionRevision();
  if (isCheckingAuth || !session || getCachedAuthSession()?.key !== session.key) {
    return <LoadingState label="正在加载工作流" />;
  }
  return <CreativeWorkflowWorkspaceContent key={`${session.key}:${sessionRevision}`} {...props} session={session} />;
}

function CreativeWorkflowWorkspaceContent({
  embedded = false,
  hideTaskList = false,
  generationDefaults,
  session,
}: CreativeWorkflowWorkspaceProps & { session: StoredAuthSession }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const editorRoute = searchParams.get("editor") || "";
  const editorTemplate = searchParams.get("template") || "single_image";
  const editorRouteKey = `${editorRoute}:${editorTemplate}`;
  const [resolvedEditorRoute, setResolvedEditorRoute] = useState("");
  const pendingEditorNavigationRef = useRef<{ from: string; to: string } | null>(null);
  const sessionKey = session.key;
  const { preferences, isReady: preferencesReady } = useImageGenerationPreferences(sessionKey);
  const { isReady: relayPreferencesReady, tokenNameForModel, nextTokenNameForModel } = useRelayTokenPreferences();
  const sessionTextChannelID = tokenNameForModel("text", preferences.default_text_model || "");
  const { assets: myAssets, upsertAsset, loading: assetLoading, loadError: ownAssetError, reload: reloadOwnAssets } = useMyAssets(
    session?.key || "",
    Boolean(session),
  );
  const [items, setItems] = useState<CreativeWorkflow[]>([]);
  const [deletingWorkflow, setDeletingWorkflow] = useState<CreativeWorkflow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [models, setModels] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [modeFilter, setModeFilter] = useState<"all" | CreativeWorkflow["mode"]>("all");
  const [view, setView] = useState<"list" | "grid">("grid");
  const [scopeFilter, setScopeFilter] = useState<"all" | CreativeWorkflow["scope"]>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [editing, setEditing] = useState<CreativeWorkflow | null>(null);
  const workflowEditorGenerationRef = useRef(0);
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [workflowSaveError, setWorkflowSaveError] = useState("");
  const workflowSaveBusyRef = useRef(false);
  const [running, setRunning] = useState<CreativeWorkflow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<WorkflowReference[]>([]);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const workflowReferenceUploadGenerationRef = useRef(0);
  const referenceUploadCountRef = useRef(0);
  const [seriesDrafts, setSeriesDrafts] = useState<WorkflowSeriesDraft[]>([]);
  const [seriesDraftLoading, setSeriesDraftLoading] = useState(false);
  const [seriesBatchAppend, setSeriesBatchAppend] = useState("");
  const [tasks, setTasks] = useState<WorkflowTask[]>([]);
  const [taskHistoryLoading, setTaskHistoryLoading] = useState(false);
  const [taskHistoryError, setTaskHistoryError] = useState("");
  const [taskHistoryAttempt, setTaskHistoryAttempt] = useState(0);
  const [taskHistoryQuery, setTaskHistoryQuery] = useState<WorkflowTaskHistoryQuery>({ page: 1, pageSize: 12, status: "all" });
  const [taskHistoryResponse, setTaskHistoryPage] = useState<{ query: WorkflowTaskHistoryQuery; page: WorkflowTaskHistoryPage } | null>(null);
  const taskHistoryPage = taskHistoryResponse?.query === taskHistoryQuery ? taskHistoryResponse.page : null;
  const [taskRecoveryError, setTaskRecoveryError] = useState("");
  const [taskRecoveryAttempt, setTaskRecoveryAttempt] = useState(0);
  const [restoredRunTimes, setRestoredRunTimes] = useState<ReadonlyMap<string, number>>(new Map());
  const [directTaskPollIDs, setDirectTaskPollIDs] = useState<string[]>([]);
  const taskWaitAbortControllerRef = useRef<AbortController | null>(null);
  const [taskHistoryOpen, setTaskHistoryOpen] = useState(false);
  const [selectedHistoryTask, setSelectedHistoryTask] = useState<WorkflowTask | null>(null);
  const selectedTaskID = selectedHistoryTask?.id || "";
  const [clearingTaskHistory, setClearingTaskHistory] = useState(false);
  const selectedTask = tasks.find((task) => task.id === selectedTaskID) || selectedHistoryTask;
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentScope, setAgentScope] = useState<"private" | "public">("private");
  const [agentModel, setAgentModel] = useState("");
  const [agentReferences, setAgentReferences] = useState<WorkflowReference[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentRunID, setAgentRunID] = useState("");
  const [agentDraft, setAgentDraft] = useState<CreativeWorkflow | null>(null);
  const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
  const [agentError, setAgentError] = useState("");
  const [assetPickerTarget, setAssetPickerTarget] = useState<"workflow" | "template" | "agent" | null>(null);
  const [sharedAssets, setSharedAssets] = useState<MyAsset[]>([]);
  const [managedAssets, setManagedAssets] = useState<MyAsset[]>([]);
  const [assetLibraryLoading, setAssetLibraryLoading] = useState(false);
  const [assetLibraryError, setAssetLibraryError] = useState("");
  const [assetLibraryAttempt, setAssetLibraryAttempt] = useState(0);
  const workspaceActiveRef = useRef(false);
  const currentSessionKeyRef = useRef(sessionKey);
  const agentDraftAbortControllerRef = useRef<AbortController | null>(null);
  const workflowReferencesRef = useRef(references);
  const agentReferencesRef = useRef(agentReferences);
  const tasksRef = useRef(tasks);
  const inFlightTaskCountsRef = useRef(new Map<string, number>());
  currentSessionKeyRef.current = sessionKey;
  tasksRef.current = tasks;
  const assetLibrary = useMemo(
    () => mergeAssetLibrary(myAssets, sharedAssets, managedAssets),
    [managedAssets, myAssets, sharedAssets],
  );

  const isCurrentWorkspace = useCallback(() => {
    return workspaceActiveRef.current
      && getCachedAuthSession()?.key === sessionKey
      && taskWaitAbortControllerRef.current?.signal.aborted === false;
  }, [sessionKey]);

  function updateWorkflowReferences(updater: (current: WorkflowReference[]) => WorkflowReference[]) {
    const next = updater(workflowReferencesRef.current);
    workflowReferencesRef.current = next;
    setReferences(next);
  }

  function updateAgentReferences(updater: (current: WorkflowReference[]) => WorkflowReference[]) {
    const next = updater(agentReferencesRef.current);
    agentReferencesRef.current = next;
    setAgentReferences(next);
  }

  function replaceEditor(workflow: CreativeWorkflow | null, template: CreativeWorkflow["mode"] | "product_detail" = workflow?.mode || "single_image") {
    workflowEditorGenerationRef.current += 1;
    setWorkflowSaveError("");
    const next = new URLSearchParams(searchParams);
    let targetRoute = ":single_image";
    if (workflow) {
      const id = items.some((item) => item.id === workflow.id) ? workflow.id : "new";
      next.set("editor", id);
      next.set("template", template);
      targetRoute = `${id}:${template}`;
    } else {
      next.delete("editor");
      next.delete("template");
    }
    pendingEditorNavigationRef.current = editorRouteKey === targetRoute ? null : { from: editorRouteKey, to: targetRoute };
    setResolvedEditorRoute(targetRoute);
    setEditing(workflow);
    setSearchParams(next, { replace: !workflow });
  }

  function updateTasks(updater: (current: WorkflowTask[]) => WorkflowTask[]) {
    const next = updater(tasksRef.current);
    tasksRef.current = next;
    setTasks(next);
  }

  function beginWorkflowTaskSubmission(id: string) {
    const counts = inFlightTaskCountsRef.current;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  function ownedTaskReferences() {
    return ownedWorkflowTaskReferences(
      tasksRef.current,
      new Set(inFlightTaskCountsRef.current.keys()),
    );
  }

  function finishWorkflowTaskSubmission(id: string, taskReferences: WorkflowReference[]) {
    const counts = inFlightTaskCountsRef.current;
    const remaining = Math.max(0, (counts.get(id) || 1) - 1);
    if (remaining) {
      counts.set(id, remaining);
      return;
    }
    counts.delete(id);
    const task = tasksRef.current.find((item) => item.id === id);
    if (task?.backend_task_ids.length) return;
    updateTasks((current) => current.map((item) =>
      item.id === id ? { ...item, references: [] } : item
    ));
    if (workspaceActiveRef.current) cleanupDiscardedWorkflowReferences(taskReferences);
  }

  useEffect(() => {
    workspaceActiveRef.current = true;
    const controller = new AbortController();
    const inFlightTaskCounts = inFlightTaskCountsRef.current;
    taskWaitAbortControllerRef.current = controller;
    return () => {
      workspaceActiveRef.current = false;
      workflowReferenceUploadGenerationRef.current += 1;
      workflowEditorGenerationRef.current += 1;
      agentDraftAbortControllerRef.current?.abort();
      agentDraftAbortControllerRef.current = null;
      controller.abort();
      if (taskWaitAbortControllerRef.current === controller) {
        taskWaitAbortControllerRef.current = null;
      }
      const allTaskReferences = tasksRef.current.flatMap((task) => task.references || []);
      const retained = ownedWorkflowTaskReferences(
        tasksRef.current,
        new Set(inFlightTaskCounts.keys()),
      );
      const keys = workflowReferenceCleanupKeys(
        [...workflowReferencesRef.current, ...agentReferencesRef.current, ...allTaskReferences],
        retained,
      );
      if (keys.length && getCachedAuthSession()?.key === sessionKey) void deleteStoredImages(keys).catch(() => undefined);
    };
  }, [sessionKey]);

  useEffect(() => {
    agentDraftAbortControllerRef.current?.abort();
    agentDraftAbortControllerRef.current = null;
    setAgentBusy(false);
    return () => {
      agentDraftAbortControllerRef.current?.abort();
      agentDraftAbortControllerRef.current = null;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!assetPickerTarget) return;
    const controller = new AbortController();
    setAssetLibraryLoading(true);
    setAssetLibraryError("");
    void Promise.allSettled([
      fetchVisibleMyAssets(sessionKey, controller.signal),
      fetchManagedImages(
        { scope: session.role === "admin" ? "all" : "visible" },
        { signal: controller.signal },
      ),
    ])
      .then(([visible, images]) => {
        if (controller.signal.aborted) return;
        if (visible.status === "fulfilled") {
          setSharedAssets(visible.value.filter((asset) => asset.owned !== true));
        }
        if (images.status === "fulfilled") {
          setManagedAssets(images.value.items.map((item) => managedImageAsset(
            item,
            Boolean(item.owner_id && item.owner_id === session.subjectId),
          )));
        }
        const errors = [
          visible.status === "rejected" ? "共享素材读取失败" : "",
          images.status === "rejected" ? "生成图片读取失败" : "",
        ];
        setAssetLibraryError(errors.filter(Boolean).join("、"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setAssetLibraryLoading(false);
      });
    return () => controller.abort();
  }, [assetLibraryAttempt, assetPickerTarget, session.role, session.subjectId, sessionKey]);

  useEffect(() => {
    const handleAuthSessionChange = () => {
      if (getCachedAuthSession()?.key !== currentSessionKeyRef.current) {
        taskWaitAbortControllerRef.current?.abort();
        agentDraftAbortControllerRef.current?.abort();
        if (workspaceActiveRef.current) setAgentBusy(false);
      }
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleAuthSessionChange);
    return () => window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleAuthSessionChange);
  }, []);

  useEffect(() => {
    if (!sessionKey || !preferencesReady || !relayPreferencesReady) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && isCurrentWorkspace();
    setLoading(true);
    setLoadError("");
    void Promise.all([fetchWorkflows(controller.signal), fetchModelConfig()])
      .then(async ([workflows, modelResponse]) => {
        if (!isCurrent()) return;
        const modelConfig = modelResponse.config;
        setModels(modelConfig);
        if (workflows.length) {
          setItems(workflows.map((workflow) => normalizeWorkflow(workflow, modelConfig, preferences)));
          return;
        }
        const starters = createStarterWorkflows(modelConfig, preferences, workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID));
        const saved = await initializeWorkflows(starters);
        if (isCurrent()) setItems(saved.map((workflow) => normalizeWorkflow(workflow, modelConfig, preferences)));
      })
      .catch((error) => {
        if (isCurrent()) setLoadError(error instanceof Error ? error.message : "工作流加载失败");
      })
      .finally(() => { if (isCurrent()) setLoading(false); });
    return () => controller.abort();
  }, [generationDefaults, isCurrentWorkspace, loadAttempt, preferences, preferencesReady, relayPreferencesReady, sessionKey, sessionTextChannelID]);

  useEffect(() => {
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && isCurrentWorkspace();
    setTaskRecoveryError("");
    void fetchWorkflowTaskHistory(controller.signal)
      .then(({ items: storedTasks, latest_run_at }) => {
        if (!isCurrent()) return;
        const restored = restoreWorkflowTasks(storedTasks);
        const currentIDs = new Set(tasksRef.current.map((task) => task.id));
        updateTasks((current) => [...current, ...restored.filter((task) => !currentIDs.has(task.id))]);
        setRestoredRunTimes(new Map(Object.entries(latest_run_at || {})));
      })
      .catch((error) => {
        if (isCurrent()) setTaskRecoveryError(error instanceof Error ? error.message : "无法恢复运行中的任务");
      });
    return () => controller.abort();
  }, [isCurrentWorkspace, taskRecoveryAttempt]);

  const taskHistoryRevision = useMemo(() => tasks.filter((task) => task.backend_task_ids.length)
    .map((task) => `${task.id}:${task.status}:${task.backend_task_ids.length}`).join(","), [tasks]);
  useEffect(() => {
    if (!taskHistoryOpen || clearingTaskHistory) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && isCurrentWorkspace();
    setTaskHistoryLoading(true);
    setTaskHistoryError("");
    void fetchWorkflowTaskHistory(controller.signal, taskHistoryQuery)
      .then((page) => { if (isCurrent()) setTaskHistoryPage({ query: taskHistoryQuery, page }); })
      .catch((error) => {
        if (isCurrent()) setTaskHistoryError(error instanceof Error ? error.message : "任务记录加载失败");
      })
      .finally(() => { if (isCurrent()) setTaskHistoryLoading(false); });
    return () => controller.abort();
  }, [clearingTaskHistory, isCurrentWorkspace, taskHistoryAttempt, taskHistoryOpen, taskHistoryQuery, taskHistoryRevision]);

  const historyTasks = useMemo(() => {
    if (!taskHistoryPage) return [];
    const local = new Map(tasks.map((task) => [task.id, task]));
    return restoreWorkflowTasks(taskHistoryPage.items).map((task) => local.get(task.id) || task);
  }, [taskHistoryPage, tasks]);
  const localHistoryTasks = useMemo(() => tasks.filter((task) => !task.backend_task_ids.length), [tasks]);

  useEffect(() => {
    const nextModel = resolveConfiguredModel(
      models?.text_models,
      agentModel,
      preferences.default_text_model,
      models?.default_text_model,
    );
    if (nextModel !== agentModel) setAgentModel(nextModel);
  }, [agentModel, models, preferences.default_text_model]);

  const directTaskPollIDSet = new Set(directTaskPollIDs);
  const recoveryBatchKey = JSON.stringify(tasks
    .filter(task => task.status === "running" && task.backend_task_ids.some(id => !directTaskPollIDSet.has(id)))
    .map(task => task.id).sort());
  const runningTaskCount = tasks.filter((task) => task.status === "running").length;

  useEffect(() => {
    const batchIDs: string[] = JSON.parse(recoveryBatchKey);
    if (!batchIDs.length) return;
    const controller = new AbortController();
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const reconcile = (items: CreationTask[]) => {
      clearTimeout(recoveryTimer);
      if (controller.signal.aborted || !isCurrentWorkspace()) return;
      const updates = new Map(restoreWorkflowTasks(items).map((task) => [task.id, task]));
      if (!updates.size) return;
      updateTasks((current) => current.map((task) => {
        const update = updates.get(task.id);
        return update ? mergeWorkflowTaskProgress(task, update, inFlightTaskCountsRef.current.has(task.id)) : task;
      }));
      // Missing serial children expire on a local deadline, without network polling.
      const deadlines = [...updates.values()]
        .flatMap((task) => task.recovery_deadline === undefined ? [] : [task.recovery_deadline]);
      if (deadlines.length) recoveryTimer = setTimeout(() => reconcile(items), Math.max(1, Math.min(2_147_483_647, Math.min(...deadlines) - Date.now() + 1)));
    };
    const unsubscribe = watchCreationTasks({
      workflowBatchIDs: batchIDs,
      signal: controller.signal,
      onUpdate: ({ items }) => reconcile(items),
      onError: error => { if (!controller.signal.aborted && !isWorkflowPollAbort(error)) toast.error(error.message); },
    });
    return () => { controller.abort(); unsubscribe(); clearTimeout(recoveryTimer); };
  }, [isCurrentWorkspace, recoveryBatchKey]);

  useEffect(function resolveEditorRoute() {
    const navigation = pendingEditorNavigationRef.current;
    if (navigation) {
      if (editorRouteKey === navigation.from) return;
      pendingEditorNavigationRef.current = null;
      if (editorRouteKey === navigation.to) return;
    }
    if (loading || resolvedEditorRoute === editorRouteKey) return;
    setResolvedEditorRoute(editorRouteKey);
    workflowEditorGenerationRef.current += 1;
    setWorkflowSaveError("");
    if (!editorRoute) {
      setEditing(null);
      return;
    }
    if (editorRoute === "new") {
      const defaults = workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID);
      if (editorTemplate === "product_detail") setEditing(createProductDetailWorkflow(models, preferences, defaults));
      else if (editorTemplate === "single_image" || editorTemplate === "multi_image_series")
        setEditing(createBlankWorkflow(models, preferences, editorTemplate, defaults));
      else setEditing(null);
      return;
    }
    const workflow = items.find((item) => item.id === editorRoute && item.editable !== false);
    setEditing(workflow ? structuredClone(workflow) : null);
  }, [
    editorRoute,
    editorRouteKey,
    resolvedEditorRoute,
    editorTemplate,
    generationDefaults,
    items,
    loading,
    models,
    preferences,
    sessionTextChannelID,
  ]);

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
      if (modeFilter !== "all" && workflow.mode !== modeFilter) return false;
      if (category !== "all" && (workflow.category || "未分类") !== category)
        return false;
      if (scopeFilter !== "all" && workflow.scope !== scopeFilter) return false;
      if (!text) return true;
      return [workflow.name, workflow.category, workflow.description].some((value) =>
        value.toLowerCase().includes(text),
      );
    });
  }, [category, items, query, scopeFilter, modeFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleWorkflows = filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => setPage(1), [category, pageSize, query, scopeFilter, modeFilter]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);
  const renderedPrompt = useMemo(
    () => (running ? renderWorkflowPrompt(running, values) : ""),
    [running, values],
  );
  async function persist(workflow: CreativeWorkflow) {
    if (!isCurrentWorkspace()) return;
    if (referenceUploadCountRef.current > 0) return;
    if (!workflow.name.trim()) {
      setWorkflowSaveError("请输入工作流名称");
      return;
    }
    if (!workflow.config.prompt_template.trim()) {
      setWorkflowSaveError("请输入提示词模板");
      return;
    }
    if (workflow.scope === "public" && workflow.template_references.some((reference) => reference.visibility !== "public")) {
      setWorkflowSaveError("公开工作流只能使用公开的模板图");
      return;
    }
    if (workflowSaveBusyRef.current) return;
    workflowSaveBusyRef.current = true;
    setWorkflowSaving(true);
    setWorkflowSaveError("");
    const generation = workflowEditorGenerationRef.current;
    try {
      const generatedByAgent = agentDraft?.id === workflow.id;
      const saved = normalizeWorkflow(
        await saveWorkflow(normalizeWorkflow(workflow, models, preferences)),
        models,
        preferences,
      );
      if (!isCurrentWorkspace()) return;
      setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      if (generation !== workflowEditorGenerationRef.current) return;
      replaceEditor(null);
      if (generatedByAgent) {
        await cleanupAgentReferences();
        if (!isCurrentWorkspace()) return;
        setAgentDraft(null);
        setAgentWarnings([]);
      }
      toast.success("工作流已保存");
    } catch (error) {
      if (isCurrentWorkspace() && generation === workflowEditorGenerationRef.current) {
        setWorkflowSaveError(error instanceof Error ? error.message : "工作流保存失败");
      }
    } finally {
      workflowSaveBusyRef.current = false;
      if (workspaceActiveRef.current) setWorkflowSaving(false);
    }
  }

  async function duplicateWorkflow(workflow: CreativeWorkflow) {
    if (!isCurrentWorkspace()) return;
    const copy = normalizeWorkflow(
      {
        ...structuredClone(workflow),
        id: "",
        revision: undefined,
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
      if (!isCurrentWorkspace()) return;
      setItems((current) => [saved, ...current]);
      toast.success("工作流副本已保存");
    } catch (error) {
      if (isCurrentWorkspace()) toast.error(error instanceof Error ? error.message : "工作流复制失败");
    }
  }

  const markWorkflowRunCompleted = useCallback((workflow: CreativeWorkflow, endedAt: number) => {
    if (workflow.editable === false) return;
    const timestamp = new Date(endedAt).toISOString();
    const metadata = { last_run_at: timestamp, updated_at: timestamp };
    setItems((current) =>
      current
        .map((item) => (item.id === workflow.id ? mergeWorkflowRunMetadata(item, metadata) : item))
        .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || ""))),
    );
    setRunning((current) => (current?.id === workflow.id
      ? mergeWorkflowRunMetadata(current, metadata)
      : current));
    void touchWorkflowLastRun(workflow.id, timestamp)
      .then((touched) => {
        if (!isCurrentWorkspace()) return;
        setItems((current) => current
          .map((item) => (item.id === touched.id ? mergeWorkflowRunMetadata(item, touched) : item))
          .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || ""))));
        setRunning((current) => (current?.id === touched.id
          ? mergeWorkflowRunMetadata(current, touched)
          : current));
      })
      .catch(() => undefined);
  }, [isCurrentWorkspace]);

  useEffect(() => {
    if (loading || loadError || !restoredRunTimes.size) return;
    setRestoredRunTimes(new Map());
    for (const workflow of items) {
      const latest = restoredRunTimes.get(workflow.id);
      if (latest && workflow.editable !== false && latest > (Date.parse(workflow.last_run_at || "") || 0)) {
        markWorkflowRunCompleted(workflow, latest);
      }
    }
  }, [items, loading, loadError, markWorkflowRunCompleted, restoredRunTimes]);

  function openRunner(workflow: CreativeWorkflow) {
    workflowReferenceUploadGenerationRef.current += 1;
    setSeriesDraftLoading(false);
    const discarded = workflowReferencesRef.current;
    updateWorkflowReferences(() => []);
    cleanupDiscardedWorkflowReferences(discarded);
    setRunning(workflow);
    setValues(createDefaultInputValues(workflow));
    setSeriesBatchAppend("");
    setSeriesDrafts([]);
  }

  function closeRunner() {
    workflowReferenceUploadGenerationRef.current += 1;
    setSeriesDraftLoading(false);
    const discarded = workflowReferencesRef.current;
    updateWorkflowReferences(() => []);
    cleanupDiscardedWorkflowReferences(discarded);
    setRunning(null);
    setSeriesDrafts([]);
    setSeriesBatchAppend("");
  }

  function cleanupDiscardedWorkflowReferences(discarded: WorkflowReference[]) {
    if (!isCurrentWorkspace()) return;
    const retained = [
      ...ownedTaskReferences(),
      ...workflowReferencesRef.current,
      ...agentReferencesRef.current,
    ];
    const keys = workflowReferenceCleanupKeys(discarded, retained);
    if (!keys.length) return;
    void deleteStoredImages(keys).catch((error) =>
      toast.error(error instanceof Error ? error.message : "参考图文件删除失败"),
    );
  }

  async function addReferences(
    files: FileList | null,
    target: "workflow" | "template" | "agent" = "workflow",
  ) {
    const selected = Array.from(files || []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!selected.length) return;
    const signal = taskWaitAbortControllerRef.current?.signal;
    if (!signal || signal.aborted || !workspaceActiveRef.current || getCachedAuthSession()?.key !== sessionKey) return;
    const workflowUploadGeneration = workflowReferenceUploadGenerationRef.current;
    const editorGeneration = workflowEditorGenerationRef.current;
    referenceUploadCountRef.current += 1;
    setReferenceBusy(true);
    try {
      const { uploaded, errors } = await settleWorkflowReferenceUploads(
        selected.map(async (file) => {
          const image = await uploadImage(file, signal);
          const reference = {
            id: taskID("reference"),
            name: file.name,
            url: image.url,
            storageKey: image.storageKey,
            temporary: true,
            role: "product" as const,
          };
          if (target === "template") {
            if (signal.aborted || getCachedAuthSession()?.key !== sessionKey || !workspaceActiveRef.current || editorGeneration !== workflowEditorGenerationRef.current) return reference;
            try {
              const asset = await upsertAsset(createMyAsset({
                kind: "image",
                title: file.name,
                url: image.url,
                storageKey: image.storageKey,
                mimeType: image.mimeType,
                bytes: image.bytes,
                width: image.width,
                height: image.height,
                tags: ["工作流模板"],
                source: "工作流模板",
                visibility: editing?.scope === "public" ? "public" : "private",
              }));
              return {
                id: taskID("template-reference"),
                name: asset.title,
                url: asset.url || image.url,
                storageKey: asset.storageKey || image.storageKey,
                visibility: asset.visibility,
              };
            } catch (error) {
              if (getCachedAuthSession()?.key === sessionKey) {
                await deleteStoredImages([image.storageKey]).catch(() => undefined);
              }
              throw error;
            }
          }
          return reference;
        }),
      );
      if (getCachedAuthSession()?.key !== sessionKey) return;
      if (!workspaceActiveRef.current) {
        const staleKeys = workflowReferenceCleanupKeys(uploaded, []);
        if (staleKeys.length) await deleteStoredImages(staleKeys).catch(() => undefined);
        return;
      }
      if ((target === "workflow" && workflowUploadGeneration !== workflowReferenceUploadGenerationRef.current)
        || (target === "template" && editorGeneration !== workflowEditorGenerationRef.current)) {
        const staleKeys = workflowReferenceCleanupKeys(uploaded, []);
        if (staleKeys.length) {
          await deleteStoredImages(staleKeys).catch((error) =>
            toast.error(error instanceof Error ? error.message : "参考图文件删除失败"),
          );
        }
        return;
      }
      if (uploaded.length) {
        if (target === "agent") {
          updateAgentReferences((value) => [...value, ...uploaded]);
        } else if (target === "template") {
          setEditing((current) => {
            if (!current || editorGeneration !== workflowEditorGenerationRef.current) return current;
            const existing = new Set(current.template_references.map((reference) => reference.storageKey || reference.url));
            const added = uploaded.filter((reference) => !existing.has(reference.storageKey || reference.url));
            const templateReferences = [...current.template_references, ...added].slice(0, 14);
            return {
              ...current,
              template_references: templateReferences,
              series_config: current.mode === "multi_image_series" && added.length
                ? { ...current.series_config, target_count: String(templateReferences.length) }
                : current.series_config,
            };
          });
        } else {
          updateWorkflowReferences((value) => [...value, ...uploaded]);
        }
      }
      if (errors.length) {
        const firstError = errors[0];
        const message = firstError instanceof Error ? firstError.message : "参考图上传失败";
        toast.error(uploaded.length ? `${errors.length} 个参考图上传失败，已保留成功项` : message);
      }
    } finally {
      referenceUploadCountRef.current = Math.max(0, referenceUploadCountRef.current - 1);
      if (workspaceActiveRef.current && referenceUploadCountRef.current === 0) setReferenceBusy(false);
    }
  }

  function insertWorkflowAsset(asset: MyAsset) {
    if (!assetPickerTarget) return;
    if (asset.kind === "text" && assetPickerTarget !== "template") {
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
    const reference = {
      id: taskID("asset-reference"),
      name: asset.title,
      url: asset.url,
      storageKey: asset.storageKey,
      visibility: asset.visibility,
      temporary: false,
      role: "product" as const,
    };
    if (assetPickerTarget === "agent") {
      updateAgentReferences((current) => [...current, reference]);
    } else if (assetPickerTarget === "template") {
      setEditing((current) => {
        if (!current) return current;
        const key = reference.storageKey || reference.url;
        if (current.template_references.some((item) => (item.storageKey || item.url) === key)) return current;
        const templateReferences = [...current.template_references, reference].slice(0, 14);
        return {
          ...current,
          template_references: templateReferences,
          series_config: current.mode === "multi_image_series"
            ? { ...current.series_config, target_count: String(templateReferences.length) }
            : current.series_config,
        };
      });
    } else {
      updateWorkflowReferences((current) => [...current, reference]);
    }
    setAssetPickerTarget(null);
  }

  function removeWorkflowReference(id: string) {
    const reference = workflowReferencesRef.current.find((item) => item.id === id);
    updateWorkflowReferences((current) => current.filter((item) => item.id !== id));
    if (reference) cleanupDiscardedWorkflowReferences([reference]);
  }

  function removeAgentReference(id: string) {
    const reference = agentReferencesRef.current.find((item) => item.id === id);
    updateAgentReferences((current) => current.filter((item) => item.id !== id));
    if (reference) cleanupDiscardedWorkflowReferences([reference]);
  }

  async function cleanupAgentReferences() {
    if (!isCurrentWorkspace()) return;
    const discarded = agentReferencesRef.current;
    updateAgentReferences(() => []);
    const keys = workflowReferenceCleanupKeys(discarded, [
      ...ownedTaskReferences(),
      ...workflowReferencesRef.current,
    ]);
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
    seriesBatchIndex?: number,
  ) {
    if (!workspaceActiveRef.current || getCachedAuthSession()?.key !== sessionKey) throw new DOMException("Session changed", "AbortError");
    const taskController = taskWaitAbortControllerRef.current;
    if (!taskController || taskController.signal.aborted) {
      throw taskController?.signal.reason || new DOMException("Workspace closed", "AbortError");
    }
    const runtime = resolveWorkflowRuntime(workflow, models, preferences);
    const model = runtime.model;
    if (!isWorkflowModelConfigured(model, models?.image_models)) {
      throw new Error("管理员尚未配置可用的图片模型");
    }
    const count = Math.max(1, Math.min(10, countOverride || runtime.count));
    const quality = ["low", "medium", "high"].includes(runtime.quality)
      ? (runtime.quality as ImageQuality)
      : undefined;
    const stream = preferences.stream;
    const partialImages = preferences.partial_images || undefined;
    const relayTokenName = nextTokenNameForModel("image", model);
    const execution = {
      stream,
      partial_images: preferences.partial_images,
      response_format_b64_json: preferences.response_format_b64_json,
      codex_cli_compatibility: preferences.codex_cli_compatibility,
      token_name: relayTokenName || undefined,
    };
    const localTaskID = seriesRun?.id || taskID("workflow-image");
    const productReferences = freezeWorkflowReferences(
      seriesRun?.references || workflowReferencesRef.current,
    ).map((reference) => ({ ...reference, role: "product" as const }));
    const templateReferences = workflow.template_references.length && draft
      ? workflow.template_references[seriesDraftIndex || 0]
        ? [workflow.template_references[seriesDraftIndex || 0]]
        : []
      : workflow.template_references;
    if (workflow.template_references.length && !productReferences.length) {
      throw new Error("使用模板图时至少需要一张新产品实拍图");
    }
    const taskReferences = freezeWorkflowReferences([
      ...templateReferences.map((reference) => ({ ...reference, temporary: false, role: "template" as const })),
      ...productReferences,
    ]);
    const referenceLimit = imageReferenceImageLimit(model);
    if (taskReferences.length > referenceLimit) {
      throw new Error(`当前模型最多支持 ${referenceLimit} 张参考图，本次需要 ${taskReferences.length} 张`);
    }
    const taskPrompt = composeWorkflowReferencePrompt(
      prompt,
      templateReferences,
      productReferences.length,
    );
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
    const batchSeriesIndex = seriesRun
      ? Math.max(1, seriesBatchIndex || seriesIndex || 1)
      : seriesIndex;
    const taskCount = seriesRun?.total || count;
    const taskSnapshot: WorkflowTask = {
      id: localTaskID,
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      prompt: taskPrompt,
      status: "running",
      started_at: startedAt,
      image_urls: [],
      images: [],
      series_title: draft?.title,
      series_index: seriesIndex,
      inputs: { ...values },
      references: taskReferences,
      model,
      api_mode: runtime.api_mode,
      config: taskConfig,
      execution,
      count: taskCount,
      backend_task_ids: [],
      completed_units: [],
      unit_errors: {},
    };
    beginWorkflowTaskSubmission(localTaskID);
    updateTasks((current) => prependWorkflowTask(current, taskSnapshot));
    if (draft) patchSeriesDraft(draft.id, { status: "running", error: undefined });
    const unitAt = (index: number) => seriesRun && batchSeriesIndex ? batchSeriesIndex : index + 1;
    const settleLocalTask = (results: WorkflowTaskUnitResult[]) =>
      updateTasks((current) => current.map((task) => task.id === localTaskID ? settleWorkflowTaskUnits(task, results) : task));
    let partialError: string | undefined;
    let imageURLs: string[];
    try {
      const imageFiles = taskReferences.length ? await workflowImageFiles(taskReferences, taskController.signal) : [];
      taskController.signal.throwIfAborted();
      const settled = await Promise.allSettled(
        Array.from({ length: count }, async (_, index) => {
          const batchIndex = unitAt(index);
          const batchCount = seriesRun?.total || count;
          const clientTaskID = seriesRun
            ? `${localTaskID}-${batchIndex}`
            : count === 1 ? localTaskID : `${localTaskID}-${index + 1}`;
          const workflowContext = {
            workflow_id: workflow.id,
            workflow_name: workflow.name,
            prompt: taskPrompt,
            inputs: { ...values },
            references: taskReferences.map((reference) => ({ ...reference })),
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
            ? await createImageEditTask(clientTaskID, imageFiles, taskPrompt, model, runtime.size || undefined, undefined, quality, 1, "private", undefined, undefined, undefined, stream, partialImages, toolOptions, undefined, relayTokenName || undefined, undefined, undefined, { signal: taskController.signal })
            : await createImageGenerationTask(clientTaskID, taskPrompt, model, runtime.size || undefined, undefined, quality, 1, "private", undefined, undefined, undefined, stream, partialImages, toolOptions, undefined, relayTokenName || undefined, undefined, undefined, { signal: taskController.signal });
          taskController.signal.throwIfAborted();
          updateTasks((current) => current.map((task) =>
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
      const results = settled.map((item, index): WorkflowTaskUnitResult => {
        const unit = unitAt(index);
        if (item.status === "rejected") {
          const error = item.reason instanceof Error ? item.reason.message : String(item.reason || "任务执行失败");
          return { unit, images: [], error: error || "任务执行失败" };
        }
        const images = creationTaskImages(item.value).map((image) => ({
          ...image,
          index: seriesRun && seriesIndex ? seriesIndex - 1 : index,
          ...(draft?.title ? { title: draft.title } : {}),
          ...(draft ? { prompt: taskPrompt } : {}),
        }));
        return { unit, images, error: images.length ? undefined : "接口没有返回图片" };
      });
      imageURLs = results.flatMap((result) => result.images.map((image) => image.url));
      partialError = [...new Set(results.flatMap((result) => result.error ? [result.error] : []))].join("\n") || undefined;
      settleLocalTask(results);
    } catch (error) {
      if (taskController.signal.aborted || isWorkflowPollAbort(error)) {
        throw taskController.signal.reason || error;
      }
      const message = error instanceof Error ? error.message : "工作流运行失败";
      settleLocalTask(Array.from({ length: count }, (_, index) => ({ unit: unitAt(index), images: [], error: message })));
      if (draft) patchSeriesDraft(draft.id, { status: "failed", error: message });
      throw error;
    } finally {
      finishWorkflowTaskSubmission(localTaskID, taskReferences);
    }
    if (draft) patchSeriesDraft(draft.id, {
      status: partialError ? "failed" : "success",
      result_ids: imageURLs,
      error: partialError,
    });
    if (partialError) throw new Error(partialError);
    markWorkflowRunCompleted(workflow, Date.now());
    return imageURLs;
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
    const runtime = resolveWorkflowRuntime(running, models, preferences);
    if (!isWorkflowModelConfigured(runtime.model, models?.image_models)) {
      toast.error("管理员尚未配置可用的图片模型");
      return;
    }
    const workflow = running;
    const prompt = renderedPrompt;
    try {
      const task = executeImageTask(workflow, prompt);
      closeRunner();
      await task;
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
    const model = resolveWorkflowTextModel(running, models, preferences);
    if (!isWorkflowModelConfigured(model, models?.text_models)) {
      toast.error("管理员尚未配置可用的文本模型");
      return;
    }
    const taskController = taskWaitAbortControllerRef.current;
    if (!taskController || taskController.signal.aborted) return;
    const runnerGeneration = workflowReferenceUploadGenerationRef.current;
    const requestSessionKey = sessionKey;
    const isCurrent = () => workspaceActiveRef.current
      && !taskController.signal.aborted
      && workflowReferenceUploadGenerationRef.current === runnerGeneration
      && getCachedAuthSession()?.key === requestSessionKey;
    if (!isCurrent()) return;
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
      const submitted = await createChatGenerationTask({
        clientTaskId: taskID("workflow-series"),
        stream: true,
        prompt,
        model,
        relayTokenName: nextTokenNameForModel("text", model),
        messages: [{ role: "user", content: prompt }],
        requestOptions: { signal: taskController.signal },
      });
      const completed = await waitForOwnedTask(
        submitted.id,
        600,
      );
      if (!isCurrent()) return;
      const drafts = parseWorkflowSeriesDrafts(taskText(completed), count, renderedPrompt);
      setSeriesDrafts(drafts);
      toast.success("多图提示词已生成，请审核后生成图片");
      if (running.series_config.review_required === false) {
        window.setTimeout(() => {
          if (isCurrent()) void runAllSeriesDrafts(drafts);
        }, 0);
      }
    } catch (error) {
      if (isCurrent() && !isWorkflowPollAbort(error)) {
        toast.error(error instanceof Error ? error.message : "系列提示词生成失败");
      }
    } finally {
      if (isCurrent()) {
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
    seriesBatchIndex?: number,
  ) {
    if (!running || !draft.prompt.trim() || draft.status === "running") return false;
    try {
      await executeImageTask(running, draft.prompt.trim(), 1, draft, index, seriesRun, seriesBatchIndex);
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
    const runtime = resolveWorkflowRuntime(running, models, preferences);
    if (!isWorkflowModelConfigured(runtime.model, models?.image_models)) {
      toast.error("管理员尚未配置可用的图片模型");
      return;
    }
    const controller = taskWaitAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    const drafts = source
      .map((draft, sourceIndex) => ({ draft, sourceIndex }))
      .filter(({ draft }) => draft.prompt.trim() && draft.status !== "running" && draft.status !== "success");
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
      references: freezeWorkflowReferences(workflowReferencesRef.current),
    };
    beginWorkflowTaskSubmission(seriesRun.id);
    let successCount = 0;
    try {
      for (let index = 0; index < drafts.length; index += concurrency) {
        if (controller.signal.aborted) return;
        const results = await Promise.all(
          drafts.slice(index, index + concurrency).map(({ draft, sourceIndex }, chunkIndex) =>
            runOneSeriesDraft(
              draft,
              sourceIndex,
              seriesRun,
              false,
              index + chunkIndex + 1,
            ),
          ),
        );
        successCount += results.filter(Boolean).length;
      }
      if (controller.signal.aborted) return;
      if (successCount === drafts.length) toast.success(`多图任务已完成，共生成 ${successCount} 张`);
      else toast.error(`多图任务完成 ${successCount}/${drafts.length} 张，请查看任务记录`);
    } finally {
      finishWorkflowTaskSubmission(seriesRun.id, seriesRun.references);
    }
  }

  async function clearCompletedTaskHistory(includeAssets: boolean) {
    if (clearingTaskHistory || !isCurrentWorkspace()) return false;
    setClearingTaskHistory(true);
    try {
      const signal = taskWaitAbortControllerRef.current!.signal;
      const excludedBatchIDs = new Set(inFlightTaskCountsRef.current.keys());
      for (const task of tasksRef.current) {
        if (task.status === "running") excludedBatchIDs.add(task.id);
      }
      const localCompleted = new Set(tasksRef.current.filter((task) =>
        !task.backend_task_ids.length && !excludedBatchIDs.has(task.id),
      ).map((task) => task.id));
      const canDeleteAssets = includeAssets && hasAPIPermission(session, "DELETE", "/api/images");
      const result = await clearWorkflowTaskHistory([...excludedBatchIDs], canDeleteAssets, signal);
      if (!isCurrentWorkspace()) return false;
      const removableTaskIDs = new Set(result.deleted_batch_ids);
      const localRemovals = tasksRef.current.filter((task) => localCompleted.has(task.id)
        && task.status !== "running" && !task.backend_task_ids.length && !inFlightTaskCountsRef.current.has(task.id));
      for (const task of localRemovals) removableTaskIDs.add(task.id);
      setTaskHistoryPage(null);
      updateTasks((current) => current.filter((task) => !removableTaskIDs.has(task.id)));
      if (!removableTaskIDs.size) {
        toast.info("没有可清理的任务记录");
        return true;
      }
      const referenceKeys = workflowReferenceCleanupKeys(
        [...(result.references || []), ...localRemovals.flatMap((task) => task.references)],
        [
          ...ownedTaskReferences(),
          ...workflowReferencesRef.current,
          ...agentReferencesRef.current,
        ],
      );
      if (removableTaskIDs.has(selectedTaskID)) setSelectedHistoryTask(null);
      if (referenceKeys.length) {
        await deleteStoredImages(referenceKeys).catch((error) => {
          if (isCurrentWorkspace()) toast.error(error instanceof Error ? `任务记录已清理，但临时参考图删除失败：${error.message}` : "任务记录已清理，但临时参考图删除失败");
        });
      }
      if (!isCurrentWorkspace()) return false;
      let deletedAssetCount = 0;
      if (canDeleteAssets) {
        const assetPaths = Array.from(new Set((result.result_urls || [])
          .map(getManagedImagePathFromUrl)
          .filter(Boolean)));
        if (assetPaths.length) {
          try {
            const assetResult = await deleteManagedImages(assetPaths);
            if (!isCurrentWorkspace()) return false;
            deletedAssetCount = assetResult.deleted;
          } catch (error) {
            if (!isCurrentWorkspace()) return false;
            toast.error(error instanceof Error ? `任务记录已清理，但关联素材删除失败：${error.message}` : "任务记录已清理，但关联素材删除失败");
            return true;
          }
        }
      }
      if (canDeleteAssets) toast.success(`已清理 ${removableTaskIDs.size} 条任务记录，并删除 ${deletedAssetCount} 个关联素材`);
      else toast.success(`已清理 ${removableTaskIDs.size} 条任务记录，关联素材已保留`);
      return true;
    } catch (error) {
      if (isCurrentWorkspace()) toast.error(error instanceof Error ? error.message : "任务记录清理失败");
      return false;
    } finally {
      if (isCurrentWorkspace()) setClearingTaskHistory(false);
    }
  }

  function acceptWorkflowAgentDraft(response: Awaited<ReturnType<typeof draftWorkflowWithAgent>>) {
    const { draft, warnings } = response;
    const base = createBlankWorkflow(
      models,
      preferences,
      draft.mode === "multi_image_series" ? "multi_image_series" : "single_image",
      workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID),
    );
    setAgentDraft(normalizeWorkflow({
      ...base,
      ...draft,
      id: taskID("workflow-draft"),
      scope: draft.scope === "public" ? "public" : "private",
      variables: Array.isArray(draft.variables) ? draft.variables : base.variables,
      config: { ...base.config, ...draft.config },
      series_config: { ...base.series_config, ...draft.series_config },
    }, models, preferences));
    setAgentWarnings(Array.isArray(warnings) ? warnings : []);
    setAgentError("");
  }

  async function draftWithAgent() {
    if (!session || !agentPrompt.trim() || agentDraftAbortControllerRef.current) return;
    const model = resolveConfiguredModel(
      models?.text_models,
      agentModel,
      preferences.default_text_model,
      models?.default_text_model,
    );
    if (!isWorkflowModelConfigured(model, models?.text_models)) {
      setAgentError("管理员尚未配置可用的文本模型");
      return;
    }
    const requestSessionKey = session.key;
    if (!workspaceActiveRef.current || getCachedAuthSession()?.key !== requestSessionKey) return;
    const controller = new AbortController();
    agentDraftAbortControllerRef.current = controller;
    setAgentBusy(true);
    setAgentError("");
    setAgentRunID("");
    const isCurrent = () => (
      workspaceActiveRef.current
      && agentDraftAbortControllerRef.current === controller
      && !controller.signal.aborted
      && currentSessionKeyRef.current === requestSessionKey
      && getCachedAuthSession()?.key === requestSessionKey
    );
    try {
      await runCurrentWorkflowAgentDraft({
        signal: controller.signal,
        isCurrent,
        prepareReferences: (signal) => agentReferences.length
          ? workflowImageDataURLs(agentReferences, signal)
          : Promise.resolve([]),
        submit: (preparedReferences, signal) => draftWorkflowWithAgent({
          prompt: agentPrompt.trim(),
          scope: agentScope,
          model,
          channelID: tokenNameForModel("text", model),
          references: preparedReferences,
        }, { signal, onStarted: (id) => { if (isCurrent()) setAgentRunID(id); } }),
        commit: acceptWorkflowAgentDraft,
      });
    } catch (error) {
      if (isCurrent()) {
        setAgentError(error instanceof Error ? error.message : "Agent 创建失败");
      }
    } finally {
      const shouldReleaseUI = isCurrent();
      if (agentDraftAbortControllerRef.current === controller) {
        agentDraftAbortControllerRef.current = null;
      }
      if (shouldReleaseUI) setAgentBusy(false);
    }
  }

  function applyAgentDraft() {
    if (!agentDraft) return;
    replaceEditor(structuredClone(agentDraft));
    setAgentOpen(false);
  }

  if (loading) {
    return (
      <LoadingState label="正在加载工作流" />
    );
  }

  const createWorkflow = (mode: CreativeWorkflow["mode"]) =>
    replaceEditor(
      createBlankWorkflow(
        models,
        preferences,
        mode,
        workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID),
      ),
    );
  const createDetailWorkflow = () =>
    replaceEditor(
      createProductDetailWorkflow(
        models,
        preferences,
        workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID),
      ),
      "product_detail",
    );

  const sectionTitle =
    category !== "all"
      ? category
      : modeFilter === "single_image"
        ? "单图工作流"
        : modeFilter === "multi_image_series"
          ? "多图系列"
          : "全部工作流";
  const workflowActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus />
          创建
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => createWorkflow("single_image")}>
          <ImageIcon />
          新建工作流
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => createWorkflow("multi_image_series")}>
          <Layers3 />
          新建多图系列
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={createDetailWorkflow}>
          <Layers3 />
          新建详情模板
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <ManagementPage aria-label="工作流">
      {editorRoute ? (
        loadError ? (
          <EmptyState role="alert" title="无法加载工作流" description={loadError} action={<Button variant="outline" onClick={() => setLoadAttempt((n) => n + 1)}>重试</Button>} />
        ) : resolvedEditorRoute !== editorRouteKey ? (
          <LoadingState label="正在加载工作流编辑器" />
        ) : editing ? (
          <WorkflowEditor
            key={editorRouteKey}
            workflow={editing}
            isNew={!items.some((item) => item.id === editing?.id)}
            models={models}
            preferences={preferences}
            saving={workflowSaving}
            saveError={workflowSaveError}
            referenceBusy={referenceBusy}
            onChange={setEditing}
            onSave={persist}
            onAssetsOpen={() => setAssetPickerTarget("template")}
            onReferencesAdd={(files) => void addReferences(files, "template")}
            onClose={() => replaceEditor(null)}
          />
        ) : (
          <EmptyState
            title="无法打开工作流"
            description="工作流不存在，或当前账号没有编辑权限。"
            action={<Button onClick={() => replaceEditor(null)}>返回工作流</Button>}
          />
        )
      ) : (
        <LibraryWorkspace
          title="工作流"
          sidebar={
            <>
              <Button variant="ghost" className="h-11 w-full justify-start" onClick={() => createWorkflow("single_image")}>
                <Plus />
                创建工作流
              </Button>
              <nav aria-label="工作流分类" className="space-y-1">
                {(
                  [
                    { value: "all", label: "全部工作流", icon: Folder },
                    { value: "single_image", label: "单图工作流", icon: ImageIcon },
                    { value: "multi_image_series", label: "多图系列", icon: Layers3 },
                  ] as const
                ).map((option) => (
                  <Button
                    key={option.value}
                    data-library-filter
                    variant={category === "all" && modeFilter === option.value ? "secondary" : "ghost"}
                    className="h-11 w-full justify-start font-normal"
                    onClick={() => {
                      setCategory("all");
                      setModeFilter(option.value);
                    }}
                  >
                    <option.icon />
                    {option.label}
                  </Button>
                ))}
              </nav>
              {categories.length ? (
                <div className="space-y-1">
                  <h2 className="px-2 pb-2 text-xs text-muted-foreground">分类</h2>
                  {categories.map((item) => (
                    <Button
                      key={item}
                      data-library-filter
                      variant={category === item ? "secondary" : "ghost"}
                      className="h-11 w-full justify-start font-normal"
                      onClick={() => {
                        setCategory(item);
                        setModeFilter("all");
                      }}
                    >
                      <Folder />
                      <span className="truncate">{item}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          }
          footer={
            !hideTaskList ? (
              <Button variant="ghost" className="h-11 w-full justify-start" aria-label="任务记录" onClick={() => setTaskHistoryOpen(true)}>
                {runningTaskCount ? <Spinner /> : <ClipboardList />}任务记录
                {runningTaskCount ? <Badge variant="secondary">{runningTaskCount}</Badge> : null}
              </Button>
            ) : null
          }
        >
          {(sidebarToggle) => (
            <>
              <ManagementToolbar className={cn("space-y-5", embedded && "pr-14 sm:pr-14")}>
                <div data-workflow-toolbar className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {sidebarToggle}
                    <h1 className="text-2xl font-semibold tracking-tight">{sectionTitle}</h1>
                  </div>
                  <div
                    data-workflow-actions
                    className="grid min-w-0 flex-1 basis-full grid-cols-2 items-center gap-2 sm:flex sm:basis-auto sm:justify-end"
                  >
                    <SearchInput
                      aria-label="搜索工作流"
                      value={query}
                      onValueChange={setQuery}
                      placeholder="搜索工作流"
                      containerClassName="col-span-2 min-w-0 max-w-sm sm:min-w-24 sm:flex-1"
                    />
                    <Button variant="outline" onClick={() => setAgentOpen(true)}>
                      <Bot />
                      Agent 创建
                    </Button>
                    {workflowActions}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div role="group" aria-label="工作流范围" className="flex items-center gap-1">
                    {workflowScopeOptions.map((option) => {
                      const Icon = option.icon;
                      return (
                        <ToggleButton
                          key={option.value}
                          pressed={scopeFilter === option.value}
                          onPressedChange={() => setScopeFilter(option.value)}
                        >
                          {Icon ? <Icon /> : null}
                          {option.label}
                        </ToggleButton>
                      );
                    })}
                  </div>
                  <div role="group" aria-label="工作流视图" className="flex items-center gap-1">
                    <Button
                      variant={view === "grid" ? "secondary" : "ghost"}
                      size="icon"
                      aria-label="卡片视图"
                      aria-pressed={view === "grid"}
                      onClick={() => setView("grid")}
                    >
                      <LayoutGrid />
                    </Button>
                    <Button
                      variant={view === "list" ? "secondary" : "ghost"}
                      size="icon"
                      aria-label="列表视图"
                      aria-pressed={view === "list"}
                      onClick={() => setView("list")}
                    >
                      <List />
                    </Button>
                  </div>
                </div>
              </ManagementToolbar>
              <ScrollArea
                className="min-h-0 min-w-0 flex-1"
                contentClassName="p-4 pr-1 sm:p-6 sm:pr-3"
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="flex w-full flex-col gap-8">
                  {loading && !items.length ? (
                    <LoadingState label="正在加载工作流" />
                  ) : loadError && !items.length ? (
                    <EmptyState role="alert" title="无法加载工作流" description={loadError} action={<Button variant="outline" onClick={() => setLoadAttempt((n) => n + 1)}>重试</Button>} />
                  ) : visibleWorkflows.length ? (
                    <section aria-label="工作流列表" className="@container/workflows">
                      {view === "list" ? (
                        <WorkflowList
                          items={visibleWorkflows}
                          onRun={openRunner}
                          onEdit={(workflow) => replaceEditor(structuredClone(workflow))}
                          onCopy={(workflow) => void duplicateWorkflow(workflow)}
                          onDelete={setDeletingWorkflow}
                        />
                      ) : (
                        <div
                          data-workflow-grid
                          className="grid grid-cols-1 gap-3 @min-[36rem]/workflows:grid-cols-2 @min-[56rem]/workflows:grid-cols-3 @min-[80rem]/workflows:grid-cols-4"
                        >
                          {visibleWorkflows.map((workflow) => (
                            <WorkflowCard
                              key={workflow.id}
                              workflow={workflow}
                              onRun={() => openRunner(workflow)}
                              onEdit={() => replaceEditor(structuredClone(workflow))}
                              onCopy={() => void duplicateWorkflow(workflow)}
                              onDelete={() => setDeletingWorkflow(workflow)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  ) : (
                    <EmptyState
                      icon={WorkflowIcon}
                      title={items.length ? "没有匹配的工作流" : "还没有工作流"}
                      description={
                        items.length ? "试试其他关键词，或清除筛选查看全部工作流。" : "创建一个模板，开始组织你的创作步骤。"
                      }
                      className="min-h-72"
                      action={
                        items.length ? (
                          <Button
                            variant="outline"
                            onClick={() => {
                              setQuery("");
                              setCategory("all");
                              setModeFilter("all");
                              setScopeFilter("all");
                            }}
                          >
                            清除筛选
                          </Button>
                        ) : (
                          <Button
                            onClick={() =>
                              replaceEditor(
                                createBlankWorkflow(
                                  models,
                                  preferences,
                                  "single_image",
                                  workflowGenerationDefaults(preferences, generationDefaults, sessionTextChannelID),
                                ),
                              )
                            }
                          >
                            <Plus />
                            新建工作流
                          </Button>
                        )
                      }
                    />
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
            </>
          )}
        </LibraryWorkspace>
      )}
      <ConfirmDialog
        open={Boolean(deletingWorkflow)}
        title="删除工作流"
        description={`确定删除「${deletingWorkflow?.name ?? ""}」吗？已生成的图片不受影响。`}
        confirmLabel="删除"
        destructive
        busy={deleteBusy}
        onOpenChange={(next) => {
          if (!next) setDeletingWorkflow(null);
        }}
        onConfirm={async () => {
          const target = deletingWorkflow;
          if (!target) return;
          setDeleteBusy(true);
          try {
            await deleteWorkflow(target.id);
            setItems((current) => current.filter((item) => item.id !== target.id));
            setDeletingWorkflow(null);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "删除失败");
          } finally {
            setDeleteBusy(false);
          }
        }}
      />
      <WorkflowTaskHistoryDialog
        open={taskHistoryOpen}
        tasks={historyTasks}
        localTasks={localHistoryTasks}
        counts={taskHistoryResponse?.page.counts}
        total={taskHistoryPage?.total ?? taskHistoryResponse?.page.counts[taskHistoryQuery.status] ?? 0}
        page={taskHistoryPage?.page || taskHistoryQuery.page}
        query={taskHistoryQuery}
        onQueryChange={(query) => {
          setTaskHistoryLoading(true);
          setTaskHistoryError("");
          setTaskHistoryQuery(query);
        }}
        loading={taskHistoryLoading}
        error={taskHistoryError}
        onRetry={() => setTaskHistoryAttempt((n) => n + 1)}
        recoveryError={taskRecoveryError}
        onRetryRecovery={() => setTaskRecoveryAttempt((n) => n + 1)}
        clearing={clearingTaskHistory}
        canDeleteAssets={hasAPIPermission(session, "DELETE", "/api/images")}
        onClearCompleted={clearCompletedTaskHistory}
        onOpenTask={(task) => {
          setTaskHistoryOpen(false);
          setSelectedHistoryTask(task);
        }}
        onClose={() => setTaskHistoryOpen(false)}
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
        preferences={preferences}
        batchAppend={seriesBatchAppend}
        onValuesChange={setValues}
        onAssetsOpen={() => setAssetPickerTarget("workflow")}
        onReferencesAdd={(files) => void addReferences(files, "workflow")}
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
      <WorkflowAgentDialog
        open={agentOpen}
        prompt={agentPrompt}
        scope={agentScope}
        model={agentModel}
        models={models}
        references={agentReferences}
        draft={agentDraft}
        warnings={agentWarnings}
        error={agentError}
        busy={agentBusy || referenceBusy}
        activeID={agentBusy ? agentRunID : undefined}
        onPromptChange={setAgentPrompt}
        onScopeChange={setAgentScope}
        onModelChange={setAgentModel}
        onAssetsOpen={() => setAssetPickerTarget("agent")}
        onReferencesAdd={(files) => void addReferences(files, "agent")}
        onReferenceRemove={removeAgentReference}
        onRecovered={acceptWorkflowAgentDraft}
        onRun={() => void draftWithAgent()}
        onApply={applyAgentDraft}
        onClose={() => setAgentOpen(false)}
      />
      {assetPickerTarget ? <WorkflowAssetPicker
        assets={assetLibrary}
        loading={assetLoading || assetLibraryLoading}
        error={[ownAssetError && "自有素材读取失败", assetLibraryError].filter(Boolean).join("、")}
        onRetry={() => {
          if (ownAssetError) reloadOwnAssets();
          if (assetLibraryError) setAssetLibraryAttempt((attempt) => attempt + 1);
        }}
        imageOnly={assetPickerTarget === "template"}
        onInsert={insertWorkflowAsset}
        onClose={() => setAssetPickerTarget(null)}
      /> : null}
      <WorkflowTaskDialog task={selectedTask} onClose={() => setSelectedHistoryTask(null)} />
    </ManagementPage>
  );
}

function WorkflowCard({ workflow, onRun, onEdit, onCopy, onDelete }: { workflow: CreativeWorkflow; onRun: () => void; onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
  const isSeries = workflow.mode === "multi_image_series";
  return (
    <Card className="group flex min-h-44 flex-col p-4 gap-0">
      <div className="flex items-start gap-3">
        <ItemMedia variant="icon" className="grid size-9 shrink-0 place-items-center"><WorkflowIcon className="size-4" /></ItemMedia>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2"><h3 className="truncate text-sm font-semibold">{workflow.name}</h3><span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">{workflow.scope === "public" ? <Globe2 className="size-3" /> : <LockKeyhole className="size-3" />}{workflow.scope === "public" ? "公开" : "个人"}</span></div>
          <p className="mt-0.5 text-xs text-muted-foreground">{workflow.category || "未分类"}</p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 flex-1 text-xs leading-5 text-muted-foreground">{workflow.description || workflow.config.prompt_template}</p>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant={isSeries ? "secondary" : "secondary"} className="shrink-0">
          {isSeries ? <Layers3  /> : <ImageIcon  />}
          {isSeries ? "多图生成" : "单图生成"}
        </Badge>
        <span className="shrink-0">{workflow.variables.length} 个变量</span>
        {workflow.template_references.length ? <span className="shrink-0">{workflow.template_references.length} 张模板图</span> : null}
        {workflow.last_run_at ? <span className="min-w-0 truncate">最近运行 {new Date(workflow.last_run_at).toLocaleString("zh-CN")}</span> : null}
      </div>
      <div className="mt-3 flex items-center gap-1 border-t border-border/70 pt-3">
        <Button size="sm" onClick={onRun}><Play />运行</Button>
        {workflow.editable !== false ? <TooltipHint content={"编辑"}><Button aria-label="编辑" size="icon" variant="ghost" onClick={onEdit}><Pencil /></Button></TooltipHint> : null}
        <TooltipHint content={"复制"}><Button aria-label="复制" size="icon" variant="ghost" onClick={onCopy}><Copy /></Button></TooltipHint>
        {workflow.editable !== false ? <TooltipHint content={"删除"}><Button aria-label="删除" size="icon" variant="ghost" className="ml-auto" onClick={onDelete}><Trash2 /></Button></TooltipHint> : null}
      </div>
    </Card>
  );
}

function WorkflowAssetPicker({ assets, loading, error, onRetry, imageOnly = false, onInsert, onClose }: { assets: MyAsset[]; loading: boolean; error: string; onRetry: () => void; imageOnly?: boolean; onInsert: (asset: MyAsset) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (asset.kind !== "image" && (imageOnly || asset.kind !== "text")) return false;
      return !text || [asset.title, asset.content, asset.source, ...asset.tags].some((value) => String(value || "").toLowerCase().includes(text));
    });
  }, [assets, imageOnly, query]);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(94vw,900px)] sm:max-w-none">
        <DialogHeader><DialogTitle>选择素材</DialogTitle><DialogDescription>{imageOnly ? "选择图片作为工作流的持久风格模板。" : "选择文本填入变量或提示词，选择图片作为参考图。"}</DialogDescription></DialogHeader>
        <SearchInput value={query} onValueChange={setQuery} placeholder="搜索素材名称、内容或标签" />
        <ScrollArea data-slot="dialog-body" className="min-h-0 max-h-[min(58dvh,560px)] flex-1" contentClassName="grid gap-3 py-1">
          {error ? <Alert variant="destructive" role="alert" className="flex flex-wrap items-center gap-2"><AlertDescription className="min-w-0 flex-1">{error}</AlertDescription><Button variant="outline" size="sm" onClick={onRetry} disabled={loading}>重试</Button></Alert> : null}
          {loading && !filtered.length ? (
            <LoadingState className="h-48" label="正在加载素材" />
          ) : filtered.length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((asset) => (
                <Button variant="outline" key={assetListKey(asset)} type="button" aria-label={`插入素材 ${asset.title}`} className="block h-auto justify-start whitespace-normal p-0 min-w-0 overflow-hidden text-left" onClick={() => onInsert(asset)}>
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/50">
                    {asset.kind === "image" && asset.url ? <AuthenticatedImage src={asset.coverUrl || asset.url} alt={asset.title} className="size-full object-cover" placeholderClassName="min-h-0" /> : <p className="line-clamp-6 p-4 text-xs leading-5 text-muted-foreground">{asset.content}</p>}
                  </div>
                  <div className="p-3"><p className="truncate text-sm font-semibold">{asset.title}</p><p className="mt-1 text-xs text-muted-foreground">{asset.kind === "text" ? "文本" : "图片"}</p></div>
                </Button>
              ))}
            </div>
          ) : error ? null : (
            <EmptyState icon={ImageIcon} title={query.trim() ? "没有匹配的素材" : "暂无可用素材"} description={query.trim() ? "试试其他关键词，或清除搜索查看全部素材。" : "在「我的素材」中添加素材后，即可在这里引用。"} action={query.trim() ? <Button variant="outline" size="sm" onClick={() => setQuery("")}>清除搜索</Button> : undefined} />
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
