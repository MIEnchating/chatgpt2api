import { Camera, Compass, ImagePlus, MousePointer2, Music, Settings2, Type, Video } from "lucide-react";
import type { CanvasCreatableNodeType } from "./canvas-workspace-controls";

const START_ACTIONS = [
  { id: "text", label: "文字", icon: Type },
  { id: "image", label: "图片", icon: ImagePlus },
  { id: "video", label: "视频", icon: Video },
  { id: "audio", label: "音频", icon: Music },
  { id: "panorama", label: "全景图", icon: Compass },
  { id: "director", label: "导演台", icon: Camera },
  { id: "config", label: "生成配置", icon: Settings2 },
] as const;

export function CanvasEmptyState({ onCreate }: { onCreate: (type: CanvasCreatableNodeType) => void }) {
  return <div data-canvas-empty-state className="pointer-events-none absolute inset-x-5 top-16 bottom-[calc(var(--canvas-dock-clearance)+1rem)] flex items-center justify-center @container/canvas-empty sm:inset-x-8">
    <div className="w-full max-w-[720px] space-y-5 text-center">
      <div className="space-y-2">
        <h2 className="text-base font-medium tracking-tight text-foreground/90">从一个节点开始</h2>
        <p className="text-xs leading-5 text-muted-foreground">添加内容、连接节点，构建你的创作画布</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {START_ACTIONS.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => onCreate(id)} className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-xl border border-border/70 bg-card/70 px-3 text-xs text-foreground/85 transition-colors hover:border-brand/40 hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Icon className="size-4 shrink-0 text-muted-foreground" />{label}
        </button>)}
      </div>
      <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/80"><MousePointer2 className="size-3.5" />也可以双击空白处添加，或直接拖入素材</p>
    </div>
  </div>;
}
