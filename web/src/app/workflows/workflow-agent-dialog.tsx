import { useRef } from "react";
import { Pencil, Sparkles, Upload, Workflow as WorkflowIcon } from "lucide-react";

import { AgentExecutionRecovery } from "@/components/agent/agent-execution-recovery";
import { AgentNotice } from "@/components/agent/agent-notice";
import { PromptInput, PromptInputFooter, PromptInputSubmit } from "@/components/ai-elements/prompt-input";
import { ModelPicker } from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { ModelConfig } from "@/lib/api";
import { configuredModelNames } from "@/lib/model-config-selection";
import type { CreativeWorkflow, WorkflowAgentDraftResponse } from "@/services/api/workflows";

import { WorkflowReferenceGrid, type WorkflowReference } from "./workflow-reference-grid";
import { isWorkflowModelConfigured } from "./workflow-runtime";

type WorkflowAgentDialogProps = {
  open: boolean;
  prompt: string;
  scope: "private" | "public";
  model: string;
  models: ModelConfig | null;
  references: WorkflowReference[];
  draft: CreativeWorkflow | null;
  warnings: string[];
  error: string;
  busy: boolean;
  activeID?: string;
  onPromptChange: (value: string) => void;
  onScopeChange: (value: "private" | "public") => void;
  onModelChange: (value: string) => void;
  onAssetsOpen: () => void;
  onReferencesAdd: (files: FileList | null) => void;
  onReferenceRemove: (id: string) => void;
  onRecovered: (response: WorkflowAgentDraftResponse) => void;
  onRun: () => void;
  onApply: () => void;
  onClose: () => void;
};

export function WorkflowAgentDialog({
  open,
  prompt,
  scope,
  model,
  models,
  references,
  draft,
  warnings,
  error,
  busy,
  activeID,
  onPromptChange,
  onScopeChange,
  onModelChange,
  onAssetsOpen,
  onReferencesAdd,
  onReferenceRemove,
  onRecovered,
  onRun,
  onApply,
  onClose,
}: WorkflowAgentDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const textModelOptions = configuredModelNames(models?.text_models);
  const modelAvailable = isWorkflowModelConfigured(model, textModelOptions);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(96vw,980px)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Agent</DialogTitle>
          <DialogDescription>描述创作目标与需要填写的变量，生成草稿后可继续编辑。</DialogDescription>
        </DialogHeader>
        <ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <AgentExecutionRecovery domain="workflow" busy={busy} activeID={activeID} onResult={onRecovered} />
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Select disabled={busy} value={scope} onValueChange={onScopeChange}>
                  <SelectTrigger aria-label="工作流可见范围"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">个人工作流</SelectItem>
                    <SelectItem value="public">公开工作流</SelectItem>
                  </SelectContent>
                </Select>
                <ModelPicker label="Agent 文本模型" value={model} options={textModelOptions} disabled={busy} onValueChange={onModelChange} placeholder="暂无可用文本模型" />
              </div>
              <PromptInput>
                <InputGroupTextarea aria-label="创作需求" className="min-h-36 sm:min-h-56" rows={6} required disabled={busy} value={prompt} onChange={(event) => onPromptChange(event.target.value)} placeholder="例如：创建一个电商海报工作流，输入产品名称、核心卖点和活动信息，生成摄影方案与营销文案。" />
                <PromptInputFooter>
                  <PromptInputSubmit disabled={busy || !prompt.trim() || !modelAvailable} aria-label="生成工作流草稿" onClick={onRun}>{busy ? <Spinner /> : <Sparkles />}</PromptInputSubmit>
                </PromptInputFooter>
              </PromptInput>
              <Card className="p-3 gap-0">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold">参考图</h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={onAssetsOpen}>我的素材</Button>
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
                <WorkflowReferenceGrid references={references} className="grid-cols-5" disabled={busy} onRemove={onReferenceRemove} />
              </Card>
            </div>
            <Card className="min-w-0 gap-3 p-3">
              <h3 className="text-sm font-semibold">草稿预览</h3>
              {draft ? (
                <>
                  <div>
                    <p className="font-semibold">{draft.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{draft.category || "未分类"} · {draft.variables.length} 个变量 · {draft.scope === "public" ? "公开" : "个人"}</p>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">{draft.description || "暂无描述"}</p>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-xs leading-5">{draft.config.prompt_template}</p>
                  {warnings.length ? (
                    <AgentNotice className="space-y-1">
                      {warnings.map((warning) => <p key={warning}>{warning}</p>)}
                    </AgentNotice>
                  ) : null}
                </>
              ) : (
                <EmptyState compact icon={WorkflowIcon} title="草稿将在这里显示" description="填写需求并生成后，确认变量和提示词，再应用到编辑器。" />
              )}
            </Card>
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {draft ? <Button disabled={busy} onClick={onApply}><Pencil />应用到编辑器</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
