import { useEffect, useState } from "react";
import { ChevronRight, CircleAlert, ClipboardList, Clock3, Download, Image as ImageIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AuthenticatedImage } from "@/components/authenticated-image";
import { ManagementPagination } from "@/components/management-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Item } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TooltipHint } from "@/components/ui/tooltip";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import type { WorkflowTaskHistoryFilter, WorkflowTaskHistoryQuery } from "@/services/api/workflows";
import { generationQualityLabel } from "./workflow-image-parameters";
import { WorkflowReferenceGrid, type WorkflowReference } from "./workflow-reference-grid";
import type { WorkflowTask } from "./workflow-task-runtime";

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

function workflowTaskDuration(task: WorkflowTask, now: number) {
  const elapsed = Math.max(0, (task.ended_at || now) - task.started_at);
  return elapsed < 60_000
    ? `${Math.max(1, Math.round(elapsed / 1000))} 秒`
    : `${Math.floor(elapsed / 60_000)} 分 ${Math.round((elapsed % 60_000) / 1000)} 秒`;
}

function WorkflowTaskStatus({ task }: { task: WorkflowTask }) {
  if (task.status === "running") return <Badge variant="secondary"><Spinner />运行中</Badge>;
  if (task.status === "failed") return <Badge variant="destructive">失败</Badge>;
  return <Badge variant="default">完成</Badge>;
}

const historyPageSizes = [12, 24, 48];
const historyFilters: { value: WorkflowTaskHistoryFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "success", label: "已完成" },
  { value: "failed", label: "失败" },
];

type WorkflowTaskHistoryDialogProps = {
  open: boolean;
  tasks: WorkflowTask[];
  localTasks: WorkflowTask[];
  counts?: Record<WorkflowTaskHistoryFilter, number>;
  total: number;
  page: number;
  query: WorkflowTaskHistoryQuery;
  onQueryChange: (query: WorkflowTaskHistoryQuery) => void;
  loading: boolean;
  error: string;
  recoveryError: string;
  onRetry: () => void;
  onRetryRecovery: () => void;
  clearing: boolean;
  canDeleteAssets: boolean;
  onClearCompleted: (includeAssets: boolean) => Promise<boolean>;
  onOpenTask: (task: WorkflowTask) => void;
  onClose: () => void;
};

