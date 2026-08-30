import { SlidersHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";

const ASPECT_RATIO_NAMES: Record<string, string> = {
  "1:1": "方形",
  "16:9": "横屏",
  "9:16": "竖屏",
  "4:3": "标准横屏",
  "3:4": "标准竖屏",
  "3:2": "横幅",
  "2:3": "竖幅",
  "21:9": "宽银幕",
};

function aspectRatioDisplayName(ratio?: string) {
  const value = String(ratio || "").trim().toLowerCase();
  if (!value || value === "auto" || value === "adaptive") return "自动";
  return ASPECT_RATIO_NAMES[value] || value;
}

function parseAspectRatio(ratio?: string) {
  const match = String(ratio || "").trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function AspectRatioGlyph({ ratio, large = false }: { ratio?: string; large?: boolean }) {
  const parsed = parseAspectRatio(ratio);
  if (!parsed) {
    return (
      <span className="flex size-5 items-center justify-center rounded bg-muted/70" aria-hidden="true">
        <SlidersHorizontal className="size-3" />
      </span>
    );
  }
  const landscape = parsed.width >= parsed.height;
  const square = parsed.width === parsed.height;
  const longEdge = large ? 24 : square ? 15 : 18;
  const minimumEdge = large ? 10 : 8;
  const width = landscape ? longEdge : Math.max(minimumEdge, longEdge * (parsed.width / parsed.height));
  const height = landscape ? Math.max(minimumEdge, longEdge * (parsed.height / parsed.width)) : longEdge;
  return (
    <span className={cn("flex shrink-0 items-center justify-center", large ? "size-7" : "size-5")} aria-hidden="true">
      <span className="block rounded-[2px] border-[1.5px] border-current" style={{ width, height }} />
    </span>
  );
}

export function AspectRatioOptionButton({
  active,
  disabled = false,
  label,
  ratio,
  description,
  layout = "compact",
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label?: string;
  ratio?: string;
  description?: string;
  layout?: "compact" | "visual";
  onClick: () => void;
}) {
  const displayLabel = label || aspectRatioDisplayName(ratio);
  const displayDescription = description || (ratio ? ratio : "自动匹配");
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "group flex min-w-0 flex-col items-center justify-center rounded-lg border border-border/70 bg-background/65 px-1.5 text-center text-muted-foreground shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,background-color,color,box-shadow] hover:border-foreground/20 hover:bg-muted/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-background/35 dark:hover:border-border dark:hover:bg-muted/35",
        layout === "visual" ? "h-[72px] gap-1.5" : "h-14 gap-1",
        active && "border-primary/55 bg-primary/[0.07] text-primary shadow-[inset_0_0_0_1px_rgba(20,86,240,0.06)] hover:border-primary/65 hover:bg-primary/[0.09] hover:text-primary dark:border-sky-700 dark:bg-sky-950/30 dark:text-sky-300 dark:hover:border-sky-600 dark:hover:bg-sky-950/40 dark:hover:text-sky-200",
      )}
      onClick={onClick}
    >
      {layout === "visual" ? (
        <>
          {ratio ? <AspectRatioGlyph ratio={ratio} large /> : null}
          <span className="max-w-full truncate font-mono text-[11px] font-semibold leading-none text-current">{displayLabel}</span>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center justify-center gap-1">
            <AspectRatioGlyph ratio={ratio} />
            <span className="truncate text-[10px] font-semibold leading-none">{displayLabel}</span>
          </span>
          <span className="max-w-full truncate font-mono text-[9px] font-medium leading-none text-muted-foreground/80 group-aria-pressed:text-current">
            {displayDescription}
          </span>
        </>
      )}
    </button>
  );
}
