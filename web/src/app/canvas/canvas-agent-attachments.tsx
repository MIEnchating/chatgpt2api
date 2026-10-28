import { useState } from "react";
import { FileText, Image as ImageIcon, Music, Video, X } from "lucide-react";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { ImageLightbox } from "@/components/image-lightbox";
import type { CanvasAssistantReference } from "./agent/canvas-agent-types";

export function CanvasAgentAttachmentChip({ attachment, onPreview, onRemove }: {
  attachment: CanvasAssistantReference;
  onPreview: (url: string) => void;
  onRemove?: () => void;
}) {
  const url = attachment.url || attachment.dataUrl;
  const Icon = attachment.type === "audio" ? Music : attachment.type === "video" ? Video : attachment.type === "text" ? FileText : ImageIcon;
  return <>
    {attachment.type === "image" && url ? <button type="button" className="flex min-w-0 items-center gap-1 rounded text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label={`预览附件 ${attachment.title}`} title={attachment.title} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onPreview(url); }}>
      <AuthenticatedImage src={url} alt="" className="size-5 shrink-0 rounded object-cover" />
      <span className="min-w-0 max-w-28 truncate">{attachment.title}</span>
    </button> : <><Icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 max-w-28 truncate" title={attachment.title}>{attachment.title}</span></>}
    {onRemove ? <button type="button" className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`移除附件 ${attachment.title}`} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button> : null}
  </>;
}

export function CanvasAgentAttachments({ attachments }: { attachments: CanvasAssistantReference[] }) {
  const [preview, setPreview] = useState<string | null>(null);
  if (!attachments.length) return null;
  return <div className="mb-2 min-w-0" aria-label="消息附件">
    <div role="group" aria-label="附件列表" className="flex flex-wrap gap-1.5 p-0.5">
      {attachments.map((item) => <span key={item.id} className="inline-flex min-w-0 max-w-[calc(50%-0.1875rem)] items-center gap-1.5 rounded-lg border border-border/60 bg-muted/20 p-1 text-xs"><CanvasAgentAttachmentChip attachment={item} onPreview={setPreview} /></span>)}
    </div>
    {preview ? <ImageLightbox images={[{ id: "attachment", src: preview }]} currentIndex={0} open onOpenChange={(open) => { if (!open) setPreview(null); }} onIndexChange={() => undefined} /> : null}
  </div>;
}
