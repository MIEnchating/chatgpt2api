import { useState } from "react";
import { Download, LocateFixed } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MediaVideoPlayer } from "@/components/media-video-player";
import type { CanvasNode } from "@/services/api/canvas";
import { downloadCanvasNodeMedia } from "./canvas-media-download";
import { canvasNodeAspectRatio } from "./canvas-node-geometry";

export function CanvasMovieCard({ node, outdated, historical, onFocus }: { node: CanvasNode; outdated?: boolean; historical?: boolean; onFocus?: (id: string) => void }) {
  const [downloading, setDownloading] = useState(false);
  const info = node.media_metadata;
  const aspectRatio = canvasNodeAspectRatio(node);
  return <Card className="min-w-0 gap-3" data-canvas-movie-card={node.id}>
    <CardHeader className="gap-2"><CardTitle>{node.title || "成片"}</CardTitle><Badge variant={outdated ? "destructive" : "secondary"}>{historical ? "历史成片" : outdated ? "旧版本 · 待更新" : "当前成片"}</Badge></CardHeader>
    <CardContent className="grid min-w-0 gap-3">
      {node.url ? <div className="mx-auto w-full" style={{ maxWidth: `calc(60dvh * ${aspectRatio})` }}><MediaVideoPlayer src={node.url} title={node.title || "成片"} aspectRatio={String(aspectRatio)} embedded /></div> : null}
      <p className="text-xs text-muted-foreground">{info ? `${(info.duration_ms / 1000).toFixed(2)} 秒 · ${info.width} × ${info.height} · ${info.has_audio === undefined ? "音轨未检测" : info.has_audio ? "含音轨" : "无音轨"}` : "媒体属性待检测"}{node.media_silent_clips ? ` · ${node.media_silent_clips} 段原片无音轨，已填充静音` : ""}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!node.url || downloading} onClick={async () => { setDownloading(true); try { await downloadCanvasNodeMedia(node); } catch (error) { toast.error(error instanceof Error ? error.message : "下载失败"); } finally { setDownloading(false); } }}><Download />{downloading ? "下载中" : "下载成片"}</Button>{onFocus ? <Button size="sm" variant="outline" onClick={() => onFocus(node.id)}><LocateFixed />定位到画布</Button> : null}</div>
    </CardContent>
  </Card>;
}
