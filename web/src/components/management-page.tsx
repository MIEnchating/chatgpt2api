import type { ComponentProps, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type ManagementPageProps = ComponentProps<"section">;

function ManagementPage({
  children,
  className,
  ...props
}: ManagementPageProps) {
  return (
    <section
      data-management-page
      className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden", className)}
      {...props}
    >
      {children}
    </section>
  );
}

type ManagementPanelProps = ComponentProps<"div">;

function ManagementPanel({
  children,
  className,
  ...props
}: ManagementPanelProps) {
  return (
    <div
      data-management-panel
      className={cn("flex min-h-0 min-w-0 flex-col gap-0 overflow-hidden p-0", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function ManagementToolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-management-toolbar
      className={cn("min-w-0 shrink-0 border-b border-border px-4 py-4 sm:px-6", className)}
      {...props}
    />
  );
}

function ManagementHeader({ title, description, action, className }: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header data-management-header className={cn("flex shrink-0 flex-wrap items-center justify-between gap-4 px-4 pt-6 pb-4 sm:px-6", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}

type ManagementPaginationBaseProps = {
  page: number;
  pageSize: number;
  pageSizeOptions: number[];
  itemLabel?: string;
  compact?: boolean;
  disabled?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

type ManagementPaginationProps = ManagementPaginationBaseProps & (
  | {
      mode?: "total";
      totalPages: number;
      totalItems: number;
    }
  | {
      mode: "cursor";
      currentItems: number;
      hasMore: boolean;
    }
);

function ManagementPagination(props: ManagementPaginationProps) {
  const cursorMode = props.mode === "cursor";
  const totalPages = cursorMode ? 1 : Math.max(1, props.totalPages);
  const page = cursorMode
    ? Math.max(1, props.page)
    : Math.min(Math.max(1, props.page), totalPages);
  const hasItems = cursorMode ? props.currentItems > 0 : props.totalItems > 0;
  const canGoPrevious = cursorMode ? page > 1 : hasItems && page > 1;
  const canGoNext = cursorMode ? props.hasMore : hasItems && page < totalPages;
  const itemLabel = props.itemLabel || "条";

  return (
    <nav
      data-management-pagination
      aria-label="分页导航"
      className={cn("mt-auto grid shrink-0 items-center gap-2 border-t border-border text-xs text-muted-foreground",
        props.compact
          ? "min-h-12 grid-cols-[1fr_auto] py-1"
          : "min-h-16 grid-cols-[minmax(0,1fr)_auto_auto] px-4 py-4 sm:grid-cols-[1fr_auto_1fr] sm:gap-4 sm:px-6")}
    >
      <span className={cn("min-w-0 break-words leading-5 tabular-nums", props.compact && "sr-only")} role="status" aria-live="polite">
        {cursorMode ? "本页" : "共"} {cursorMode ? props.currentItems : props.totalItems} {itemLabel}
      </span>
      <div className={cn("flex min-w-0 items-center gap-1 sm:gap-2", !props.compact && "justify-center")}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label="上一页"
          disabled={!canGoPrevious || props.disabled}
          onClick={() => props.onPageChange(page - 1)}
        >
          <ChevronLeft  />
        </Button>
        <span className="min-w-12 text-center tabular-nums sm:min-w-24">
          <span className="sm:hidden">{cursorMode ? `${hasItems || page > 1 ? page : 0}` : `${hasItems ? page : 0} / ${hasItems ? totalPages : 0}`}</span>
          <span className="hidden sm:inline">
          {cursorMode
            ? `第 ${hasItems || page > 1 ? page : 0} 页`
            : `第 ${hasItems ? page : 0} / ${hasItems ? totalPages : 0} 页`}
          </span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label="下一页"
          disabled={!canGoNext || props.disabled}
          onClick={() => props.onPageChange(page + 1)}
        >
          <ChevronRight  />
        </Button>
      </div>
      <div className="justify-self-end">
        <Select
          value={String(props.pageSize)}
          onValueChange={(value) => props.onPageSizeChange(Number(value))}
          disabled={props.disabled}
        >
          <SelectTrigger
            className="w-20 shrink-0 sm:w-24"
            aria-label="每页数量"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.pageSizeOptions.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {option} {itemLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </nav>
  );
}

export {
  ManagementPage,
  ManagementHeader,
  ManagementPagination,
  ManagementPanel,
  ManagementToolbar,
};
