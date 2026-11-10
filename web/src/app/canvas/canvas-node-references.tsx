import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment";
import { useEffect, useState } from "react";
import { AlignLeft, ArrowLeft, AtSign, Image as ImageIcon, Music, Video, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { ImagePreview } from "@/components/image-preview";
import { canvasConfigInputLabel, type CanvasConfigInput } from "./canvas-config-inputs";

export function CanvasNodeReferences({ inputs, allInputs, onFocus, onRemove }: {
  inputs: readonly CanvasConfigInput[];
  allInputs: readonly CanvasConfigInput[];
  onFocus: (nodeID: string) => void;
  onRemove: (nodeID: string) => void;
}) {
  const [activeReferenceID, setActiveReferenceID] = useState("");
  if (!inputs.length) return null;
  return <AttachmentGroup data-canvas-reference-cards aria-label="引用的画布节点" className="shrink-0 gap-2 px-2.5 pr-10" onWheel={(event) => { event.stopPropagation(); }}>
    {inputs.map((input) => {
      const label = canvasConfigInputLabel(input, allInputs);
      const Icon = input.type === "audio" ? Music : input.type === "video" ? Video : input.type === "image" ? ImageIcon : AlignLeft;
      return <Attachment key={input.nodeID} data-reference-node-id={input.nodeID} orientation="vertical" size="xs" className="w-14">
        <AttachmentMedia variant={input.type === "image" || input.type === "video" ? "image" : "icon"}>
          {input.type === "image" && input.url ? <ImagePreview src={input.url} alt={input.title} className="size-full object-contain" /> : input.type === "video" && input.url ? <video src={input.url} muted preload="metadata" className="size-full object-contain" /> : <Icon />}
          <Badge variant="secondary" className="absolute left-1 top-1">{label.replace(/\D/g, "")}</Badge>
          <Badge variant="secondary" className="absolute bottom-1 right-1 size-5 p-0"><AtSign /></Badge>
        </AttachmentMedia>
        <Tooltip open={activeReferenceID === input.nodeID} onOpenChange={(open) => setActiveReferenceID((current) => open ? input.nodeID : current === input.nodeID ? "" : current)}>
        <TooltipTrigger asChild>
        <AttachmentTrigger onPointerEnter={() => setActiveReferenceID(input.nodeID)} onPointerDown={() => setActiveReferenceID("")} aria-label={`${label}：${input.title}，双击定位节点`} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onFocus(input.nodeID); }} onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onFocus(input.nodeID);
        }} />
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="w-max max-w-[min(272px,calc(100vw-1rem))]"><CanvasReferenceDetails input={input} /></TooltipContent>
        </Tooltip>
        <AttachmentActions className="group-data-[orientation=vertical]/attachment:top-0 group-data-[orientation=vertical]/attachment:right-0"><AttachmentAction type="button" aria-label={`移除${label}引用`} title="移除引用" onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setActiveReferenceID(""); onRemove(input.nodeID); }}><X /></AttachmentAction></AttachmentActions>
      </Attachment>;
    })}
  </AttachmentGroup>;
}

function CanvasReferenceDetails({ input }: { input: CanvasConfigInput }) {
  return <div data-canvas-reference-details>
    {input.type === "image" && input.url ? <ImagePreview src={input.url} alt={input.title} className="mx-auto block h-auto max-h-64 w-auto max-w-60 rounded-md object-contain" /> : null}
    {input.type === "video" && input.url ? <video src={input.url} muted preload="metadata" className="mx-auto block h-auto max-h-64 w-auto max-w-60 rounded-md object-contain" /> : null}
    {input.type === "audio" && input.url ? <audio src={input.url} controls preload="metadata" className="w-60 max-w-full" /> : null}
    {input.type === "text" && input.text ? <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-w-60" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain" style={{maxHeight: "13rem"}}><div className="min-w-0 whitespace-pre-wrap break-words text-xs leading-5">{input.text}</div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot> : null}
  </div>;
}

export function CanvasReferenceReturn({ expiresAt, onReturn, onDismiss }: {
  expiresAt: number;
  onReturn: () => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const remaining = expiresAt - current;
      if (remaining <= 0) return;
      // Wake exactly when the displayed whole second changes, and stop once expired.
      timer = window.setTimeout(tick, remaining % 1000 || 1000);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const seconds = Math.max(0, Math.min(10, Math.ceil((expiresAt - now) / 1000)));
  if (!seconds) return null;
  return <Card data-canvas-reference-return className="absolute left-1/2 top-16 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 p-1 sm:top-4 flex-row">
    <Button variant="ghost" type="button" aria-label="返回原节点" className="flex items-center whitespace-nowrap" onClick={onReturn}><ArrowLeft  />返回原节点<span className="w-6 text-right tabular-nums text-muted-foreground">{seconds}s</span></Button>
    <Button variant="ghost" size="icon-sm" type="button" aria-label="关闭返回入口" className="grid place-items-center" onClick={onDismiss}><X  /></Button>
  </Card>;
}
