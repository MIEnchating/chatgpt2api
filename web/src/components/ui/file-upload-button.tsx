import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Spinner } from "./spinner";

import { Button } from "./button";
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
    <Button variant="outline"
      type="button"
      data-slot="file-upload-button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn("min-h-8 w-full min-w-0 justify-start whitespace-normal text-left", className)}
      {...props}
    >
      {loading ? <Spinner /> : <Icon />}
      <span className="min-w-0 flex-1 break-words leading-5">{children}</span>
    </Button>
  );
}

export { FileUploadButton };
