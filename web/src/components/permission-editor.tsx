"use client";

import { useMemo } from "react";
import { KeyRound, Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ApiPermission, PermissionMenu } from "@/lib/api";
import { cn } from "@/lib/utils";

function flattenMenuPermissions(items: PermissionMenu[] | null | undefined): PermissionMenu[] {
  const out: PermissionMenu[] = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    out.push(item);
    out.push(...flattenMenuPermissions(item.children));
  });
  return out;
}

function groupApiPermissions(items: ApiPermission[]) {
  return items.reduce<Array<{ group: string; items: ApiPermission[] }>>((groups, item) => {
    const group = item.group || "其他";
    const existing = groups.find((entry) => entry.group === group);
    if (existing) {
      existing.items.push(item);
      return groups;
    }
    groups.push({ group, items: [item] });
    return groups;
  }, []);
}

function toggleListValue(values: string[], value: string, checked: boolean) {
  const current = new Set(values);
  if (checked) current.add(value);
  else current.delete(value);
  return Array.from(current).sort();
}

function toggleListValues(values: string[], targets: string[], checked: boolean) {
  const current = new Set(values);
  targets.forEach((target) => {
    if (checked) current.add(target);
    else current.delete(target);
  });
  return Array.from(current).sort();
}

function apiMethodClass(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
      return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300";
    case "POST":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300";
    case "PUT":
    case "PATCH":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300";
    case "DELETE":
      return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

type PermissionEditorProps = {
  menus: PermissionMenu[];
  apis: ApiPermission[];
  selectedMenuPaths: string[];
  selectedApiPermissions: string[];
  onMenuPathsChange: (paths: string[]) => void;
  onApiPermissionsChange: (permissions: string[]) => void;
  disabled?: boolean;
  className?: string;
};

export function PermissionEditor({
  menus,
  apis,
  selectedMenuPaths,
  selectedApiPermissions,
  onMenuPathsChange,
  onApiPermissionsChange,
  disabled = false,
  className,
}: PermissionEditorProps) {
  const menuPermissions = useMemo(() => flattenMenuPermissions(menus), [menus]);
  const apiPermissionGroups = useMemo(() => groupApiPermissions(apis), [apis]);
  const allMenuPaths = useMemo(() => menuPermissions.map((item) => item.path), [menuPermissions]);
  const allApiPermissionKeys = useMemo(() => apis.map((item) => item.key), [apis]);

  return (
    <div
      data-permission-editor
      className={cn(
        "grid h-full min-h-0 min-w-0 grid-rows-[minmax(260px,0.7fr)_minmax(420px,1.3fr)] lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-1",
        className,
      )}
      aria-busy={disabled}
    >
      <section className="flex min-h-0 min-w-0 flex-col border-b border-border lg:border-r lg:border-b-0">
        <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Menu className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">菜单访问</h3>
              <p className="text-xs tabular-nums text-muted-foreground">{selectedMenuPaths.length} / {allMenuPaths.length}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={disabled || selectedMenuPaths.length === allMenuPaths.length} onClick={() => onMenuPathsChange(allMenuPaths)}>全选</Button>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={disabled || selectedMenuPaths.length === 0} onClick={() => onMenuPathsChange([])}>清空</Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {menuPermissions.length ? (
            <div className="divide-y divide-border">
              {menuPermissions.map((item) => {
                const checked = selectedMenuPaths.includes(item.path);
                return (
                  <label key={item.path} data-selected={checked} className="flex min-h-[58px] cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 data-[selected=true]:bg-primary/[0.045]">
                    <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onMenuPathsChange(toggleListValue(selectedMenuPaths, item.path, Boolean(value)))} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{item.label}</div>
                      <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{item.path}</code>
                    </div>
                  </label>
                );
              })}
            </div>
          ) : <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">暂无菜单权限</div>}
        </ScrollArea>
      </section>

      <section className="flex min-h-0 min-w-0 flex-col">
        <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">功能权限</h3>
              <p className="text-xs tabular-nums text-muted-foreground">{selectedApiPermissions.length} / {allApiPermissionKeys.length}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={disabled || selectedApiPermissions.length === allApiPermissionKeys.length} onClick={() => onApiPermissionsChange(allApiPermissionKeys)}>全选</Button>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={disabled || selectedApiPermissions.length === 0} onClick={() => onApiPermissionsChange([])}>清空</Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="p-4 sm:p-5">
          {apiPermissionGroups.length ? (
            <div className="space-y-5">
              {apiPermissionGroups.map((group) => {
                const groupKeys = group.items.map((item) => item.key);
                const selectedCount = groupKeys.filter((key) => selectedApiPermissions.includes(key)).length;
                const groupChecked = selectedCount === groupKeys.length ? true : selectedCount > 0 ? "indeterminate" : false;
                return (
                  <section key={group.group} className="min-w-0">
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                        <Checkbox checked={groupChecked} disabled={disabled} onCheckedChange={(value) => onApiPermissionsChange(toggleListValues(selectedApiPermissions, groupKeys, Boolean(value)))} />
                        <h4 className="truncate text-xs font-semibold text-foreground">{group.group}</h4>
                      </label>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{selectedCount} / {group.items.length}</span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                      {group.items.map((permission) => {
                        const checked = selectedApiPermissions.includes(permission.key);
                        return (
                          <label key={permission.key} data-selected={checked} className="flex min-h-[68px] cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-muted/50 data-[selected=true]:border-primary/35 data-[selected=true]:bg-primary/[0.04]">
                            <Checkbox checked={checked} disabled={disabled} className="mt-0.5" onCheckedChange={(value) => onApiPermissionsChange(toggleListValue(selectedApiPermissions, permission.key, Boolean(value)))} />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none", apiMethodClass(permission.method))}>{permission.method}</span>
                                <span className="truncate text-xs font-medium text-foreground">{permission.label}</span>
                              </div>
                              <code className="mt-1.5 block truncate font-mono text-[11px] text-muted-foreground">{permission.path}{permission.subtree ? "/*" : ""}</code>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">暂无功能权限</div>}
        </ScrollArea>
      </section>
    </div>
  );
}
