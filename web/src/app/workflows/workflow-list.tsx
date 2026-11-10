import { Copy, Globe2, LockKeyhole, MoreHorizontal, Pencil, Play, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CreativeWorkflow } from "@/services/api/workflows";

export function WorkflowList({
  items,
  onRun,
  onEdit,
  onCopy,
  onDelete,
}: {
  items: CreativeWorkflow[];
  onRun: (workflow: CreativeWorkflow) => void;
  onEdit: (workflow: CreativeWorkflow) => void;
  onCopy: (workflow: CreativeWorkflow) => void;
  onDelete: (workflow: CreativeWorkflow) => void;
}) {
  return (
    <Table aria-label="工作流列表" className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead className="hidden w-32 md:table-cell">分类</TableHead>
          <TableHead className="hidden w-44 xl:table-cell">上次运行</TableHead>
          <TableHead className="w-24 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((workflow) => (
          <TableRow key={workflow.id}>
            <TableCell className="max-w-0 py-3">
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-3 px-0 py-2 text-left"
                aria-label={`运行工作流：${workflow.name}`}
                onClick={() => onRun(workflow)}
              >
                <Workflow className="size-5 shrink-0" />
                <span className="min-w-0 truncate font-normal">{workflow.name}</span>
                {workflow.scope === "public" ? (
                  <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <LockKeyhole className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </Button>
            </TableCell>
            <TableCell className="hidden truncate text-muted-foreground md:table-cell">
              {workflow.category || "未分类"}
            </TableCell>
            <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
              {workflow.last_run_at ? new Date(workflow.last_run_at).toLocaleString("zh-CN") : "尚未运行"}
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`运行 ${workflow.name}`}
                  onClick={() => onRun(workflow)}
                >
                  <Play />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" aria-label={`更多操作：${workflow.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    {workflow.editable !== false ? (
                      <DropdownMenuItem onSelect={() => onEdit(workflow)}>
                        <Pencil />
                        编辑
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={() => onCopy(workflow)}>
                      <Copy />
                      复制
                    </DropdownMenuItem>
                    {workflow.editable !== false ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(workflow)}>
                          <Trash2 />
                          删除
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
