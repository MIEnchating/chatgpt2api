import { useId, type ComponentProps, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SettingsPanelProps = ComponentProps<"section"> & {
  action?: ReactNode;
  contentClassName?: string;
  contentScrollable?: boolean;
  description?: string;
  meta?: ReactNode;
  showHeader?: boolean;
  title: string;
};

export function SettingsPanel({
  action,
  children,
  className,
  contentClassName,
  contentScrollable = true,
  description,
  meta,
  showHeader = true,
  title,
  ...props
}: SettingsPanelProps) {
  const headingId = useId();
  return (
    <section
      data-settings-panel
      aria-labelledby={headingId}
      className={cn("mx-auto flex h-full min-h-0 w-full min-w-0 max-w-3xl flex-col gap-8", className)}
      {...props}
    >
      {showHeader ? <header data-settings-panel-header className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 id={headingId} className="text-2xl font-semibold tracking-tight">{title}</h1>
              {meta}
            </div>
            {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div> : null}
      </header> : <h1 id={headingId} className="sr-only">{title}</h1>}
      {contentScrollable ? (
        // Leave room for card rings and focus outlines inside the viewport.
        <ScrollArea
          data-settings-panel-body
          className="-mr-3 -ml-1 min-h-0 min-w-0 flex-1"
          contentClassName={cn("min-w-0 py-1 pl-1", contentClassName)}
          onWheel={(event) => event.stopPropagation()}
        >
          {children}
        </ScrollArea>
      ) : (
        <div data-settings-panel-body className={cn("flex min-h-0 min-w-0 flex-1 flex-col", contentClassName)}>
          {children}
        </div>
      )}
    </section>
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  contentClassName?: string;
}) {
  const headingId = useId();
  return (
    <section data-settings-section aria-labelledby={headingId} className={cn("grid min-w-0 gap-4", className)} {...props}>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-base font-medium">{title}</h2>
          {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div> : null}
      </header>
      <Card className="gap-0 py-0">
        <CardContent className={cn("grid min-w-0 gap-5 p-4 sm:p-5", contentClassName)}>{children}</CardContent>
      </Card>
    </section>
  );
}
