import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export function EditorWorkspace({
  title,
  description,
  backLabel,
  onBack,
  busy = false,
  actions,
  children,
}: {
  title: string;
  description: string;
  backLabel: string;
  onBack: () => void;
  busy?: boolean;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-editor-workspace aria-label={title} className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-4 sm:px-6">
        <Button variant="ghost" size="icon" aria-label={backLabel} disabled={busy} onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 hidden text-sm text-muted-foreground sm:block">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </header>
      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        contentClassName="mx-auto max-w-7xl p-4 pr-1 sm:p-6 sm:pr-3"
        onWheel={(event) => event.stopPropagation()}
      >
        {children}
      </ScrollArea>
    </section>
  );
}
