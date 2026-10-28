import { useEffect } from "react";
import { useMatch } from "react-router-dom";

import { AnimatedRoutes } from "@/app/animated-routes";
import { preloadRoute } from "@/app/route-config";
import { TopNav } from "@/components/top-nav";
import { purgeDeprecatedBrowserPersistence } from "@/lib/deprecated-browser-persistence";
import { RelayTokenPreferencesProvider } from "@/lib/relay-token-preferences";
import { cn } from "@/lib/utils";

export function AppShell() {
  const sharedCanvas = useMatch("/share/canvas/:token") !== null;
  const canvasEditor = useMatch("/canvas/:projectID") !== null;
  useEffect(() => {
    purgeDeprecatedBrowserPersistence();
  }, []);

  if (sharedCanvas) return <main id="page-content" className="h-dvh w-full text-foreground"><AnimatedRoutes /></main>;

  return (
    <RelayTokenPreferencesProvider>
      <main className="min-h-dvh text-foreground">
        <a href="#page-content" className="fixed top-3 left-3 z-[110] -translate-y-24 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg focus:translate-y-0">
          跳转到页面内容
        </a>
        <div className={cn("mx-auto box-border flex h-dvh w-full max-w-none flex-col", !canvasEditor && "gap-[var(--page-section-gap)] px-[var(--page-padding)] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-4 sm:pb-4")}>
          {!canvasEditor ? <TopNav onPreloadRoute={preloadRoute} /> : null}
          <div id="page-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 outline-none">
            <AnimatedRoutes />
          </div>
        </div>
      </main>
    </RelayTokenPreferencesProvider>
  );
}
