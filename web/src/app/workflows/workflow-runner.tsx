import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { PromptInput, PromptInputFooter } from "@/components/ai-elements/prompt-input";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { Item, ItemMedia } from "@/components/ui/item";
import { Card } from "@/components/ui/card";
import { TooltipHint } from "@/components/ui/tooltip";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, CircleCheck, Layers3, Play, Settings2, Sparkles, Trash2, Upload } from "lucide-react";
import { isWorkflowModelConfigured, resolveWorkflowTextModel, type WorkflowSeriesDraft } from "@/app/workflows/workflow-runtime";
import { buildImageSize } from "@/lib/image-options";
import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox } from "@/components/ui/checkbox";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { PromptTextareaFrame } from "@/components/generation/prompt-textarea-frame";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { imageReferenceImageLimit, type ImageGenerationPreferences, type ModelConfig } from "@/lib/api";
import { type CreativeWorkflow, type WorkflowVariable } from "@/services/api/workflows";
import { cn } from "@/lib/utils";
import { resolveConfiguredModel } from "@/lib/model-config-selection";
import { WorkflowImageSettings } from "./workflow-image-settings";
import { generationQualityLabel, workflowImageSettings } from "./workflow-image-parameters";
import { WorkflowReferenceGrid, type WorkflowReference } from "./workflow-reference-grid";

