import { Toaster } from "sonner";

import { AppShell } from "@/app/app-shell";

export default function App() {
  return (
    <>
      <Toaster position="top-center" richColors expand visibleToasts={5} gap={12} offset={56} />
      <AppShell />
    </>
  );
}
