import { useLocation } from "react-router-dom";

import { AnimatedRoutes } from "@/app/animated-routes";
import { TopNav } from "@/components/top-nav";
import { cn } from "@/lib/utils";

export function AppShell() {
  const location = useLocation();
  const canvasRoute = location.pathname === "/canvas";

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div
        className={cn(
          "mx-auto box-border flex h-dvh w-full flex-col px-3 py-3 sm:px-5 sm:py-4 lg:px-6",
          canvasRoute ? "max-w-none gap-3" : "max-w-[1480px] gap-4",
        )}
      >
        <TopNav />
        <div className="min-h-0 min-w-0 flex-1">
          <AnimatedRoutes />
        </div>
      </div>
    </main>
  );
}
