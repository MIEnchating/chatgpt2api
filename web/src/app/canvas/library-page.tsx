import { LoadingState } from "@/components/ui/loading-state";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { PromptInput, PromptInputFooter, PromptInputSubmit } from "@/components/ai-elements/prompt-input";
import { ItemMedia } from "@/components/ui/item";
import { Card } from "@/components/ui/card";
import { ManagementHeader, ManagementPanel, ManagementToolbar } from "@/components/management-page";
import { TooltipHint } from "@/components/ui/tooltip";
import { CanvasAgentAssetMenu } from "./canvas-agent-composer";
import { CanvasAgentMediaModelPicker } from "./canvas-agent-media-model-picker";
import { CanvasAgentModelPicker } from "./canvas-agent-model-picker";
import { CanvasAgentPromptChipInput } from "./canvas-agent-prompt-chip-input";
import { CanvasAgentSkillPicker } from "@/app/canvas/canvas-agent-skill-picker";
import { ArrowRight, ArrowUp, Bot, CheckSquare, Download, FileUp, FolderOpen, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { CanvasProjectDialog, type CanvasProjectDialogMode } from "@/app/canvas/canvas-project-dialog";
import { createCanvasProjectArchive, downloadCanvasProjectArchive, readCanvasProjectArchive } from "@/app/canvas/canvas-project-transfer";
import { CanvasAssetPicker } from "@/app/canvas/canvas-asset-picker";
import { canvasProjectPath } from "@/lib/canvas-project-route";
import { canvasAgentStarterLabel, createCanvasPendingAgentAsset, defaultCanvasAgentStarterConfig } from "@/app/canvas/agent/canvas-agent-starter";
import type { CanvasAgentConfig, CanvasInsertAssetPayload, CanvasPendingAgentAsset } from "@/app/canvas/agent/canvas-agent-types";
import { fetchModelConfig } from "@/lib/api";
import { configuredModelNames, resolveConfiguredModel } from "@/lib/model-config-selection";
import { loadImageGenerationPreferences } from "@/lib/use-image-generation-preferences";
import { resolveConfiguredVideoModel } from "@/lib/video-model-capabilities";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import {
  fetchCanvasDocument,
  fetchCanvasProjectList,
  mutateCanvasProjectList,
  saveCanvasDocument,
  updateCanvasProject,
  type CanvasProjectSummary,
} from "@/services/api/canvas";
import type { StoredAuthSession } from "@/lib/auth-session";

function projectDate(value?: string) {
  if (!value) return "暂无更新时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "暂无更新时间" : `更新于 ${date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

const agentStatusLabel = { running: "运行中", waiting: "等待处理", error: "执行失败", interrupted: "执行中断", success: "有新结果" };
const emptyAgentModels = { text: [], image: [], video: [] };

export default function CanvasLibraryPage({ session }: { session: StoredAuthSession }) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [activeProjectID, setActiveProjectID] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const visibleProjects = useMemo(() => search ? projects.filter((project) => (project.title || "未命名画布").toLocaleLowerCase().includes(search)) : projects, [projects, search]);
  const [busy, setBusy] = useState(false);
  const [selectedProjectIDs, setSelectedProjectIDs] = useState<Set<string>>(new Set());
  const allVisibleSelected = visibleProjects.length > 0 && visibleProjects.every((project) => selectedProjectIDs.has(project.id));
  const [agentPrompt, setAgentPrompt] = useState("");
  const [pendingAssets, setPendingAssets] = useState<CanvasPendingAgentAsset[]>([]);
  const [uploadingAsset, setUploadingAsset] = useState(false);
  const [agentConfig, setAgentConfig] = useState<CanvasAgentConfig>(defaultCanvasAgentStarterConfig);
  const [agentStarterOpen, setAgentStarterOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ mode: CanvasProjectDialogMode; project?: CanvasProjectSummary; count?: number } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const agentUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [agentModels, setAgentModels] = useState<Record<"text" | "image" | "video", string[]>>(emptyAgentModels);
  const [agentModelLoading, setAgentModelLoading] = useState(false);
  const [agentModelError, setAgentModelError] = useState("");
  const [agentModelAttempt, setAgentModelAttempt] = useState(0);
  const agentTextModel = agentModels.text.includes(agentConfig.textModel || "") ? agentConfig.textModel || "" : "";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void fetchCanvasProjectList(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setProjects(list.projects);
        setActiveProjectID(list.active_project_id);
        setSelectedProjectIDs(new Set());
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "画布库加载失败");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [session.key, reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    async function refreshAgentStatus() {
      if (refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try {
        const list = await fetchCanvasProjectList(controller.signal);
        if (controller.signal.aborted) return;
        const updated = new Map(list.projects.map(project => [project.id, project]));
        setProjects(current => current.map(project => {
          const fresh = updated.get(project.id);
          return fresh && fresh.revision >= project.revision ? { ...project, agent_status: fresh.agent_status } : project;
        }));
      } catch {
        // Keep the last known status until the next visible refresh.
      } finally {
        refreshing = false;
      }
    }
    const timer = window.setInterval(() => void refreshAgentStatus(), 10000);
    document.addEventListener("visibilitychange", refreshAgentStatus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshAgentStatus);
    };
  }, [session.key]);

  useEffect(() => {
    if (!agentStarterOpen) return;
    let active = true;
    setAgentModels(emptyAgentModels);
    setAgentModelLoading(true);
    setAgentModelError("");
    void Promise.all([fetchModelConfig(), loadImageGenerationPreferences()])
      .then(([{ config }, result]) => {
        if (!active) return;
        if (result.status === "error") throw result.error;
        const { preferences } = result;
        const models = {
          text: configuredModelNames(config.text_models),
          image: configuredModelNames(config.image_models).filter((model) => model.toLowerCase() !== "auto"),
          video: configuredModelNames(config.video_models),
        };
        if (!models.text.length) setAgentModelError("暂无可用的文本模型");
        setAgentModels(models);
        setAgentConfig((current) => ({
          ...current,
          textModel: resolveConfiguredModel(models.text, current.textModel, preferences.default_text_model, config.default_text_model),
          imageModel: resolveConfiguredModel(models.image, current.imageModel, preferences.default_image_model, config.default_image_model),
          videoModel: resolveConfiguredVideoModel(models.video, current.videoModel || "", preferences.workbench.video_model, preferences.default_video_model, config.default_video_model),
        }));
      })
      .catch((error) => { if (active) setAgentModelError(error instanceof Error ? error.message : "加载文本模型失败"); })
      .finally(() => { if (active) setAgentModelLoading(false); });
    return () => {
      active = false;
    };
  }, [agentStarterOpen, agentModelAttempt, session.key]);

  async function createAndOpen() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await mutateCanvasProjectList({ action: "create", title: `无限画布 ${projects.length + 1}` });
      navigate(canvasProjectPath(response.active_project_id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建画布失败");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAgentAsset(file?: File) {
    if (!file || uploadingAsset) return;
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
      toast.error("仅支持图片、视频和音频文件");
      return;
    }
    setUploadingAsset(true);
    try {
      let payload: CanvasInsertAssetPayload;
      if (file.type.startsWith("image/")) {
        const uploaded = await uploadImage(file);
        payload = { kind: "image", dataUrl: uploaded.url, title: file.name, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
      } else {
        const uploaded = await uploadAssetMediaFile(file);
        payload = file.type.startsWith("video/")
          ? { kind: "video", url: uploaded.url, title: file.name, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType, durationMs: uploaded.durationMs }
          : { kind: "audio", url: uploaded.url, title: file.name, storageKey: uploaded.storageKey, bytes: uploaded.bytes, mimeType: uploaded.mimeType, durationMs: uploaded.durationMs };
      }
      addPendingAsset(payload);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "素材上传失败");
    } finally {
      setUploadingAsset(false);
    }
  }

  function addPendingAsset(payload: CanvasInsertAssetPayload) {
    setPendingAssets((current) => [...current, createCanvasPendingAgentAsset(payload, canvasAgentStarterLabel(payload.kind, current))]);
  }

  function onAgentUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    void uploadAgentAsset(file);
  }

  async function createWithAgent(value = agentPrompt) {
    const prompt = value.trim() || (pendingAssets.length ? "请查看这些附件" : "");
    if (!prompt || !agentTextModel || busy || uploadingAsset) return;
    setBusy(true);
    try {
      const created = await updateCanvasProject({ action: "create", title: `无限画布 ${projects.length + 1}` });
      const document = created.document;
      await saveCanvasDocument({
        ...document,
        agent_config: agentConfig,
        pending_agent_request: { prompt, assets: pendingAssets },
      });
      navigate(canvasProjectPath(created.active_project_id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Agent 创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function exportProject(project: CanvasProjectSummary) {
    if (busy) return;
    setBusy(true);
    try {
      const workspace = await fetchCanvasDocument(project.id);
      const safeTitle = (project.title || "无限画布").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 80) || "无限画布";
      downloadCanvasProjectArchive(await createCanvasProjectArchive([workspace.document]), safeTitle);
      toast.success("画布已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出画布失败");
    } finally {
      setBusy(false);
    }
  }

  function toggleProject(projectID: string) {
    setSelectedProjectIDs((current) => {
      const next = new Set(current);
      if (next.has(projectID)) next.delete(projectID);
      else next.add(projectID);
      return next;
    });
  }

  function toggleAllProjects() {
    setSelectedProjectIDs((current) => {
      const next = new Set(current);
      for (const project of visibleProjects) {
        if (allVisibleSelected) next.delete(project.id);
        else next.add(project.id);
      }
      return next;
    });
  }

  async function exportSelectedProjects() {
    const selected = projects.filter((project) => selectedProjectIDs.has(project.id));
    if (!selected.length || busy) return;
    setBusy(true);
    try {
      const documents = await Promise.all(selected.map(async (project) => (await fetchCanvasDocument(project.id)).document));
      downloadCanvasProjectArchive(await createCanvasProjectArchive(documents), `无限画布-${selected.length}个项目`);
      toast.success(`已导出 ${selected.length} 个画布`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出画布失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedProjects() {
    const selected = projects.filter((project) => selectedProjectIDs.has(project.id));
    if (!selected.length || busy) return;
    setProjectDialog({ mode: "delete", count: selected.length });
  }

  async function confirmDeleteSelectedProjects() {
    const selected = projects.filter((project) => selectedProjectIDs.has(project.id));
    if (!selected.length || busy) return;
    setBusy(true);
    let deletedCount = 0;
    try {
      for (const project of selected) {
        const list = await mutateCanvasProjectList({ action: "delete", project_id: project.id, revision: project.revision });
        deletedCount += 1;
        setProjects(list.projects);
        setActiveProjectID(list.active_project_id);
        setSelectedProjectIDs((current) => new Set([...current].filter((id) => id !== project.id)));
      }
      setProjectDialog(null);
      setSelectedProjectIDs(new Set());
      toast.success(`已删除 ${selected.length} 个画布`);
    } catch (error) {
      if (deletedCount < selected.length) setProjectDialog({ mode: "delete", count: selected.length - deletedCount });
      toast.error(error instanceof Error ? error.message : "批量删除画布失败");
    } finally {
      setBusy(false);
    }
  }

  async function importProjects(file?: File) {
    if (!file || busy) return;
    setBusy(true);
    let imported = 0;
    try {
      const projectsToImport = await readCanvasProjectArchive(file);
      if (!projectsToImport.length) throw new Error("文件中没有有效的画布项目");
      for (const project of projectsToImport) {
        await mutateCanvasProjectList({ action: "import", document: project });
        imported += 1;
      }
      toast.success(`已导入 ${projectsToImport.length} 个画布`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "导入画布失败";
      toast.error(imported ? `已导入 ${imported} 个画布，其余导入失败：${reason}` : reason);
    } finally {
      // Already imported projects must show up even when a later one failed.
      if (imported) {
        try {
          const list = await fetchCanvasProjectList();
          setProjects(list.projects);
          setActiveProjectID(list.active_project_id);
          setSelectedProjectIDs(new Set());
        } catch {
          toast.error("画布列表刷新失败，请重新加载页面");
        }
      }
      setBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  async function renameProject(project: CanvasProjectSummary) {
    if (busy) return;
    setProjectDialog({ mode: "rename", project });
  }

  async function confirmRenameProject(value?: string) {
    const project = projectDialog?.project;
    const title = value?.trim() || "";
    if (!project || !title || title === project.title || busy) {
      if (project && title === project.title) setProjectDialog(null);
      return;
    }
    setBusy(true);
    try {
      const list = await mutateCanvasProjectList({ action: "rename", project_id: project.id, title, revision: project.revision });
      setProjects(list.projects);
      setActiveProjectID(list.active_project_id);
      setProjectDialog(null);
      toast.success("画布名称已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重命名画布失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(project: CanvasProjectSummary) {
    if (busy) return;
    setProjectDialog({ mode: "delete", project });
  }

  async function confirmDeleteProject() {
    const project = projectDialog?.project;
    if (!project || busy) return;
    setBusy(true);
    try {
      const list = await mutateCanvasProjectList({ action: "delete", project_id: project.id, revision: project.revision });
      setProjects(list.projects);
      setActiveProjectID(list.active_project_id);
      setProjectDialog(null);
      toast.success("画布已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除画布失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="无限画布" className="flex h-full min-h-0 flex-col overflow-hidden">
      <ManagementHeader title="无限画布" description="管理画布项目，继续创作或导入已有画布。" />
      <ManagementPanel className="flex-1">
        <ManagementToolbar data-canvas-project-toolbar className="flex min-w-0 shrink-0 flex-wrap items-center gap-3">
          <SearchInput value={query} onValueChange={setQuery} placeholder="搜索画布名称" containerClassName="min-w-40 flex-1 sm:max-w-sm" />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" role="status">{loading ? "正在加载" : `共 ${visibleProjects.length} 个画布`}</span>
          {projects.length ? <Button type="button" variant="ghost" size="sm" disabled={busy || !visibleProjects.length} onClick={toggleAllProjects}><CheckSquare />{allVisibleSelected ? "取消全选" : "全选当前结果"}</Button> : null}
          <div data-canvas-project-actions className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => importInputRef.current?.click()}><FileUp />导入画布</Button>
            {selectedProjectIDs.size ? <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void exportSelectedProjects()}><Download />导出选中 ({selectedProjectIDs.size})</Button>
              <Button type="button" variant="outline"  disabled={busy} onClick={() => void deleteSelectedProjects()}><Trash2 />删除选中</Button>
              <TooltipHint content={"取消选择"}><Button type="button" variant="ghost" size="icon"  aria-label="取消选择" disabled={busy} onClick={() => setSelectedProjectIDs(new Set())}><X /></Button></TooltipHint>
            </> : null}
            <Button type="button" variant="outline" disabled={busy} onClick={() => { setAgentModels(emptyAgentModels); setAgentModelError(""); setAgentStarterOpen(true); }}><Bot />Agent</Button>
            <Button type="button" disabled={busy} onClick={() => void createAndOpen()}>{busy ? <Spinner /> : <Plus />}新建画布</Button>
          </div>
        </ManagementToolbar>
      <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0">
        <div data-canvas-project-content className="w-full p-4 sm:p-6">
        {loading ? (
          <LoadingState className="min-h-[360px]" label="正在加载画布..." />
        ) : loadError ? (
          <EmptyState icon={FolderOpen} title="画布加载失败" description={loadError} className="min-h-72" action={<Button variant="outline" onClick={() => setReloadKey((key) => key + 1)}>重新加载</Button>} />
        ) : visibleProjects.length ? (
          <div data-canvas-project-grid className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visibleProjects.map((project) => (
              <Card key={project.id} data-canvas-project-card data-selected={selectedProjectIDs.has(project.id)} className="group flex min-w-0 flex-col gap-0 p-4 text-left transition-colors data-[selected=true]:bg-primary/5 data-[selected=true]:ring-2 data-[selected=true]:ring-primary/50">
                <div className="mb-3 flex min-h-5 items-center justify-between gap-3">
                  <Label data-disabled={busy} data-selected={selectedProjectIDs.has(project.id)} className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground transition-colors has-disabled:cursor-not-allowed data-[selected=true]:text-primary" onClick={(event) => event.stopPropagation()}>
                    <Checkbox checked={selectedProjectIDs.has(project.id)} onCheckedChange={() => toggleProject(project.id)} disabled={busy} aria-label={`选择${project.title}`} />
                    <span>{selectedProjectIDs.has(project.id) ? "已选择" : "选择"}</span>
                  </Label>
                  {project.id === activeProjectID ? <span className="text-[11px] font-medium text-primary">当前画布</span> : null}
                </div>
                <Button variant="ghost" type="button" disabled={busy} onClick={() => navigate(canvasProjectPath(project.id))} className="block h-auto min-w-0 flex-1 justify-start rounded-none p-0 text-left whitespace-normal hover:bg-transparent dark:hover:bg-transparent hover:text-inherit disabled:cursor-wait disabled:opacity-60">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <ItemMedia variant="icon" className="flex size-9 shrink-0 items-center justify-center"><Sparkles  /></ItemMedia>
                      <span className="truncate text-base font-semibold">{project.title || "未命名画布"}</span>
                    </div>
                    <ArrowRight className="mt-1 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
                  </div>
                  <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <p className="shrink-0">{project.node_count} 个节点</p>
                    <span aria-hidden="true" className="text-border">·</span>
                    <p>{projectDate(project.updated_at || project.created_at)}</p>
                  </div>
                </Button>
                <div className="mt-4 flex items-center justify-end gap-1 border-t border-border/70 pt-3">
                  {project.agent_status ? <Button type="button" size="sm" variant="ghost" className="mr-auto px-0" disabled={busy} aria-label={`${project.title} Agent ${agentStatusLabel[project.agent_status.status]}`} onClick={() => navigate(canvasProjectPath(project.id, project.agent_status?.session_id))}><Badge variant={project.agent_status.status === "error" ? "destructive" : "secondary"}>{agentStatusLabel[project.agent_status.status]}</Badge></Button> : null}
                  <TooltipHint content={"导出画布"}><Button type="button" variant="ghost" size="icon"  aria-label="导出画布" disabled={busy} onClick={() => void exportProject(project)}><Download  /></Button></TooltipHint>
                  <TooltipHint content={"重命名画布"}><Button type="button" variant="ghost" size="icon"  aria-label="重命名画布" disabled={busy} onClick={() => void renameProject(project)}><Pencil  /></Button></TooltipHint>
                  <TooltipHint content={"删除画布"}><Button type="button" variant="ghost" size="icon"  aria-label="删除画布" disabled={busy} onClick={() => void deleteProject(project)}><Trash2  /></Button></TooltipHint>
                </div>
              </Card>
            ))}
          </div>
        ) : query.trim() ? (
          <EmptyState icon={FolderOpen} title="没有找到匹配的画布" description="试试其他名称，或清除搜索查看所有画布。" className="min-h-72" action={<Button variant="outline" onClick={() => setQuery("")}>清除搜索</Button>} />
        ) : (
          <EmptyState icon={Sparkles} title="还没有画布" description="新建一个画布开始你的创作。" className="min-h-72" action={<Button type="button" disabled={busy} onClick={() => void createAndOpen()}><Plus />新建画布</Button>} />
        )}
        <input ref={importInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importProjects(event.target.files?.[0])} />
        </div>
      </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
      </ManagementPanel>
      <Dialog open={agentStarterOpen} onOpenChange={(open) => !busy && setAgentStarterOpen(open)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Bot className="size-5 text-primary" />Agent</DialogTitle>
            <DialogDescription>描述创作目标，Agent 将创建画布并直接开始执行。</DialogDescription>
          </DialogHeader>
          {agentModelLoading ? <LoadingState compact label="正在加载文本模型" /> : agentModelError ? (
            <div className="flex flex-wrap items-center justify-between gap-2" role="alert">
              <p className="min-w-0 text-sm text-destructive [overflow-wrap:anywhere]">{agentModelError}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => setAgentModelAttempt((n) => n + 1)}>重试</Button>
            </div>
          ) : null}
          <PromptInput data-canvas-agent-starter>
            <ScrollArea className="w-full max-h-[min(220px,40dvh)]" onKeyDownCapture={(event) => {
              if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              void createWithAgent();
            }}>
              <CanvasAgentPromptChipInput
                value={agentPrompt}
                references={[]}
                attachments={pendingAssets.map((asset) => asset.reference)}
                onRemoveAttachments={(ids) => setPendingAssets((current) => current.filter((item) => !ids.includes(item.reference.id)))}
                onChange={setAgentPrompt}
                onPasteImage={(file) => void uploadAgentAsset(file)}
                onSubmit={(value) => void createWithAgent(value)}
                className="min-h-24 w-full px-2.5 py-2 text-base md:text-sm"
                placeholder="描述创作目标"
              />
            </ScrollArea>
            {uploadingAsset ? <LoadingState compact className="mt-1 shrink-0" label="附件上传中…" /> : null}
            <PromptInputFooter>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                <CanvasAgentAssetMenu uploading={uploadingAsset} disabled={busy} onUpload={() => agentUploadInputRef.current?.click()} onOpenAssets={() => setAssetPickerOpen(true)} />
                <CanvasAgentModelPicker model={agentTextModel} models={agentModels.text.map((value) => ({ value, label: value }))} codex={false} disabled={busy} onChange={(textModel) => setAgentConfig((current) => ({ ...current, textModel }))} />
                <CanvasAgentMediaModelPicker disabled={busy || agentModelLoading} models={{
                  image: { value: agentConfig.imageModel || "", options: agentModels.image, onChange: (imageModel) => setAgentConfig((current) => ({ ...current, imageModel })) },
                  video: { value: agentConfig.videoModel || "", options: agentModels.video, onChange: (videoModel) => setAgentConfig((current) => ({ ...current, videoModel })) },
                }} />
                <CanvasAgentSkillPicker compact selectedIds={agentConfig.activeSkillIds || []} onChange={(activeSkillIds) => setAgentConfig((current) => ({ ...current, activeSkillIds }))} disabled={busy} />
              </div>
              <TooltipHint content="创建画布并执行"><PromptInputSubmit disabled={(!agentPrompt.trim() && !pendingAssets.length) || !agentTextModel || uploadingAsset || busy} aria-label="创建画布并执行" onClick={() => void createWithAgent()}>{busy ? <Spinner /> : <ArrowUp />}</PromptInputSubmit></TooltipHint>
            </PromptInputFooter>
            <input ref={agentUploadInputRef} hidden type="file" accept="image/*,video/*,audio/*" onChange={onAgentUploadChange} />
          </PromptInput>
        </DialogContent>
      </Dialog>
      <CanvasProjectDialog
        open={Boolean(projectDialog)}
        mode={projectDialog?.mode || "rename"}
        title={projectDialog?.project?.title || (projectDialog?.count ? `选中的 ${projectDialog.count} 个画布` : "")}
        description={projectDialog?.count ? `确定删除选中的 ${projectDialog.count} 个画布吗？此操作不可恢复。` : undefined}
        busy={busy}
        onOpenChange={(open) => !open && !busy && setProjectDialog(null)}
        onConfirm={(value) => void (projectDialog?.count ? confirmDeleteSelectedProjects() : projectDialog?.mode === "rename" ? confirmRenameProject(value) : confirmDeleteProject())}
      />
      <CanvasAssetPicker
        open={assetPickerOpen}
        session={session}
        onInsert={(payload) => {
          addPendingAsset(payload);
          setAssetPickerOpen(false);
        }}
        onClose={() => setAssetPickerOpen(false)}
      />
    </section>
  );
}
