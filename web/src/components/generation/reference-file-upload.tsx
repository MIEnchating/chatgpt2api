import { Spinner } from "@/components/ui/spinner";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export function ReferenceFileUpload({ label, hint, accept, disabled = false, loading = false, remaining = 1, icon, showLabel = true, showHint = true, onFiles }: {
  icon?: ReactNode;
  showLabel?: boolean;
  showHint?: boolean;
  label: string;
  hint: string;
  accept: string;
  disabled?: boolean;
  loading?: boolean;
  remaining?: number;
  onFiles: (files: File[]) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const unavailable = disabled || loading || busy || remaining <= 0;
  const upload = async (files: File[]) => {
    if (unavailable || busyRef.current || !files.length) return;
    const types = accept.toLowerCase().split(",");
    const accepted = files.filter(file => types.some(type => type.startsWith(".") ? file.name.toLowerCase().endsWith(type) : file.type.toLowerCase() === type));
    if (accepted.length !== files.length) toast.error(`文件格式不支持，请选择${hint.split(" · ")[0]}`);
    if (accepted.length > remaining) toast.info(`最多还可添加 ${remaining} 个文件`);
    if (!accepted.length) return;
    busyRef.current = true;
    setBusy(true);
    try { await onFiles(accepted.slice(0, remaining)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = unavailable ? "none" : "copy";
    setDragging(!unavailable);
  };
  if (remaining <= 0) return null;
  return <Attachment
    orientation="vertical"
    state={loading || busy ? "uploading" : "idle"}
    aria-busy={loading || busy || undefined}
    className="w-full has-data-[slot=attachment-content]:w-full"
    data-reference-upload={label}
    onDragEnter={dragOver}
    onDragOver={dragOver}
    onDragLeave={event => {
      event.stopPropagation();
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    }}
    onDrop={event => {
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      void upload(Array.from(event.dataTransfer.files));
    }}
  >
    <input ref={inputRef} type="file" accept={accept} multiple={remaining > 1} disabled={unavailable} className="hidden" onChange={event => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      void upload(files);
    }} />
    <AttachmentTrigger
      aria-label={label}
      aria-busy={loading || busy || undefined}
      title={`${label} · ${hint} · 点击或拖入`}
      disabled={unavailable}
      onClick={() => inputRef.current?.click()}
    />
      <AttachmentMedia className={cn("aspect-auto flex-col gap-1", showLabel ? "h-16" : "h-24")}>
        {loading || busy ? <Spinner /> : icon || <Plus  />}
        <span className="text-xs">{loading || busy ? "正在上传…" : dragging ? "松开上传" : "点击或拖入"}</span>
        {!showLabel && showHint ? <AttachmentDescription>{hint}</AttachmentDescription> : null}
      </AttachmentMedia>
      {showLabel ? <AttachmentContent><AttachmentTitle>{label}</AttachmentTitle></AttachmentContent> : null}
  </Attachment>;
}
