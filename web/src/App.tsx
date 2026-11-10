import { createPortal } from "react-dom";
import { Toaster } from "sonner";
import { OVERLAY_LAYER } from "@/lib/overlay-layers";

import { AppShell } from "@/app/app-shell";
import { TooltipDomBridge, TooltipProvider } from "@/components/ui/tooltip";
import { useColorTheme } from "@/lib/use-color-theme";

export default function App() {
  const theme = useColorTheme();

  return (
    <TooltipProvider>
      <TooltipDomBridge />
      {createPortal(
        <Toaster closeButton style={{ zIndex: OVERLAY_LAYER.notification }} theme={theme} position="top-center" expand visibleToasts={5} gap={12} offset={56} toastOptions={{ style: { pointerEvents: "auto" } }} />,
        document.body,
      )}
      <AppShell />
    </TooltipProvider>
  );
}
