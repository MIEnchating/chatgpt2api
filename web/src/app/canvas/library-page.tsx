import { ArrowRight, ArrowUp, Bot, CheckSquare, Download, FileUp, FolderOpen, Image as ImageIcon, LoaderCircle, Menu, Pencil, Plus, Sparkles, Trash2, Upload, Video, X } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  CanvasAgentImageSettings,
  CanvasAgentVideoSettings,
} from "@/app/canvas/canvas-agent-generation-settings";
import {
  canvasAgentImageSettingsSummary,
  canvasAgentVideoSettingsSummary,
} from "@/app/canvas/canvas-agent-generation-settings-summary";
import { CanvasProjectDialog, type CanvasProjectDialogMode } from "@/app/canvas/canvas-project-dialog";
import { createCanvasProjectArchive, downloadCanvasProjectArchive, readCanvasProjectArchive } from "@/app/canvas/canvas-project-transfer";
import { CanvasAssetPicker } from "@/app/canvas/canvas-asset-picker";
import { canvasProjectPath } from "@/lib/canvas-project-route";
import { canvasAgentStarterLabel, createCanvasPendingAgentAsset, defaultCanvasAgentStarterConfig } from "@/app/canvas/agent/canvas-agent-starter";
import type { CanvasAgentConfig, CanvasInsertAssetPayload, CanvasPendingAgentAsset } from "@/app/canvas/agent/canvas-agent-types";
import { DEFAULT_IMAGE_MODEL, fetchModelConfig } from "@/lib/api";
import { useImageGenerationPreferences } from "@/lib/use-image-generation-preferences";
import { resolveConfiguredVideoModel } from "@/lib/video-model-capabilities";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import {
  fetchCanvasDocument,
  importCanvasProject,
  saveCanvasDocument,
  updateCanvasProject,
  type CanvasProjectSummary,
} from "@/services/api/canvas";
import type { StoredAuthSession } from "@/store/auth";

