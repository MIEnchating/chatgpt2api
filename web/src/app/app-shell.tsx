import { useEffect } from "react";

import { AnimatedRoutes } from "@/app/animated-routes";
import { preloadRoute } from "@/app/route-config";
import { TopNav } from "@/components/top-nav";
import { purgeDeprecatedBrowserPersistence } from "@/lib/deprecated-browser-persistence";
import { RelayTokenPreferencesProvider } from "@/lib/relay-token-preferences";

export function AppShell() {
  useEffect(() => {
    purgeDeprecatedBrowserPersistence();
  }, []);

  return (
    <RelayTokenPreferencesProvider>
      <main className="min-h-dvh text-foreground">
        <a href="#page-content" className="fixed top-3 left-3 z-[110] -translate-y-24 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg focus:translate-y-0">
          跳转到页面内容
        </a>
        <div className="mx-auto box-border flex h-dvh w-full max-w-none flex-col gap-[var(--page-section-gap)] px-[var(--page-padding)] py-3 sm:py-4">
          <TopNav onPreloadRoute={preloadRoute} />
          <div id="page-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 outline-none">
            <AnimatedRoutes />
          </div>
        </div>
      </main>
    </RelayTokenPreferencesProvider>
  );
}
