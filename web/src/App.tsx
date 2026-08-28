import { Toaster } from "sonner";

import { AppShell } from "@/app/app-shell";
import { TooltipDomBridge, TooltipProvider } from "@/components/ui/tooltip";

export default function App() {
  return (
    <TooltipProvider>
      <TooltipDomBridge />
      <Toaster position="top-center" richColors expand visibleToasts={5} gap={12} offset={56} />
      <AppShell />
    </TooltipProvider>
  );
}