export function WorkflowRunner({ workflow, values, prompt, references, referenceBusy, drafts, draftLoading, batchAppend, models, preferences, onValuesChange, onAssetsOpen, onReferencesAdd, onReferenceRemove, onRun, onGenerateDrafts, onRunAll, onRunDraft, onDraftChange, onDraftMove, onDraftDelete, onBatchAppendChange, onBatchAppend, onClose }: { workflow: CreativeWorkflow | null; values: Record<string, string>; prompt: string; references: WorkflowReference[]; referenceBusy: boolean; drafts: WorkflowSeriesDraft[]; draftLoading: boolean; batchAppend: string; models: ModelConfig | null; preferences: ImageGenerationPreferences; onValuesChange: (values: Record<string, string>) => void; onAssetsOpen: () => void; onReferencesAdd: (files: FileList | null) => void; onReferenceRemove: (id: string) => void; onRun: () => void; onGenerateDrafts: () => void; onRunAll: () => void; onRunDraft: (draft: WorkflowSeriesDraft, index: number) => void; onDraftChange: (id: string, patch: Partial<WorkflowSeriesDraft>) => void; onDraftMove: (id: string, direction: -1 | 1) => void; onDraftDelete: (id: string) => void; onBatchAppendChange: (value: string) => void; onBatchAppend: () => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const draftHeadingRef = useRef<HTMLHeadingElement>(null);
  const hasDrafts = drafts.length > 0;
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (hasDrafts) draftHeadingRef.current?.focus();
  }, [hasDrafts]);
  if (!workflow) return null;
  const imageModel = resolveConfiguredModel(
    models?.image_models,
    workflow.config.image_model,
    workflow.config.model,
    preferences.default_image_model,
    models?.default_image_model,
  );
  const imageModelAvailable = isWorkflowModelConfigured(imageModel, models?.image_models);
  const referenceLimit = imageReferenceImageLimit(imageModel);
  const templateReferenceCount = workflow.mode === "multi_image_series"
    ? Math.min(1, workflow.template_references.length)
    : workflow.template_references.length;
  const totalReferenceCount = templateReferenceCount + references.length;
  const referenceOverflow = totalReferenceCount > referenceLimit;
  const missingProductReference = workflow.template_references.length > 0 && references.length === 0;
  const textModel = resolveWorkflowTextModel(workflow, models, preferences);
  const textModelAvailable = isWorkflowModelConfigured(textModel, models?.text_models);
  const imageSettings = workflowImageSettings(workflow.config);
  const requiredVariables = workflow.variables.filter((variable) => variable.required);
  const completedRequiredVariables = requiredVariables.filter((variable) => String(values[variable.key] || "").trim()).length;
  const missingRequiredVariables = requiredVariables.length - completedRequiredVariables;
  const runningDraftCount = drafts.filter((draft) => draft.status === "running").length;
  const completedDraftCount = drafts.filter((draft) => draft.status === "success").length;
  const runnableDraftCount = drafts.filter((draft) => draft.status !== "running" && draft.status !== "success" && draft.prompt.trim()).length;
  const allDraftsComplete = drafts.length > 0 && completedDraftCount === drafts.length;
  const primaryModelAvailable = workflow.mode === "multi_image_series" && drafts.length === 0
    ? textModelAvailable
    : imageModelAvailable;
  const seriesStep = missingRequiredVariables > 0
    ? 1
    : draftLoading || drafts.length === 0
      ? 2
      : runningDraftCount > 0 || allDraftsComplete
        ? 4
        : 3;
  const seriesNextStep = missingRequiredVariables > 0
    ? `还有 ${missingRequiredVariables} 个必填项。`
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
      <DialogContent className={cn("sm:max-w-none", cn("h-[min(92dvh,900px)]", "w-[min(96vw,1120px)] max-w-none"))}>
        <DialogHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">{workflow.name}</DialogTitle>
            <Badge variant="secondary">{workflow.mode === "multi_image_series" ? "多图生成" : "单图生成"}</Badge>
          </div>
          <DialogDescription>{workflow.description || "填写内容，确认提示词后启动生成任务。"}</DialogDescription>
        </DialogHeader>
        <ScrollArea data-slot="dialog-body" className="min-h-0 flex-1" contentClassName="grid items-start gap-5 py-1 pr-2 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
          <section aria-label="填写生成内容" className="min-w-0">
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5">
              <div>
                <h3 className="text-sm font-semibold">填写生成内容</h3>
                <p className="mt-1 text-xs text-muted-foreground">这些内容会自动填入工作流提示词。</p>
              </div>
              {requiredVariables.length ? (
                <Badge variant={completedRequiredVariables === requiredVariables.length ? "default" : "outline"} className="shrink-0 tabular-nums">
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
              )) : <Item variant="muted" className="px-3 py-5 text-center">此工作流没有需要填写的变量</Item>}
            </div>
            {workflow.template_references.length ? (
              <div className="border-t border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">风格模板</h3>
                    <p className="mt-1 text-xs text-muted-foreground">已随工作流加载；多图任务会按顺序为每一页匹配模板。</p>
                  </div>
                  <Badge variant="outline">{workflow.template_references.length} 张</Badge>
                </div>
                <WorkflowReferenceGrid references={workflow.template_references} className="grid-cols-4" />
              </div>
            ) : null}
            <div className="border-t border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">新产品实拍图</h3>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={onAssetsOpen}>我的素材</Button>
                  <Button size="sm" variant="outline" disabled={referenceBusy} onClick={() => inputRef.current?.click()}>
                    {referenceBusy ? <Spinner /> : <Upload />}
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
              <WorkflowReferenceGrid references={references} className="grid-cols-4" emptyMessage={workflow.template_references.length ? "请添加至少一张新产品实拍图" : "未添加产品参考图"} disabled={referenceBusy} onRemove={onReferenceRemove} />
              {referenceOverflow ? <p className="mt-2 text-xs text-destructive">当前模型最多支持 {referenceLimit} 张参考图，本次共需 {totalReferenceCount} 张。</p> : null}
            </div>
          </section>
          <div className="min-w-0 space-y-4">
            <Card className="p-4 gap-0">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">生成提示词预览</h3>
                <CodeBlockCopyButton size="sm" variant="outline" value={prompt}>复制</CodeBlockCopyButton>
              </div>
              <ScrollArea className="max-h-72" contentClassName="py-2 pr-3 text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {prompt || "填写变量后会在这里预览最终提示词"}
              </ScrollArea>
            </Card>
            <Card className="overflow-hidden gap-0 p-0">
              <Button variant="ghost"
                type="button"
                aria-expanded={settingsOpen}
                className="flex w-full items-center text-left justify-start"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <Settings2 className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">创作参数</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {imageModel || "暂无可用模型"} · {generationQualityLabel(imageSettings.quality)} · {imageSize} · {imageSettings.count} 张
                  </span>
                </span>
                <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", settingsOpen && "rotate-180")} />
              </Button>
              {settingsOpen ? (
                <div className="border-t border-border p-4">
                  <WorkflowImageSettings models={models} model={imageModel} value={imageSettings} readOnly showHeading={false} />
                </div>
              ) : null}
            </Card>
          </div>
          {workflow.mode === "multi_image_series" ? (
            <section data-workflow-series-workspace className="min-w-0 border-t lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 ref={draftHeadingRef} tabIndex={-1} className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="size-4" />多图提示词</h3>
                  <Badge variant="outline">{drafts.length} 条</Badge>
                  {completedDraftCount > 0 ? <Badge variant="default">已完成 {completedDraftCount}</Badge> : null}
                  {runningDraftCount > 0 ? <Badge variant="secondary"><Spinner />生成中 {runningDraftCount}</Badge> : null}
                </div>
                {drafts.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" disabled={!textModelAvailable || draftLoading || runningDraftCount > 0} onClick={onGenerateDrafts}>
                      {draftLoading ? <Spinner /> : null}
                      重新生成提示词
                    </Button>
                    <Button size="sm" disabled={!imageModelAvailable || !runnableDraftCount || runningDraftCount > 0} onClick={onRunAll}>
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
                      <Card
                        key={label}
                        aria-current={current ? "step" : undefined}
                        className="flex min-h-10 items-center gap-2 px-3 flex-row"
                      >
                        <ItemMedia variant="icon" className="grid size-5 shrink-0 place-items-center">
                          {complete ? <CircleCheck className="size-4" /> : step}
                        </ItemMedia>
                        {label}
                      </Card>
                    );
                  })}
                </div>
                <Item variant="muted" role="status" className="mt-3 flex min-h-10 items-center px-3">
                  {seriesNextStep}
                </Item>

                {drafts.length ? (
                  <>
                    <PromptInput className="mt-4">
                      <InputGroupTextarea rows={1} value={batchAppend} onChange={(event) => onBatchAppendChange(event.target.value)} aria-label="为所有提示词追加统一要求" placeholder="为所有提示词追加统一要求" />
                      <PromptInputFooter>
                        <Button type="button" size="sm" className="ml-auto" variant="outline" disabled={!batchAppend.trim() || runningDraftCount > 0} onClick={onBatchAppend}>批量追加</Button>
                      </PromptInputFooter>
                    </PromptInput>
                    <div className="mt-4 grid min-w-0 gap-3 2xl:grid-cols-2">
                      {drafts.map((draft, index) => (
                        <SeriesDraftCard
                          key={draft.id}
                          draft={draft}
                          index={index}
                          first={index === 0}
                          last={index === drafts.length - 1}
                          generationDisabled={!imageModelAvailable}
                          onChange={(patch) => onDraftChange(draft.id, patch)}
                          onMove={(direction) => onDraftMove(draft.id, direction)}
                          onDelete={() => onDraftDelete(draft.id)}
                          onRun={() => onRunDraft(draft, index)}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  draftLoading ? <LoadingState className="mt-4 min-h-44" label="正在生成多图提示词" description="生成后可逐条修改、排序或单独生成。" /> : <EmptyState className="mt-4 min-h-44" icon={Sparkles} title="还没有提示词草稿" description="系统会根据工作流规划拆分每张图片的标题和提示词。" action={<Button size="sm" disabled={!textModelAvailable || missingRequiredVariables > 0} onClick={onGenerateDrafts}><Layers3 />生成提示词</Button>} />
                )}
              </div>
            </section>
          ) : null}
        </ScrollArea>
        <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-end">
          <p className="basis-full text-xs text-muted-foreground sm:mr-auto sm:basis-auto">
            {missingProductReference
              ? "请添加新产品实拍图后再生成"
              : referenceOverflow
                ? `参考图超过当前模型的 ${referenceLimit} 张上限`
                : workflow.mode === "multi_image_series"
              ? seriesNextStep
              : requiredVariables.length && completedRequiredVariables < requiredVariables.length
              ? `还有 ${requiredVariables.length - completedRequiredVariables} 个必填项未完成`
              : "内容就绪后即可开始生成"}
          </p>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={!primaryModelAvailable || referenceBusy || referenceOverflow || missingProductReference || completedRequiredVariables < requiredVariables.length || draftLoading || workflow.mode === "multi_image_series" && drafts.length > 0 && (!runnableDraftCount || runningDraftCount > 0)}
            onClick={workflow.mode === "multi_image_series" && drafts.length > 0 ? onRunAll : onRun}
          >
            {draftLoading || runningDraftCount > 0 ? <Spinner /> : workflow.mode === "multi_image_series" ? drafts.length ? <Play /> : <Layers3 /> : <Play />}
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

export function SeriesDraftCard({ draft, index, first, last, generationDisabled, onChange, onMove, onDelete, onRun }: { draft: WorkflowSeriesDraft; index: number; first: boolean; last: boolean; generationDisabled: boolean; onChange: (patch: Partial<WorkflowSeriesDraft>) => void; onMove: (direction: -1 | 1) => void; onDelete: () => void; onRun: () => void }) {
  const statusLabel = draft.status === "success" ? "已完成" : draft.status === "failed" ? "生成失败" : draft.status === "running" ? "生成中" : "待审核";
  const statusVariant = draft.status === "success" ? "default" : draft.status === "failed" ? "destructive" : draft.status === "running" ? "secondary" : "outline";
  const running = draft.status === "running";
  const resultURL = draft.result_ids?.[0] || "";
  return (
    <Card data-series-draft-card data-status={draft.status} className="overflow-hidden">
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-3 py-2.5">
        <Badge variant="secondary" className="shrink-0 tabular-nums">{String(index + 1).padStart(2, "0")}</Badge>
        <Input className="min-w-0 flex-1 basis-36" value={draft.title} aria-label={`第 ${index + 1} 张标题`} disabled={running} onChange={(event) => onChange({ title: event.target.value })} />
        <Badge variant={statusVariant} className="shrink-0">{running ? <Spinner /> : null}{statusLabel}</Badge>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <TooltipHint content={"上移"}><Button aria-label="上移"  size="icon" variant="ghost" disabled={first || running} onClick={() => onMove(-1)}><ArrowUp /></Button></TooltipHint>
          <TooltipHint content={"下移"}><Button aria-label="下移"  size="icon" variant="ghost" disabled={last || running} onClick={() => onMove(1)}><ArrowDown /></Button></TooltipHint>
          <TooltipHint content={"复制提示词"}><CodeBlockCopyButton aria-label="复制提示词" size="icon" value={draft.prompt} /></TooltipHint>
          <TooltipHint content={"删除草稿"}><Button aria-label="删除草稿"  size="icon" variant="ghost" disabled={running} onClick={onDelete}><Trash2 /></Button></TooltipHint>
        </div>
      </header>
      <div className={cn("grid gap-3 p-3", resultURL && "sm:grid-cols-[132px_minmax(0,1fr)]")}>
        {resultURL ? (
          <Card className="relative min-h-32 overflow-hidden gap-0 p-0">
            <AuthenticatedImage src={resultURL} alt={`${draft.title || `第 ${index + 1} 张`}生成结果`} loading="lazy" decoding="async" className="size-full min-h-32 object-cover" placeholderClassName="min-h-32" />
            <Badge variant="secondary" className="absolute right-2 bottom-2">生成结果</Badge>
          </Card>
        ) : running ? (
          <LoadingState label="正在生成图片" className="min-h-32" />
        ) : null}
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground"><span>图片提示词</span><span className="font-normal tabular-nums">{draft.prompt.length} 字</span></div>
          <PromptInput className="h-auto min-w-0">
            <PromptTextareaFrame value={draft.prompt} className="h-32 min-h-32">
              <InputGroupTextarea aria-label={`第 ${index + 1} 张提示词`} className="min-h-full resize-none overflow-hidden" value={draft.prompt} disabled={running} onChange={(event) => onChange({ prompt: event.target.value, status: draft.status === "success" ? "draft" : draft.status })} />
            </PromptTextareaFrame>
          </PromptInput>
        </div>
      </div>
      <div className="flex min-h-12 items-center justify-between gap-3 border-t border-border bg-muted/15 px-3 py-2.5">
        <p className={cn("min-w-0 text-xs leading-5", draft.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{draft.error || (draft.status === "success" ? "生成完成，结果已显示在卡片中" : running ? "任务已提交，完成后会在这里显示结果" : "确认标题和提示词无误后生成此图")}</p>
        <Button size="sm" variant={draft.status === "draft" || draft.status === "failed" ? "default" : "outline"} className="shrink-0" disabled={generationDisabled || !draft.prompt.trim() || running || draft.status === "success"} onClick={onRun}>
          {running ? <Spinner /> : draft.status === "success" ? <CircleCheck /> : <Play />}
          {running ? "生成中" : draft.status === "success" ? "已生成" : "生成此图"}
        </Button>
      </div>
    </Card>
  );
}

function WorkflowVariableInput({ variable, value, onChange }: { variable: WorkflowVariable; value: string; onChange: (value: string) => void }) {
  const inputID = useId();
  const label = variable.label || variable.key;
  return (
    <div className="grid min-w-0 gap-2 text-xs">
      <Label htmlFor={inputID} className="font-medium">{label}{variable.required ? <span className="ml-1 text-destructive">*</span> : null}</Label>
      {variable.type === "textarea" ? (
        <Textarea id={inputID} required={variable.required} rows={3} value={value} placeholder={variable.placeholder || variable.default_value} onChange={(event) => onChange(event.target.value)} />
      ) : variable.type === "select" ? (
        <Select value={value || "__none"} onValueChange={(next) => onChange(next === "__none" ? "" : next)}>
          <SelectTrigger id={inputID} aria-required={variable.required}><SelectValue placeholder={variable.placeholder || "请选择"} /></SelectTrigger>
          <SelectContent><SelectItem value="__none">请选择</SelectItem>{variable.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
        </Select>
      ) : variable.type === "boolean" ? (
        <Card className="flex min-h-10 items-center justify-between gap-3 px-3 p-0 flex-row">
          <span className="text-muted-foreground">{value === "true" ? "已开启" : "已关闭"}</span>
          <Checkbox id={inputID} aria-label={label} aria-required={variable.required} checked={value === "true"} onCheckedChange={(checked) => onChange(checked === true ? "true" : "false")} />
        </Card>
      ) : (
        <Input id={inputID} required={variable.required} type={variable.type === "number" ? "number" : "text"} value={value} placeholder={variable.placeholder || variable.default_value} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}
