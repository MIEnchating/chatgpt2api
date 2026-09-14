"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

type SettingsCardTone = "blue" | "amber" | "slate" | "violet";

const toneClassNames: Record<SettingsCardTone, string> = {
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/50",
  blue: "bg-primary/10 text-primary ring-1 ring-primary/15",
  slate: "bg-secondary text-muted-foreground ring-1 ring-border",
  violet: "bg-violet-50 text-violet-700 ring-1 ring-violet-100 dark:bg-violet-950/30 dark:text-violet-300 dark:ring-violet-900/50",
};

type SettingsCardProps = {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  contentScrollable?: boolean;
  description: string;
  icon: LucideIcon;
  meta?: ReactNode;
  title: string;
  tone?: SettingsCardTone;
};

export const settingsInputClassName = "bg-background";
export const settingsDialogInputClassName = "h-10 bg-background";
export const settingsListItemClassName =
  "min-w-0 rounded-xl border border-border bg-background p-4 shadow-[var(--shadow-card)]";
export const settingsPanelClassName =
  "rounded-xl border border-border/70 bg-muted/30 p-4";
export function SettingsCard({
  action,
  children,
  className,
  contentClassName,
  contentScrollable = true,
  description,
  icon: Icon,
  meta,
  title,
  tone = "blue",
}: SettingsCardProps) {
  return (
    <Card
      data-settings-card
      className={cn(
        "min-w-0 overflow-hidden rounded-xl lg:h-full lg:min-h-0",
        className,
      )}
    >
      <div
        data-settings-card-header-frame
        className="shrink-0 bg-card"
      >
        <CardHeader
          data-settings-card-header
          className="gap-4 border-b border-border bg-card p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:p-5"
        >
          <div className="flex min-w-0 items-center gap-3 sm:flex-[1_1_16rem]">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-lg",
                toneClassNames[tone],
              )}
            >
              <Icon className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-lg leading-7 font-semibold">
                {title}
              </CardTitle>
              <CardDescription className="mt-1 break-words text-sm leading-5">
                {description}
              </CardDescription>
            </div>
          </div>
          {meta || action ? (
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:justify-end">
              {meta}
              {action}
            </div>
          ) : null}
        </CardHeader>
      </div>
      {contentScrollable ? (
        <ScrollArea
          data-settings-card-body
          className="min-h-0 min-w-0 lg:flex-1"
        >
          <CardContent className={cn("min-w-0 p-4 sm:p-5", contentClassName)}>
            {children}
          </CardContent>
        </ScrollArea>
      ) : (
        <div data-settings-card-body className="min-h-0 min-w-0 lg:flex lg:flex-1 lg:flex-col">
          <CardContent className={cn("min-w-0 p-4 sm:p-5", contentClassName)}>
            {children}
          </CardContent>
        </div>
      )}
    </Card>
  );
}

export function SettingsNotice({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-muted/60 px-4 py-3 text-sm leading-6 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsEmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <EmptyState icon={Icon} title={title} description={description} />
  );
}
