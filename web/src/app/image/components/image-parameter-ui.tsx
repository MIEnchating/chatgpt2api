import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { parseImageRatio } from "@/app/image/image-options";
import { cn } from "@/lib/utils";

export function ImageParameterLabel({ children, help }: { children: ReactNode; help?: string }) {
  return (
    <div className="flex min-h-5 items-center gap-1 text-xs font-semibold text-[#3f4147] dark:text-foreground">
      <span>{children}</span>
      {help ? (
        <button
          type="button"
          className="inline-flex size-4 items-center justify-center rounded-full text-[#92959c] transition hover:bg-black/[0.05] hover:text-[#45515e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground"
          title={help}
          aria-label={`${String(children)}说明：${help}`}
        >
          <CircleHelp className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function ImageAspectRatioGlyph({ ratio }: { ratio: string }) {
  const parsed = parseImageRatio(ratio) || { width: 1, height: 1 };
  const landscape = parsed.width >= parsed.height;
  return (
    <span
      className={cn(
        "block rounded-[2px] border-2 border-current",
        landscape ? "h-3.5 max-w-7" : "w-3.5 max-h-7",
      )}
      style={{ aspectRatio: `${parsed.width} / ${parsed.height}` }}
      aria-hidden="true"
    />
  );
}
