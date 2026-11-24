import { useEffect, useRef, useState, type ComponentProps } from "react";
import { AuthenticatedImage } from "./authenticated-image";
import { Skeleton } from "@/components/ui/skeleton";
import { acquireImagePreview, type HeldImagePreview } from "@/lib/image-preview-cache";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { cn } from "@/lib/utils";

type Props = ComponentProps<typeof AuthenticatedImage> & { onMetadata?: (width: number, height: number, bytes: number) => void };

// Only display previews here; downloads, editing, and generation continue to use the original URL.
export function ImagePreview({ src, onMetadata, onLoad, className, style, width, height, ...props }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inViewport = useRef(false);
  const [visible, setVisible] = useState(props.loading !== "lazy");
  const revision = useAuthSessionRevision();
  const [result, setResult] = useState<{ source: string; revision: number; url: string; metadata?: HeldImagePreview } | null>(null);
  const loaded = result?.source === src && result.revision === revision ? result : null;
  const shouldLoad = visible || props.loading !== "lazy";
  useEffect(() => {
    if (loaded || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => { inViewport.current = entry.isIntersecting; });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      inViewport.current = false;
    };
  }, [loaded]);
  useEffect(() => {
    if (visible || props.loading !== "lazy") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "200px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible, props.loading]);
  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    let held: HeldImagePreview | undefined;
    void acquireImagePreview(src, controller.signal, () => inViewport.current).then(metadata => {
      if (controller.signal.aborted) {
        metadata.release();
        return;
      }
      held = metadata;
      setResult({ source: src, revision, url: metadata.url, metadata });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ source: src, revision, url: src });
    });
    return () => {
      controller.abort();
      held?.release();
    };
  }, [src, shouldLoad, revision]);
  if (!loaded) return <Skeleton ref={ref} role="status" aria-label="正在加载图片" className={cn("block min-h-20 motion-reduce:animate-none", className)} style={{ ...style, aspectRatio: width && height ? `${width}/${height}` : undefined }} />;
  return <AuthenticatedImage {...props} src={loaded.url} width={width} height={height} className={className} style={style} onLoad={event => {
    const meta = loaded.metadata;
    onMetadata?.(meta?.width || event.currentTarget.naturalWidth, meta?.height || event.currentTarget.naturalHeight, meta?.bytes || 0);
    onLoad?.(event);
  }} />;
}
