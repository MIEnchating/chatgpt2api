import { useEffect, useState } from "react";
import { AlignLeft, ArrowLeft, AtSign, Image as ImageIcon, Music, Video, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { canvasConfigInputLabel, type CanvasConfigInput } from "./canvas-config-inputs";

export function CanvasNodeReferences({ inputs, allInputs, onFocus, onRemove }: {
  inputs: readonly CanvasConfigInput[];
  allInputs: readonly CanvasConfigInput[];
  onFocus: (nodeID: string) => void;
  onRemove: (nodeID: string) => void;
}) {
  const [activeReferenceID, setActiveReferenceID] = useState("");
  if (!inputs.length) return null;
  return <ScrollArea data-canvas-reference-cards aria-label="引用的画布节点" className="h-16 shrink-0" viewClass="flex w-max min-w-full gap-2 pb-1" viewportClassName="overscroll-contain">
    {inputs.map((input) => {
      const label = canvasConfigInputLabel(input, allInputs);
      const Icon = input.type === "audio" ? Music : input.type === "video" ? Video : input.type === "image" ? ImageIcon : AlignLeft;
      return <div key={input.nodeID} data-reference-node-id={input.nodeID} className="group relative size-14 shrink-0">
        <Tooltip open={activeReferenceID === input.nodeID} onOpenChange={(open) => setActiveReferenceID((current) => open ? input.nodeID : current === input.nodeID ? "" : current)}>
        <TooltipTrigger asChild>
        <button type="button" onPointerEnter={() => setActiveReferenceID(input.nodeID)} onPointerDown={() => setActiveReferenceID("")} aria-label={`${label}：${input.title}，双击定位节点`} className="relative block size-full overflow-hidden rounded-xl border border-border bg-muted text-left shadow-sm transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onFocus(input.nodeID); }} onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onFocus(input.nodeID);
        }}>
          {input.type === "image" && input.url ? <AuthenticatedImage src={input.url} alt={input.title} className="size-full object-contain" /> : input.type === "video" && input.url ? <video src={input.url} muted preload="metadata" className="size-full object-contain" /> : <div className="grid size-full place-items-center"><Icon className="size-5 text-muted-foreground" /></div>}
          <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">{label.replace(/\D/g, "")}</span>
          <span className="absolute bottom-1 right-1 rounded bg-black/60 p-0.5 text-white"><AtSign className="size-3" /></span>
        </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="w-max max-w-[min(272px,calc(100vw-1rem))] p-2"><CanvasReferenceDetails input={input} /></TooltipContent>
        </Tooltip>
        <button type="button" aria-label={`移除${label}引用`} title="移除引用" className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-black/60 text-white hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setActiveReferenceID(""); onRemove(input.nodeID); }}><X className="size-3" /></button>
      </div>;
    })}
  </ScrollArea>;
}

function CanvasReferenceDetails({ input }: { input: CanvasConfigInput }) {
  return <div data-canvas-reference-details>
    {input.type === "image" && input.url ? <AuthenticatedImage src={input.url} alt={input.title} className="mx-auto block h-auto max-h-64 w-auto max-w-60 rounded-md object-contain" /> : null}
    {input.type === "video" && input.url ? <video src={input.url} muted preload="metadata" className="mx-auto block h-auto max-h-64 w-auto max-w-60 rounded-md object-contain" /> : null}
    {input.type === "audio" && input.url ? <audio src={input.url} controls preload="metadata" className="w-60 max-w-full" /> : null}
    {input.type === "text" && input.text ? <ScrollArea className="max-w-60" maxHeight="13rem" viewClass="whitespace-pre-wrap break-words text-xs leading-5">{input.text}</ScrollArea> : null}
  </div>;
}

export function CanvasReferenceReturn({ expiresAt, onReturn, onDismiss }: {
  expiresAt: number;
  onReturn: () => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(interval);
  }, [expiresAt]);
  const seconds = Math.max(0, Math.min(10, Math.ceil((expiresAt - now) / 1000)));
  if (!seconds) return null;
  return <div data-canvas-reference-return className="absolute left-1/2 top-16 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/95 p-1 shadow-[var(--shadow-elevated)] backdrop-blur-xl sm:top-4">
    <button type="button" aria-label="返回原节点" className="flex h-8 items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onReturn}><ArrowLeft className="size-3.5" />返回原节点<span className="w-6 text-right tabular-nums text-muted-foreground">{seconds}s</span></button>
    <button type="button" aria-label="关闭返回入口" className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onDismiss}><X className="size-3.5" /></button>
  </div>;
}