function projectDate(value?: string) {
  if (!value) return "暂无更新时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "暂无更新时间" : `更新于 ${date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

export default function CanvasLibraryPage({ session }: { session: StoredAuthSession }) {
  const navigate = useNavigate();
  const { preferences: imageGenerationPreferences, isReady: imageGenerationPreferencesReady } = useImageGenerationPreferences(session.key);
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [activeProjectID, setActiveProjectID] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedProjectIDs, setSelectedProjectIDs] = useState<Set<string>>(new Set());
  const [agentPrompt, setAgentPrompt] = useState("");
  const [pendingAssets, setPendingAssets] = useState<CanvasPendingAgentAsset[]>([]);
  const [uploadingAsset, setUploadingAsset] = useState(false);
  const [agentConfig, setAgentConfig] = useState<CanvasAgentConfig>(defaultCanvasAgentStarterConfig);
  const [agentStarterOpen, setAgentStarterOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ mode: CanvasProjectDialogMode; project?: CanvasProjectSummary; count?: number } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const agentUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [agentVideoModel, setAgentVideoModel] = useState("");

  useEffect(() => {
    let active = true;
    void fetchCanvasDocument()
      .then((workspace) => {
        if (!active) return;
        setProjects(workspace.projects || []);
        setActiveProjectID(workspace.active_project_id || workspace.document?.id || "");
        setSelectedProjectIDs(new Set());
      })
      .catch((error) => {
        if (active) toast.error(error instanceof Error ? error.message : "画布库加载失败");
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [session.key]);

  useEffect(() => {
    if (!imageGenerationPreferencesReady) return;
    let active = true;
    void fetchModelConfig()
      .then(({ config }) => {
        if (!active) return;
        const model = resolveConfiguredVideoModel(
          config.video_models,
          imageGenerationPreferences.workbench.video_model,
          imageGenerationPreferences.default_video_model,
          config.default_video_model,
        );
        setAgentVideoModel(model);
        setAgentConfig(defaultCanvasAgentStarterConfig(model));
      })
      .catch(() => {
        if (!active) return;
        setAgentVideoModel("");
        setAgentConfig(defaultCanvasAgentStarterConfig(""));
      });
    return () => {
      active = false;
    };
  }, [imageGenerationPreferences.default_video_model, imageGenerationPreferences.workbench.video_model, imageGenerationPreferencesReady]);

  async function createAndOpen() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await updateCanvasProject({ action: "create", title: `无限画布 ${projects.length + 1}` });
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
    setPendingAssets((current) => {
      const asset = createCanvasPendingAgentAsset(payload, canvasAgentStarterLabel(payload.kind, current));
      setAgentPrompt((prompt) => `${prompt}${prompt.endsWith(" ") || !prompt ? "" : " "}${asset.reference.label} `);
      return [...current, asset];
    });
  }

  function onAgentUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    void uploadAgentAsset(file);
  }

  async function createWithAgent() {
    const prompt = agentPrompt.trim();
    if (!prompt || busy || uploadingAsset) return;
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

  async function openProject(project: CanvasProjectSummary) {
    if (busy) return;
    setBusy(true);
    try {
      if (project.id !== activeProjectID) {
        const response = await updateCanvasProject({ action: "activate", project_id: project.id });
        setActiveProjectID(response.active_project_id);
      }
      navigate(canvasProjectPath(project.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打开画布失败");
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
    setSelectedProjectIDs((current) => current.size === projects.length ? new Set() : new Set(projects.map((project) => project.id)));
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
    try {
      for (const project of selected) {
        await updateCanvasProject({ action: "delete", project_id: project.id, revision: project.revision });
      }
      const workspace = await fetchCanvasDocument();
      setProjects(workspace.projects || []);
      setActiveProjectID(workspace.active_project_id || workspace.document?.id || "");
      setSelectedProjectIDs(new Set());
      toast.success(`已删除 ${selected.length} 个画布`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量删除画布失败");
    } finally {
      setBusy(false);
    }
  }

  async function importProjects(file?: File) {
    if (!file || busy) return;
    setBusy(true);
    try {
      const projectsToImport = await readCanvasProjectArchive(file);
      if (!projectsToImport.length) throw new Error("文件中没有有效的画布项目");
      for (const project of projectsToImport) await importCanvasProject(project);
      const workspace = await fetchCanvasDocument();
      setProjects(workspace.projects || []);
      setActiveProjectID(workspace.active_project_id || workspace.document?.id || "");
      setSelectedProjectIDs(new Set());
      toast.success(`已导入 ${projectsToImport.length} 个画布`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入画布失败");
    } finally {
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
      const response = await updateCanvasProject({ action: "rename", project_id: project.id, title, revision: project.revision });
      setProjects(response.projects || []);
      setActiveProjectID(response.active_project_id || activeProjectID);
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
      const response = await updateCanvasProject({ action: "delete", project_id: project.id, revision: project.revision });
      setProjects(response.projects || []);
      setActiveProjectID(response.active_project_id || "");
      setProjectDialog(null);
      toast.success("画布已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除画布失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-[var(--page-section-gap)] overflow-hidden">
      <PageHeader
        actions={
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={() => importInputRef.current?.click()}><FileUp />导入画布</Button>
            {projects.length ? <Button type="button" variant="ghost" disabled={busy} onClick={toggleAllProjects}><CheckSquare />{selectedProjectIDs.size === projects.length ? "取消全选" : "全选"}</Button> : null}
            {selectedProjectIDs.size ? <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void exportSelectedProjects()}><Download />导出选中 ({selectedProjectIDs.size})</Button>
              <Button type="button" variant="outline" className="text-rose-600 hover:text-rose-700" disabled={busy} onClick={() => void deleteSelectedProjects()}><Trash2 />删除选中</Button>
              <Button type="button" variant="ghost" size="icon" className="size-9" title="取消选择" aria-label="取消选择" disabled={busy} onClick={() => setSelectedProjectIDs(new Set())}><X /></Button>
            </> : null}
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAgentStarterOpen(true)}><Bot />Agent</Button>
            <Button type="button" disabled={busy} onClick={() => void createAndOpen()}>{busy ? <LoaderCircle className="animate-spin" /> : <Plus />}新建画布</Button>
          </>
        }
      />
      <ScrollArea className="card-surface min-h-0 flex-1 rounded-xl border border-border/80 shadow-[0_4px_16px_rgba(24,40,72,0.05)]">
        <div data-canvas-project-content className="w-full px-4 py-4 sm:px-6 sm:py-6">
        {loading ? (
          <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />正在加载画布...</div>
        ) : projects.length ? (
          <div data-canvas-project-grid className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {projects.map((project) => (
              <div key={project.id} data-canvas-project-card data-selected={selectedProjectIDs.has(project.id)} data-interaction="trigger" className="interactive-card group flex min-w-0 flex-col rounded-lg border border-border bg-card p-4 text-left shadow-sm">
                <div className="mb-3 flex min-h-5 items-center justify-between gap-3">
                  <label data-disabled={busy} className="selection-trigger flex items-center gap-2 text-xs text-muted-foreground" onClick={(event) => event.stopPropagation()}>
                    <Checkbox checked={selectedProjectIDs.has(project.id)} onCheckedChange={() => toggleProject(project.id)} className="selection-control" disabled={busy} aria-label={`选择${project.title}`} />
                    <span>{selectedProjectIDs.has(project.id) ? "已选择" : "选择"}</span>
                  </label>
                  {project.id === activeProjectID ? <span className="text-[11px] font-medium text-[#1456f0]">当前画布</span> : null}
                </div>
                <button type="button" disabled={busy} onClick={() => void openProject(project)} className="interactive-card-trigger min-w-0 flex-1 text-left disabled:cursor-wait disabled:opacity-60">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#edf4ff] text-[#1456f0] dark:bg-blue-950/40 dark:text-blue-300"><Sparkles className="size-4.5" /></span>
                      <span className="truncate text-base font-semibold">{project.title || "未命名画布"}</span>
                    </div>
                    <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-[#1456f0]" />
                  </div>
                  <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <p className="shrink-0">{project.node_count} 个节点</p>
                    <span aria-hidden="true" className="text-border">·</span>
                    <p>{projectDate(project.updated_at || project.created_at)}</p>
                  </div>
                </button>
                <div className="mt-4 flex items-center justify-end gap-1 border-t border-border/70 pt-3">
                  <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg" title="导出画布" aria-label="导出画布" disabled={busy} onClick={() => void exportProject(project)}><Download className="size-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg" title="重命名画布" aria-label="重命名画布" disabled={busy} onClick={() => void renameProject(project)}><Pencil className="size-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg text-rose-600 hover:text-rose-700" title="删除画布" aria-label="删除画布" disabled={busy} onClick={() => void deleteProject(project)}><Trash2 className="size-4" /></Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
            <Sparkles className="size-8 text-muted-foreground/60" />
            <h2 className="mt-4 text-xl font-medium">还没有画布</h2>
            <p className="mt-2 text-sm text-muted-foreground">新建一个画布开始你的创作。</p>
            <Button type="button" className="mt-6" disabled={busy} onClick={() => void createAndOpen()}><Plus />新建画布</Button>
          </div>
        )}
        <input ref={importInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importProjects(event.target.files?.[0])} />
        </div>
      </ScrollArea>
      <Dialog open={agentStarterOpen} onOpenChange={(open) => !busy && setAgentStarterOpen(open)}>
        <DialogContent className="w-[min(94vw,900px)] max-w-none gap-5 sm:p-7">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Bot className="size-5 text-[#1456f0]" />Agent</DialogTitle>
            <DialogDescription>描述创作目标，Agent 将创建画布并直接开始执行。</DialogDescription>
          </DialogHeader>
          <div data-canvas-agent-starter className="rounded-xl border border-border bg-card p-4">
            {pendingAssets.length ? <div className="mb-2 flex flex-wrap gap-1.5">{pendingAssets.map((asset) => <span key={asset.nodeId} className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-[11px]"><span className="max-w-52 truncate">{asset.reference.label} · {asset.reference.title}</span><button type="button" className="grid size-5 place-items-center rounded hover:bg-muted" aria-label={`移除${asset.reference.title}`} onClick={() => setPendingAssets((current) => current.filter((item) => item.nodeId !== asset.nodeId))}><X className="size-3" /></button></span>)}</div> : null}
            <Textarea
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.target.value)}
              onPaste={(event) => {
                const image = [...event.clipboardData.files].find((file) => file.type.startsWith("image/"));
                if (!image) return;
                event.preventDefault();
                void uploadAgentAsset(image);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void createWithAgent();
              }}
              className="min-h-36 max-h-[50dvh] resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0 sm:min-h-48"
              placeholder="描述创作目标"
              aria-label="Agent 创作目标"
            />
            <div className="mt-2 flex min-w-0 items-center gap-1.5">
              <AgentStarterAssetMenu uploading={uploadingAsset} busy={busy} onUpload={() => agentUploadInputRef.current?.click()} onOpenAssets={() => setAssetPickerOpen(true)} />
              <AgentStarterParameterMenu icon={<ImageIcon />} label="图片参数" summary={canvasAgentImageSettingsSummary(agentConfig.imageQuality, agentConfig.imageSize)}><CanvasAgentImageSettings model={DEFAULT_IMAGE_MODEL} quality={agentConfig.imageQuality} size={agentConfig.imageSize} onChange={(patch) => setAgentConfig((current) => ({ ...current, ...patch }))} /></AgentStarterParameterMenu>
              <AgentStarterParameterMenu icon={<Video />} label="视频参数" summary={canvasAgentVideoSettingsSummary(agentConfig.videoQuality, agentConfig.videoSize)}><CanvasAgentVideoSettings model={agentVideoModel} quality={agentConfig.videoQuality} size={agentConfig.videoSize} onChange={(patch) => setAgentConfig((current) => ({ ...current, ...patch }))} /></AgentStarterParameterMenu>
              <Button type="button" size="icon" className="size-10 shrink-0 rounded-full" disabled={!agentPrompt.trim() || uploadingAsset || busy} aria-label="创建画布并执行" title="创建画布并执行" onClick={() => void createWithAgent()}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}</Button>
            </div>
            <input ref={agentUploadInputRef} hidden type="file" accept="image/*,video/*,audio/*" onChange={onAgentUploadChange} />
          </div>
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

function AgentStarterAssetMenu({ uploading, busy, onUpload, onOpenAssets }: { uploading: boolean; busy: boolean; onUpload: () => void; onOpenAssets: () => void }) {
  return <Popover><PopoverTrigger asChild><Button type="button" size="icon" variant="secondary" className="size-9 shrink-0 rounded-full" aria-label="添加 Agent 素材"><Menu /></Button></PopoverTrigger><PopoverContent side="bottom" align="start" className="w-40 p-1.5"><button type="button" disabled={uploading || busy} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50" onClick={onUpload}>{uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}上传文件</button><button type="button" disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50" onClick={onOpenAssets}><FolderOpen className="size-4" />我的素材</button></PopoverContent></Popover>;
}

function AgentStarterParameterMenu({ icon, label, summary, children }: { icon: React.ReactNode; label: string; summary: string; children: React.ReactNode }) {
  return <Popover><PopoverTrigger asChild><Button type="button" variant="secondary" className="h-9 min-w-0 flex-1 !gap-0.5 rounded-full !px-1.5 text-[10px] [&_svg]:size-3" aria-label={label}>{icon}<span className="truncate">{summary}</span></Button></PopoverTrigger><PopoverContent side="bottom" align="center" className="w-[min(calc(100vw-2rem),23rem)] overflow-hidden p-0"><ScrollArea className="max-h-[min(70dvh,32rem)]"><div className="space-y-3 p-3 pr-4"><p className="text-xs font-semibold">{label}</p>{children}</div></ScrollArea></PopoverContent></Popover>;
}
