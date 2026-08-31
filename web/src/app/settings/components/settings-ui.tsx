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
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
  blue: "bg-[#edf4ff] text-[#1456f0] ring-1 ring-blue-100",
  slate: "bg-secondary text-muted-foreground ring-1 ring-border",
  violet: "bg-violet-50 text-violet-700 ring-1 ring-violet-100",
};

type SettingsCardProps = {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  description: string;
  icon: LucideIcon;
  meta?: ReactNode;
  title: string;
  tone?: SettingsCardTone;
};

export const settingsInputClassName = "bg-background";
export const settingsDialogInputClassName = "h-11 bg-background";
export const settingsListItemClassName =
  "rounded-xl border border-border/80 bg-background px-4 py-4 shadow-[0_4px_6px_rgba(0,0,0,0.04)]";
export const settingsPanelClassName =
  "rounded-xl border border-border/70 bg-muted/30 p-4";
export function SettingsCard({
  action,
  children,
  className,
  contentClassName,
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
        "overflow-hidden rounded-xl border-border/80 lg:h-full lg:min-h-0",
        className,
      )}
    >
      <div
        data-settings-card-header-frame
        className="shrink-0 bg-card"
      >
        <CardHeader
          data-settings-card-header
          className="gap-4 border-b border-border/80 bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-center gap-3">
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
              <CardDescription className="mt-1 line-clamp-2 text-sm leading-5">
                {description}
              </CardDescription>
            </div>
          </div>
          {meta || action ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
              {meta}
              {action}
            </div>
          ) : null}
        </CardHeader>
      </div>
      <ScrollArea
        data-settings-card-body
        className="min-h-0 lg:flex-1"
        viewportClassName="pr-4"
      >
        <CardContent className={cn("p-5 pt-0 sm:p-6 sm:pt-0", contentClassName)}>
          {children}
        </CardContent>
      </ScrollArea>
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
