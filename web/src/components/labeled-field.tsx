import { useId, type ComponentProps, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { TooltipHint } from "@/components/ui/tooltip";

export function LabeledField({ label, hint, meta, description, children, ...props }: Omit<ComponentProps<typeof Field>, "orientation" | "children"> & {
  label: ReactNode;
  hint?: string;
  meta?: ReactNode;
  description?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <Field {...props}>
      <div className="flex min-h-6 items-center gap-1.5">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint ? <TooltipHint content={hint}>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`${typeof label === "string" ? label : "字段"}说明`}>
            <CircleHelp aria-hidden="true" />
          </Button>
        </TooltipHint> : null}
        {meta != null ? <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span> : null}
      </div>
      {children(id)}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
