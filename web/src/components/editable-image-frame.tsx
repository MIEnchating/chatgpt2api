import type { ReactNode } from "react";
import { CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { useEditableImageSource } from "@/components/use-editable-image-source";

export function EditableImageFrame({ source, className, children, loadingHint }: {
  source: ReturnType<typeof useEditableImageSource>;
  className?: string;
  children: ReactNode;
  loadingHint?: string;
}) {
  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden rounded-xl border border-border bg-black/5", className)} aria-busy={!source.url && !source.error}>
      {source.url ? children : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/90 px-5 text-center" role={source.error ? "alert" : "status"}>
          {source.error ? <>
            <CircleAlert className="size-6 text-destructive" />
            <p className="text-sm text-destructive">{source.error}</p>
            <Button type="button" variant="outline" onClick={source.retry}><RotateCcw />重新加载</Button>
          </> : <>
            <LoaderCircle className="size-6 animate-spin text-brand" />
            <p className="text-sm font-medium">正在加载原图</p>
            {loadingHint ? <p className="text-xs text-muted-foreground">{loadingHint}</p> : null}
          </>}
        </div>
      )}
    </div>
  );
}
