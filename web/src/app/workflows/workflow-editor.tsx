import { useId, useRef, useState } from "react";
import { Braces, CircleAlert, Image as ImageIcon, Layers3, Plus, Save, Trash2, Upload } from "lucide-react";

import { PromptInput, PromptInputFooter } from "@/components/ai-elements/prompt-input";
import { EditorWorkspace } from "@/components/editor-workspace";
import { LabeledField as Field } from "@/components/labeled-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Field as FormField, FieldContent, FieldDescription, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { TooltipHint } from "@/components/ui/tooltip";
import type { ImageSettingsValue } from "@/components/generation/image-settings-panel";
import type { ImageGenerationPreferences, ModelConfig } from "@/lib/api";
import { buildImageSize } from "@/lib/image-options";
import { resolveConfiguredModel } from "@/lib/model-config-selection";
import { cn } from "@/lib/utils";
import type { CreativeWorkflow, WorkflowGenerationConfig, WorkflowSeriesConfig, WorkflowVariable } from "@/services/api/workflows";

import { WorkflowImageSettings } from "./workflow-image-settings";
import { workflowImageSettings } from "./workflow-image-parameters";
import { WorkflowReferenceGrid } from "./workflow-reference-grid";
import { createWorkflowVariable, parseVariableOptions } from "./workflow-runtime";

