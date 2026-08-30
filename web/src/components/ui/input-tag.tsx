"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

type InputTagRejectReason = "duplicate" | "invalid" | "limit";

type InputTagProps = Omit<
  React.ComponentProps<"input">,
  "defaultValue" | "onChange" | "value"
> & {
  allowDuplicates?: boolean;
  inputClassName?: string;
  maxTags?: number;
  onInputValueChange?: (value: string) => void;
  onTagRejected?: (tag: string, reason: InputTagRejectReason) => void;
  onValueChange: (value: string[]) => void;
  tagClassName?: string;
  validateTag?: (tag: string) => boolean;
  value: string[];
};

const TAG_SEPARATOR_PATTERN = /[\n,，;；]+/;

function splitTagInput(value: string) {
  return value
    .split(TAG_SEPARATOR_PATTERN)
    .map((item) => item.trim())
    .filter(Boolean);
}

const InputTag = React.forwardRef<HTMLInputElement, InputTagProps>(
  (
    {
      allowDuplicates = false,
      className,
      disabled,
      inputClassName,
      maxTags,
      onBlur,
      onCompositionEnd,
      onCompositionStart,
      onInputValueChange,
      onKeyDown,
      onPaste,
      onTagRejected,
      onValueChange,
      placeholder = "输入内容后按回车添加",
      readOnly,
      tagClassName,
      validateTag,
      value,
      ...props
    },
    forwardedRef,
  ) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const composingRef = React.useRef(false);
    const [inputValue, setInputValue] = React.useState("");
    const limitReached = maxTags !== undefined && value.length >= maxTags;
    const invalid = props["aria-invalid"] !== undefined &&
      props["aria-invalid"] !== false &&
      props["aria-invalid"] !== "false";

    const setInputRef = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof forwardedRef === "function") {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      },
      [forwardedRef],
    );

    const updateInputValue = (nextValue: string) => {
      setInputValue(nextValue);
      onInputValueChange?.(nextValue);
    };

    const addTags = (candidates: string[]) => {
      if (disabled || readOnly) return;

      const next = [...value];
      for (const candidate of candidates) {
        const tag = candidate.trim();
        if (!tag) continue;
        if (validateTag && !validateTag(tag)) {
          onTagRejected?.(tag, "invalid");
          continue;
        }
        if (!allowDuplicates && next.includes(tag)) {
          onTagRejected?.(tag, "duplicate");
          continue;
        }
        if (maxTags !== undefined && next.length >= maxTags) {
          onTagRejected?.(tag, "limit");
          continue;
        }
        next.push(tag);
      }

      if (next.length !== value.length) {
        onValueChange(next);
      }
    };

    const commitInput = () => {
      const tags = splitTagInput(inputValue);
      if (tags.length === 0) return;
      addTags(tags);
      updateInputValue("");
    };

    const removeTag = (index: number) => {
      if (disabled || readOnly) return;
      onValueChange(value.filter((_, itemIndex) => itemIndex !== index));
      inputRef.current?.focus();
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || composingRef.current) return;

      if (event.key === "Enter" || event.key === "," || event.key === "，" || event.key === ";" || event.key === "；") {
        event.preventDefault();
        commitInput();
        return;
      }
      if (event.key === "Backspace" && inputValue.length === 0 && value.length > 0) {
        event.preventDefault();
        removeTag(value.length - 1);
      }
    };

    const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
      onPaste?.(event);
      if (event.defaultPrevented || disabled || readOnly) return;
      const pastedValue = event.clipboardData.getData("text");
      const tags = splitTagInput(pastedValue);
      if (tags.length <= 1 && !TAG_SEPARATOR_PATTERN.test(pastedValue)) return;
      event.preventDefault();
      addTags(tags);
    };

    return (
      <div
        data-slot="input-tag"
        data-disabled={disabled || undefined}
        data-readonly={readOnly || undefined}
        data-limit-reached={limitReached || undefined}
        className={cn(
          "flex min-h-10 w-full min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 text-sm shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow,background-color] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20",
          disabled && "cursor-not-allowed bg-muted/50 opacity-60",
          readOnly && "bg-muted/30",
          invalid && "border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
          className,
        )}
        onClick={() => {
          if (!disabled && !readOnly && !limitReached) inputRef.current?.focus();
        }}
      >
        {value.map((tag, index) => (
          <span
            key={`${tag}-${index}`}
            data-slot="input-tag-item"
            className={cn(
              "inline-flex h-7 max-w-full items-center gap-1 rounded-[7px] border border-border/70 bg-muted/65 pl-2.5 text-xs font-medium text-foreground",
              (disabled || readOnly) && "pr-2.5",
              tagClassName,
            )}
          >
            <span className="max-w-56 truncate" title={tag}>{tag}</span>
            {!disabled && !readOnly ? (
              <button
                type="button"
                data-slot="input-tag-remove"
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                aria-label={`删除标签 ${tag}`}
                onClick={(event) => {
                  event.stopPropagation();
                  removeTag(index);
                }}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </span>
        ))}
        {!readOnly ? (
          <input
            {...props}
            ref={setInputRef}
            data-slot="input-tag-input"
            disabled={disabled || limitReached}
            value={inputValue}
            placeholder={value.length === 0 ? placeholder : undefined}
            className={cn(
              "h-7 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
              value.length === 0 ? "min-w-32" : "min-w-10",
              inputClassName,
            )}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) {
                commitInput();
              }
              onBlur?.(event);
            }}
            onChange={(event) => updateInputValue(event.target.value)}
            onCompositionStart={(event) => {
              composingRef.current = true;
              onCompositionStart?.(event);
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              onCompositionEnd?.(event);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        ) : null}
      </div>
    );
  },
);

InputTag.displayName = "InputTag";

export { InputTag };
export type { InputTagProps, InputTagRejectReason };
