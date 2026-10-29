import { useState } from "react";
import { AudioLines, LoaderCircle, Play, Video, X } from "lucide-react";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function ReferenceMediaCard({ kind, src, label, uploading = false, compact = false, removeDisabled = false, onRemove }: {
  kind: "image" | "video" | "audio";
  src: string;
  label: string;
  uploading?: boolean;
  compact?: boolean;
  removeDisabled?: boolean;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <div data-reference-card={kind} className={cn("group relative min-w-0 rounded-xl border border-border/70 bg-background", compact && "w-28 shrink-0 [@media(max-height:600px)]:w-36")}>
    <button type="button" disabled={uploading} onClick={() => setOpen(true)} aria-label={`预览${label}`} className={cn("block w-full overflow-hidden rounded-xl text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring", compact && "[@media(max-height:600px)]:flex [@media(max-height:600px)]:items-center")}>
      <div className={cn("relative flex h-16 items-center justify-center overflow-hidden rounded-t-xl bg-muted/50", compact && "[@media(max-height:600px)]:h-10 [@media(max-height:600px)]:w-14 [@media(max-height:600px)]:shrink-0 [@media(max-height:600px)]:rounded-none")}>
        {kind === "image" ? <AuthenticatedImage src={src} alt={label} className="size-full object-cover" placeholderClassName="min-h-0" /> : kind === "video" ? <VideoFirstFrame key={src} src={src} /> : <AudioLines className="size-7 text-brand/75" />}
        {kind !== "image" ? <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white"><Play className="size-2.5" />{kind === "video" ? "视频" : "音频"}</span> : null}
        {uploading ? <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white"><LoaderCircle className="size-4 animate-spin" /></span> : null}
      </div>
      <p className={cn("truncate px-2 py-1.5 text-[11px] font-medium", compact && "[@media(max-height:600px)]:pr-7")} title={label}>{label}</p>
    </button>
    {!uploading ? <button type="button" disabled={removeDisabled} onClick={onRemove} aria-label={`移除${label}`} className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button> : null}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="z-[90] sm:max-w-2xl" overlayClassName="z-[80]" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        {kind === "image" ? <AuthenticatedImage src={src} alt={label} className="max-h-[65dvh] w-full object-contain" /> : kind === "video" ? <video src={src} controls playsInline preload="metadata" className="max-h-[65dvh] w-full rounded-lg bg-black" /> : <audio src={src} controls preload="metadata" className="w-full" />}
      </DialogContent>
    </Dialog>
  </div>;
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
    {!ready || failed ? <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">{failed ? <><Video className="size-5" /><span className="text-[10px]">预览不可用</span></> : <LoaderCircle className="size-4 animate-spin" />}</span> : null}
  </>;
}
