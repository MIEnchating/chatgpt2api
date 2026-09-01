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
  actions?: ReactNode;
};

function ManagementPage({
  actions,
  children,
  className,
  ...props
}: ManagementPageProps) {
  return (
    <section
      data-management-page
      className={cn(
        "flex h-full min-h-0 flex-col gap-[var(--page-section-gap)] overflow-hidden",
        className
      )}
      {...props}
    >
      {actions ? <PageHeader actions={actions} /> : null}
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
        "card-surface flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 shadow-[0_4px_16px_rgba(24,40,72,0.05)]",
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
        "shrink-0 border-b border-border px-4 py-4 sm:px-5",
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
    <div
      data-management-pagination
      className="mt-auto grid min-h-14 shrink-0 grid-cols-[1fr_auto] items-center gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground sm:grid-cols-[1fr_auto_1fr] sm:px-5"
    >
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        {cursorMode ? "本页" : "共"} {cursorMode ? props.currentItems : props.totalItems} {itemLabel}
      </span>
      <div className="order-3 col-span-2 flex items-center justify-center gap-2 sm:order-none sm:col-span-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 shrink-0 rounded-lg"
          aria-label="上一页"
          disabled={!canGoPrevious || props.disabled}
          onClick={() => props.onPageChange(page - 1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-24 shrink-0 text-center tabular-nums">
          {cursorMode
            ? `第 ${hasItems || page > 1 ? page : 0} 页`
            : `第 ${hasItems ? page : 0} / ${hasItems ? totalPages : 0} 页`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 shrink-0 rounded-lg"
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
            className="h-9 w-24 shrink-0 rounded-lg"
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
    </div>
  );
}

export {
  ManagementPage,
  ManagementPagination,
  ManagementPanel,
  ManagementToolbar,
};