export function WorkflowTaskHistoryDialog({
  open, tasks, localTasks, counts: storedCounts, total, page, query, onQueryChange, loading, error,
  recoveryError, onRetry, onRetryRecovery, clearing, canDeleteAssets, onClearCompleted, onOpenTask, onClose,
}: WorkflowTaskHistoryDialogProps) {
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearAssets, setClearAssets] = useState(false);
  if (!open) return null;

  const { status: filter, pageSize } = query;
  const counts = { all: 0, running: 0, success: 0, failed: 0, ...storedCounts };
  const localRows = [];
  for (const task of localTasks) {
    counts.all += 1;
    counts[task.status] += 1;
    if (page === 1 && (filter === "all" || filter === task.status)) localRows.push(task);
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const visibleTasks = [...localRows, ...tasks];
  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !clearing && onClose()}>
        <DialogContent className="max-h-[min(94dvh,780px)] w-[min(96vw,920px)] max-w-none gap-2 sm:max-w-none sm:gap-4" showCloseButton={!clearing}>
          <DialogHeader >
            <DialogTitle className="flex items-center"><ClipboardList className="size-5" />任务记录</DialogTitle>
            <DialogDescription>{counts.running ? `${counts.running} 个工作流任务正在执行` : counts.all ? `共 ${counts.all} 条工作流运行记录` : "运行工作流后，任务记录会显示在这里"}</DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b pb-2">
            <ToggleGroup type="single" value={filter} onValueChange={(value) => {
              if (!value) return;
              if (value === filter) return;
              onQueryChange({ page: 1, pageSize, status: value as WorkflowTaskHistoryFilter });
            }} aria-label="任务状态" className="min-w-0 flex-wrap justify-start" size="sm">
              {historyFilters.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  type="button"
                  value={option.value}
                  className="shrink-0"
                >
                  {option.label}
                  <span className="tabular-nums text-[10px] opacity-70">{counts[option.value]}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {counts.success + counts.failed > 0 ? <Button size="sm" variant="ghost"  disabled={clearing} onClick={() => setClearConfirmOpen(true)}>{clearing ? <Spinner /> : <Trash2 />}{clearing ? "清理中" : "清理历史"}</Button> : null}
          </div>
          <ScrollArea key={`${filter}:${page}:${pageSize}`} data-slot="dialog-body" aria-busy={loading} className="min-h-0 max-h-[min(62dvh,560px)] flex-1">
            {recoveryError ? <Alert variant="destructive" className="mb-3"><CircleAlert /><AlertTitle>运行中的任务恢复失败</AlertTitle><AlertDescription>{recoveryError}<Button size="sm" variant="outline" onClick={onRetryRecovery}>重试恢复</Button></AlertDescription></Alert> : null}
            {error ? <Alert variant="destructive" className="mb-3"><CircleAlert /><AlertTitle>任务记录加载失败</AlertTitle><AlertDescription>{error}<Button size="sm" variant="outline" onClick={onRetry}>重试</Button></AlertDescription></Alert> : null}
            {visibleTasks.length ? (
              <div data-workflow-task-list>
                {visibleTasks.map((task) => <WorkflowTaskRow key={task.id} task={task} onOpen={() => onOpenTask(task)} />)}
              </div>
            ) : loading ? <LoadingState label="正在加载任务记录" /> : !error ? (
              <EmptyState
                icon={ClipboardList}
                title={`当前没有${filter === "all" ? "任务记录" : historyFilters.find((option) => option.value === filter)?.label + "任务"}`}
                description={filter === "all" ? "从工作流启动任务后可在这里查看进度和结果" : "切换其他状态查看工作流运行记录"}
                className="min-h-32"
              />
            ) : null}
          </ScrollArea>
          {total > historyPageSizes[0] || pageSize !== historyPageSizes[0] ? (
            <ManagementPagination compact page={page} pageSize={pageSize} totalPages={totalPages} totalItems={total}
              pageSizeOptions={historyPageSizes} onPageChange={(nextPage) => onQueryChange({ ...query, page: nextPage })}
              onPageSizeChange={(size) => onQueryChange({ page: 1, pageSize: size, status: filter })} />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={(nextOpen) => {
          if (clearing) return;
          setClearConfirmOpen(nextOpen);
          if (!nextOpen) setClearAssets(false);
        }}
        title="清理任务历史？"
        description={<>将清除 {counts.success + counts.failed} 条已完成或失败的任务记录，运行中的任务不会受到影响。</>}
        confirmLabel={clearing ? "清理中" : clearAssets ? "清理记录和素材" : "仅清理记录"}
        busy={clearing}
        destructive
        onConfirm={() => void onClearCompleted(clearAssets).then((cleared) => {
                if (!cleared) return;
                setClearConfirmOpen(false);
                setClearAssets(false);
              })}
      >
          <Item variant="outline" asChild><Label className={cn("flex items-start gap-3 p-3.5", !canDeleteAssets && "cursor-not-allowed")}>
            <Checkbox
              className="mt-0.5"
              checked={clearAssets}
              disabled={clearing || !canDeleteAssets}
              onCheckedChange={(checked) => setClearAssets(checked === true)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">一并删除关联素材</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {!canDeleteAssets
                  ? "当前角色没有删除素材的权限，任务图片将继续保留。"
                  : "将永久删除这些任务生成的服务器素材，外部图片不受影响。"}
              </span>
            </span>
          </Label></Item>
      </ConfirmDialog>
    </>
  );
}

export function WorkflowTaskRow({ task, onOpen }: { task: WorkflowTask; onOpen: () => void }) {
  const now = useNow(task.status === "running");
  const duration = workflowTaskDuration(task, now);
  const title = task.series_title ? `${task.workflow_name} · ${task.series_title}` : task.workflow_name;
  return (
    <Item asChild className="flex-nowrap gap-1"><article>
      <Button type="button" variant="ghost" aria-label={`查看任务：${title}`} onClick={onOpen}
        className="group grid h-auto min-w-0 flex-1 grid-cols-[56px_minmax(0,1fr)_auto] items-center justify-start gap-3 whitespace-normal text-left sm:grid-cols-[64px_minmax(0,1fr)_auto]">
      <Card className="grid aspect-square size-14 shrink-0 place-items-center overflow-hidden sm:size-16 gap-0 p-0">
        {task.images[0]?.url ? <AuthenticatedImage src={task.images[0].url} alt="" className="size-full object-cover" placeholderClassName="min-h-0" /> : task.status === "running" ? <Spinner className="size-5 animate-spin text-muted-foreground" /> : <ImageIcon className="size-5 text-muted-foreground" />}
      </Card>
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
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Button>
      <TooltipHint content="复制提示词"><CodeBlockCopyButton type="button" aria-label="复制提示词" size="icon" value={task.prompt} /></TooltipHint>
    </article></Item>
  );
}

function formatWorkflowBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function WorkflowTaskDialog({ task, onClose }: { task: WorkflowTask | null; onClose: () => void }) {
  const [selectedImage, setSelectedImage] = useState(0);
  const now = useNow(task?.status === "running");
  useEffect(() => setSelectedImage(0), [task?.id]);
  if (!task) return null;
  const duration = workflowTaskDuration(task, now);
  const activeImage = task.images[selectedImage] || task.images[0];
  const activeImagePrompt = activeImage?.prompt || task.prompt;
  const activeImageTitle = activeImage?.title?.trim() || `第 ${selectedImage + 1} 张`;
  const inputEntries = Object.entries(task.inputs).filter(([, value]) => String(value).trim());
  const templateReferences = task.references.filter((reference) => reference.role === "template");
  const productReferences = task.references.filter((reference) => reference.role === "product");
  const title = task.series_title ? `${task.workflow_name} · ${task.series_title}` : task.workflow_name;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn("sm:max-w-none", cn("h-[min(92dvh,920px)]", "w-[min(96vw,1180px)] max-w-none"))}>
        <DialogHeader >
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <DialogTitle >{title}</DialogTitle>
            <WorkflowTaskStatus task={task} />
          </div>
          <DialogDescription>{new Date(task.started_at).toLocaleString("zh-CN")} · 耗时 {duration} · {task.count} 张</DialogDescription>
        </DialogHeader>
        <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0">
          <div className="grid min-h-full lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
            <section className="min-w-0 border-b border-border p-4 sm:p-6 lg:border-r lg:border-b-0">
              {activeImage ? (
                <>
                  <Card className="flex min-h-72 items-center justify-center overflow-hidden lg:min-h-[520px] gap-0 p-0 flex-row">
                    <AuthenticatedImage src={activeImage.url} alt={`${title} 结果 ${selectedImage + 1}`} className="max-h-[62dvh] w-full object-contain" />
                  </Card>
                  <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden mt-2 min-h-16" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0 flex w-max min-w-full gap-2 pb-1">
                    {task.images.map((image, index) => (
                      <Button variant="outline" size="icon-sm" key={`${image.url}-${index}`} type="button" aria-label={`查看第 ${index + 1} 张结果`} onClick={() => setSelectedImage(index)} className={cn("h-auto p-0", "relative aspect-square size-16 shrink-0 overflow-hidden")}>
                        <AuthenticatedImage src={image.url} alt="" className="size-full object-cover" placeholderClassName="min-h-0" />
                        <Badge variant="secondary" className="absolute right-1 bottom-1">{index + 1}</Badge>
                      </Button>
                    ))}
                  </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
                  <p className="mt-1 text-xs text-muted-foreground">{activeImage.width && activeImage.height ? `${activeImage.width} × ${activeImage.height}` : "尺寸未记录"}{activeImage.bytes ? ` · ${formatWorkflowBytes(activeImage.bytes)}` : ""}</p>
                </>
              ) : (
                task.status === "running" ? <LoadingState className="min-h-72 lg:min-h-[520px]" label={`任务生成中，已运行 ${duration}`} /> : <EmptyState className="min-h-72 lg:min-h-[520px]" icon={ImageIcon} title="任务没有返回图片" />
              )}
            </section>
            <aside className="min-w-0 p-4 sm:p-6">
              {task.error ? <Alert variant="destructive" className="mb-5"><AlertTitle>失败原因</AlertTitle><AlertDescription className="whitespace-pre-wrap">{task.error}</AlertDescription></Alert> : null}
              <section className="border-b border-border pb-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">当前图片提示词</h3>
                    {activeImage ? <p className="mt-1 truncate text-xs text-muted-foreground">{activeImageTitle} · 第 {selectedImage + 1}/{task.images.length} 张</p> : null}
                  </div>
                  <TooltipHint content={"复制当前图片提示词"}><CodeBlockCopyButton aria-label="复制当前图片提示词" size="icon" disabled={!activeImagePrompt} value={activeImagePrompt} /></TooltipHint>
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">{activeImagePrompt || "未记录"}</p>
              </section>
              <section className="border-b border-border py-5">
                <h3 className="text-sm font-semibold">输入变量</h3>
                {inputEntries.length ? <dl className="mt-3 divide-y divide-border/70">{inputEntries.map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(90px,0.35fr)_minmax(0,1fr)] gap-3 py-2 text-xs"><dt className="break-words text-muted-foreground">{key}</dt><dd className="whitespace-pre-wrap break-words text-foreground">{value}</dd></div>)}</dl> : <p className="mt-2 text-xs text-muted-foreground">没有输入变量</p>}
              </section>
              {task.references.length ? <section className="border-b border-border py-5">{[["风格模板", templateReferences], ["产品实拍", productReferences]].map(([label, items]) => (items as WorkflowReference[]).length ? <div key={label as string} className="mb-4 last:mb-0"><h3 className="text-sm font-semibold">{label as string}</h3><WorkflowReferenceGrid references={items as WorkflowReference[]} className="grid-cols-4" openOriginal /></div> : null)}</section> : null}
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
        </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
        <DialogFooter className="m-0 shrink-0 flex-row justify-end sm:justify-end">
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {activeImage ? <Button onClick={() => void downloadWorkflowImage(activeImage.url, `workflow-task-${selectedImage + 1}.png`).catch((error) => toast.error(error instanceof Error ? error.message : "图片下载失败"))}><Download />下载当前图片</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
