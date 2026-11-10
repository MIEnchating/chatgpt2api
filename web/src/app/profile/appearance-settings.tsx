import { MoonStar, Sun } from "lucide-react";
import { SettingsPanel, SettingsSection } from "@/components/settings-panel";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { applyColorTheme, saveColorTheme, type ColorTheme } from "@/lib/theme";
import { useColorTheme } from "@/lib/use-color-theme";

function ThemePreview({ theme }: { theme: ColorTheme }) {
  const dark = theme === "dark";
  return (
    <span className="block h-16 w-24 sm:h-20 sm:w-30" aria-hidden="true">
      <svg viewBox="0 0 120 80" className="size-full">
        <rect x="1" y="1" width="118" height="78" rx="7" fill={dark ? "#171717" : "#fafafa"} stroke={dark ? "#404040" : "#d4d4d4"} />
        <path d="M9 9h22v62H9z" fill={dark ? "#262626" : "#ededed"} />
        <circle cx="16" cy="17" r="3" fill={dark ? "#737373" : "#a3a3a3"} />
        <path d="M14 29h12m-12 7h10m-10 7h12" stroke={dark ? "#737373" : "#a3a3a3"} strokeWidth="2" strokeLinecap="round" />
        <rect x="58" y="16" width="48" height="11" rx="4" fill={dark ? "#404040" : "#e5e5e5"} />
        <path d="M42 36h50m-50 6h59m-59 6h39" stroke={dark ? "#737373" : "#a3a3a3"} strokeWidth="2" strokeLinecap="round" />
        <rect x="41" y="59" width="66" height="10" rx="5" fill={dark ? "#262626" : "#ededed"} />
      </svg>
    </span>
  );
}

export function AppearanceSettings() {
  const theme = useColorTheme();
  return (
    <SettingsPanel title="外观">
      <SettingsSection title="视觉风格" contentClassName="flex flex-wrap items-center justify-between gap-6">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">界面模式</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">选择你习惯的明暗风格。</p>
            </div>
            <ToggleGroup className="grid max-w-full grid-cols-2" type="single" variant="outline" value={theme} aria-label="界面主题" onValueChange={(value) => {
              if (value !== "light" && value !== "dark") return;
              applyColorTheme(value);
              saveColorTheme(value);
            }}>
              <ToggleGroupItem className="h-auto min-w-0 flex-col gap-2 p-2" value="light" aria-label="浅色模式">
                <ThemePreview theme="light" /><span className="flex items-center gap-1.5 text-xs"><Sun />浅色</span>
              </ToggleGroupItem>
              <ToggleGroupItem className="h-auto min-w-0 flex-col gap-2 p-2" value="dark" aria-label="深色模式">
                <ThemePreview theme="dark" /><span className="flex items-center gap-1.5 text-xs"><MoonStar />深色</span>
              </ToggleGroupItem>
            </ToggleGroup>
      </SettingsSection>
    </SettingsPanel>
  );
}
