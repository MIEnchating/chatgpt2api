import { AnimatedRoutes } from "@/app/animated-routes";
import { TopNav } from "@/components/top-nav";

export function AppShell() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto box-border flex h-dvh w-full max-w-[1480px] flex-col gap-4 px-3 py-3 sm:px-5 sm:py-4 lg:px-6">
        <TopNav />
        <div className="min-h-0 min-w-0 flex-1">
          <AnimatedRoutes />
        </div>
      </div>
    </main>
  );
}
