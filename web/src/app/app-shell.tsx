import { useEffect } from "react";

import { AnimatedRoutes } from "@/app/animated-routes";
import { TopNav } from "@/components/top-nav";
import { purgeDeprecatedBrowserPersistence } from "@/lib/deprecated-browser-persistence";
import { RelayTokenPreferencesProvider } from "@/lib/relay-token-preferences";

export function AppShell() {
  useEffect(() => {
    purgeDeprecatedBrowserPersistence();
  }, []);

  return (
    <RelayTokenPreferencesProvider>
      <main className="min-h-dvh bg-background text-foreground">
        <div className="mx-auto box-border flex h-dvh w-full max-w-none flex-col gap-[var(--page-section-gap)] px-3 py-3 sm:px-5 sm:py-4 lg:px-6">
          <TopNav />
          <div className="min-h-0 min-w-0 flex-1">
            <AnimatedRoutes />
          </div>
        </div>
      </main>
    </RelayTokenPreferencesProvider>
  );
}
