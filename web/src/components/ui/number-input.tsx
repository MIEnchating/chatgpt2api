import * as React from "react";
import { Minus, Plus } from "lucide-react";

import { TooltipButton } from "@/components/ui/tooltip";
import { InputGroup, InputGroupInput } from "./input-group";
import { cn } from "@/lib/utils";

type NumberInputProps = Omit<
  React.ComponentProps<"input">,
  "className" | "onChange" | "type" | "value"
> & {
  className?: string;
  controlsLayout?: "trailing" | "split";
  inputClassName?: string;
  onValueChange: (value: string) => void;
  suffix?: React.ReactNode;
  value: number | string;
};

function numericBound(value: number | string | undefined) {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      className,
      controlsLayout = "trailing",
      disabled,
      inputClassName,
      max,
      min,
      onValueChange,
      readOnly,
      step = 1,
      suffix,
      value,
      ...props
    },
    forwardedRef,
  ) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const currentValue = numericBound(value);
    const minimum = numericBound(min);
    const maximum = numericBound(max);
    const splitInputWidth = Math.min(
      12,
      Math.max(String(value).length, String(min ?? "").length, String(max ?? "").length, 1),
    );
    const decrementDisabled = Boolean(
      disabled || readOnly ||
        (currentValue !== null && minimum !== null && currentValue <= minimum),
    );
    const incrementDisabled = Boolean(
      disabled || readOnly ||
        (currentValue !== null && maximum !== null && currentValue >= maximum),
    );

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

    const changeByStep = (direction: -1 | 1) => {
      const input = inputRef.current;
      if (!input || disabled || readOnly) {
        return;
      }
      input.focus();
      if (direction < 0) {
        input.stepDown();
      } else {
        input.stepUp();
      }
      onValueChange(input.value);
    };

    const decrementButton = (
      <TooltipButton
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="减少数值"
        tooltip="减少"
        disabled={decrementDisabled}
        onClick={() => changeByStep(-1)}
        className={cn("flex max-h-full shrink-0 items-center justify-center focus-visible:z-10 disabled:cursor-not-allowed", controlsLayout === "split" && "ml-1")}
      >
        <Minus  />
      </TooltipButton>
    );

    const incrementButton = (
      <TooltipButton
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="增加数值"
        tooltip="增加"
        disabled={incrementDisabled}
        onClick={() => changeByStep(1)}
        className={cn("flex max-h-full shrink-0 items-center justify-center focus-visible:z-10 disabled:cursor-not-allowed", controlsLayout === "split" && "mr-1")}
      >
        <Plus  />
      </TooltipButton>
    );

    return (
      <InputGroup
        className={cn("flex w-full min-w-0 items-center", className)}
      >
        {controlsLayout === "split" ? decrementButton : null}
        <div
          className={cn("flex h-full min-w-0 flex-1 items-center", controlsLayout === "split" && "justify-center gap-1")}
        >
          <InputGroupInput
            {...props}
            ref={setInputRef}
            type="number"
            data-number-input=""
            disabled={disabled}
            readOnly={readOnly}
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            className={cn("h-full min-w-0 max-w-full appearance-none tabular-nums disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none", controlsLayout === "split" ? "flex-none px-0 text-right" : "flex-1", inputClassName)}
            style={controlsLayout === "split" ? { ...props.style, width: `${splitInputWidth + 0.5}ch` } : props.style}
          />
          {suffix ? (
            <span
              className={cn("min-w-0 max-w-24 truncate text-xs font-medium text-muted-foreground", controlsLayout === "split" ? "px-0" : "px-2")}
            >
              {suffix}
            </span>
          ) : null}
        </div>
        {controlsLayout === "split" ? incrementButton : (
          <div className="mr-0.5 flex h-8 max-h-full shrink-0 items-center gap-0.5">
            {decrementButton}
            {incrementButton}
          </div>
        )}
      </InputGroup>
    );
  },
);

NumberInput.displayName = "NumberInput";

export { NumberInput };
