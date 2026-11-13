import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LabeledField } from "@/components/labeled-field";
import { ImagePreview } from "@/components/image-preview";
import { MediaVideoPlayer } from "@/components/media-video-player";
import type { CanvasNode, CanvasScriptShot } from "@/services/api/canvas";
import { canvasGenerationNeedsRecovery } from "./canvas-generation-context";
import { scriptMediaCanRetry, scriptMediaHasExistingResult, scriptMediaStatus } from "./canvas-script";
import { canvasNodeAspectRatio } from "./canvas-node-geometry";

export function ScriptShotMediaDialog({ shot, nodes, running, confirmed, onClose, onBind, onNavigate, onGenerate, onRetry }: {
  shot: CanvasScriptShot;
  nodes: readonly CanvasNode[];
  running: boolean;
  confirmed: boolean;
  onClose: () => void;
  onBind: (type: "image" | "video", id: string) => void;
  onNavigate: (id: string) => void;
  onGenerate: (type: "image" | "video", regenerate: boolean) => void;
  onRetry: (id: string) => void;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex w-[min(960px,calc(100vw-2rem))] max-w-none flex-col sm:max-w-none">
      <DialogTitle>镜头素材与成品</DialogTitle>
      <DialogDescription>关联已有分镜或视频，查看任务进度。脚本改动后的旧成品会标记为待更新，重新生成会保留旧节点。</DialogDescription>
      <ScrollArea className="min-h-0 flex-1" contentClassName="grid gap-4 sm:grid-cols-2">
        {(["image", "video"] as const).map((type) => {
          const id = shot[type === "image" ? "image_node_id" : "video_node_id"];
          const node = nodes.find((item) => item.id === id && item.type === type);
          const outdated = shot[type === "image" ? "image_outdated" : "video_outdated"];
          const label = type === "image" ? "分镜图片" : "镜头视频";
          const hasExistingResult = scriptMediaHasExistingResult(node);
          const recovering = Boolean(node && canvasGenerationNeedsRecovery(node));
          const status = scriptMediaStatus(node, outdated);
          return <Card key={type} className="min-w-0 gap-3 p-4">
            <div className="flex items-center justify-between gap-2"><span>{label}</span><Badge variant={outdated || node?.generation_status === "error" ? "destructive" : "secondary"}>{status}</Badge></div>
            {node?.url ? type === "image" ? <ImagePreview src={node.url} alt={label} className="aspect-video w-full object-contain" /> : <div className="mx-auto w-full" style={{ maxWidth: `calc(60dvh * ${canvasNodeAspectRatio(node)})` }}><MediaVideoPlayer src={node.url} title={label} aspectRatio={String(canvasNodeAspectRatio(node))} embedded /></div> : <EmptyState compact title={status} description={node?.generation_status === "loading" ? `${Math.round(node.generation_progress || 0)}%` : "可关联画布成品，或提交生成"} />}
            {node?.media_metadata ? <p className="text-xs text-muted-foreground">实测 {(node.media_metadata.duration_ms/1000).toFixed(2)} 秒 · {node.media_metadata.width} × {node.media_metadata.height} · {node.media_metadata.has_audio===undefined ? "音轨未检测" : node.media_metadata.has_audio ? "含音轨" : "无音轨"}</p> : null}
            {node?.media_probe_error ? <FieldError>{node.media_probe_error}</FieldError> : null}
            {node?.generation_error ? <FieldError>{node.generation_error}</FieldError> : null}
            <LabeledField label={`关联${label}`}>{(fieldID) => <Select value={node?.id || "__none__"} disabled={running} onValueChange={(value) => onBind(type, value === "__none__" ? "" : value)}><SelectTrigger id={fieldID}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none__">不关联</SelectItem>{nodes.filter((item) => item.type === type).map((item) => <SelectItem key={item.id} value={item.id}>{item.title || (item.type === "image" ? "未命名图片" : "未命名视频")}</SelectItem>)}</SelectContent></Select>}</LabeledField>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!node} onClick={() => node && onNavigate(node.id)}>跳转至节点</Button>
              {node && scriptMediaCanRetry(node) && !outdated ? <Button variant="outline" size="sm" disabled={running || !confirmed} onClick={() => onRetry(node.id)}>重试生成</Button> : null}
              <Button size="sm" disabled={running || !confirmed || recovering} onClick={() => onGenerate(type, hasExistingResult)}>{hasExistingResult ? "重新生成" : "生成"}</Button>
            </div>
          </Card>;
        })}
      </ScrollArea>
    </DialogContent>
  </Dialog>;
}
