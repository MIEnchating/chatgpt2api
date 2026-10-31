export type StatusTone = "info" | "success" | "warning" | "danger";

type StatusToneClasses = {
  chip: string;
  soft: string;
  panel: string;
  text: string;
  dot: string;
  bar: string;
  trigger: string;
};

// Shared light/dark status palette for chips, panels, text, dots, progress bars and trigger buttons.
export const statusToneClasses: Record<StatusTone, StatusToneClasses> = {
  info: {
    chip: "bg-sky-50 text-brand ring-sky-100 dark:bg-sky-950/30 dark:text-sky-300 dark:ring-sky-800",
    soft: "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300",
    panel: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300",
    text: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
    bar: "bg-brand",
    trigger: "border-sky-200 bg-sky-50 text-brand hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300 dark:hover:bg-sky-950/35",
  },
  success: {
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-800",
    soft: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
    panel: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300",
    text: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
    trigger: "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/35",
  },
  warning: {
    chip: "bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-800",
    soft: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
    panel: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
    trigger: "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/35",
  },
  danger: {
    chip: "bg-rose-50 text-rose-700 ring-rose-100 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-800",
    soft: "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300",
    panel: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300",
    text: "text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
    bar: "bg-rose-500",
    trigger: "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/35",
  },
};
