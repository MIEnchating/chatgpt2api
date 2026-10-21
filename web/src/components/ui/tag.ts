import { cva } from "class-variance-authority";

export const tagVariants = cva(
  "inline-flex min-h-8 min-w-0 max-w-full items-center justify-center rounded-lg border px-2.5 py-1 text-xs leading-4 font-medium whitespace-normal [overflow-wrap:anywhere] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 transition-[color,background-color,border-color,box-shadow]",
  {
    variants: {
      selected: {
        true: "border-brand-border bg-brand-soft text-brand",
        false: "border-transparent bg-muted/55 text-muted-foreground enabled:hover:border-border enabled:hover:bg-muted enabled:hover:text-foreground",
      },
    },
    defaultVariants: {
      selected: false,
    },
  },
);
