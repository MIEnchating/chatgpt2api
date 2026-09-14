"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";

import { cn } from "@/lib/utils";

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      locale={zhCN}
      showOutsideDays={showOutsideDays}
      className={cn("relative min-w-0 p-1 text-sm", className)}
      classNames={{
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "min-w-0",
        month_caption: "flex h-10 items-center justify-center px-10 font-medium",
        caption_label: "truncate text-sm font-semibold",
        nav: "pointer-events-none absolute inset-x-1 top-1 z-10 flex items-center justify-between",
        button_previous: "pointer-events-auto inline-flex size-8 items-center justify-center rounded-lg border border-input bg-background text-foreground shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60",
        button_next: "pointer-events-auto inline-flex size-8 items-center justify-center rounded-lg border border-input bg-background text-foreground shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60",
        month_grid: "w-full border-separate border-spacing-y-1",
        weekdays: "mt-2 grid grid-cols-7 text-xs text-muted-foreground",
        weekday: "flex h-8 items-center justify-center font-normal",
        week: "grid grid-cols-7",
        day: "h-9 p-0 text-center align-middle text-sm",
        day_button: "mx-auto inline-flex size-8 items-center justify-center rounded-lg text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed",
        today: "[&_button]:font-semibold [&_button]:ring-1 [&_button]:ring-inset [&_button]:ring-brand/40",
        selected: "font-semibold [&_button]:bg-brand [&_button]:text-brand-foreground [&_button]:hover:bg-brand/90",
        range_start: "rdp-range_start rounded-l-lg bg-brand-soft",
        range_middle: "rdp-range_middle bg-brand-soft [&_button]:rounded-none [&_button]:bg-transparent [&_button]:text-brand [&_button]:hover:bg-brand/10",
        range_end: "rdp-range_end rounded-r-lg bg-brand-soft",
        outside: "[&_button]:text-muted-foreground",
        disabled: "opacity-40 [&_button]:cursor-not-allowed [&_button]:text-muted-foreground",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />,
      }}
      {...props}
    />
  );
}

export { Calendar };
