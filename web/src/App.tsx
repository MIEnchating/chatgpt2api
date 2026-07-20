import { Toaster } from "sonner";

import { AppShell } from "@/app/app-shell";
import { LegacyImageConversationMigration } from "@/components/legacy-image-conversation-migration";

export default function App() {
  return (
    <>
      <Toaster position="top-center" richColors expand visibleToasts={5} gap={12} offset={56} />
      <LegacyImageConversationMigration />
      <AppShell />
    </>
  );
}
