import { CircleAlert, FileText, Link2, ShieldCheck, Square, WandSparkles } from "lucide-react";

import { AgentExecutionRecovery } from "@/components/agent/agent-execution-recovery";
import { ModelPicker } from "@/components/model-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { VideoContractAgentDetail, VideoModelContractImportResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { VideoContractImportActivity } from "@/lib/video-contract-agent-progress";

import { VideoContractAgentDetails } from "./video-contract-agent-details";
import { VideoContractDocumentUpload } from "./video-contract-document-upload";
import { VideoContractImportProgress } from "./video-contract-import-progress";

type VideoContractImportDialogProps = {
  open: boolean;
  sourceType: "file" | "url";
  file: File | null;
  url: string;
  urlCount: number;
  model: string;
  models: string[];
  generatePlugin: boolean;
  activity: VideoContractImportActivity | null;
  details: VideoContractAgentDetail[];
  error: string;
  startedAt: number;
  endedAt: number;
  loadingModels: boolean;
  modelsError: string;
  running: boolean;
  onSourceTypeChange: (value: "file" | "url") => void;
  onFileChange: (file: File | null) => void;
  onURLChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onRetryModels: () => void;
  onGeneratePluginChange: (value: boolean) => void;
  onEdit: () => void;
  onGenerate: () => void;
  onRecovered: (data: VideoModelContractImportResult) => void;
  onStop: () => void;
  onClose: () => void;
};

export function VideoContractImportDialog({
  open, sourceType, file, url, urlCount, model, models, generatePlugin,
  activity, details, error, startedAt, endedAt, loadingModels, modelsError, running,
  onSourceTypeChange, onFileChange, onURLChange, onModelChange, onRetryModels, onGeneratePluginChange,
  onEdit, onGenerate, onRecovered, onStop, onClose,
}: VideoContractImportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !running && onClose()}>
      <DialogContent className="w-[min(calc(100%-2rem),60rem)] sm:max-w-none" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 leading-6"><WandSparkles className="size-5 shrink-0" />从文档生成契约</DialogTitle>
          <DialogDescription>{running ? "按步骤读取文档、匹配协议并校验配置，执行记录实时更新。" : activity ? "本次执行已结束。查看执行记录，或调整文档与模型后重试。" : "提供 API 文档，由 Agent 提取视频能力与接口配置，生成可审核的契约草稿。"}</DialogDescription>
        </DialogHeader>
        <ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 px-1 py-1">
          <AgentExecutionRecovery domain="video_contract" busy={running} onResult={onRecovered} />
          <div className="grid gap-4">
            <div className={cn("grid min-w-0 items-stretch gap-4 md:grid-cols-[minmax(0,1fr)_18rem]", activity && "hidden")}>
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle>文档来源</CardTitle>
                  <CardDescription>上传本地文件，或提供多份在线文档。</CardDescription>
                </CardHeader>
                <CardContent>
                  <Tabs value={sourceType} onValueChange={(value) => { if (value === "file" || value === "url") onSourceTypeChange(value); }} className="min-w-0 gap-4">
                    <TabsList className="w-full" aria-label="文档来源">
                      <TabsTrigger value="file" disabled={running}><FileText />上传文档</TabsTrigger>
                      <TabsTrigger value="url" disabled={running}><Link2 />文档链接</TabsTrigger>
                    </TabsList>
                    <TabsContent value="file">
                      <VideoContractDocumentUpload file={file} disabled={running} onChange={onFileChange} />
                    </TabsContent>
                    <TabsContent value="url" className="min-h-52 py-3">
                      <Field>
                        <FieldLabel htmlFor="video-contract-import-url">文档地址</FieldLabel>
                        <Textarea id="video-contract-import-url" value={url} disabled={running} rows={5} className="min-h-32 resize-y" placeholder={"https://docs.example.com/video/create\nhttps://docs.example.com/video/query"} aria-describedby="video-contract-import-url-help" onChange={(event) => onURLChange(event.target.value)} />
                        <FieldDescription id="video-contract-import-url-help">每行一个公开的 HTTP 或 HTTPS 链接，最多 24 个。重复地址会去重，Agent 将合并分析所有文档及相关接口页面。</FieldDescription>
                        <span className="text-xs text-muted-foreground" aria-live="polite">已填写 {urlCount} 个地址</span>
                      </Field>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle>生成设置</CardTitle>
                  <CardDescription>选择分析模型和草稿生成后的操作。</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5">
                  <Field>
                    <FieldLabel htmlFor="video-contract-analysis-model">分析模型</FieldLabel>
                    <ModelPicker id="video-contract-analysis-model" label="契约分析模型" value={model} options={models} disabled={running || loadingModels || Boolean(modelsError)} onValueChange={onModelChange} placeholder={loadingModels ? "读取模型中" : "暂无可用文本模型"} />
                    <FieldDescription>需支持工具调用，使用个人默认文本 Key。</FieldDescription>
                  </Field>
                  {modelsError ? (
                    <Alert variant="destructive">
                      <AlertDescription className="[overflow-wrap:anywhere]">{modelsError}</AlertDescription>
                      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={onRetryModels}>重试读取模型</Button>
                    </Alert>
                  ) : null}
                  <Separator />
                  <Field orientation="horizontal" className="items-start">
                    <FieldContent>
                      <FieldLabel htmlFor="video-contract-import-plugin">生成 New API 插件</FieldLabel>
                      <FieldDescription id="video-contract-import-plugin-help">开启后，草稿生成完成时进入插件配置，可逐份生成和下载。</FieldDescription>
                    </FieldContent>
                    <Switch id="video-contract-import-plugin" aria-describedby="video-contract-import-plugin-help" checked={generatePlugin} disabled={running} onCheckedChange={onGeneratePluginChange} />
                  </Field>
                </CardContent>
              </Card>
            </div>
            {activity ? <VideoContractImportProgress activity={activity} running={running} error={error} startedAt={startedAt} endedAt={endedAt} /> : null}
            <VideoContractAgentDetails entries={details} running={running} />
            {error && !activity ? (
              <Alert variant="destructive" role="alert" className="flex flex-wrap items-center gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words leading-relaxed">{error}</span>
              </Alert>
            ) : null}
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0" />生成后先审核草稿，再发布生效。</p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!running && activity ? <Button type="button" variant="ghost" onClick={onEdit}>调整文档或模型</Button> : null}
            <Button type="button" variant="outline" onClick={running ? onStop : onClose}>
              {running ? <Square className="fill-current" /> : null}{running ? "停止分析" : "取消"}
            </Button>
            <Button type="button" disabled={running || loadingModels || Boolean(modelsError) || !model || (sourceType === "file" ? !file : urlCount === 0)} onClick={onGenerate}>
              {running ? <Spinner /> : <WandSparkles />}{running ? "分析中" : activity ? "重新分析" : generatePlugin ? "生成草稿并配置插件" : "生成契约草稿"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
