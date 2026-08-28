import * as React from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type FileUploadButtonProps = React.ComponentProps<"button"> & {
  icon: LucideIcon;
  loading?: boolean;
};

function FileUploadButton({
  children,
  className,
  disabled,
  icon: Icon,
  loading = false,
  ...props
}: FileUploadButtonProps) {
  return (
    <button
      type="button"
      data-slot="file-upload-button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "group flex h-11 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-border/80 bg-muted/25 px-2.5 text-left text-xs font-medium text-foreground transition-[border-color,background-color,color,box-shadow] hover:border-primary/45 hover:bg-primary/[0.045] hover:text-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:border-border/80 disabled:bg-muted/15 disabled:text-muted-foreground disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-sm ring-1 ring-border/70 transition-colors group-hover:text-primary group-disabled:text-muted-foreground">
        {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export { FileUploadButton };
