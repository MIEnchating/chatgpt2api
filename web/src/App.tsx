import { createPortal } from "react-dom";
import { Toaster } from "sonner";

import { AppShell } from "@/app/app-shell";
import { TooltipDomBridge, TooltipProvider } from "@/components/ui/tooltip";
import { useColorTheme } from "@/lib/use-color-theme";

export default function App() {
  const theme = useColorTheme();

  return (
    <TooltipProvider>
      <TooltipDomBridge />
      {createPortal(
        <Toaster closeButton theme={theme} position="top-center" richColors expand visibleToasts={5} gap={12} offset={56} toastOptions={{ classNames: { toast: "font-sans !rounded-xl !gap-3 !p-4 !shadow-[var(--shadow-popover)]", title: "font-semibold leading-5 [overflow-wrap:anywhere]", description: "leading-5 [overflow-wrap:anywhere]", actionButton: "!rounded-lg", cancelButton: "!rounded-lg" }, style: { pointerEvents: "auto" } }} />,
        document.body,
      )}
      <AppShell />
    </TooltipProvider>
  );
}
