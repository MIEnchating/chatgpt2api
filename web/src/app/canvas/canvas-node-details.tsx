import { useMemo, useState, type ReactNode } from "react";
import { Camera, Compass, Grid2X2, ImagePlus, Music, Settings2, Type, Video } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block";
import { ItemMedia } from "@/components/ui/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";
import { canvasConfigPromptDisplay, type CanvasConfigInput } from "./canvas-config-inputs";
import { canvasGenerationStatusLabel, canvasNodeFallbackTitle, canvasNodeInfoJSON } from "./canvas-node-info";

export function CanvasNodeInfoContent({ node, configInputs }: { node: CanvasNode; configInputs: CanvasConfigInput[] }) {
  const [view, setView] = useState<"info" | "json">("info");
  const json = useMemo(() => view === "json" ? canvasNodeInfoJSON(node) : "", [node, view]);
  const typeLabel = canvasNodeFallbackTitle(node.type);
  const NodeIcon = { image: ImagePlus, video: Video, audio: Music, panorama: Compass, director: Camera, config: Settings2, group: Grid2X2, script: Type, text: Type }[node.type];
  const statusLabel = node.generation_status ? canvasGenerationStatusLabel(node.generation_status) : "普通节点";
  return (
    <Tabs value={view} onValueChange={(value) => setView(value === "json" ? "json" : "info")} className="min-w-0 gap-4 pb-2">
      <TabsList aria-label="节点数据" className="sticky top-0 z-10">
        <TabsTrigger value="info">信息</TabsTrigger>
        <TabsTrigger value="json">JSON</TabsTrigger>
      </TabsList>
      <TabsContent value="info">
          <div className="space-y-5 text-sm">
            <div className="flex min-w-0 items-center gap-3">
              <ItemMedia variant="icon" className="grid size-10 shrink-0 place-items-center [&>svg]:size-4.5"><NodeIcon /></ItemMedia>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{node.title || canvasNodeFallbackTitle(node.type)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{typeLabel}</p>
              </div>
              {node.generation_status ? <Badge variant="secondary" className="shrink-0">{statusLabel}</Badge> : null}
            </div>
            <InfoSection title="基础信息">
              <InfoRow label="节点 ID" value={node.id} mono copyable />
              <InfoRow label="画布尺寸" value={`${Math.round(node.width)} × ${Math.round(node.height)}`} />
              {node.natural_width && node.natural_height ? <InfoRow label="原始尺寸" value={`${node.natural_width} × ${node.natural_height}`} /> : null}
              {node.bytes ? <InfoRow label="文件大小" value={formatCanvasFileBytes(node.bytes)} /> : null}
              <InfoRow label="位置" value={`${Math.round(node.x)}, ${Math.round(node.y)}`} />
              {node.type === "text" ? <InfoRow label="字号" value={`${node.font_size || 14}px`} /> : null}
              {node.batch_child_ids && node.batch_child_ids.length > 1 ? <InfoRow label="图片组" value={`${node.batch_child_ids.length} 张`} /> : null}
              {node.created_at ? <InfoRow label="创建时间" value={new Date(node.created_at).toLocaleString("zh-CN")} /> : null}
            </InfoSection>
            {node.prompt || node.composer_content ? <InfoSection title="内容">
              {node.prompt ? <InfoRow label="提示词" value={node.prompt} /> : null}
              {node.composer_content ? <InfoRow label="组装提示词" value={canvasConfigPromptDisplay(node.composer_content, configInputs)} /> : null}
            </InfoSection> : null}
            {node.task_id || node.generation_model || node.generation_type || node.generation_status || node.generation_error ? <InfoSection title="生成信息">
              {node.generation_model ? <InfoRow label="模型" value={node.generation_model} mono /> : null}
              {node.generation_type ? <InfoRow label="请求类型" value={node.generation_type === "edit" ? "图片编辑" : "图片生成"} /> : null}
              {node.generation_status ? <InfoRow label="状态" value={statusLabel} /> : null}
              {node.task_id ? <InfoRow label="任务 ID" value={node.task_id} mono copyable /> : null}
              {node.generation_error ? <InfoRow label="失败原因" value={node.generation_error} /> : null}
            </InfoSection> : null}
            {node.url ? <InfoSection title="资源">
              <InfoRow label={node.type === "video" ? "视频地址" : node.type === "audio" ? "音频地址" : node.type === "panorama" ? "全景图地址" : "图片地址"} value={node.url} mono copyable />
            </InfoSection> : null}
          </div>
      </TabsContent>
      <TabsContent value="json" className="min-w-0">
        <CodeBlock className="min-w-0">
          <div className="flex justify-end px-2 pt-2">
            <TooltipHint content="复制 JSON"><CodeBlockCopyButton size="icon-sm" aria-label="复制 JSON" value={json} /></TooltipHint>
          </div>
          <CodeBlockContent wrap>{json}</CodeBlockContent>
        </CodeBlock>
      </TabsContent>
    </Tabs>
  );
}

function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h3 className="mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground">{title}</h3><div className="divide-y divide-border/65 border-y border-border/65">{children}</div></section>;
}

function InfoRow({ label, value, mono = false, copyable = false }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  return <div className="grid min-h-10 grid-cols-[76px_minmax(0,1fr)] items-start gap-3 py-2.5"><span className="text-xs leading-5 text-muted-foreground">{label}</span><span className="flex min-w-0 items-start gap-1.5"><span className={cn("min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]", mono && "font-mono text-xs")}>{value}</span>{copyable ? <TooltipHint content={`复制${label}`}><CodeBlockCopyButton size="icon-sm" className="shrink-0" aria-label={`复制${label}`} value={value} /></TooltipHint> : null}</span></div>;
}

function formatCanvasFileBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
