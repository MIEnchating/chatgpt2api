import { Toaster } from "sonner";

import { AppShell } from "@/app/app-shell";
import { LegacyImageConversationMigration } from "@/components/legacy-image-conversation-migration";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function App() {
  return (
    <TooltipProvider>
      <Toaster position="top-center" richColors expand visibleToasts={5} gap={12} offset={56} />
      <LegacyImageConversationMigration />
      <AppShell />
    </TooltipProvider>
  );
}
