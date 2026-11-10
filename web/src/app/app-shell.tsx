import { Button } from "@/components/ui/button";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { useEffect } from "react";
import { useMatch } from "react-router-dom";

import { AnimatedRoutes } from "@/app/animated-routes";
import { preloadRoute } from "@/app/route-config";
import { TopNav } from "@/components/top-nav";
import { purgeDeprecatedBrowserPersistence } from "@/lib/deprecated-browser-persistence";
import { RelayTokenPreferencesProvider } from "@/lib/relay-token-preferences";

export function AppShell() {
  const sharedCanvas = useMatch("/share/canvas/:token") !== null;
  const canvasEditor = useMatch("/canvas/:projectID") !== null;
  useEffect(() => {
    purgeDeprecatedBrowserPersistence();
  }, []);

  if (sharedCanvas) return <main id="page-content" className="h-dvh w-full text-foreground"><AnimatedRoutes /></main>;

  return (
    <RelayTokenPreferencesProvider>
      <main className="min-h-dvh bg-sidebar text-foreground">
        <Button asChild className="fixed top-3 left-3 z-50 -translate-y-24 focus:translate-y-0"><a href="#page-content">
          跳转到页面内容
        </a></Button>
        <div className="box-border flex h-dvh w-full min-w-0 flex-col md:flex-row">
          {!canvasEditor ? <TopNav onPreloadRoute={preloadRoute} /> : null}
          {canvasEditor ? (
            <div id="page-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 outline-none">
              <AnimatedRoutes />
            </div>
          ) : (
            <div data-app-workspace className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
              <ScrollAreaRoot id="page-content" tabIndex={-1} className="relative min-h-0 min-w-0 flex-1 outline-none" data-slot="scroll-area">
                <ScrollAreaViewport data-slot="scroll-area-viewport" className="size-full overscroll-contain [&>div]:block! [&>div]:h-full">
                  {/* Keep a usable workspace when toolbars exceed the available screen height. */}
                  <div className="h-full min-h-[40rem] lg:min-h-[32rem]">
                    <AnimatedRoutes />
                  </div>
                </ScrollAreaViewport>
                <ScrollBar />
              </ScrollAreaRoot>
            </div>
          )}
        </div>
      </main>
    </RelayTokenPreferencesProvider>
  );
}
