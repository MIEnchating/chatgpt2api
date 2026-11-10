"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Badge } from "./badge";
import { Button } from "./button";
import { InputGroup, InputGroupInput } from "./input-group";
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
      // Safari fires compositionend before the confirming keydown, so also check the native flags.
      if (event.defaultPrevented || composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;

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
      <InputGroup
        data-slot="input-tag"
        data-disabled={disabled || undefined}
        data-readonly={readOnly || undefined}
        data-limit-reached={limitReached || undefined}
        className={cn("h-auto min-h-8 w-full min-w-0 flex-wrap items-center gap-1.5 p-1", className)}
        onClick={() => {
          if (!disabled && !readOnly && !limitReached) inputRef.current?.focus();
        }}
      >
        {value.map((tag, index) => (
          <Badge variant="secondary"
            key={`${tag}-${index}`}
            data-slot="input-tag-item"
            className={cn("min-w-0 max-w-full", tagClassName)}
          >
            <span className="min-w-0 max-w-full truncate" title={tag}>{tag}</span>
            {!disabled && !readOnly ? (
              <Button variant="ghost" size="icon-xs"
                type="button"
                data-slot="input-tag-remove"
                className="flex shrink-0 cursor-pointer items-center justify-center"
                aria-label={`删除标签 ${tag}`}
                onClick={(event) => {
                  event.stopPropagation();
                  removeTag(index);
                }}
              >
                <X  />
              </Button>
            ) : null}
          </Badge>
        ))}
        {!readOnly ? (
          <InputGroupInput
            {...props}
            ref={setInputRef}
            data-slot="input-tag-input"
            disabled={disabled || limitReached}
            value={inputValue}
            placeholder={value.length === 0 ? placeholder : undefined}
            className={cn("max-w-full flex-1 disabled:cursor-not-allowed", value.length === 0 ? "min-w-32" : "min-w-10", inputClassName)}
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
      </InputGroup>
    );
  },
);

InputTag.displayName = "InputTag";

export { InputTag };
export type { InputTagProps, InputTagRejectReason };
