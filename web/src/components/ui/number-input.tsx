import * as React from "react";
import { Minus, Plus } from "lucide-react";

import { TooltipButton } from "@/components/ui/tooltip";
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
      disabled ||
        (currentValue !== null && minimum !== null && currentValue <= minimum),
    );
    const incrementDisabled = Boolean(
      disabled ||
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
      if (!input) {
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
        type="button"
        aria-label="减少数值"
        tooltip="减少"
        disabled={decrementDisabled}
        onClick={() => changeByStep(-1)}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-30",
          controlsLayout === "split" && "ml-1",
        )}
      >
        <Minus className="size-3.5" />
      </TooltipButton>
    );

    const incrementButton = (
      <TooltipButton
        type="button"
        aria-label="增加数值"
        tooltip="增加"
        disabled={incrementDisabled}
        onClick={() => changeByStep(1)}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-30",
          controlsLayout === "split" && "mr-1",
        )}
      >
        <Plus className="size-3.5" />
      </TooltipButton>
    );

    return (
      <div
        className={cn(
          "flex h-10 w-full min-w-0 items-center rounded-lg border border-input bg-background shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow,background-color] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20",
          disabled && "cursor-not-allowed bg-muted/50 opacity-60",
          className,
        )}
      >
        {controlsLayout === "split" ? decrementButton : null}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center",
            controlsLayout === "split" && "justify-center gap-1",
          )}
        >
          <input
            {...props}
            ref={setInputRef}
            type="number"
            data-slot="number-input"
            disabled={disabled}
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            className={cn(
              "h-full min-w-0 appearance-none bg-transparent py-2 text-sm tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
              controlsLayout === "split" ? "flex-none px-0 text-right" : "flex-1 px-3",
              inputClassName,
            )}
            style={controlsLayout === "split" ? { ...props.style, width: `${splitInputWidth + 0.5}ch` } : props.style}
          />
          {suffix ? (
            <span
              className={cn(
                "shrink-0 text-xs font-medium text-muted-foreground",
                controlsLayout === "split" ? "px-0" : "px-2",
              )}
            >
              {suffix}
            </span>
          ) : null}
        </div>
        {controlsLayout === "split" ? incrementButton : (
          <div className="mr-1 flex h-8 shrink-0 items-center rounded-md bg-muted/55 p-0.5">
            {decrementButton}
            {incrementButton}
          </div>
        )}
      </div>
    );
  },
);

NumberInput.displayName = "NumberInput";

export { NumberInput };
