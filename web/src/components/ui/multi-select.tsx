"use client";

import { Check, ChevronDown, X } from "lucide-react";
import * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type MultiSelectOption = {
  value: string;
  label: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
};

export function MultiSelect({
  className,
  collapseTags = true,
  collapseTagsTooltip = true,
  disabled = false,
  emptyText = "暂无可用选项",
  onValueChange,
  options,
  placeholder = "请选择",
  value,
}: {
  className?: string;
  collapseTags?: boolean;
  collapseTagsTooltip?: boolean;
  disabled?: boolean;
  emptyText?: string;
  onValueChange: (value: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  value: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [visibleTagCount, setVisibleTagCount] = React.useState(value.length);
  const tagsViewportRef = React.useRef<HTMLDivElement>(null);
  const measuredTagRefs = React.useRef(new Map<string, HTMLSpanElement>());
  const measuredCollapseRefs = React.useRef(new Map<number, HTMLSpanElement>());
  const optionMap = React.useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const selected = React.useMemo(
    () => value.filter((item, index) => optionMap.has(item) && value.indexOf(item) === index),
    [optionMap, value],
  );
  const visibleSelected = collapseTags ? selected.slice(0, visibleTagCount) : selected;
  const collapsedSelected = collapseTags ? selected.slice(visibleTagCount) : [];

  const measureVisibleTags = React.useCallback(() => {
    if (!collapseTags) {
      setVisibleTagCount(selected.length);
      return;
    }
    const viewport = tagsViewportRef.current;
    if (!viewport || selected.length === 0) {
      setVisibleTagCount(0);
      return;
    }
    const availableWidth = viewport.clientWidth;
    if (availableWidth <= 0) return;
    const gap = Number.parseFloat(window.getComputedStyle(viewport).columnGap) || 6;
    let occupiedWidth = 0;
    let nextVisibleCount = 0;

    for (let index = 0; index < selected.length; index += 1) {
      const tagWidth = measuredTagRefs.current.get(selected[index])?.getBoundingClientRect().width || 0;
      if (tagWidth <= 0) return;
      const candidateWidth = occupiedWidth + (index > 0 ? gap : 0) + tagWidth;
      const remaining = selected.length - index - 1;
      if (remaining === 0) {
        if (candidateWidth <= availableWidth) nextVisibleCount = index + 1;
        break;
      }
      const collapseWidth = measuredCollapseRefs.current.get(remaining)?.getBoundingClientRect().width || 0;
      if (collapseWidth <= 0) return;
      if (candidateWidth + gap + collapseWidth > availableWidth) break;
      occupiedWidth = candidateWidth;
      nextVisibleCount = index + 1;
    }

    setVisibleTagCount(nextVisibleCount);
  }, [collapseTags, selected]);

  React.useLayoutEffect(() => {
    measureVisibleTags();
    const viewport = tagsViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureVisibleTags);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [measureVisibleTags]);

  const remove = (item: string) => onValueChange(selected.filter((valueItem) => valueItem !== item));
  const toggle = (item: string) => onValueChange(selected.includes(item) ? selected.filter((valueItem) => valueItem !== item) : [...selected, item]);
  const collapsedTag = collapsedSelected.length > 0 ? (
    <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/70 bg-muted/55 px-1.5 text-[11px] font-medium text-muted-foreground">
      +{collapsedSelected.length}
    </span>
  ) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="combobox"
          tabIndex={disabled ? -1 : 0}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-disabled={disabled}
          className={cn(
            "flex min-h-9 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1 text-sm shadow-[0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-[border-color,box-shadow,background-color] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
            disabled && "cursor-not-allowed bg-muted/50 opacity-60",
            className,
          )}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <div ref={tagsViewportRef} className={cn("relative flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden", !collapseTags && "flex-wrap overflow-visible")}>
            {visibleSelected.map((item) => {
              const option = optionMap.get(item);
              if (!option) return null;
              return (
                <span key={item} className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border border-border/70 bg-muted/55 pl-2 pr-1 text-[11px] font-medium text-foreground">
                  <span className="truncate">{option.label}</span>
                  <button
                    type="button"
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`移除 ${option.label}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      remove(item);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            {collapsedTag ? collapseTagsTooltip ? (
              <TooltipHint
                content={<div className="grid max-w-64 gap-1">{selected.map((item) => <span key={item} className="truncate">{optionMap.get(item)?.label || item}</span>)}</div>}
              >
                {collapsedTag}
              </TooltipHint>
            ) : collapsedTag : null}
            {selected.length === 0 ? <span className="truncate px-1 text-muted-foreground">{options.length > 0 ? placeholder : emptyText}</span> : null}
            {collapseTags ? (
              <div className="pointer-events-none absolute left-0 top-0 invisible flex items-center gap-1.5" aria-hidden="true">
                {selected.map((item) => {
                  const option = optionMap.get(item);
                  if (!option) return null;
                  return (
                    <span
                      key={item}
                      ref={(node) => {
                        if (node) measuredTagRefs.current.set(item, node);
                        else measuredTagRefs.current.delete(item);
                      }}
                      className="inline-flex h-6 w-max items-center gap-1 rounded-md border border-border/70 bg-muted/55 pl-2 pr-1 text-[11px] font-medium"
                    >
                      <span>{option.label}</span>
                      <span className="inline-flex size-4 items-center justify-center"><X className="size-3" /></span>
                    </span>
                  );
                })}
                {selected.map((_, index) => {
                  const remaining = index + 1;
                  return (
                    <span
                      key={remaining}
                      ref={(node) => {
                        if (node) measuredCollapseRefs.current.set(remaining, node);
                        else measuredCollapseRefs.current.delete(remaining);
                      }}
                      className="inline-flex h-6 w-max items-center rounded-md border border-border/70 bg-muted/55 px-1.5 text-[11px] font-medium"
                    >
                      +{remaining}
                    </span>
                  );
                })}
              </div>
            ) : null}
          </div>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </div>
      </PopoverTrigger>
      <PopoverContent scrollable={false} align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[min(90vw,18rem)] p-1.5">
        <ScrollArea
          maxHeight="min(20rem, calc(var(--radix-popover-content-available-height) - 0.75rem))"
          viewportClassName="pr-2"
        >
          <div role="listbox" aria-multiselectable="true" className="space-y-0.5">
            {options.map((option) => {
              const checked = selected.includes(option.value);
              return (
                <div key={option.value} className="flex items-center gap-1 rounded-md hover:bg-muted">
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm"
                    onClick={() => toggle(option.value)}
                  >
                    <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border border-border", checked && "border-primary bg-primary text-primary-foreground")}>
                      {checked ? <Check className="size-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.meta}
                  </button>
                  {option.action}
                </div>
              );
            })}
            {options.length === 0 ? <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{emptyText}</p> : null}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
