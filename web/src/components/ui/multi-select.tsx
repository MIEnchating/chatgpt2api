"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "./combobox";
import { Badge } from "./badge";
import { InputGroup } from "./input-group";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type MultiSelectOption = {
  value: string;
  label: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
};

export function MultiSelect({
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
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
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
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
  const anchor = React.useRef<HTMLDivElement>(null);
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

  React.useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const remove = (item: string) => {
    if (!disabled) {
      onValueChange(selected.filter((valueItem) => valueItem !== item));
    }
  };
  const collapsedTag = collapsedSelected.length > 0 ? (
    <Badge variant="secondary">
      +{collapsedSelected.length}
    </Badge>
  ) : null;

  return (
    <Combobox
      multiple
      autoHighlight
      disabled={disabled}
      items={options}
      value={selected.map((item) => optionMap.get(item)!)}
      isItemEqualToValue={(option, selectedOption) => option.value === selectedOption.value}
      onValueChange={(nextSelected) => {
        if (!disabled) onValueChange(nextSelected.map((option) => option.value));
      }}
      open={!disabled && open}
      onOpenChange={(nextOpen) => {
        if (!disabled) setOpen(nextOpen);
      }}
    >
      <ComboboxTrigger
        render={<InputGroup ref={anchor} />}
        nativeButton={false}
        id={id}
        data-slot="multi-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={disabled ? -1 : 0}
        disabled={disabled}
        className={cn("h-auto min-h-8 cursor-pointer gap-1.5 p-1", className)}
        onKeyDown={(event) => {
          if (disabled || event.defaultPrevented || event.target !== event.currentTarget) return;
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
              <Badge key={item} variant="secondary" className="min-w-0 max-w-full">
                <span className="truncate">{option.label}</span>
                <Button variant="ghost" size="icon-xs"
                  type="button"
                  disabled={disabled}
                  aria-label={`移除 ${option.label}`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    remove(item);
                  }}
                >
                  <X />
                </Button>
              </Badge>
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
                  <Badge variant="secondary"
                    key={item}
                    ref={(node) => {
                      if (node) measuredTagRefs.current.set(item, node);
                      else measuredTagRefs.current.delete(item);
                    }}
                    className="w-max"
                  >
                    <span>{option.label}</span>
                    <Button variant="ghost" size="icon-xs" tabIndex={-1} disabled={disabled}><X /></Button>
                  </Badge>
                );
              })}
              {selected.map((_, index) => {
                const remaining = index + 1;
                return (
                  <Badge variant="secondary"
                    key={remaining}
                    ref={(node) => {
                      if (node) measuredCollapseRefs.current.set(remaining, node);
                      else measuredCollapseRefs.current.delete(remaining);
                    }}
                    className="w-max"
                  >
                    +{remaining}
                  </Badge>
                );
              })}
            </div>
          ) : null}
        </div>
      </ComboboxTrigger>
      <ComboboxContent anchor={anchor} className="min-w-[min(12rem,calc(100vw-1rem))]">
        <ComboboxInput showTrigger={false} disabled={disabled} placeholder="搜索选项…" aria-label="搜索选项" />
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(option: MultiSelectOption) => (
            <ComboboxItem key={option.value} value={option} disabled={disabled}>
              <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
              {option.meta ? <span className="shrink-0 text-xs text-muted-foreground">{option.meta}</span> : null}
              {option.action ? <span className="flex shrink-0 items-center" onFocus={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}>{option.action}</span> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
