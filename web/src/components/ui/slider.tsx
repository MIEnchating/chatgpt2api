import * as React from "react";

import { cn } from "@/lib/utils";

function Slider({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="range"
      data-slot="slider"
      className={cn(
        "h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[#1456f0] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
        "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-[#1456f0] [&::-webkit-slider-thumb]:shadow-sm",
        "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-[#1456f0] [&::-moz-range-thumb]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Slider };
