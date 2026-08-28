import { cva } from "class-variance-authority";

export const tagVariants = cva(
  "inline-flex h-7 max-w-full items-center justify-center rounded-[7px] border px-2.5 text-[11px] leading-4 font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow]",
  {
    variants: {
      selected: {
        true: "border-[#9ab7f7] bg-[#edf4ff] text-[#1456f0] shadow-[inset_0_0_0_1px_rgba(20,86,240,0.04)] dark:border-sky-700/80 dark:bg-sky-950/45 dark:text-sky-300",
        false: "border-transparent bg-muted/55 text-foreground/68 hover:border-border/70 hover:bg-muted hover:text-foreground dark:bg-white/6 dark:text-white/62 dark:hover:border-white/12 dark:hover:bg-white/10 dark:hover:text-white/88",
      },
    },
    defaultVariants: {
      selected: false,
    },
  },
);