export function WorkflowEditor({
  workflow,
  isNew,
  models,
  preferences,
  saving,
  saveError,
  referenceBusy,
  onChange,
  onSave,
  onAssetsOpen,
  onReferencesAdd,
  onClose,
}: {
  workflow: CreativeWorkflow;
  isNew: boolean;
  models: ModelConfig | null;
  preferences: ImageGenerationPreferences;
  saving: boolean;
  saveError: string;
  referenceBusy: boolean;
  onChange: (workflow: CreativeWorkflow) => void;
  onSave: (workflow: CreativeWorkflow) => void;
  onAssetsOpen: () => void;
  onReferencesAdd: (files: FileList | null) => void;
  onClose: () => void;
}) {
  const templateInputRef = useRef<HTMLInputElement>(null);
  const promptTemplateRef = useRef<HTMLTextAreaElement>(null);
  const reviewPromptsID = useId();
  const patch = (value: Partial<CreativeWorkflow>) => onChange({ ...workflow, ...value });
  const patchConfig = (value: Partial<WorkflowGenerationConfig>) => patch({ config: { ...workflow.config, ...value } });
  const patchSeries = (value: Partial<WorkflowSeriesConfig>) =>
    patch({ series_config: { ...workflow.series_config, ...value } });
  const patchVariable = (id: string, value: Partial<WorkflowVariable>) =>
    patch({ variables: workflow.variables.map((item) => (item.id === id ? { ...item, ...value } : item)) });
  const promptTemplate = workflow.config.prompt_template;
  const hasPrivateTemplateReferences =
    workflow.scope === "public" && workflow.template_references.some((reference) => reference.visibility !== "public");
  const templateVariableKeys = Array.from(promptTemplate.matchAll(/{{\s*([\w.-]+)\s*}}/g), (match) => match[1]);
  const uniqueTemplateVariableKeys = [...new Set(templateVariableKeys)];
  const knownVariableKeys = new Set(workflow.variables.map((variable) => variable.key).filter(Boolean));
  const undefinedTemplateVariables = uniqueTemplateVariableKeys.filter((key) => !knownVariableKeys.has(key));
  const insertTemplateVariable = (key: string) => {
    const textarea = promptTemplateRef.current;
    const token = `{{${key}}}`;
    const start = textarea?.selectionStart ?? promptTemplate.length;
    const end = textarea?.selectionEnd ?? start;
    const nextPrompt = `${promptTemplate.slice(0, start)}${token}${promptTemplate.slice(end)}`;
    patchConfig({ prompt_template: nextPrompt });
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true });
      const cursor = start + token.length;
      textarea?.setSelectionRange(cursor, cursor);
    });
  };
  const removeTemplateReference = (id: string) => {
    const templateReferences = workflow.template_references.filter((reference) => reference.id !== id);
    patch({
      template_references: templateReferences,
      series_config:
        workflow.mode === "multi_image_series" && templateReferences.length
          ? { ...workflow.series_config, target_count: String(templateReferences.length) }
          : workflow.series_config,
    });
  };
  const moveTemplateReference = (id: string, direction: -1 | 1) => {
    const index = workflow.template_references.findIndex((reference) => reference.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= workflow.template_references.length) return;
    const references = [...workflow.template_references];
    [references[index], references[target]] = [references[target], references[index]];
    patch({ template_references: references });
  };
  const imageModel = resolveConfiguredModel(
    models?.image_models,
    workflow.config.image_model,
    workflow.config.model,
    preferences.default_image_model,
    models?.default_image_model,
  );
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
    <EditorWorkspace
      title={isNew ? "新建工作流" : "编辑工作流"}
      description={`${workflow.mode === "multi_image_series" ? "多图生成" : "单图生成"} · ${workflow.variables.length} 个变量`}
      backLabel="返回工作流"
      onBack={onClose}
      busy={saving}
      status={saveError ? <Alert variant="destructive"><AlertDescription className="break-all">{saveError}</AlertDescription></Alert> : null}
      actions={
        <Button
          aria-label="保存工作流"
          disabled={saving || referenceBusy || !workflow.name.trim() || !workflow.config.prompt_template.trim() || hasPrivateTemplateReferences}
          onClick={() => onSave(workflow)}
        >
          {saving ? <Spinner /> : <Save />}
          {saving ? "保存中" : "保存"}
        </Button>
      }
    >
      <FieldSet disabled={saving} className="contents space-y-6">
        <section className="border-b border-border pb-6">
          <h2 className="mb-4 text-sm font-semibold">基本信息</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="工作流名称">{(fieldId) => <Input id={fieldId}
                value={workflow.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="输入工作流名称"
              />}</Field>
            <Field label="分类">{(fieldId) => <Input id={fieldId}
                value={workflow.category}
                onChange={(event) => patch({ category: event.target.value })}
                placeholder="输入分类"
              />}</Field>
            <Field label="生成方式">{(fieldId) => <Select
                value={workflow.mode}
                onValueChange={(mode: CreativeWorkflow["mode"]) =>
                  patch({
                    mode,
                    series_config:
                      mode === "multi_image_series" && workflow.template_references.length
                        ? { ...workflow.series_config, target_count: String(workflow.template_references.length) }
                        : workflow.series_config,
                  })
                }
              >
                <SelectTrigger id={fieldId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single_image">单图生成</SelectItem>
                  <SelectItem value="multi_image_series">多图生成</SelectItem>
                </SelectContent>
              </Select>}</Field>
            <Field label="可见范围">{(fieldId) => <Select value={workflow.scope} onValueChange={(scope: CreativeWorkflow["scope"]) => patch({ scope })}>
                <SelectTrigger id={fieldId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">个人工作流</SelectItem>
                  <SelectItem value="public">公开工作流</SelectItem>
                </SelectContent>
              </Select>}</Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <Field label="适用场景">{(fieldId) => <Textarea id={fieldId}
                  rows={2}
                  value={workflow.description}
                  onChange={(event) => patch({ description: event.target.value })}
                  placeholder="输入适用场景说明"
                />}</Field>
            </div>
          </div>
        </section>

        <section className="border-b border-border pb-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ImageIcon className="size-4" />
                风格模板图 <Badge variant="outline">{workflow.template_references.length}</Badge>
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                按生成顺序排列模板。生成时以模板为版式参考，以运行时上传的实拍图为商品参考。
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onAssetsOpen}>
                我的素材
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={referenceBusy || workflow.template_references.length >= 14}
                onClick={() => templateInputRef.current?.click()}
              >
                {referenceBusy ? <Spinner /> : <Upload />}上传模板图
              </Button>
              <input
                ref={templateInputRef}
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
          </div>
          {hasPrivateTemplateReferences ? (
            <Alert className="mb-3">
              <AlertDescription>公开工作流只能使用公开素材。请移除个人模板图，或将工作流改为个人。</AlertDescription>
            </Alert>
          ) : null}
          <WorkflowReferenceGrid
            references={workflow.template_references}
            className="grid-cols-3 sm:grid-cols-5 lg:grid-cols-7"
            emptyMessage="还没有模板图"
            disabled={referenceBusy}
            onRemove={removeTemplateReference}
            onMove={moveTemplateReference}
          />
        </section>

        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <section className="border-b border-border pb-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">输入变量</h2>
                  <Badge variant="outline">{workflow.variables.length}</Badge>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => patch({ variables: [...workflow.variables, createWorkflowVariable()] })}
                >
                  <Plus />
                  添加变量
                </Button>
              </div>
              {workflow.variables.length ? (
                <div className="space-y-3">
                  {workflow.variables.map((variable, index) => (
                    <VariableEditor
                      key={variable.id}
                      index={index}
                      variable={variable}
                      onChange={(value) => patchVariable(variable.id, value)}
                      onDelete={() =>
                        patch({ variables: workflow.variables.filter((item) => item.id !== variable.id) })
                      }
                    />
                  ))}
                </div>
              ) : (
                <EmptyState compact title="暂无输入变量" />
              )}
            </section>

            <section className={cn(workflow.mode === "multi_image_series" && "border-b border-border pb-6")}>
              <h2 className="mb-4 text-sm font-semibold">提示词模板</h2>
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="workflow-prompt-template" className="text-sm font-medium">
                      用户提示词模板
                    </Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {promptTemplate.length} 字 · {Math.max(1, promptTemplate.split("\n").length)} 行
                    </span>
                  </div>
                  <PromptInput className="h-auto min-w-0">
                    <InputGroupTextarea
                      id="workflow-prompt-template"
                      ref={promptTemplateRef}
                      rows={8}
                      className="min-h-44 resize-y font-mono"
                      value={promptTemplate}
                      onChange={(event) => patchConfig({ prompt_template: event.target.value })}
                      placeholder="例如：为 {{product_name}} 生成一张……"
                    />
                    <PromptInputFooter className="flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <Braces className="size-3.5" />
                        使用双大括号插入变量
                      </span>
                      <span>空变量会替换为空文本</span>
                      {undefinedTemplateVariables.length ? (
                        <span className={cn("inline-flex items-center gap-1", "text-muted-foreground")}>
                          <CircleAlert className="size-3.5" />
                          未定义：{undefinedTemplateVariables.join("、")}
                        </span>
                      ) : null}
                    </PromptInputFooter>
                  </PromptInput>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">快速插入</span>
                    {workflow.variables.length ? (
                      workflow.variables.map((variable) => (
                        <Button
                          key={variable.id}
                          type="button"
                          size="sm"
                          variant="outline"
                          className="font-mono"
                          onClick={() => insertTemplateVariable(variable.key)}
                          disabled={!variable.key}
                        >
                          {`{{${variable.key || "变量名"}}}`}
                        </Button>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">先在上方添加变量</span>
                    )}
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    建议把固定要求写在模板中，把产品名称、风格、受众等变化内容定义为变量。变量名必须与上方设置完全一致。
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="系统提示词">{(fieldId) => <PromptInput><InputGroupTextarea id={fieldId}
                      rows={3}
                      value={workflow.config.system_prompt}
                      onChange={(event) => patchConfig({ system_prompt: event.target.value })}
                      placeholder="可选"
                    /></PromptInput>}</Field>
                  <Field label="负面约束">{(fieldId) => <PromptInput><InputGroupTextarea id={fieldId}
                      rows={3}
                      value={workflow.config.negative_prompt}
                      onChange={(event) => patchConfig({ negative_prompt: event.target.value })}
                      placeholder="可选"
                    /></PromptInput>}</Field>
                </div>
              </div>
            </section>

            {workflow.mode === "multi_image_series" ? (
              <section>
                <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
                  <Layers3 className="size-4" />
                  多图提示词规划
                </h2>
                <Card className="grid gap-4 p-4 xl:grid-cols-[240px_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="草稿张数">{(fieldId) => <Input id={fieldId}
                          type="number"
                          min={1}
                          max={20}
                          value={workflow.series_config.target_count}
                          onChange={(event) => patchSeries({ target_count: event.target.value })}
                        />}</Field>
                      <Field label="图片并发">{(fieldId) => <Input id={fieldId}
                          type="number"
                          min={1}
                          max={6}
                          value={workflow.series_config.concurrency}
                          onChange={(event) => patchSeries({ concurrency: event.target.value })}
                        />}</Field>
                    </div>
                    <FormField orientation="horizontal">
                      <Checkbox
                        id={reviewPromptsID}
                        checked={workflow.series_config.review_required}
                        onCheckedChange={(checked) => patchSeries({ review_required: checked === true })}
                      />
                      <FieldContent>
                        <FieldLabel htmlFor={reviewPromptsID}>生成前审核提示词</FieldLabel>
                        <FieldDescription>确认并调整每张图的提示词后，再生成图片。</FieldDescription>
                      </FieldContent>
                    </FormField>
                  </div>
                  <Field label="系列拆分说明">{(fieldId) => <PromptInput><InputGroupTextarea id={fieldId}
                      rows={4}
                      value={workflow.series_config.prompt_instruction}
                      onChange={(event) => patchSeries({ prompt_instruction: event.target.value })}
                      placeholder="说明封面、步骤、要点和总结图之间的结构关系"
                    /></PromptInput>}</Field>
                </Card>
              </section>
            ) : null}
          </div>

          <Card className="min-w-0 overflow-hidden lg:sticky lg:top-0 gap-0 p-0">
            <div className="p-4">
              <WorkflowImageSettings
                models={models}
                model={imageModel}
                value={imageSettings}
                onModelChange={(model) => patchConfig({ model, image_model: model })}
                onChange={patchImageSettings}
              />
            </div>
            {!workflow.config.system_prompt && preferences.system_prompt ? (
              <div className="border-t border-border p-4">
                <Button
                  className="w-full"
                  size="sm"
                  variant="outline"
                  onClick={() => patchConfig({ system_prompt: preferences.system_prompt })}
                >
                  使用当前系统提示词
                </Button>
              </div>
            ) : null}
          </Card>
        </div>
      </FieldSet>
    </EditorWorkspace>
  );
}

