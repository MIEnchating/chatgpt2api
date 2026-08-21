import { CircleHelp, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { parseImageRatio } from "@/app/image/image-options";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ImageParameterLabel({ children, help }: { children: ReactNode; help?: string }) {
  return (
    <div className="flex min-h-5 items-center gap-1 text-xs font-semibold text-[#3f4147] dark:text-foreground">
      <span>{children}</span>
      {help ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-4 items-center justify-center rounded-full text-[#92959c] transition hover:bg-black/[0.05] hover:text-[#45515e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground"
              aria-label={`${String(children)}说明`}
            >
              <CircleHelp className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{help}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function ImageAspectRatioGlyph({ ratio }: { ratio: string }) {
  const parsed = parseImageRatio(ratio) || { width: 1, height: 1 };
  const landscape = parsed.width >= parsed.height;
  const square = parsed.width === parsed.height;
  const longEdge = square ? 16 : 20;
  const width = landscape ? longEdge : Math.max(8, longEdge * (parsed.width / parsed.height));
  const height = landscape ? Math.max(8, longEdge * (parsed.height / parsed.width)) : longEdge;
  return (
    <span className="flex h-5 w-6 shrink-0 items-center justify-center" aria-hidden="true">
      <span
        className="block rounded-[2px] border-[1.5px] border-current"
        style={{ width, height }}
      />
    </span>
  );
}

export function ImageAspectRatioOptionButton({
  active,
  label,
  ratio,
  onClick,
}: {
  active: boolean;
  label: string;
  ratio?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border border-transparent bg-[#f4f4f5] px-1.5 text-[10px] font-medium text-[#686b73] transition-colors hover:bg-[#eceef1] hover:text-[#222222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:bg-muted/55 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground",
        active &&
          "border-[#a9c1ff] bg-[#edf3ff] text-[#1456f0] shadow-[inset_0_0_0_1px_rgba(20,86,240,0.04)] hover:bg-[#edf3ff] hover:text-[#1456f0] dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-300 dark:hover:bg-sky-950/45 dark:hover:text-sky-200",
      )}
      onClick={onClick}
    >
      {ratio ? <ImageAspectRatioGlyph ratio={ratio} /> : (
        <span className="flex h-5 w-6 shrink-0 items-center justify-center" aria-hidden="true">
          <SlidersHorizontal className="size-3.5" />
        </span>
      )}
      <span className="whitespace-nowrap leading-none">{label}</span>
    </button>
  );
}
