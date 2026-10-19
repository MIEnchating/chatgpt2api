import type { ComponentProps, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type ManagementPageProps = ComponentProps<"section"> & {
  title?: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
};

function ManagementPage({
  title,
  description,
  meta,
  actions,
  children,
  className,
  ...props
}: ManagementPageProps) {
  return (
    <section
      data-management-page
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col gap-[var(--page-section-gap)] overflow-x-hidden overflow-y-auto",
        className
      )}
      {...props}
    >
      {title || actions ? <PageHeader title={title} description={description} meta={meta} actions={actions} /> : null}
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
      className={cn(
        "card-surface flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border shadow-[var(--shadow-card)]",
        className
      )}
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
      className={cn(
        "min-w-0 shrink-0 border-b border-border bg-muted/15 px-4 py-3 sm:px-5 sm:py-4",
        className
      )}
      {...props}
    />
  );
}

type ManagementPaginationBaseProps = {
  page: number;
  pageSize: number;
  pageSizeOptions: number[];
  itemLabel?: string;
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
      className="mt-auto grid min-h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-t border-border bg-card px-3 py-2 text-xs text-muted-foreground sm:grid-cols-[1fr_auto_1fr] sm:gap-3 sm:px-5"
    >
      <span className="min-w-0 truncate tabular-nums" role="status" aria-live="polite">
        {cursorMode ? "本页" : "共"} {cursorMode ? props.currentItems : props.totalItems} {itemLabel}
      </span>
      <div className="flex items-center justify-center gap-1 sm:gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8 shrink-0 rounded-lg sm:size-9"
          aria-label="上一页"
          disabled={!canGoPrevious || props.disabled}
          onClick={() => props.onPageChange(page - 1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-10 shrink-0 text-center tabular-nums sm:min-w-24">
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
          className="size-8 shrink-0 rounded-lg sm:size-9"
          aria-label="下一页"
          disabled={!canGoNext || props.disabled}
          onClick={() => props.onPageChange(page + 1)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div className="justify-self-end">
        <Select
          value={String(props.pageSize)}
          onValueChange={(value) => props.onPageSizeChange(Number(value))}
          disabled={props.disabled}
        >
          <SelectTrigger
            className="h-8 w-20 shrink-0 rounded-lg px-2 text-xs sm:h-9 sm:w-24 sm:px-3 sm:text-sm"
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
  ManagementPagination,
  ManagementPanel,
  ManagementToolbar,
};