function VariableEditor({ index, variable, onChange, onDelete }: { index: number; variable: WorkflowVariable; onChange: (value: Partial<WorkflowVariable>) => void; onDelete: () => void }) {
  const [optionsText, setOptionsText] = useState(() => variable.options.join(" / "));
  return (
    <Card className="p-3.5 gap-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-muted-foreground">变量 {index + 1}</h3>
        <div className="flex items-center gap-2">
          <Label className="flex items-center gap-1.5 text-xs"><Checkbox checked={variable.required} onCheckedChange={(checked) => onChange({ required: checked === true })} />必填</Label>
          <TooltipHint content={"删除变量"}><Button aria-label="删除变量" size="icon" variant="ghost" onClick={onDelete}><Trash2 /></Button></TooltipHint>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="变量名">{(fieldId) => <Input id={fieldId} value={variable.key} onChange={(event) => onChange({ key: event.target.value.replace(/[^\w.-]/g, "_") })} placeholder="例如 product_name" />}</Field>
        <Field label="显示名称">{(fieldId) => <Input id={fieldId} value={variable.label} onChange={(event) => onChange({ label: event.target.value })} placeholder="例如 产品名称" />}</Field>
        <Field label="输入类型">{(fieldId) => <Select value={variable.type} onValueChange={(type: WorkflowVariable["type"]) => onChange({ type })}>
            <SelectTrigger id={fieldId}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="text">短文本</SelectItem><SelectItem value="textarea">长文本</SelectItem><SelectItem value="number">数字</SelectItem><SelectItem value="select">选项</SelectItem><SelectItem value="boolean">开关</SelectItem></SelectContent>
          </Select>}</Field>
        {variable.type === "select" ? (
          <Field label="默认选项">{(fieldId) => <Select value={variable.default_value || "__none"} onValueChange={(value) => onChange({ default_value: value === "__none" ? "" : value })}>
              <SelectTrigger id={fieldId}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="__none">无默认值</SelectItem>{variable.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
            </Select>}</Field>
        ) : variable.type === "boolean" ? (
          <Field label="默认状态">{(fieldId) => <Card className="flex h-9 items-center gap-2 px-3 p-0 flex-row"><Checkbox id={fieldId} checked={variable.default_value === "true"} onCheckedChange={(checked) => onChange({ default_value: checked === true ? "true" : "false" })} />{variable.default_value === "true" ? "开启" : "关闭"}</Card>}</Field>
        ) : (
          <Field label="默认值">{(fieldId) => <Input id={fieldId} type={variable.type === "number" ? "number" : "text"} value={variable.default_value} onChange={(event) => onChange({ default_value: event.target.value })} placeholder="可选" />}</Field>
        )}
        {variable.type === "select" ? (
          <div className="sm:col-span-2 xl:col-span-2">
            <Field label="选项">
              {(fieldId) => (
                <Input
                  id={fieldId}
                  value={optionsText}
                  onChange={(event) => {
                    const text = event.target.value;
                    setOptionsText(text);
                    const options = parseVariableOptions(text);
                    onChange({ options, default_value: options.includes(variable.default_value) ? variable.default_value : "" });
                  }}
                  placeholder="例如 自动 / 极简 / 商业"
                />
              )}
            </Field>
          </div>
        ) : null}
        <div className="sm:col-span-2 xl:col-span-2"><Field label="输入提示">{(fieldId) => <Input id={fieldId} value={variable.placeholder || ""} onChange={(event) => onChange({ placeholder: event.target.value })} placeholder="可选" />}</Field></div>
      </div>
    </Card>
  );
}
