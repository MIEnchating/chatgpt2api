import { Toaster } from "sonner";

import { AppShell } from "@/app/app-shell";
import { TooltipDomBridge, TooltipProvider } from "@/components/ui/tooltip";
import { useColorTheme } from "@/lib/use-color-theme";

export default function App() {
  const theme = useColorTheme();

  return (
    <TooltipProvider>
      <TooltipDomBridge />
      <Toaster closeButton theme={theme} position="top-center" richColors expand visibleToasts={5} gap={12} offset={56} toastOptions={{ classNames: { toast: "font-sans rounded-xl" } }} />
      <AppShell />
    </TooltipProvider>
  );
}
