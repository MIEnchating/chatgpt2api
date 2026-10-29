import { useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { LoaderCircle, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export function ReferenceFileUpload({ label, hint, accept, disabled = false, loading = false, remaining = 1, onFiles }: {
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
  return <div
    className="min-w-0"
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
    <button
      type="button"
      aria-label={label}
      aria-busy={loading || busy || undefined}
      title={`${label} · ${hint} · 点击或拖入`}
      disabled={unavailable}
      onClick={() => inputRef.current?.click()}
      className={cn("group block w-full min-w-0 overflow-hidden rounded-xl border border-dashed border-border/70 bg-background text-muted-foreground transition-colors enabled:hover:border-brand/60 enabled:hover:bg-brand-soft/40 enabled:hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", dragging && "border-brand bg-brand-soft text-brand ring-2 ring-brand/20")}
    >
      <span className="flex h-16 flex-col items-center justify-center gap-1 bg-muted/20">
        {loading || busy ? <LoaderCircle className="size-5 animate-spin" /> : <Plus className="size-5" />}
        <span className="text-[10px] leading-4">{loading || busy ? "正在上传…" : dragging ? "松开上传" : "点击或拖入"}</span>
      </span>
      <span className="block truncate px-2 py-1.5 text-[11px] font-medium">{label}</span>
    </button>
  </div>;
}
