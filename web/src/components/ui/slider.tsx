import * as React from "react";

import { cn } from "@/lib/utils";

function Slider({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="range"
      data-slot="slider"
      className={cn(
        "h-7 w-full cursor-pointer appearance-none rounded-lg bg-transparent accent-brand outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60",
        "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted-foreground/20 [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:shadow-sm",
        "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted-foreground/20 [&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-brand [&::-moz-range-thumb]:size-4.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-brand [&::-moz-range-thumb]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Slider };
