import { useState } from "react";
import { FileText, Image as ImageIcon, Music, Video, X } from "lucide-react";
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentTrigger, AttachmentActions, AttachmentAction } from "@/components/ui/attachment";
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
  return <Attachment size="xs" className="min-w-0 max-w-full flex-nowrap" onKeyDown={event => event.stopPropagation()}>
    <AttachmentMedia variant={attachment.type === "image" && url ? "image" : "icon"}>
      {attachment.type === "image" && url ? <AuthenticatedImage src={url} alt="" /> : <Icon />}
    </AttachmentMedia>
    <AttachmentContent><AttachmentTitle title={attachment.title}>{attachment.title}</AttachmentTitle></AttachmentContent>
    {attachment.type === "image" && url ? <AttachmentTrigger aria-label={`预览附件 ${attachment.title}`} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onPreview(url); }} /> : null}
    {onRemove ? <AttachmentActions><AttachmentAction aria-label={`移除附件 ${attachment.title}`} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X /></AttachmentAction></AttachmentActions> : null}
  </Attachment>;
}
export function CanvasAgentAttachments({ attachments, onRemove }: { attachments: CanvasAssistantReference[]; onRemove?: (id: string) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  if (!attachments.length) return null;
  return <div className="mb-2 min-w-0" aria-label="消息附件">
    <AttachmentGroup aria-label="附件列表" className="flex-wrap overflow-visible">{attachments.map((item) => <CanvasAgentAttachmentChip key={item.id} attachment={item} onPreview={setPreview} onRemove={onRemove ? () => onRemove(item.id) : undefined} />)}</AttachmentGroup>
    {preview ? <ImageLightbox images={[{ id: "attachment", src: preview }]} currentIndex={0} open onOpenChange={(open) => { if (!open) setPreview(null); }} onIndexChange={() => undefined} /> : null}
  </div>;
}
