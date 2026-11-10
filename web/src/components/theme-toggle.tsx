import { TooltipHint } from "@/components/ui/tooltip";
import { MoonStar, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  applyColorTheme,
  saveColorTheme,
} from "@/lib/theme";
import { useColorTheme } from "@/lib/use-color-theme";
import { cn } from "@/lib/utils";

export function ThemeToggle({
  className,
  variant = "ghost",
}: {
  className?: string;
  variant?: "ghost" | "outline";
}) {
  const theme = useColorTheme();

  return (
    <TooltipHint content={theme === "dark" ? "浅色模式" : "深色模式"}><Button
      type="button"
      variant={variant}
      size="icon"
      className={cn("relative shrink-0", className)}
      aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
      onClick={(event) => {
        const nextTheme = theme === "dark" ? "light" : "dark";
        const rect = event.currentTarget.getBoundingClientRect();
        applyColorTheme(nextTheme, {
          force: true,
          origin: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        });
        saveColorTheme(nextTheme);
      }}
    >
      <span className="relative flex size-5 shrink-0 items-center justify-center"><Sun className="size-5 scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90" />
      <MoonStar className="absolute size-5 scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0" />
      </span>
    </Button></TooltipHint>
  );
}
