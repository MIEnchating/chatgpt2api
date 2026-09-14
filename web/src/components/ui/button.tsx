import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs not-disabled:hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs not-disabled:hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border border-border bg-background text-foreground shadow-xs not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-none not-disabled:hover:bg-secondary/80",
        ghost:
          "text-muted-foreground not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-lg px-3 has-[>svg]:px-2.5",
        lg: "h-11 rounded-lg px-6 has-[>svg]:px-4",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  title,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  const button = (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      aria-label={props["aria-label"] || title}
      {...props}
    />
  );

  return title ? <TooltipHint content={title}>{button}</TooltipHint> : button;
}

export { Button };
