import { useEffect, useRef, useState, type ComponentProps } from "react";
import { AuthenticatedImage } from "./authenticated-image";
import { Skeleton } from "@/components/ui/skeleton";
import { getCachedImagePreview, loadImagePreview, type CachedImagePreview } from "@/lib/image-preview-cache";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { cn } from "@/lib/utils";

type Props = ComponentProps<typeof AuthenticatedImage> & { onMetadata?: (width: number, height: number, bytes: number) => void };

// Only display previews here; downloads, editing, and generation continue to use the original URL.
export function ImagePreview({ src, onMetadata, onLoad, className, style, width, height, ...props }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(props.loading !== "lazy");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ source: string; url: string; metadata?: CachedImagePreview } | null>(null);
  useEffect(() => {
    const changed = () => { setResult(null); setRevision(value => value + 1); };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, changed);
    return () => window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, changed);
  }, []);
  useEffect(() => {
    if (visible || props.loading !== "lazy") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "200px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible, props.loading]);
  useEffect(() => {
    const cached = getCachedImagePreview(src);
    if (cached) {
      setResult({ source: src, url: cached.url, metadata: cached });
      return;
    }
    if (!visible && props.loading === "lazy") return;
    let current = true;
    setResult(null);
    void loadImagePreview(src).then(metadata => {
      if (!current) return;
      setResult({ source: src, url: metadata.url, metadata });
    }).catch(() => { if (current) setResult({ source: src, url: src }); });
    return () => { current = false; };
  }, [src, visible, props.loading, revision]);
  const cached = getCachedImagePreview(src);
  const loaded = cached ? { source: src, url: cached.url, metadata: cached } : result?.source === src ? result : null;
  if (!loaded) return <Skeleton ref={ref} role="status" aria-label="正在加载图片" className={cn("block min-h-20 motion-reduce:animate-none", className)} style={{ ...style, aspectRatio: width && height ? `${width}/${height}` : undefined }} />;
  return <AuthenticatedImage {...props} src={loaded.url} width={width} height={height} className={className} style={style} onLoad={event => {
    const meta = loaded.metadata;
    onMetadata?.(meta?.width || event.currentTarget.naturalWidth, meta?.height || event.currentTarget.naturalHeight, meta?.bytes || 0);
    onLoad?.(event);
  }} />;
}
