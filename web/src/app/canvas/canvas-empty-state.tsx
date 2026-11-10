import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import { Camera, Compass, ImagePlus, MousePointer2, Music, Settings2, Type, Video } from "lucide-react";
import type { CanvasCreatableNodeType } from "./canvas-workspace-controls";

const START_ACTIONS = [
  { id: "text", label: "文字", icon: Type },
  { id: "image", label: "图片", icon: ImagePlus },
  { id: "video", label: "视频", icon: Video },
  { id: "audio", label: "音频", icon: Music },
  { id: "panorama", label: "全景图", icon: Compass },
  { id: "script", label: "脚本", icon: Type },
  { id: "director", label: "导演台", icon: Camera },
  { id: "config", label: "生成配置", icon: Settings2 },
] as const;

export function CanvasEmptyState({ onCreate }: { onCreate: (type: CanvasCreatableNodeType) => void }) {
  return <Empty data-canvas-empty-state className="pointer-events-none absolute inset-x-5 top-16 bottom-[calc(var(--canvas-dock-clearance)+1rem)] w-auto gap-5 p-0 @container/canvas-empty sm:inset-x-8">
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>从一个节点开始</EmptyTitle>
        <EmptyDescription>添加内容、连接节点，构建你的创作画布</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-[720px] gap-5">
      <div className="flex flex-wrap justify-center gap-2">
        {START_ACTIONS.map(({ id, label, icon: Icon }) => <Button variant="outline" key={id} type="button" onClick={() => onCreate(id)} className="pointer-events-auto inline-flex items-center">
          <Icon className="shrink-0 text-muted-foreground" />{label}
        </Button>)}
      </div>
      <EmptyDescription className="flex items-center justify-center gap-1.5"><MousePointer2 className="size-3.5 shrink-0" />也可以双击空白处添加，或直接拖入素材</EmptyDescription>
      </EmptyContent>
  </Empty>;
}
