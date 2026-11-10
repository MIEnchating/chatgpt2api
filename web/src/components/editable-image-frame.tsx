import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import type { ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
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
    <Card className={cn("relative flex items-center justify-center overflow-hidden p-0 gap-0", className)} aria-busy={!source.url && !source.error}>
      {source.url ? children : (
        source.error ? <EmptyState compact role="alert" className="absolute inset-0 min-h-0 px-5" icon={CircleAlert} title="原图加载失败" description={source.error} action={<Button type="button" variant="outline" onClick={source.retry}><RotateCcw />重新加载</Button>} />
          : <LoadingState className="absolute inset-0 min-h-0 px-5" label="正在加载原图" description={loadingHint} />
      )}
    </Card>
  );
}
