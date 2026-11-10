import { Spinner } from "@/components/ui/spinner";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";
import { useState } from "react";
import { AudioLines, Play, X } from "lucide-react";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function ReferenceMediaCard({ kind, src, label, uploading = false, compact = false, thumbnailOnly = false, removeDisabled = false, onRemove }: {
  kind: "image" | "video" | "audio";
  src: string;
  label: string;
  uploading?: boolean;
  compact?: boolean;
  thumbnailOnly?: boolean;
  removeDisabled?: boolean;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <Attachment data-reference-card={kind} orientation="vertical" state={uploading ? "uploading" : "done"} aria-busy={uploading} className={cn("w-full has-data-[slot=attachment-content]:w-full", compact && "w-28 has-data-[slot=attachment-content]:w-28 [@media(max-height:600px)]:w-36 [@media(max-height:600px)]:has-data-[slot=attachment-content]:w-36 [@media(max-height:600px)]:flex-row")}>
      <AttachmentMedia variant={kind === "audio" ? "icon" : "image"} className={cn("h-16 aspect-auto", thumbnailOnly && "h-24", compact && "[@media(max-height:600px)]:h-10 [@media(max-height:600px)]:w-14!")}>
        {kind === "image" ? <AuthenticatedImage src={src} alt={label} className="size-full object-cover" placeholderClassName="min-h-0" /> : kind === "video" ? <VideoFirstFrame key={src} src={src} /> : <AudioLines />}
        {kind !== "image" ? <Badge variant="secondary" className="absolute bottom-1.5 left-1.5 flex items-center gap-1"><Play  />{kind === "video" ? "视频" : "音频"}</Badge> : null}
        {uploading ? <span className="absolute inset-0 flex items-center justify-center"><Spinner aria-label={`正在上传${label}`} /></span> : null}
      </AttachmentMedia>
      {!thumbnailOnly ? <AttachmentContent className={compact ? "[@media(max-height:600px)]:pr-7" : undefined}><AttachmentTitle title={label}>{label}</AttachmentTitle></AttachmentContent> : null}
    <AttachmentTrigger disabled={uploading} onClick={() => setOpen(true)} aria-label={`预览${label}`} />
    {!uploading ? <AttachmentActions className="group-data-[orientation=vertical]/attachment:top-1 group-data-[orientation=vertical]/attachment:right-1"><AttachmentAction type="button" disabled={removeDisabled} onClick={onRemove} aria-label={`移除${label}`}><X /></AttachmentAction></AttachmentActions> : null}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
        {kind === "image" ? <AuthenticatedImage src={src} alt={label} className="max-h-[65dvh] w-full object-contain" /> : kind === "video" ? <video src={src} controls playsInline preload="metadata" className="max-h-[65dvh] w-full rounded-lg bg-black" /> : <audio src={src} controls preload="metadata" className="w-full" />}
      </ScrollArea></DialogContent>
    </Dialog>
  </Attachment>;
}

function VideoFirstFrame({ src }: { src: string }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    {!failed ? <video
      src={src.split("#")[0] + "#t=0"}
      muted playsInline disablePictureInPicture preload="auto"
      aria-label="视频首帧"
      className={cn("size-full object-cover", !ready && "invisible")}
      onLoadedData={() => setReady(true)}
      onError={() => setFailed(true)}
    /> : null}
    {failed ? <EmptyState compact title="预览不可用" className="absolute inset-0 min-h-0 p-1" /> : !ready ? <LoadingState compact label="正在加载视频预览" className="absolute inset-0 min-h-0 gap-1 p-1" /> : null}
  </>;
}
