"use client";

import { ScrollArea } from "@/components/ui/scroll-area";

import { ButtonGroup } from "@/components/ui/button-group";

import { useEffect, useState } from "react";
import { format, parse, subDays } from "date-fns";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type DateRangeFilterProps = {
  startDate: string;
  endDate: string;
  onChange: (startDate: string, endDate: string) => void;
  className?: string;
};

export function DateRangeFilter({ startDate, endDate, onChange, className }: DateRangeFilterProps) {
  const [numberOfMonths, setNumberOfMonths] = useState(1);
  const [open, setOpen] = useState(false);
  const selected: DateRange | undefined = startDate
    ? {
        from: parse(startDate, "yyyy-MM-dd", new Date()),
        to: endDate ? parse(endDate, "yyyy-MM-dd", new Date()) : undefined,
      }
    : undefined;

  const label = startDate ? `${startDate} 至 ${endDate || startDate}` : "选择日期范围";

  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const updateNumberOfMonths = () => setNumberOfMonths(query.matches ? 2 : 1);

    updateNumberOfMonths();
    query.addEventListener("change", updateNumberOfMonths);
    return () => query.removeEventListener("change", updateNumberOfMonths);
  }, []);

  return (
    <Field className={cn("min-w-0 w-full sm:w-[240px]", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-full min-w-0 justify-start"
          >
            <CalendarIcon className="shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[min(calc(100vw-1.5rem),20.5rem)] sm:w-auto"
          align="center"
          collisionPadding={12}
          sideOffset={8}
        ><ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          <ButtonGroup className="mb-3 grid w-full grid-cols-3" aria-label="快捷日期范围">
            {[{ label: "今天", days: 0 }, { label: "近 7 天", days: 6 }, { label: "近 30 天", days: 29 }].map(({ label: presetLabel, days }) => <Button key={days} type="button" variant="ghost" size="sm"  onClick={() => { const today = new Date(); onChange(format(subDays(today, days), "yyyy-MM-dd"), format(today, "yyyy-MM-dd")); setOpen(false); }}>{presetLabel}</Button>)}
          </ButtonGroup>
          <Calendar
            mode="range"
            defaultMonth={selected?.from}
            selected={selected}
            onSelect={(value) => onChange(value?.from ? format(value.from, "yyyy-MM-dd") : "", value?.to ? format(value.to, "yyyy-MM-dd") : "")}
            numberOfMonths={numberOfMonths}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" disabled={!startDate && !endDate} onClick={() => { onChange("", ""); setOpen(false); }}>清除日期</Button>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>完成</Button>
          </div>
        </ScrollArea></PopoverContent>
      </Popover>
    </Field>
  );
}
