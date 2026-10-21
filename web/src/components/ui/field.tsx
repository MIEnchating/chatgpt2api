import * as React from "react";

import { cn } from "@/lib/utils";

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field" className={cn("grid min-w-0 content-start gap-2", className)} {...props} />;
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      className={cn("min-w-0 text-sm leading-5 font-medium text-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("min-w-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

export { Field, FieldDescription, FieldLabel };
