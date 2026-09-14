import * as React from "react";

import { cn } from "@/lib/utils";

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid min-w-0 gap-2", className)} {...props} />;
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn("text-sm leading-5 font-medium text-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

export { Field, FieldDescription, FieldLabel };
