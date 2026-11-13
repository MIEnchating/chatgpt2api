import { useMemo } from "react";
import { ChevronDown, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { CanvasNode } from "@/services/api/canvas";
import { scriptMediaStatus } from "./canvas-script";

export function CanvasScriptNavigation({ scripts, nodes, onFitScript, onFocusNode }: {
  scripts: readonly CanvasNode[];
  nodes: readonly CanvasNode[];
  onFitScript: (id: string) => void;
  onFocusNode: (id: string) => void;
}) {
  const byID = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const media = (id: string | undefined, type: "image" | "video") => {
    const node = byID.get(id || "");
    return node?.type === type ? node : undefined;
  };
  return <nav aria-label="当前制作导航" className="grid min-w-0 gap-2 border-t pt-2">
    <p className="text-xs text-muted-foreground">按素材和镜头定位当前版本</p>
    {scripts.map(script => {
      const project = script.script_project;
      if (!project) return null;
      const title = script.title || "未命名脚本";
      return <Collapsible key={script.id} defaultOpen={scripts.length === 1} className="min-w-0">
        <div className="flex min-w-0 items-center gap-1">
          <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start whitespace-normal text-left" aria-label={`定位脚本制作：${title}`} onClick={() => onFitScript(script.id)}><FileText className="shrink-0" /><span className="min-w-0 break-words">{title}</span></Button>
          <CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`展开或收起制作导航：${title}`}><ChevronDown /></Button></CollapsibleTrigger>
        </div>
        <CollapsibleContent className="grid min-w-0 gap-3 pt-2">
          {project.assets.length ? <Collapsible className="min-w-0">
            <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="w-full justify-between">素材 {project.assets.length}<ChevronDown /></Button></CollapsibleTrigger>
            <CollapsibleContent className="grid min-w-0 gap-1">
              {project.assets.map(asset => <ScriptNavigationTarget key={asset.id} label={asset.name || "未命名素材"} accessibleLabel={`定位${title}素材：${asset.name || "未命名素材"}`} node={media(asset.image_node_id, "image")} onFocus={onFocusNode} />)}
            </CollapsibleContent>
          </Collapsible> : null}
          {project.shots.map((shot, index) => <div key={shot.id} className="grid min-w-0 gap-1">
            <p className="px-2 text-xs text-muted-foreground">第 {index + 1} 镜 · {shot.seconds} 秒</p>
            <div className="grid min-w-0 grid-cols-2 gap-1">
              <ScriptNavigationTarget label="分镜" accessibleLabel={`定位${title}：第 ${index + 1} 镜分镜`} node={media(shot.image_node_id, "image")} outdated={shot.image_outdated} onFocus={onFocusNode} />
              <ScriptNavigationTarget label="视频" accessibleLabel={`定位${title}：第 ${index + 1} 镜视频`} node={media(shot.video_node_id, "video")} outdated={shot.video_outdated} onFocus={onFocusNode} />
            </div>
          </div>)}
          {project.merged_video_node_id ? <ScriptNavigationTarget label="成片" accessibleLabel={`定位${title}成片`} node={media(project.merged_video_node_id, "video")} outdated={project.merged_video_outdated} onFocus={onFocusNode} /> : null}
        </CollapsibleContent>
      </Collapsible>;
    })}
  </nav>;
}

function ScriptNavigationTarget({ label, accessibleLabel, node, outdated, onFocus }: {
  label: string;
  accessibleLabel: string;
  node: CanvasNode | undefined;
  outdated?: boolean;
  onFocus: (id: string) => void;
}) {
  return <Button variant="ghost" size="sm" className="h-auto min-w-0 flex-wrap justify-start whitespace-normal py-2 text-left" aria-label={accessibleLabel} data-canvas-navigation-node={node?.id} disabled={!node} onClick={() => node && onFocus(node.id)}>
    <span className="min-w-0 break-words">{label}</span>
    <Badge variant={outdated || node?.generation_status === "error" ? "destructive" : "outline"}>{scriptMediaStatus(node, outdated)}</Badge>
  </Button>;
}
