import { ItemMedia } from "@/components/ui/item";
import { Toggle } from "@/components/ui/toggle";

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

function AspectRatioGlyph({ ratio }: { ratio?: string }) {
  const parsed = parseAspectRatio(ratio);
  if (!parsed) {
    return (
      <ItemMedia variant="icon" className="flex size-5 items-center justify-center" aria-hidden="true">
        <SlidersHorizontal className="size-3" />
      </ItemMedia>
    );
  }
  const landscape = parsed.width >= parsed.height;
  const square = parsed.width === parsed.height;
  const longEdge = square ? 15 : 18;
  const minimumEdge = 8;
  const width = landscape ? longEdge : Math.max(minimumEdge, longEdge * (parsed.width / parsed.height));
  const height = landscape ? Math.max(minimumEdge, longEdge * (parsed.height / parsed.width)) : longEdge;
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
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
  "aria-label": ariaLabel,
  layout = "compact",
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label?: string;
  ratio?: string;
  description?: string;
  "aria-label"?: string;
  layout?: "compact" | "inline";
  onClick: () => void;
}) {
  const displayLabel = label || aspectRatioDisplayName(ratio);
  const displayDescription = description || (ratio ? ratio : "自动匹配");
  return (
    <Toggle variant="outline"
      type="button"
      disabled={disabled}
      pressed={active}
      aria-label={ariaLabel}
      className={cn(
        "group flex min-w-0 items-center justify-center text-center disabled:cursor-not-allowed disabled:opacity-50",
        layout === "inline" ? "h-8 gap-1 px-1" : "min-h-16 flex-col",
      )}
      onClick={onClick}
    >
      {layout === "inline" ? (
        <>
          <span className="@max-[20rem]:hidden"><AspectRatioGlyph ratio={ratio} /></span>
          <span className="truncate font-mono text-xs">{displayLabel}</span>
        </>
      ) : (
        <>
          <span className="flex min-w-0 max-w-full items-center justify-center gap-1">
            <AspectRatioGlyph ratio={ratio} />
            <span className="truncate text-xs font-semibold leading-none">{displayLabel}</span>
          </span>
          <span className="max-w-full truncate font-mono text-[11px] font-medium leading-none text-muted-foreground/80 group-aria-pressed:text-current">
            {displayDescription}
          </span>
        </>
      )}
    </Toggle>
  );
}
