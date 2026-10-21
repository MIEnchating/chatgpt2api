import * as React from "react";

import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return <table data-slot="table" className={cn("w-full min-w-[28rem] caption-bottom border-collapse text-sm text-foreground", className)} {...props} />;
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("sticky top-0 z-10 border-b border-border bg-card text-xs text-muted-foreground shadow-[0_1px_0_var(--border)]", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border/70 transition-colors hover:bg-muted/35 focus-within:bg-muted/35 data-[state=selected]:bg-accent", className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return <th className={cn("h-11 px-3 py-2.5 text-left align-middle leading-5 font-semibold whitespace-nowrap sm:px-4", className)} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-3.5 align-middle leading-6 [overflow-wrap:anywhere] sm:px-4", className)} {...props} />;
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
