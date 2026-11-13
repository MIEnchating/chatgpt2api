
import type { scriptProductionSummary } from "./canvas-script";
import { FieldError } from "@/components/ui/field";
import { useRef } from "react";
import { Card } from "@/components/ui/card";
import {
  AlignLeft,
  ArrowRight,
  Check,
  Download,
  Film,
  RotateCw,
  Upload,
} from "lucide-react";
import type { CanvasNode } from "@/services/api/canvas";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { CanvasInlineModelSelect } from "./canvas-inline-model-select";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasGenerationFooter } from "./canvas-generation-footer";
import { CanvasNodeInputToolbar } from "./canvas-node-input-toolbar";
import { PromptTextareaFrame } from "@/components/generation/prompt-textarea-frame";
import type { CanvasResourceReference } from "./canvas-resources";

export function CanvasScriptNode({ node, completedSteps = [false, false, false], summary, onOpen, onFocusMovie }: { node: CanvasNode; completedSteps?: readonly boolean[]; summary?: ReturnType<typeof scriptProductionSummary>; onOpen: () => void; onFocusMovie: (id: string) => void }) {
  const currentStep = completedSteps.findIndex((complete) => !complete);
  return (
    <div className="flex size-full flex-col items-center justify-center gap-5 bg-card p-5 text-center">
      <AlignLeft className="size-8 text-muted-foreground" />
      {node.prompt ? <p className="line-clamp-3 w-full whitespace-pre-wrap text-left text-sm">{node.prompt}</p> : null}
      <ol aria-label="脚本制作进度" className="grid w-full grid-cols-3 text-xs">
        {["确认镜头", "准备素材", "合成提示词"].map((label, index) => {
          const complete = completedSteps[index];
          const current = index === currentStep;
          return <li key={label} aria-current={current ? "step" : undefined} aria-label={`${label}：${complete ? "已完成" : current ? "进行中" : "未完成"}`} className={cn("relative flex min-w-0 flex-col items-center gap-1 text-muted-foreground", (complete || current) && "text-foreground")}>
            <Badge variant={complete ? "default" : "outline"} className="relative z-10 size-5 p-0">
              {complete ? <Check aria-hidden="true" /> : index + 1}
            </Badge>
            {index < 2 ? <Separator className="absolute top-2.5 left-[calc(50%+1rem)] data-horizontal:h-0.5 data-horizontal:w-[calc(100%-2rem)]" /> : null}
            <span>{label}</span>
          </li>;
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        {node.script_project?.shots.length ?? 0} 个镜头 · {node.script_project?.assets.length || 0}{" "}
        个素材
      </p>
      {summary ? <div className="grid w-full grid-cols-2 gap-2 text-left text-xs"><span>计划 {summary.plannedSeconds} 秒</span><span>视频 {summary.delivered}/{summary.total}</span><span>{summary.measured === summary.total && summary.total ? `实测 ${summary.actualSeconds.toFixed(2)} 秒` : `时长检测 ${summary.measured}/${summary.total}`}</span></div> : null}
      {node.script_project?.merged_video_node_id ? <Button variant="outline" size="sm" className="w-full" data-canvas-no-pan onMouseDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onFocusMovie(node.script_project!.merged_video_node_id!);}}>定位成片{node.script_project.merged_video_outdated ? " · 待更新" : ""}</Button> : null}
      <Button
        size="sm"
        className="w-full"
        data-canvas-no-pan
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        打开脚本节点
        <ArrowRight  />
      </Button>
    </div>
  );
}

export function CanvasScriptPromptPanel({
  node,
  models,
  defaultModel,
  references,
  running,
  onChange,
  onReferenceSelect,
  onGenerate,
  onStop,
  onUploadReference,
}: {
  node: CanvasNode;
  models: string[];
  defaultModel: string;
  references: readonly CanvasResourceReference[];
  running: boolean;
  onChange: (patch: Partial<CanvasNode>) => void;
  onReferenceSelect: (reference: CanvasResourceReference) => void;
  onGenerate: () => void;
  onStop: () => void;
  onUploadReference: (file: File) => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 pl-3 pr-12">
        <Button type="button" variant="outline" size="sm" disabled={running} aria-label="上传脚本参考图" onClick={() => uploadRef.current?.click()}>
          <Upload className="size-3.5" />
          参考图
        </Button>
        <input
          ref={uploadRef}
          type="file"
          accept="image/*"
          aria-label="上传脚本参考图"
          disabled={running}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUploadReference(file);
          }}
        />
      </div>
      <PromptTextareaFrame value={node.prompt || ""} className="min-h-0 flex-1">
        <CanvasResourceMentionTextarea
          aria-label="故事描述"
          value={node.prompt || ""}
          references={references}
          onReferenceSelect={onReferenceSelect}
          onChange={(prompt) => onChange({ prompt })}
          disabled={running}
          maxLength={12000}
          placeholder="描述剧情片段、故事，为你生成分镜脚本。输入 @ 引用画布素材"
          containerClassName="min-h-full"
          className="min-h-full resize-none px-3 py-1"
        />
      </PromptTextareaFrame>
      {node.generation_error ? (
        <FieldError>
          {node.generation_error}
        </FieldError>
      ) : null}
      <CanvasNodeInputToolbar
        action={
          <CanvasGenerationFooter
            running={running}
            disabled={!running && !models.includes(node.generation_text_model || defaultModel)}
            onGenerate={onGenerate}
            onStop={onStop}
          />
        }
      >
        <CanvasInlineModelSelect
          label="脚本文本模型"
          value={node.generation_text_model || defaultModel}
          models={models}
          onChange={(generation_text_model) => onChange({ generation_text_model })}
        />
      </CanvasNodeInputToolbar>
    </div>
  );
}

export function CanvasScriptActions({
  running,
  ready,
  onGenerate,
  onImages,
  onVideos,
  onDownload,
}: {
  running: boolean;
  ready: { image: boolean; video: boolean };
  onGenerate: () => void;
  onImages: () => void;
  onVideos: () => void;
  onDownload: () => void;
}) {
  return (
    <Card className="flex flex-wrap gap-1 p-1.5 flex-row">
      <Button variant="ghost" size="sm" disabled={running} onClick={onGenerate}>
        <RotateCw  />
        重新生成
      </Button>
      <Button variant="ghost" size="sm" disabled={running || !ready.image} onClick={onImages}>
        <Film  />
        批量生成分镜
      </Button>
      <Button variant="ghost" size="sm" disabled={running || !ready.video} onClick={onVideos}>
        <Film  />
        批量生成视频
      </Button>
      <Button variant="ghost" size="icon" aria-label="下载脚本" onClick={onDownload}>
        <Download  />
      </Button>
    </Card>
  );
}
